/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The side sheet's module (DS.sheet). The modal sheet's behaviour is the
 * core's (js/overlay.js: the stack, the trap, focus return, Escape,
 * dismiss, the exit, the snackbars that follow its panel); this holds the
 * sheet's own API, its declarative form, the docked panels and resizing.
 *
 *   <button data-ds-open="#details">Details</button>
 *   <dialog class="ds-sheet" id="details" aria-labelledby="t" data-ds-sheet>...</dialog>
 *
 *   DS.sheet.open(sheet, { opener });  DS.sheet.close(sheet);   // DS.overlay.open and close
 *   DS.sheet.create(sheet)             // get(), set(), on(), destroy()
 *   DS.sheet.resizable(panel, { remember: 'devices' })   // get() the width, set(px)
 *
 * Docked panels (3.0): a .ds-sheet__panel--push or --inspector inside a
 * .ds-sheet__layout, next to its .ds-sheet__main. DS.overlay opens them as
 * a non-modal layer (no trap, nothing inert, no scroll lock; Escape
 * closes the top layer; focus goes back to the opener when it was inside).
 * Push: the content beside it narrows while it opens, and focus moves in
 * once it opened (autofocus, else its first focusable control, else the
 * panel). Inspector: the panel next to a list shows the detail of the
 * chosen row; focus stays in the list, which stays usable, and another
 * row only swaps the panel's content. Both watch their body's scroll for
 * the head's hairline, as DS.overlay does for a modal sheet. DS.init()
 * installs this (one ds:open listener per root).
 *
 * Resizing: a .ds-sheet__resize (role="separator") in a panel of an
 * element with data-ds-sheet (the sheet, or the docked panel itself), or
 * resizable(panel). A pointer drags it (the width follows the pointer,
 * with data-resizing on the panel, which holds its transitions), the
 * arrow keys move it by --ds-space-4 (Shift: four times that), Home and
 * End go to the narrowest and the widest, a double click goes back to the
 * default. The width is the runtime property --ds-sheet-size on the panel,
 * between data-ds-sheet-min (280) and data-ds-sheet-max (what leaves the
 * page or the list 280px), and is remembered through DS.store (namespace
 * "sheet") under data-ds-sheet-remember (or `remember`). The separator
 * carries aria-valuenow, -min, -max and aria-controls; ds:resize
 * ({ width }) follows each change that ends (a release, a key).
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { own, watchScrolled } from './dom.js';
import { internals, open as openOverlay, close as closeOverlay } from './overlay.js';
import { tabbables } from './a11y.js';
import { settled } from './motion.js';
import { open as openStore } from './store.js';

const { controllerOf, activeIn } = internals;

/** The docked panels. */
const DOCKED = '.ds-sheet__panel--push, .ds-sheet__panel--inspector';

/** The narrowest a panel goes, and the least it leaves the page or list beside it (px). */
export const MIN_WIDTH = 280;

/**
 * Opens a side sheet or a docked panel: DS.overlay.open().
 * @param {Element} element
 * @param {{ opener?: Element|null, container?: boolean, returnTo?: () => Element|null|undefined }} [options]
 * @returns {Promise<void>}
 */
export function open(element, options = {}) {
  return openOverlay(element, options);
}

/**
 * Closes a side sheet or a docked panel: DS.overlay.close().
 * @param {Element} element
 * @param {{ reason?: string }} [options]
 * @returns {Promise<void>}
 */
export function close(element, options = {}) {
  return closeOverlay(element, options);
}

/** The panel of a sheet, a docked panel, or the panel around a separator. */
function panelOf(element) {
  if (typeof element?.matches !== 'function') return null;
  if (element.matches('.ds-sheet__panel')) return element;
  return element.querySelector('.ds-sheet__panel') ?? element.closest('.ds-sheet__panel');
}

/** A number of an attribute, or the fallback. */
function numberOf(element, name, fallback) {
  const value = Number.parseFloat(element.getAttribute(name) ?? '');
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The bounds of a panel's width: data-ds-sheet-min, data-ds-sheet-max (on
 * the panel or the element with data-ds-sheet), else what leaves the page
 * (a modal sheet) or the main column (a docked one) MIN_WIDTH.
 * @param {Element} panel
 * @param {Element} [owner]
 * @returns {{ min: number, max: number }}
 */
function boundsOf(panel, owner = panel) {
  const read = (name, fallback) => numberOf(panel, name, numberOf(owner, name, fallback));
  const min = Math.max(0, read('data-ds-sheet-min', MIN_WIDTH));
  const docked = panel.matches(DOCKED);
  const around = docked ? panel.closest('.ds-sheet__layout') : null;
  const room = around ? around.getBoundingClientRect().width : (panel.ownerDocument.defaultView?.innerWidth ?? 1280);
  const max = Math.max(min, read('data-ds-sheet-max', room - MIN_WIDTH));
  return { min, max };
}

/**
 * The width within bounds, whole pixels.
 * @param {number} width
 * @param {{ min: number, max: number }} bounds
 * @returns {number}
 */
export function clampWidth(width, bounds) {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

/**
 * The width a drag gives: `start` plus the pointer's travel `delta`
 * (px, positive to the right), towards the side the separator sits on
 * (`side`: 'left' widens as the pointer goes left), within bounds.
 * @param {number} start
 * @param {number} delta
 * @param {'left'|'right'} side
 * @param {{ min: number, max: number }} bounds
 * @returns {number}
 */
export function dragWidth(start, delta, side, bounds) {
  return clampWidth(start + (side === 'left' ? -delta : delta), bounds);
}

/** Every panel's resizing, one per panel. @type {WeakMap<Element, any>} */
const resizers = new WeakMap();

/**
 * Makes a panel resizable through its .ds-sheet__resize (see the header).
 * `remember` (else data-ds-sheet-remember) keeps the width in DS.store
 * (namespace "sheet"); `min` and `max` bound it. Returns the controller:
 * get() the width in px, or null at the default; set(px) (null: back to
 * the default); on('resize', fn); destroy(). Once per panel; a second
 * call returns the first controller.
 * @param {Element} element  the panel, or an element around it
 * @param {{ remember?: string, min?: number, max?: number }} [options]
 */
export function resizable(element, options = {}) {
  const panel = panelOf(element);
  if (!panel) return null;
  const known = resizers.get(panel);
  if (known) return known;
  const handle = panel.querySelector(':scope > .ds-sheet__resize');
  const owner = element;
  const abort = new AbortController();
  const signal = abort.signal;
  const key = options.remember ?? owner.getAttribute('data-ds-sheet-remember') ?? panel.getAttribute('data-ds-sheet-remember') ?? '';
  const store = key ? openStore('sheet') : null;
  const listeners = [];
  const bounds = () => {
    const found = boundsOf(panel, owner);
    return {
      min: options.min ?? found.min,
      max: Math.max(options.min ?? found.min, options.max ?? found.max),
    };
  };
  own(panel, 'props', '--ds-sheet-size');
  own(panel, 'attrs', 'data-resizing');
  /** @type {number|null} */
  let width = null;
  const current = () => width ?? Math.round(panel.getBoundingClientRect().width);
  const paint = () => {
    if (width == null) /** @type {HTMLElement} */ (panel).style.removeProperty('--ds-sheet-size');
    else /** @type {HTMLElement} */ (panel).style.setProperty('--ds-sheet-size', `${width}px`);
    if (!handle) return;
    const { min, max } = bounds();
    handle.setAttribute('aria-valuemin', String(Math.round(min)));
    handle.setAttribute('aria-valuemax', String(Math.round(max)));
    const now = current();
    if (now > 0) handle.setAttribute('aria-valuenow', String(Math.min(max, Math.max(min, now))));
  };
  const commit = () => {
    if (store) store.set(key, width ?? undefined);
    emit(panel, 'resize', { width: current() });
  };
  const apply = (/** @type {number|null} */ next, save = true) => {
    width = next == null ? null : clampWidth(next, bounds());
    paint();
    if (save) commit();
  };

  if (handle) {
    if (!handle.hasAttribute('role')) handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    if (!handle.hasAttribute('tabindex')) handle.setAttribute('tabindex', '0');
    if (!handle.hasAttribute('aria-label') && !handle.hasAttribute('aria-labelledby')) handle.setAttribute('aria-label', t('resizePanel'));
    if (panel.id) handle.setAttribute('aria-controls', panel.id);
    const sideOf = () => {
      const box = handle.getBoundingClientRect();
      const around = panel.getBoundingClientRect();
      return box.left + box.width / 2 < around.left + around.width / 2 ? 'left' : 'right';
    };
    handle.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      const start = current();
      const startX = event.clientX;
      const side = sideOf();
      const limits = bounds();
      handle.setPointerCapture?.(event.pointerId);
      panel.setAttribute('data-resizing', '');
      const move = (/** @type {PointerEvent} */ moved) => {
        if (moved.pointerId !== event.pointerId) return;
        width = dragWidth(start, moved.clientX - startX, side, limits);
        paint();
      };
      const end = (/** @type {PointerEvent} */ ended) => {
        if (ended.pointerId !== event.pointerId) return;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        panel.removeAttribute('data-resizing');
        if (width != null && width !== start) commit();
      };
      handle.addEventListener('pointermove', move, { signal });
      handle.addEventListener('pointerup', end, { signal });
      handle.addEventListener('pointercancel', end, { signal });
    }, { signal });
    handle.addEventListener('dblclick', () => apply(null), { signal });
    handle.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const limits = bounds();
      const view = panel.ownerDocument.defaultView;
      const unit = Number.parseFloat(view?.getComputedStyle(handle).getPropertyValue('--ds-space-4') ?? '') || 16;
      const step = event.shiftKey ? unit * 4 : unit;
      const side = sideOf();
      let next = null;
      if (event.key === 'ArrowLeft') next = current() + (side === 'left' ? step : -step);
      else if (event.key === 'ArrowRight') next = current() + (side === 'left' ? -step : step);
      else if (event.key === 'Home') next = limits.min;
      else if (event.key === 'End') next = limits.max;
      else return;
      event.preventDefault();
      apply(next);
    }, { signal });
  }

  const stored = store?.get(key, null);
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    width = Math.round(stored);
    paint();
  } else paint();
  // The bounds follow the room: a narrower window or layout keeps the width
  // inside them. An observer of the room (the docked panel's layout, else
  // the root element, as wide as the window), no listener on the window.
  const view = panel.ownerDocument.defaultView;
  const room = panel.matches(DOCKED) ? panel.closest('.ds-sheet__layout') : panel.ownerDocument.documentElement;
  const sizes = room && typeof view?.ResizeObserver === 'function' ? new view.ResizeObserver(() => {
    if (width != null) width = clampWidth(width, bounds());
    paint();
  }) : null;
  sizes?.observe(room);
  // Its values once the entrance settled: a docked panel opens its width from 0.
  owner.addEventListener('ds:open', (event) => {
    if (event.target === panel || event.target === owner) settled(panel, { transitions: true }).then(paint);
  }, { signal });

  const controller = {
    element: panel,
    get: () => width,
    set: (/** @type {number|null} */ value) => apply(value == null ? null : Number(value)),
    on(/** @type {string} */ type, /** @type {(event: Event) => void} */ fn) {
      const name = `ds:${type}`;
      panel.addEventListener(name, fn);
      const off = () => panel.removeEventListener(name, fn);
      listeners.push(off);
      return off;
    },
    destroy() {
      if (resizers.get(panel) !== controller) return;
      resizers.delete(panel);
      abort.abort();
      sizes?.disconnect();
      for (const off of listeners.splice(0)) off();
      store?.destroy();
    },
  };
  resizers.set(panel, controller);
  return controller;
}

/**
 * The controller of a side sheet or docked panel, the one [data-ds-sheet]
 * makes: get() whether it is open, set(true|false, options), on(), destroy().
 * A .ds-sheet__resize in its panel makes it resizable (resizable()).
 * @param {Element} element
 * @returns {ReturnType<typeof controllerOf>}
 */
export function create(element) {
  const base = controllerOf(element);
  const panel = panelOf(element);
  const sizer = panel?.querySelector(':scope > .ds-sheet__resize') ? resizable(element) : null;
  return {
    ...base,
    destroy() {
      base.destroy();
      sizer?.destroy();
    },
  };
}

/**
 * A docked panel that DS.overlay opened: its body's scroll is watched for
 * the head's hairline, and a push panel takes focus (an inspector leaves
 * it in the list).
 */
function dockedOpened(panel) {
  for (const body of panel.querySelectorAll(':scope > .ds-sheet__body')) {
    const handle = watchScrolled(body);
    if (!body.querySelector(':scope > [data-ds-sentinel]')) handle.update();
  }
  if (!panel.matches('.ds-sheet__panel--push')) return;
  const active = activeIn(panel);
  if (active && panel.contains(active)) return;
  const target = tabbables(panel).find((node) => !node.matches('.ds-sheet__resize'));
  if (target) target.focus({ preventScroll: true });
  else {
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    panel.focus({ preventScroll: true });
  }
}

define('sheet', {
  attribute: 'data-ds-sheet',
  init: (element) => create(element),
  global(root) {
    const onOpen = (/** @type {Event} */ event) => {
      const panel = /** @type {Element} */ (event.target);
      if (panel?.matches?.(DOCKED)) dockedOpened(panel);
    };
    root.addEventListener('ds:open', onOpen);
    return () => root.removeEventListener('ds:open', onOpen);
  },
});
