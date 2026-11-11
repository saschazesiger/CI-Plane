/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Back to top (DS.backtop): a button that shows once the reader has scrolled
 * a page or a box down, and takes them back to its top.
 *
 *   <button class="ds-btn ds-btn--elevated ds-btn--icon ds-backtop" type="button" data-ds-backtop hidden>(arrowUp)</button>
 *   const top = DS.backtop.create(button, { after: 600 });
 *   top.get();  top.set(true);  top.go();  top.on('change', ({ shown }) => ...);
 *
 * The scroller: data-ds-backtop-target (a selector), else the nearest
 * scrolling ancestor of the button, else the page. The button shows once the
 * scroller is scrolled down by more than data-ds-backtop-after px (default:
 * one height of the scroller) and hides again above half of that, so a
 * reader who stops at the line does not make it flicker. It enters and
 * leaves with DS.motion.enter / leave ('scale'); `hidden` is owned state.
 *
 * A click scrolls the scroller to its top (smoothly within three of its
 * heights, at once beyond that) and moves the focus to the top: the element
 * data-ds-backtop-focus names, else the box's first heading (the page's
 * first h1), else the scroller itself (a tabindex="-1", owned, when it takes no focus of its
 * own); the focus never scrolls. A button without text of its own is named
 * by the string backToTop (aria-label, owned).
 *
 * One passive scroll listener on the scroller (rAF-throttled); it goes with
 * the controller. Events: ds:change ({ shown }) on the button.
 *
 * ES2022. Progressive: none.
 */
import { define, emit, t } from './core.js';
import { enter, leave } from './motion.js';
import { own, disown } from './dom.js';

/** How many heights of the scroller the way back glides through before it jumps. */
const GLIDE_SCREENS = 3;

/**
 * Whether the button shows at a scroll position: past `after` px it shows,
 * under half of it it hides, in between it keeps what it was (`shown`).
 * @param {number} top  the scroller's scrollTop
 * @param {{ after: number, shown?: boolean }} options
 * @returns {boolean}
 */
export function shown(top, options) {
  const { after, shown: was = false } = options;
  if (top > after) return true;
  if (top < after / 2) return false;
  return was;
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

/**
 * The controller of one button.
 * @param {HTMLElement} button
 * @param {{ after?: number|null, target?: Element|string|null, focus?: Element|string|null }} options
 * @param {AbortSignal} [signal]
 */
function controller(button, options, signal) {
  const doc = button.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const abort = new AbortController();
  signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const listeners = new Set();
  const owned = [];
  const take = (element, name) => {
    own(element, 'attrs', name);
    owned.push([element, name]);
  };
  const find = (value) => (typeof value === 'string' ? doc.querySelector(value) : value ?? null);

  const named = options.target ? find(options.target) : null;
  const scroller = named && named !== doc.documentElement && named !== doc.body ? named : (named ? null : scrollerOf(button, view));
  const box = () => scroller ?? doc.scrollingElement ?? doc.documentElement;
  const height = () => (scroller ? scroller.clientHeight : view.innerHeight || doc.documentElement.clientHeight);
  const threshold = () => (typeof options.after === 'number' ? options.after : height());

  take(button, 'hidden');
  if (!button.textContent.trim() && !button.hasAttribute('aria-label') && !button.hasAttribute('aria-labelledby')) {
    take(button, 'aria-label');
    button.setAttribute('aria-label', t('backToTop'));
  }

  let visible = !button.hidden;
  const show = (on) => {
    if (on === visible) return;
    visible = on;
    if (on) enter(button, 'scale');
    else leave(button, 'scale', { then: 'hide' });
    const detail = { shown: on };
    emit(button, 'change', detail);
    for (const fn of listeners) fn(detail);
  };

  let frame = 0;
  const update = () => {
    frame = 0;
    show(shown(box().scrollTop, { after: threshold(), shown: visible }));
  };
  const later = () => {
    if (frame) return;
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(update) : 0;
    if (!frame) update();
  };
  (scroller ?? view).addEventListener('scroll', later, { passive: true, signal: abort.signal });

  /** Back to the top: scrolls there and moves the focus to it. */
  const go = () => {
    const distance = box().scrollTop;
    const behavior = distance <= height() * GLIDE_SCREENS ? 'smooth' : 'instant';
    (scroller ?? view).scrollTo({ top: 0, behavior });
    const target = find(options.focus) ?? (scroller ? scroller.querySelector('h1, h2, h3, h4, h5, h6') ?? scroller : doc.querySelector('h1') ?? doc.querySelector('main') ?? doc.body);
    if (!target) return;
    if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) {
      take(target, 'tabindex');
      target.setAttribute('tabindex', '-1');
    }
    target.focus({ preventScroll: true });
  };

  button.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    go();
  }, { signal: abort.signal });

  // The markup's state first: a hidden button shows when the scroll says so.
  if (button.hidden) visible = false;
  update();

  let gone = false;
  return {
    /** Whether the button shows. */
    get() {
      return visible;
    },
    /** Shows (true) or hides (false) the button until the next scroll decides again. */
    set(value) {
      show(Boolean(value));
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    go,
    destroy() {
      if (gone) return;
      gone = true;
      abort.abort();
      listeners.clear();
      if (frame) view.cancelAnimationFrame?.(frame);
      for (const [element, name] of owned) disown(element, 'attrs', name);
      owned.length = 0;
    },
  };
}

/** The options of the attribute path. */
function optionsOf(el) {
  const after = Number.parseFloat(el.getAttribute('data-ds-backtop-after') ?? '');
  return {
    after: Number.isFinite(after) ? after : null,
    target: el.getAttribute('data-ds-backtop-target') || null,
    focus: el.getAttribute('data-ds-backtop-focus') || null,
  };
}

define('backtop', {
  attribute: 'data-ds-backtop',
  attributes: ['data-ds-backtop-after', 'data-ds-backtop-target', 'data-ds-backtop-focus'],
  init(el, ctx) {
    return controller(/** @type {HTMLElement} */ (el), optionsOf(el), ctx.signal);
  },
});

/**
 * A back-to-top button driven from the page; the same controller the
 * attribute path makes.
 * @param {HTMLElement} el  the .ds-backtop button
 * @param {{ after?: number|null, target?: Element|string|null, focus?: Element|string|null }} [options]
 */
export function create(el, options = {}) {
  return controller(el, { after: options.after ?? null, target: options.target ?? null, focus: options.focus ?? null });
}
