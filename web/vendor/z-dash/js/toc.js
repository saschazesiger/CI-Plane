/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Jump links and tables of contents (DS.toc): scroll-spy. The link of the
 * section being read carries aria-current="location" while the reader
 * scrolls, and a link scrolls to its section and takes the focus there.
 *
 *   <nav class="ds-toc" aria-label="On this page" data-ds-toc>
 *     <ol class="ds-toc__list"><li><a class="ds-toc__link" href="#overview">Overview</a></li> ...</ol>
 *   </nav>
 *   const toc = DS.toc.create(nav, { offset: 64, hash: false });
 *   toc.get();  toc.set('history');  toc.on('change', ({ id, link, target }) => ...);
 *
 * Which section is current: the last one whose top has passed the reading
 * line, `offset` px below the top of the scroller (default: the first
 * section's scroll-margin-top plus a quarter of the scroller's height). At
 * the end of the scroll, where the last
 * sections cannot reach the line, the last one whose top shows is current.
 * A link the reader chose stays current while its section shows, so a
 * short section near the end keeps the mark it was given. An
 * IntersectionObserver whose root ends at the reading line tells when a
 * section crosses it (no scroll listener); a second one tells when the
 * last section comes into view; a ResizeObserver on the scroller moves the
 * line with its height.
 *
 * A click (or Enter) on a link scrolls its section to the top (smoothly
 * within three heights of the scroller, at once beyond that), focuses it (tabindex="-1", owned, when it takes
 * no focus of its own; the focus never scrolls) so the keyboard goes on
 * from there, and writes the hash with history.pushState unless
 * data-ds-toc-hash="off" (no hashchange: a router that listens to it is
 * left alone). The scroller is the nearest scrolling ancestor of the first
 * section, else the page.
 *
 * aria-current and the targets' tabindex are owned state: DS.dom.morphHtml
 * keeps them. The indicator is DS.indicator on the top list
 * (.ds-toc__indicator); a bar keeps the current link in view (reveal).
 * Events: ds:change ({ id, link, target }) on the nav.
 *
 * ES2022. Progressive: none (IntersectionObserver and ResizeObserver are at
 * the floor; without them, in a test fake, the first link is current).
 */
import { define, emit } from './core.js';
import { own, disown } from './dom.js';
import { create as makeIndicator } from './indicator.js';

/** How many heights of the scroller a link glides through before it jumps. */
const GLIDE_SCREENS = 3;

/**
 * Which section is current, from where each one's top lies (px from the top
 * of the scroller's view, in document order): the last one at or above the
 * reading `line`; at the end of the scroll the last one whose top shows (above
 * `bottom`); the `pinned` one (an index) while its top shows. -1 when none has
 * reached the line yet and none is pinned: the first one then, if any.
 * @param {number[]} tops
 * @param {{ line: number, bottom: number, atEnd?: boolean, pinned?: number }} options
 * @returns {number}
 */
export function current(tops, options) {
  const { line, bottom, atEnd = false, pinned = -1 } = options;
  if (!tops.length) return -1;
  if (pinned >= 0 && pinned < tops.length && tops[pinned] < bottom && tops[pinned] > -bottom) return pinned;
  let index = -1;
  for (let at = 0; at < tops.length; at += 1) if (tops[at] <= line) index = at;
  if (atEnd) {
    for (let at = tops.length - 1; at > index; at -= 1) {
      if (tops[at] < bottom) return at;
    }
  }
  return index < 0 ? 0 : index;
}

/** Whether an element scrolls on the block axis. */
function scrolls(element, view) {
  const style = view.getComputedStyle(element);
  return /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
}

/** The nearest scrolling ancestor of `element`, or null for the page. */
function scrollerOf(element, view) {
  for (let node = element?.parentElement; node && node !== element.ownerDocument.body && node !== element.ownerDocument.documentElement; node = node.parentElement) {
    if (scrolls(node, view)) return node;
  }
  return null;
}

/** The element a link's hash names, in the tree of the link. */
function targetOf(link) {
  const hash = link.getAttribute('href') ?? '';
  if (!hash.startsWith('#') || hash.length < 2) return null;
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // A malformed escape: the id as written.
  }
  const root = link.getRootNode?.();
  return (typeof root?.getElementById === 'function' ? root.getElementById(id) : null) ?? link.ownerDocument.getElementById(id);
}

/**
 * The controller of one toc.
 * @param {HTMLElement} nav
 * @param {{ offset?: number|null, hash?: boolean }} options
 * @param {AbortSignal} [signal]
 */
function controller(nav, options, signal) {
  const doc = nav.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const abort = new AbortController();
  signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const listeners = new Set();
  const owned = [];
  const take = (element, name) => {
    own(element, 'attrs', name);
    owned.push([element, name]);
  };
  let entries = [];
  let scroller = null;
  let active = -1;
  let pinned = -1;
  let lineObserver = null;
  let endObserver = null;
  let frame = 0;
  /** The frame watch of a jump's scroll: while it runs, the jump's section stays marked. */
  let jump = 0;

  const read = () => {
    entries = [...nav.querySelectorAll('.ds-toc__link')]
      .map((link) => ({ link, target: targetOf(link) }))
      .filter((entry) => entry.target);
    for (const { link } of entries) {
      if (!owned.some(([element]) => element === link)) take(link, 'aria-current');
    }
    scroller = scrollerOf(entries[0]?.target ?? nav, view);
  };

  /** The view of the scroller: its top and height in the viewport. */
  const viewBox = () => {
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      return { top: rect.top, height: scroller.clientHeight };
    }
    return { top: 0, height: view.innerHeight || doc.documentElement.clientHeight };
  };

  /** Where the reading line lies below the top of the view (px). */
  const line = () => {
    if (typeof options.offset === 'number') return options.offset;
    const margin = entries[0] ? parseFloat(view.getComputedStyle(entries[0].target).scrollMarginTop) || 0 : 0;
    return margin + Math.round(viewBox().height / 4);
  };

  const atEnd = () => {
    const box = scroller ?? doc.scrollingElement ?? doc.documentElement;
    return box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
  };

  const mark = (index, reason) => {
    if (index === active) return;
    active = index;
    entries.forEach(({ link }, at) => {
      if (at === index) link.setAttribute('aria-current', 'location');
      else if (link.hasAttribute('aria-current')) link.removeAttribute('aria-current');
    });
    const entry = entries[index];
    if (!entry) return;
    const detail = { id: entry.target.id, link: entry.link, target: entry.target, reason };
    emit(nav, 'change', detail);
    for (const entryFn of listeners) entryFn(detail);
  };

  /** Reads where the sections lie and marks the current one. */
  const update = () => {
    frame = 0;
    if (!entries.length) return;
    // A jump on its way: the sections it passes never take the mark from its own.
    if (jump && pinned >= 0) return;
    const box = viewBox();
    const tops = entries.map(({ target }) => target.getBoundingClientRect().top - box.top);
    if (pinned >= 0 && !(tops[pinned] < box.height && tops[pinned] > -box.height)) pinned = -1;
    mark(current(tops, { line: line() + 1, bottom: box.height, atEnd: atEnd(), pinned }), 'scroll');
  };

  const later = () => {
    if (frame) return;
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(update) : 0;
    if (!frame) update();
  };

  /** Two observers: one whose root ends at the reading line, one for the last section. */
  const observe = () => {
    lineObserver?.disconnect();
    endObserver?.disconnect();
    if (typeof view.IntersectionObserver !== 'function' || !entries.length) return;
    const box = viewBox();
    const below = Math.max(0, Math.round(box.height - line() - 1));
    const root = scroller ?? null;
    lineObserver = new view.IntersectionObserver(later, { root, rootMargin: `0px 0px -${below}px 0px`, threshold: [0, 1] });
    endObserver = new view.IntersectionObserver(later, { root, threshold: [0, 1] });
    for (const { target } of entries) lineObserver.observe(target);
    endObserver.observe(entries[entries.length - 1].target);
  };

  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => { observe(); later(); }) : null;

  /**
   * Watches a jump's scroll frame by frame until it has held still for three
   * frames once it moved (thirty while it has not: a jump that needs no
   * scroll, or one that starts late; every engine, with or without the
   * scrollend event), then reads
   * where the sections lie: a glide that passes other sections keeps the
   * jump's mark, and a section that cannot reach the line gives it up then.
   */
  const watchJump = () => {
    const box = scroller ?? doc.scrollingElement ?? doc.documentElement;
    if (typeof view.requestAnimationFrame !== 'function') return;
    if (jump) view.cancelAnimationFrame(jump);
    const start = box.scrollTop;
    let last = start;
    let still = 0;
    let moved = false;
    const step = () => {
      const now = box.scrollTop;
      if (now !== start) moved = true;
      still = now === last ? still + 1 : 0;
      last = now;
      // A smooth scroll may take a few frames to start on a busy page: before it has moved, it waits longer.
      if (still >= (moved ? 3 : 30)) {
        jump = 0;
        later();
        return;
      }
      jump = view.requestAnimationFrame(step);
    };
    jump = view.requestAnimationFrame(step);
  };

  /** Scrolls a section to the top of the view and moves the focus there. */
  const go = (index, how = {}) => {
    const entry = entries[index];
    if (!entry) return false;
    const { target } = entry;
    const box = viewBox();
    const distance = Math.abs(target.getBoundingClientRect().top - box.top);
    const behavior = distance <= box.height * GLIDE_SCREENS ? 'smooth' : 'instant';
    pinned = index;
    mark(index, 'link');
    target.scrollIntoView({ behavior, block: 'start' });
    watchJump();
    if (how.focus !== false) {
      if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) {
        take(target, 'tabindex');
        target.setAttribute('tabindex', '-1');
      }
      target.focus({ preventScroll: true });
    }
    if (how.hash !== false && options.hash !== false && target.id && typeof view.history?.pushState === 'function' && view.location) {
      const url = `#${encodeURIComponent(target.id)}`;
      if (view.location.hash !== url) view.history.pushState(view.history.state, '', url);
    }
    return true;
  };

  nav.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = /** @type {Element} */ (event.target)?.closest?.('.ds-toc__link');
    const index = entries.findIndex((entry) => entry.link === link);
    if (index < 0) return;
    event.preventDefault();
    go(index);
  }, { signal: abort.signal });

  read();
  // The markup's own mark first (a server that knows), else what the scroll says.
  const marked = entries.findIndex(({ link }) => { const value = link.getAttribute('aria-current'); return value !== null && value !== 'false'; });
  if (marked >= 0) active = marked;
  observe();
  resize?.observe(scroller ?? doc.documentElement);
  update();
  // After the first mark: the pill's first placement jumps, so the link
  // the page loads on is marked in place instead of growing on load.
  const top = nav.querySelector('.ds-toc__list');
  const indicator = top ? makeIndicator(top, {
    active: '.ds-toc__link[aria-current]:not([aria-current="false"])',
    className: 'ds-toc__indicator',
    reveal: nav.classList.contains('ds-toc--bar'),
  }) : null;

  // Links added or removed: read them again.
  const changes = typeof view.MutationObserver === 'function' ? new view.MutationObserver((records) => {
    if (!records.some((record) => record.type === 'childList' || record.attributeName === 'href')) return;
    read();
    observe();
    later();
  }) : null;
  changes?.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });

  let gone = false;
  return {
    /** The id of the current section, or null. */
    get() {
      return entries[active]?.target.id ?? null;
    },
    /** Goes to a section (its id, or its link): scrolls, focuses, marks it. */
    set(value) {
      const index = entries.findIndex((entry) => entry.target.id === value || entry.link === value || entry.target === value);
      return go(index);
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Reads the links, the sections and their places again. */
    refresh() {
      read();
      observe();
      update();
    },
    destroy() {
      if (gone) return;
      gone = true;
      abort.abort();
      listeners.clear();
      lineObserver?.disconnect();
      endObserver?.disconnect();
      resize?.disconnect();
      changes?.disconnect();
      if (frame) view.cancelAnimationFrame?.(frame);
      if (jump) view.cancelAnimationFrame?.(jump);
      for (const [element, name] of owned) disown(element, 'attrs', name);
      indicator?.destroy();
    },
  };
}

/** The options of the attribute path. */
function optionsOf(el) {
  const offset = Number.parseFloat(el.getAttribute('data-ds-toc-offset') ?? '');
  return {
    offset: Number.isFinite(offset) ? offset : null,
    hash: el.getAttribute('data-ds-toc-hash') !== 'off',
  };
}

define('toc', {
  attribute: 'data-ds-toc',
  attributes: ['data-ds-toc-offset', 'data-ds-toc-hash'],
  init(el, ctx) {
    return controller(/** @type {HTMLElement} */ (el), optionsOf(el), ctx.signal);
  },
});

/**
 * A table of contents driven from the page; the same controller the
 * attribute path makes.
 * @param {HTMLElement} el  the .ds-toc nav
 * @param {{ offset?: number|null, hash?: boolean }} [options]
 */
export function create(el, options = {}) {
  return controller(el, { offset: options.offset ?? null, hash: options.hash !== false });
}
