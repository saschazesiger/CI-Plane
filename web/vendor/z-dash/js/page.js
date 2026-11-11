/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Page head (DS.page): a sticky head that condenses once the reader has
 * scrolled, and actions that fold into a More menu by width.
 *
 *   <header class="ds-page-head ds-page-head--sticky" data-ds-page-head> ... </header>
 *   const head = DS.page.create(header, { condense: true });
 *   head.get();  head.set(true);  head.refresh();  head.on('change', ({ condensed }) => ...);
 *
 * Condensing (a .ds-page-head--sticky head; data-ds-page-head-condense="off"
 * keeps it whole): the scroller is the nearest scrolling ancestor of the
 * head, else the page. Once the head sticks and the reader has scrolled
 * past what folds (the back link or breadcrumbs, the lead, the status, the
 * key facts; measured with the head's place in the scroller), the head
 * takes data-scrolled and the stylesheet folds those parts away; scrolled
 * back above that it gives it up. The head keeps its room in the flow (a
 * bottom margin as tall as what folded, --ds-page-head-fold, a runtime
 * property), so the content under it never moves, a running smooth scroll
 * goes on, and the state follows the scroll position alone (no flicker).
 * One passive scroll listener on the scroller, throttled to a frame.
 *
 * Folding actions (any head with .ds-page-head__actions): the module writes
 * a More button (.ds-page-head__more, a quiet icon button named by the
 * string moreActions) and its .ds-menu after the actions. The actions that
 * do not fit the title row (half of it in a condensed head, beside the
 * title) hide (owned `hidden`), first to last with the filled ones last, and the menu lists them: its items press the action
 * (a click on the hidden button, or the link's address), with its icon,
 * label and blocked state. An action that opens an overlay passes the More
 * button as its opener while it is folded (page.md). A ResizeObserver on the row and a
 * MutationObserver on the actions lay them out again.
 *
 * Owned state (DS.dom.morphHtml keeps it): data-scrolled and the style (the
 * fold) on the head, hidden on the folded actions. The More button and its menu are the system's own
 * (data-ds-keep). Events: ds:change ({ condensed }) on the head.
 *
 * ES2022. Progressive: overflow-anchor (none while the fold is measured, so
 * no anchoring moves the scroll; without it the scroll is put back, which
 * stops a smooth scroll on its way). ResizeObserver and MutationObserver are
 * at the floor; without them, in a test fake, the actions lay out once.
 */
import { define, emit, t } from './core.js';
import { own, disown } from './dom.js';
import { iconElement, moreVertical } from './icons.js';
import { open as openMenu, close as closeMenu } from './menu.js';

/** The numbering of the ids this module writes (More menus). */
let serial = 0;

/** px of scroll that count as the top: the head unfolds at or above it. */
const TOP = 1;

/**
 * Which actions fold, in a row of `room` px: none when all of them fit;
 * otherwise they fold in `order` (indices, the first folds first) until the
 * ones left and the More button (`more` px) fit. `gap` is the room between
 * two. Returns the folded indices, sorted.
 * @param {number[]} widths
 * @param {{ room: number, gap?: number, more?: number, order?: number[] }} options
 * @returns {number[]}
 */
export function fold(widths, options) {
  const { room, gap = 0, more = 0, order = widths.map((_, index) => index) } = options;
  const need = (kept, withMore) => {
    const parts = kept.map((index) => widths[index]);
    if (withMore) parts.push(more);
    return parts.length ? parts.reduce((sum, width) => sum + width, 0) + gap * (parts.length - 1) : 0;
  };
  const all = widths.map((_, index) => index);
  if (need(all, false) <= room) return [];
  const folded = new Set();
  for (const index of order) {
    folded.add(index);
    if (need(all.filter((each) => !folded.has(each)), true) <= room) break;
  }
  return [...folded].sort((a, b) => a - b);
}

/** Whether an element scrolls on the block axis. */
function scrolls(element, view) {
  const style = view.getComputedStyle(element);
  return /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
}

/** The nearest scrolling ancestor of `element`, or null for the page. */
function scrollerOf(element, view) {
  const doc = element.ownerDocument;
  for (let node = element.parentElement; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    if (scrolls(node, view)) return node;
  }
  return null;
}

/** The text an action is known by: its label, else its aria-label or title. */
function labelOf(action) {
  const copy = action.cloneNode(true);
  for (const part of copy.querySelectorAll('svg, .ds-sr, .ds-badge')) part.remove();
  return copy.textContent.trim() || action.getAttribute('aria-label') || action.getAttribute('data-tip') || action.getAttribute('title') || '';
}

/**
 * The controller of one head.
 * @param {HTMLElement} head
 * @param {{ condense?: boolean }} options
 * @param {AbortSignal} [signal]
 */
function controller(head, options, signal) {
  const doc = head.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const abort = new AbortController();
  const listen = { signal: abort.signal };
  signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const listeners = new Set();
  const owned = [];
  const take = (element, name) => {
    if (owned.some(([each, which]) => each === element && which === name)) return;
    own(element, 'attrs', name);
    owned.push([element, name]);
  };

  /* ── Condensing ─────────────────────────────── */

  const sticky = options.condense !== false && head.classList.contains('ds-page-head--sticky');
  const scroller = sticky ? scrollerOf(head, view) : null;
  const box = () => scroller ?? doc.scrollingElement ?? doc.documentElement;
  let condensed = head.hasAttribute('data-scrolled');
  /** How much the head lost the last time it condensed: no trial before the reader has scrolled that far. */
  let foldHeight = 0;
  /**
   * Where the head starts to stick, in the scroller's content: its place in
   * the flow less its sticky top. A head below a banner or a toolbar
   * condenses only once it sticks and the reader has scrolled past what folds.
   */
  let offset = 0;
  if (sticky) {
    take(head, 'data-scrolled');
    take(head, 'style');
  }

  /**
   * Runs `fn` with scroll anchoring off on the scroller: measuring the
   * condensed head changes its height for a moment, and the browser would
   * move the scroll to keep the content in place, and not move it back.
   */
  const quiet = (fn) => {
    const target = scroller ?? doc.documentElement;
    const before = target.style.overflowAnchor;
    target.style.overflowAnchor = 'none';
    try {
      fn();
    } finally {
      target.style.overflowAnchor = before;
    }
  };

  const apply = (on, fold = 0) => {
    if (on) {
      head.setAttribute('data-scrolled', '');
      head.style.setProperty('--ds-page-head-fold', `${fold}px`);
    } else {
      head.removeAttribute('data-scrolled');
      head.style.removeProperty('--ds-page-head-fold');
    }
  };

  /**
   * Measures what folds: the head condensed for a moment, then whole again,
   * before anything paints. A browser that anchors the scroll may move it
   * meanwhile; it goes back to where the reader had it.
   */
  const measureFold = () => {
    if (!sticky || condensed) return;
    const start = box().scrollTop;
    // The trial is styled (the reads flush it): without transitions
    // (data-ds-moving, motion.css), or the hairline and the folding parts
    // would start toward the condensed look and back on every measure.
    const settling = !head.hasAttribute('data-ds-moving');
    if (settling) head.setAttribute('data-ds-moving', '');
    // No scroll anchoring through the trial: it would move the scroll, and the
    // write that puts it back cancels a smooth scroll on its way.
    const scrolling = box();
    const anchor = scrolling.style.overflowAnchor;
    scrolling.style.overflowAnchor = 'none';
    quiet(() => {
      // The head's place in the flow: unstuck for a moment (static ignores its top).
      const before = head.style.position;
      head.style.position = 'static';
      const place = head.getBoundingClientRect().top;
      head.style.position = before;
      const stick = parseFloat(view.getComputedStyle(head).top) || 0;
      const origin = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
      offset = Math.max(0, Math.round(place - origin + start - stick));
      const tall = head.getBoundingClientRect().height;
      apply(true);
      foldHeight = Math.max(0, tall - head.getBoundingClientRect().height);
      apply(false);
    });
    if (settling) {
      void view.getComputedStyle(head).opacity;
      head.removeAttribute('data-ds-moving');
    }
    scrolling.style.overflowAnchor = anchor;
    // Engines without overflow-anchor (or a scroll that moved anyway) go back to where the reader had it.
    // A whole pixel or more: Firefox reports fractional positions mid-glide, and a write stops a smooth scroll.
    if (Math.abs(box().scrollTop - start) >= 1) box().scrollTop = start;
  };

  /**
   * Condenses (true) or unfolds (false) the head; returns whether the state
   * changed. The head keeps its room in the flow (a bottom margin as tall as
   * what folded, --ds-page-head-fold), so nothing under it moves and a
   * running scroll goes on undisturbed. It condenses only once the reader
   * has scrolled past what folds: the content then already lies under the
   * condensed head.
   */
  const condense = (on, force = false) => {
    if (on === condensed) return false;
    if (on) {
      if (!force && box().scrollTop <= offset + foldHeight + TOP) return false;
      quiet(() => {
        const tall = head.getBoundingClientRect().height;
        apply(true, foldHeight);
        // The fold as it is now (a width change may have moved it): the margin follows at once.
        const fold = Math.max(0, tall - head.getBoundingClientRect().height);
        // Exact, not rounded: a margin a fraction off the fold moves the content, and Firefox's scroll anchoring
        // then moves the scroll (a smooth scroll ended a pixel short).
        if (Math.abs(fold - foldHeight) > 0.01) {
          foldHeight = fold;
          apply(true, fold);
        }
      });
    } else quiet(() => apply(false));
    condensed = on;
    layout();
    const detail = { condensed: on };
    emit(head, 'change', detail);
    for (const fn of listeners) fn(detail);
    return true;
  };

  let frame = 0;
  const update = () => {
    frame = 0;
    if (!sticky) return;
    const top = box().scrollTop;
    if (!condensed && top > offset + foldHeight + TOP) condense(true);
    else if (condensed && top <= offset + foldHeight) condense(false);
  };
  const later = () => {
    if (frame) return;
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(update) : 0;
    if (!frame) update();
  };
  if (sticky) (scroller ?? view).addEventListener('scroll', later, { passive: true, signal: abort.signal });
  // What folds changes with the head's width and content: measured again while the head is whole.
  let folds = 0;
  const heads = sticky && typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => {
    if (condensed || folds) return;
    folds = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(() => { folds = 0; measureFold(); update(); }) : 0;
  }) : null;
  heads?.observe(head);
  measureFold();

  /* ── Folding actions ────────────────────────── */

  const actions = head.querySelector('.ds-page-head__actions');
  const row = actions?.closest('.ds-page-head__row') ?? actions?.parentElement ?? null;
  const folded = new Set();
  const itemsOf = new WeakMap();
  let more = null;
  let menu = null;

  const actionList = () => (actions ? [...actions.children].filter((child) => child !== more && child !== menu && !child.classList.contains('ds-menu')) : []);

  if (actions) {
    serial += 1;
    const menuId = `ds-page-more-${serial}`;
    more = doc.createElement('button');
    more.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-page-head__more';
    more.type = 'button';
    more.hidden = true;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-controls', menuId);
    more.setAttribute('aria-label', t('moreActions'));
    more.setAttribute('data-tip', t('moreActions'));
    more.dataset.dsKeep = '';
    more.append(iconElement(moreVertical, 20, '', doc));
    menu = doc.createElement('div');
    menu.className = 'ds-menu';
    menu.id = menuId;
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('moreActions'));
    menu.dataset.dsKeep = '';
    actions.append(more, menu);
    more.addEventListener('click', (event) => {
      if (event.detail > 1) return;
      if (more.getAttribute('aria-expanded') === 'true') closeMenu(menu);
      else openMenu(menu, { opener: more });
    }, listen);
    more.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openMenu(menu, { opener: more });
    }, listen);
    menu.addEventListener('click', (event) => {
      const item = /** @type {Element} */ (event.target)?.closest?.('.ds-menu__item');
      const action = item ? itemsOf.get(item) : null;
      if (!action || item.getAttribute('aria-disabled') === 'true') return;
      if (item.tagName === 'A') {
        // A link item navigates by itself; the menu only closes.
        closeMenu(menu);
        return;
      }
      closeMenu(menu);
      action.click();
    }, listen);
  }

  /** The menu's items: one per folded action, its icon and label. */
  const fillMenu = (list) => {
    if (!menu) return;
    const items = list.map((action) => {
      const link = action.tagName === 'A' && action.hasAttribute('href');
      const item = doc.createElement(link ? 'a' : 'button');
      item.className = 'ds-menu__item';
      item.setAttribute('role', 'menuitem');
      if (link) {
        item.setAttribute('href', action.getAttribute('href'));
        for (const name of ['target', 'rel', 'download']) if (action.hasAttribute(name)) item.setAttribute(name, action.getAttribute(name));
      } else item.type = 'button';
      if (action.matches(':disabled') || action.getAttribute('aria-disabled') === 'true' || action.getAttribute('aria-busy') === 'true') item.setAttribute('aria-disabled', 'true');
      const glyph = action.querySelector(':scope > svg');
      if (glyph) item.append(glyph.cloneNode(true));
      const label = doc.createElement('span');
      label.className = 'ds-menu__label';
      label.textContent = labelOf(action);
      item.append(label);
      itemsOf.set(item, action);
      return item;
    });
    menu.replaceChildren(...items);
  };

  /** Lays the actions out: the ones that fit stay, the others go into the menu. */
  function layout() {
    if (!more || !actions.isConnected || !row) return;
    for (const action of folded) action.hidden = false;
    folded.clear();
    more.hidden = true;
    const all = actionList().filter((action) => !action.hidden);
    const style = view.getComputedStyle(actions);
    const gap = parseFloat(style.columnGap) || 0;
    const widths = all.map((action) => action.getBoundingClientRect().width);
    more.hidden = false;
    const moreWidth = more.getBoundingClientRect().width;
    more.hidden = true;
    // The first ones fold first; a filled action, the page's main one, last.
    const order = all.map((_, index) => index).sort((a, b) => Number(all[a].classList.contains('ds-btn--filled')) - Number(all[b].classList.contains('ds-btn--filled')) || a - b);
    // Condensed, the actions share one line with the title: they keep half of it at most.
    const out = fold(widths, { room: condensed ? row.clientWidth / 2 : row.clientWidth, gap, more: moreWidth, order });
    if (!out.length) {
      fillMenu([]);
      if (more.getAttribute('aria-expanded') === 'true') closeMenu(menu);
      return;
    }
    const list = [];
    for (const index of out) {
      const action = all[index];
      take(action, 'hidden');
      action.hidden = true;
      folded.add(action);
      list.push(action);
    }
    more.hidden = false;
    fillMenu(list);
  }

  let layoutFrame = 0;
  const relayout = () => {
    if (layoutFrame) return;
    layoutFrame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(() => { layoutFrame = 0; layout(); }) : 0;
    if (!layoutFrame) layout();
  };
  const resize = more && typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => layout()) : null;
  resize?.observe(row);
  // The system's own hidden helpers (data-ds-keep and aria-hidden: the
  // fixed-origin probe DS.position puts beside the menu where anchor
  // positioning is missing) are no change of the actions: a layout then
  // would hide the focused More button for a moment and drop the focus to
  // <body>.
  const helper = (node) => node === menu || node === more || (node.nodeType === 1 && /** @type {Element} */ (node).hasAttribute('data-ds-keep') && /** @type {Element} */ (node).getAttribute('aria-hidden') === 'true');
  const helpersOnly = (record) => record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(helper);
  const changes = more && typeof view.MutationObserver === 'function' ? new view.MutationObserver((records) => {
    if (records.every((record) => record.target === menu || menu.contains(record.target) || record.target === more || helpersOnly(record))) return;
    relayout();
  }) : null;
  changes?.observe(actions, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'aria-label'] });
  layout();
  doc.fonts?.ready?.then(() => { if (!abort.signal.aborted) layout(); });
  update();

  let gone = false;
  return {
    /** Whether the head is condensed. */
    get() {
      return condensed;
    },
    /** Condenses (true) or unfolds (false) a sticky head, until the next scroll decides again. */
    set(value) {
      if (sticky) condense(Boolean(value), true);
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Lays the actions out again and measures the head (after a change the observers cannot see, such as a font or content above it). */
    refresh() {
      layout();
      measureFold();
      update();
    },
    destroy() {
      if (gone) return;
      gone = true;
      abort.abort();
      listeners.clear();
      resize?.disconnect();
      changes?.disconnect();
      heads?.disconnect();
      if (folds) view.cancelAnimationFrame?.(folds);
      if (frame) view.cancelAnimationFrame?.(frame);
      if (layoutFrame) view.cancelAnimationFrame?.(layoutFrame);
      for (const action of folded) action.hidden = false;
      folded.clear();
      if (menu && more?.getAttribute('aria-expanded') === 'true') closeMenu(menu);
      more?.remove();
      menu?.remove();
      for (const [element, name] of owned) disown(element, 'attrs', name);
      owned.length = 0;
    },
  };
}

define('page', {
  attribute: 'data-ds-page-head',
  attributes: ['data-ds-page-head-condense'],
  init(el, ctx) {
    return controller(/** @type {HTMLElement} */ (el), { condense: el.getAttribute('data-ds-page-head-condense') !== 'off' }, ctx.signal);
  },
});

/**
 * A page head driven from the page; the same controller the attribute path
 * makes.
 * @param {HTMLElement} el  the .ds-page-head
 * @param {{ condense?: boolean }} [options]
 */
export function create(el, options = {}) {
  return controller(el, { condense: options.condense !== false });
}
