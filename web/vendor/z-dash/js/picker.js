/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The picker popover (DS.picker): the floating panel that the date, time,
 * range and time range pickers open from their button, and that a page may
 * use for a panel of its own. DS.overlay opens and closes it (the stack,
 * Escape, focus return, the entrance from the button); this module places
 * it, keeps Tab inside it, closes it on a press outside, and follows the
 * button through scrolling and resizing.
 *
 *   <div class="ds-picker" data-ds-picker>
 *     <button class="ds-btn" type="button" data-ds-picker-toggle>Filters</button>
 *     <div class="ds-picker__popover" role="dialog" aria-label="Filters" hidden>...</div>
 *   </div>
 *
 *   const picker = DS.picker.create(root, { toggle, panel, focus: () => first });
 *   picker.open(); picker.close(); picker.get();   // true while open
 *
 * DS.overlay sends ds:open and ds:close (with its reason) on the panel; they
 * bubble through the root.
 *
 * The panel is a dialog (role="dialog", aria-modal="true": the WAI-ARIA
 * date picker dialog): opening moves focus into it (options.focus(), else
 * [autofocus], else its first tabbable element), Tab and Shift+Tab cycle
 * inside it, Escape closes it and focus goes back to the button (DS.overlay),
 * a press outside closes it and leaves focus where the press put it. The
 * button gets aria-haspopup="dialog", aria-controls and aria-expanded.
 * Alt+ArrowDown on the root (a field around the button) opens it too.
 *
 * Placement: in the top layer (popover="manual", where the engine has
 * popovers), fixed, below the root (the field around the button) and
 * aligned with its start edge (towards its end edge when there is no room),
 * above it when it does not fit below and there is more room there
 * (data-placement="top"), never taller than the room on its side (it
 * scrolls inside), 8px from the window's edges (DS.position.place();
 * --ds-picker-x and --ds-picker-y are its coordinates).
 *
 * ES2022; no progressive feature of its own.
 */
import { define } from './core.js';
import { open as openOverlay, close as closeOverlay } from './overlay.js';
import { place, pxOf } from './position.js';
import { tabbables } from './a11y.js';

const controllers = new WeakMap();
let serial = 0;

/**
 * The picker's controller, the one [data-ds-picker] makes; once per root.
 * Options: `toggle` (the button; default [data-ds-picker-toggle] or the
 * root's .ds-picker__toggle), `panel` (default the root's
 * .ds-picker__popover; one is made when there is none), `anchor` (what it
 * is placed at, default the root), `label` (the
 * panel's name when it has none), `focus()` (what takes focus on open),
 * `onOpen()`, `onClose(reason)`.
 * @param {Element} root
 * @param {object} [options]
 * @returns {any}
 */
export function create(root, options = {}) {
  const existing = controllers.get(root);
  if (existing) return existing;
  const doc = root.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const abort = new AbortController();
  const { signal } = abort;
  const listeners = new Map();
  const toggle = options.toggle ?? root.querySelector('[data-ds-picker-toggle], .ds-picker__toggle');
  let panel = options.panel ?? root.querySelector(':scope > .ds-picker__popover, .ds-picker__popover');
  if (!panel) {
    panel = doc.createElement('div');
    panel.className = 'ds-picker__popover';
    panel.hidden = true;
    root.append(panel);
  }
  if (!panel.id) panel.id = `ds-picker-${serial += 1}`;
  if (!panel.hasAttribute('role')) panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  if (!panel.hasAttribute('aria-label') && !panel.hasAttribute('aria-labelledby') && options.label) panel.setAttribute('aria-label', options.label);
  if (toggle) {
    toggle.setAttribute('aria-haspopup', 'dialog');
    toggle.setAttribute('aria-controls', panel.id);
    if (!toggle.hasAttribute('aria-expanded')) toggle.setAttribute('aria-expanded', 'false');
  }

  let session = null;
  const isOpen = () => panel.getAttribute('data-state') === 'open';

  function placeNow() {
    const anchor = options.anchor ?? root;
    place(/** @type {HTMLElement} */ (panel), anchor, { side: 'bottom', align: 'start', offset: pxOf(panel, '--ds-space-1', 4), padding: pxOf(panel, '--ds-space-2', 8), crossFlip: true, x: '--ds-picker-x', y: '--ds-picker-y' });
  }

  function open() {
    if (isOpen()) return Promise.resolve();
    // Placed at rest size before the entrance, so it grows from the button.
    panel.setAttribute('data-state', 'closed');
    /** @type {HTMLElement} */ (panel).hidden = false;
    options.onOpen?.();
    placeNow();
    const done = openOverlay(panel, { opener: toggle ?? undefined });
    toTopLayer();
    const target = options.focus?.() ?? panel.querySelector('[autofocus]') ?? tabbables(panel)[0];
    /** @type {HTMLElement|null} */ (target)?.focus({ preventScroll: true });
    follow();
    for (const fn of listeners.get('open') ?? []) fn({});
    return done;
  }

  function close(reason = 'api') {
    if (panel.getAttribute('data-state') !== 'open') return Promise.resolve();
    return closeOverlay(panel, { reason });
  }

  /**
   * Into the top layer (popover="manual"), so no dialog, transform or
   * stacking context around the button covers or traps it; it stays fixed
   * at the same coordinates. Leaves it once DS.overlay hid it.
   */
  function toTopLayer() {
    const html = /** @type {HTMLElement} */ (panel);
    if (typeof html.showPopover !== 'function' || !panel.isConnected) return;
    if (panel.getAttribute('popover') !== 'manual') panel.setAttribute('popover', 'manual');
    try {
      if (!panel.matches(':popover-open')) html.showPopover();
    } catch {
      // Not in a document that takes popovers: it stays fixed in place.
    }
  }

  function fromTopLayer() {
    if (!panel.hasAttribute('popover')) return;
    try {
      if (panel.matches(':popover-open')) /** @type {HTMLElement} */ (panel).hidePopover();
    } catch {
      // Already hidden.
    }
    panel.removeAttribute('popover');
  }

  // DS.overlay hides the panel once its exit is over: then it leaves the top layer.
  const hiddenWatch = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {
    if (/** @type {HTMLElement} */ (panel).hidden) fromTopLayer();
  }) : null;
  hiddenWatch?.observe(panel, { attributes: true, attributeFilter: ['hidden'] });

  /** While open: a press outside closes, scrolling and resizing move it with the button. */
  function follow() {
    session?.abort();
    session = new AbortController();
    const own = { signal: session.signal, capture: true };
    let frame = 0;
    const replace = (/** @type {Event} */ event) => {
      if (event?.type === 'scroll' && panel.contains(/** @type {Node} */ (event.target))) return;
      if (frame) return;
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        if (isOpen()) placeNow();
      });
    };
    doc.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
      const path = event.composedPath?.() ?? [];
      if (path.includes(panel) || path.includes(root) || (toggle && path.includes(toggle))) return;
      close('outside');
    }, own);
    doc.addEventListener('scroll', replace, { ...own, passive: true });
    view.addEventListener('resize', replace, { signal: session.signal });
  }

  panel.addEventListener('ds:close', (event) => {
    if (event.target !== panel) return;
    session?.abort();
    session = null;
    const reason = /** @type {CustomEvent} */ (event).detail?.reason;
    options.onClose?.(reason);
    for (const fn of listeners.get('close') ?? []) fn({ reason });
  }, { signal });

  // Tab and Shift+Tab stay inside the open panel (a modal dialog).
  panel.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Tab' || event.defaultPrevented || !isOpen()) return;
    const items = tabbables(panel);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items.at(-1);
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      /** @type {HTMLElement} */ (last).focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      /** @type {HTMLElement} */ (first).focus();
    }
  }, { signal });

  toggle?.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    // The second click of a double click toggles nothing.
    if (event.detail > 1 || toggle.getAttribute('aria-disabled') === 'true' || /** @type {any} */ (toggle).disabled) return;
    if (isOpen()) close('close');
    else open();
  }, { signal });

  root.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'ArrowDown' || !event.altKey || event.defaultPrevented || panel.contains(/** @type {Node} */ (event.target))) return;
    if (toggle && (toggle.getAttribute('aria-disabled') === 'true' || /** @type {any} */ (toggle).disabled)) return;
    event.preventDefault();
    open();
  }, { signal });

  const controller = {
    element: root,
    panel,
    toggle,
    /** Whether it is open. */
    get() {
      return isOpen();
    },
    /** Opens (true) or closes (false). */
    set(value) {
      return value ? open() : close();
    },
    open,
    close,
    /** Places it again (after its content changed size). */
    place() {
      if (isOpen()) placeNow();
    },
    on(type, fn) {
      const key = String(type).replace(/^ds:/, '');
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key)?.delete(fn);
    },
    destroy() {
      if (signal.aborted) return;
      session?.abort();
      hiddenWatch?.disconnect();
      fromTopLayer();
      abort.abort();
      listeners.clear();
      controllers.delete(root);
    },
  };
  controllers.set(root, controller);
  return controller;
}

/**
 * Opens the picker of a root (made with its defaults when it has none).
 * @param {Element} root
 * @returns {Promise<void>}
 */
export function open(root) {
  return create(root).open();
}

/**
 * Closes the picker of a root.
 * @param {Element} root
 * @param {{ reason?: string }} [options]
 * @returns {Promise<void>}
 */
export function close(root, options = {}) {
  return controllers.get(root)?.close(options.reason) ?? Promise.resolve();
}

define('picker', {
  attribute: 'data-ds-picker',
  init(root) {
    return create(root);
  },
});
