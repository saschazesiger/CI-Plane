/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The bottom sheet (DS.bottomsheet): a modal sheet at the bottom edge with
 * a drag handle, detents and drag to dismiss. DS.overlay opens and closes it
 * (the trap, the inert page, the scroll lock, Escape, focus return, the
 * exit); this module holds its heights and its drag.
 *
 *   <dialog class="ds-sheet ds-bottomsheet" data-ds-bottomsheet data-ds-bottomsheet-detents="0.5 1"> ... </dialog>
 *
 *   DS.bottomsheet.open(sheet, { opener, detent: 1 });   // DS.overlay.open, at a detent (default the smallest)
 *   DS.bottomsheet.close(sheet);
 *   DS.bottomsheet.create(sheet)    // get(), set(), on(), destroy()
 *
 * Detents: data-ds-bottomsheet-detents, fractions (0 to 1) of the panel's
 * full height, smallest first after parsing; the panel rests at one of
 * them: --ds-bottomsheet-offset (a runtime property on the panel) moves it
 * down by the rest, and --ds-bottomsheet-rest (that offset, written only
 * at rest, so a drag does not lay it out on every move) pads its end, so
 * the foot and the end of the body stay in the window. data-detents on
 * the sheet says it has them. Without the attribute it rests fully up, as
 * tall as its content.
 *
 * Drag: a pointer on the handle or the head (not on a control in it) drags
 * the panel; it follows the finger (data-dragging holds its transition),
 * never above its full height. On release the throw (the speed of the
 * last moves, projected over --ds-dur-medium) picks the nearest detent; one
 * thrown below half of the smallest detent closes the sheet (reason
 * "drag"). A press without a move is a click: the handle goes to the next
 * detent.
 *
 * The handle (a button): Enter and Space the next detent (from the largest
 * back to the smallest), ArrowUp the larger one, ArrowDown the smaller.
 * Each stop says "Sheet at 50 percent of the screen" politely and sends
 * ds:detent ({ detent, index }).
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { motionDuration } from './motion.js';
import { own } from './dom.js';
import { internals, open as openOverlay, close as closeOverlay } from './overlay.js';
import { announce } from './a11y.js';

const { overlays } = internals;

/**
 * The detents of an attribute value: the fractions in (0, 1], sorted, once
 * each; none gives [1].
 * @param {string|null|undefined} value
 * @returns {number[]}
 */
export function parseDetents(value) {
  const list = String(value ?? '').split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 1);
  const unique = [...new Set(list.map((n) => Math.round(n * 1000) / 1000))].sort((a, b) => a - b);
  return unique.length ? unique : [1];
}

/**
 * Where a release ends: the detent nearest to the position the throw
 * reaches (`shown`, the share of the panel showing, plus `velocity` in
 * shares per ms over `projection` ms), or -1 to close when that is below
 * half of the smallest detent.
 * @param {number[]} detents
 * @param {number} shown
 * @param {number} velocity  positive upwards
 * @param {number} projection
 * @returns {number} the index of the detent, or -1
 */
export function settleDetent(detents, shown, velocity, projection) {
  const reach = shown + velocity * projection;
  if (reach < detents[0] / 2) return -1;
  let best = 0;
  for (let i = 1; i < detents.length; i += 1) {
    if (Math.abs(detents[i] - reach) < Math.abs(detents[best] - reach)) best = i;
  }
  return best;
}

const isOpen = (element) => overlays.get(element)?.phase === 'open';

/** The controller of each sheet. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

/**
 * The controller of a bottom sheet, the one [data-ds-bottomsheet] makes;
 * once per sheet. get() returns { open, detent, index }; set(true|false)
 * opens or closes it, set(detent) (a fraction of the list) or
 * set({ index }) moves it to a detent; on(type, fn) hears ds:detent,
 * ds:open and ds:close; destroy().
 * @param {Element} element
 */
export function create(element) {
  const known = controllers.get(element);
  if (known) return known;
  const panel = /** @type {HTMLElement|null} */ (element.querySelector('.ds-bottomsheet__panel, .ds-sheet__panel'));
  const handle = /** @type {HTMLElement|null} */ (element.querySelector('.ds-bottomsheet__handle'));
  const abort = new AbortController();
  const signal = abort.signal;
  const listeners = [];
  const state = { index: 0, detents: [1], drag: /** @type {any} */ (null), wanted: /** @type {number|null} */ (null) };
  own(panel, 'props', '--ds-bottomsheet-offset');
  own(panel, 'props', '--ds-bottomsheet-rest');
  own(panel, 'attrs', 'data-dragging');
  own(element, 'attrs', 'data-detents');

  const read = () => {
    const value = element.getAttribute('data-ds-bottomsheet-detents');
    state.detents = parseDetents(value);
    if (value) element.setAttribute('data-detents', '');
    else element.removeAttribute('data-detents');
    state.index = Math.min(state.index, state.detents.length - 1);
  };
  read();
  if (handle && !handle.hasAttribute('aria-label') && !handle.hasAttribute('aria-labelledby')) handle.setAttribute('aria-label', t('resizeSheet'));

  const fullHeight = () => panel?.getBoundingClientRect().height ?? 0;
  const offsetFor = (detent) => Math.round((1 - detent) * fullHeight());
  const paint = (offset) => panel?.style.setProperty('--ds-bottomsheet-offset', `${Math.max(0, Math.round(offset))}px`);

  /** Moves to detent `index`; `say` announces it. */
  const rest = (index, say = true) => {
    state.index = Math.min(state.detents.length - 1, Math.max(0, index));
    const offset = offsetFor(state.detents[state.index]);
    paint(offset);
    // The part below the window is padding, so the foot and the body's end stay in view.
    panel?.style.setProperty('--ds-bottomsheet-rest', `${Math.max(0, Math.round(offset))}px`);
    if (!say) return;
    announce(t('sheetDetent', { percent: Math.round(state.detents[state.index] * 100) }));
    emit(element, 'detent', { detent: state.detents[state.index], index: state.index });
  };

  element.addEventListener('ds:open', (event) => {
    if (event.target !== element) return;
    read();
    rest(state.wanted ?? 0, false);
    state.wanted = null;
  }, { signal });

  // The handle's keys and its click.
  handle?.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    if (state.drag?.moved || state.detents.length < 2) return;
    event.preventDefault();
    rest((state.index + 1) % state.detents.length);
  }, { signal });
  handle?.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowUp' && state.index < state.detents.length - 1) rest(state.index + 1);
    else if (event.key === 'ArrowDown' && state.index > 0) rest(state.index - 1);
    else if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
  }, { signal });

  // The drag, from the handle or the head.
  const draggable = (target) => {
    if (!panel || !target?.closest) return false;
    if (handle?.contains(target)) return true;
    const head = target.closest('.ds-sheet__head');
    if (!head || head.parentElement !== panel) return false;
    return !target.closest('button, a, input, select, textarea, [tabindex]');
  };
  panel?.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
    if (!event.isPrimary || event.button !== 0 || !isOpen(element) || !draggable(/** @type {Element} */ (event.target))) return;
    const height = fullHeight();
    const start = Number.parseFloat(panel.style.getPropertyValue('--ds-bottomsheet-offset')) || 0;
    state.drag = { id: event.pointerId, y: event.clientY, start, height, moved: false, samples: [[event.timeStamp, event.clientY]] };
    try {
      panel.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer the engine no longer tracks: the drag runs without capture.
    }
  }, { signal });
  panel?.addEventListener('pointermove', (/** @type {PointerEvent} */ event) => {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.id) return;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      panel.setAttribute('data-dragging', '');
    }
    drag.samples.push([event.timeStamp, event.clientY]);
    if (drag.samples.length > 6) drag.samples.shift();
    // The finger leads: never above the full height.
    paint(Math.max(0, drag.start + dy));
  }, { signal });
  const end = (/** @type {PointerEvent} */ event) => {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.id) return;
    panel.removeAttribute('data-dragging');
    if (!drag.moved) {
      state.drag = null;
      return;
    }
    const offset = Math.max(0, drag.start + event.clientY - drag.y);
    const [t0, y0] = drag.samples[0];
    const [t1, y1] = drag.samples.at(-1);
    const velocity = t1 > t0 ? -(y1 - y0) / (t1 - t0) / drag.height : 0;
    const shown = drag.height ? 1 - offset / drag.height : 1;
    const index = settleDetent(state.detents, shown, velocity, motionDuration(panel, '--ds-dur-medium'));
    // Keep the moved flag until the click that follows the release has passed.
    setTimeout(() => {
      if (state.drag === drag) state.drag = null;
    });
    if (index < 0) closeOverlay(element, { reason: 'drag' });
    else rest(index, index !== state.index);
  };
  panel?.addEventListener('pointerup', end, { signal });
  panel?.addEventListener('pointercancel', end, { signal });

  // The window's height changes the panel's full height: the detent's offset
  // follows. An observer of the panel's border box (the rest's padding
  // changes only its content box), no listener on the window.
  const Observer = element.ownerDocument.defaultView?.ResizeObserver;
  const sizes = panel && typeof Observer === 'function' ? new Observer(() => {
    if (isOpen(element) && !state.drag) rest(state.index, false);
  }) : null;
  sizes?.observe(panel, { box: 'border-box' });

  const controller = {
    element,
    get: () => ({ open: isOpen(element), detent: state.detents[state.index], index: state.index }),
    set(/** @type {boolean|number|{ index?: number }} */ value) {
      if (typeof value === 'boolean') return value ? open(element) : closeOverlay(element);
      if (typeof value === 'number') {
        const index = state.detents.findIndex((detent) => Math.abs(detent - value) < 0.001);
        if (index >= 0) rest(index);
      } else if (typeof value?.index === 'number') rest(value.index);
      return Promise.resolve();
    },
    on(/** @type {string} */ type, /** @type {(event: Event) => void} */ fn) {
      const name = `ds:${type}`;
      element.addEventListener(name, fn);
      const off = () => element.removeEventListener(name, fn);
      listeners.push(off);
      return off;
    },
    destroy() {
      if (controllers.get(element) !== controller) return;
      controllers.delete(element);
      abort.abort();
      sizes?.disconnect();
      for (const off of listeners.splice(0)) off();
    },
    /** The detent to open at (open() sets it). */
    want(/** @type {number|null} */ index) {
      state.wanted = index;
    },
  };
  controllers.set(element, controller);
  return controller;
}

/**
 * Opens a bottom sheet at `detent` (a fraction of its list; default the
 * smallest): DS.overlay.open().
 * @param {Element} element
 * @param {{ opener?: Element|null, detent?: number, returnTo?: () => Element|null|undefined }} [options]
 * @returns {Promise<void>}
 */
export function open(element, options = {}) {
  const controller = create(element);
  if (typeof options.detent === 'number') {
    const detents = parseDetents(element.getAttribute('data-ds-bottomsheet-detents'));
    const index = detents.findIndex((detent) => Math.abs(detent - /** @type {number} */ (options.detent)) < 0.001);
    controller.want(index >= 0 ? index : null);
  }
  return openOverlay(element, { opener: options.opener, returnTo: options.returnTo });
}

/**
 * Closes a bottom sheet: DS.overlay.close().
 * @param {Element} element
 * @param {{ reason?: string }} [options]
 * @returns {Promise<void>}
 */
export function close(element, options = {}) {
  return closeOverlay(element, options);
}

define('bottomsheet', {
  attribute: 'data-ds-bottomsheet',
  attributes: ['data-ds-bottomsheet-detents'],
  init: (element) => create(element),
});
