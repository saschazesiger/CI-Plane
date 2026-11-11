/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * AI label (DS.ailabel): the toggletip of a .ds-ailabel button, which
 * explains what generated content is.
 *
 *   <button class="ds-ailabel" type="button" aria-expanded="false" aria-controls="ai-tip-1" data-ds-ailabel>...</button>
 *   <div class="ds-ailabel__tip" id="ai-tip-1" role="dialog" aria-labelledby="ai-tip-1-title" popover="manual" hidden>...</div>
 *   const label = DS.ailabel.create(button);
 *   label.set(true);                           // opens the explainer
 *
 * - A press on the button opens the tip it names (aria-controls), a second
 *   press closes it. It opens through DS.overlay (a popup: aria-expanded on
 *   the button, the Escape stack, the motion keyed on data-state) as a
 *   popover="manual" in the top layer, placed under the button (above it
 *   without room) by DS.position's geometry, and again when the page
 *   scrolls or resizes. The focus moves into the tip (tabindex="-1" when
 *   it has none), so a screen reader reads it; Escape closes it and gives
 *   the focus back to the button; a press outside it or a focus that leaves
 *   it closes it too. ds:open and ds:close come from DS.overlay.
 * - Without a tip the button is a label that does nothing.
 *
 * The controller: get() ({ open }), set(open), on('toggle', fn) (after
 * each open and close, { open }), destroy().
 */
import { define, emit } from './core.js';
import { open as openOverlay, close as closeOverlay } from './overlay.js';
import { place, pxOf } from './position.js';

/** The events a controller's on() takes. */
const EVENTS = new Set(['toggle']);

function controller(button) {
  const doc = button.ownerDocument;
  const view = doc.defaultView;
  const abort = new AbortController();
  const signal = abort.signal;
  const listeners = new Map();
  let shown = null;

  const tip = () => {
    const id = button.getAttribute('aria-controls');
    return /** @type {HTMLElement|null} */ (id ? doc.getElementById(id) : null);
  };
  const isOpen = (el) => Boolean(el && !el.hidden && el.getAttribute('data-state') === 'open');

  const fire = (open) => {
    const detail = { open };
    emit(button, 'toggle', detail);
    for (const fn of listeners.get('toggle') ?? []) fn(detail);
  };

  function position(el) {
    place(el, button, {
      side: 'bottom', align: 'start', offset: pxOf(el, '--ds-space-1', 4), padding: pxOf(el, '--ds-space-2', 8),
      flip: 'room', x: '--ds-ailabel-x', y: '--ds-ailabel-y',
    });
  }

  function open() {
    const el = tip();
    if (!el || isOpen(el)) return;
    if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.hidden = false;
    try {
      if (!el.matches(':popover-open')) el.showPopover();
    } catch {
      // Not in the document, or no popover: it stays fixed in place.
    }
    position(el);
    openOverlay(el, { opener: button });
    el.focus({ preventScroll: true });
    watch(el);
    fire(true);
  }

  function close(reason = 'api') {
    const el = tip();
    if (!el || el.hidden || el.getAttribute('data-state') === 'closed') return;
    closeOverlay(el, { reason });
  }

  /** While it is open: what closes it and what places it again. */
  function watch(el) {
    shown?.abort();
    const watching = new AbortController();
    shown = watching;
    const options = { signal: watching.signal };
    const capture = { signal: watching.signal, capture: true };
    doc.addEventListener('pointerdown', (event) => {
      const target = /** @type {Node} */ (event.target);
      if (el.contains(target) || button.contains(target)) return;
      close('outside');
    }, capture);
    el.addEventListener('focusout', (event) => {
      const next = /** @type {Node|null} */ (event.relatedTarget);
      if (!next || el.contains(next) || button.contains(next)) return;
      close('blur');
    }, options);
    let frame = 0;
    const again = () => {
      if (frame) return;
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        if (isOpen(el)) position(el);
      });
    };
    view.addEventListener('scroll', again, { signal: watching.signal, capture: true, passive: true });
    view.addEventListener('resize', again, options);
    el.addEventListener('ds:close', () => {
      watching.abort();
      if (shown === watching) shown = null;
      fire(false);
      // Out of the top layer once the exit has played and DS.overlay hid it.
      const done = () => {
        if (el.getAttribute('data-state') === 'open' || !el.hidden) return false;
        try {
          if (el.matches(':popover-open')) el.hidePopover();
        } catch {
          // Already hidden.
        }
        return true;
      };
      if (done()) return;
      const hiding = new view.MutationObserver(() => {
        if (done() || el.getAttribute('data-state') === 'open') hiding.disconnect();
      });
      hiding.observe(el, { attributes: true, attributeFilter: ['hidden', 'data-state'] });
    }, { once: true, signal: watching.signal });
  }

  const onClick = () => {
    if (button.matches(':disabled, [aria-disabled="true"]')) return;
    if (isOpen(tip())) close('toggle');
    else open();
  };
  button.addEventListener('click', onClick, { signal });
  if (tip() && !button.hasAttribute('aria-expanded')) button.setAttribute('aria-expanded', 'false');

  return {
    get() {
      return { open: isOpen(tip()) };
    },
    set(value) {
      if (value) open();
      else close();
    },
    on(type, fn) {
      if (!EVENTS.has(type) || typeof fn !== 'function') return () => {};
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    destroy() {
      if (signal.aborted) return;
      close();
      shown?.abort();
      abort.abort();
      listeners.clear();
    },
  };
}

/** The controller of each label, so create() and the attribute path share one. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

function controllerOf(el) {
  const held = controllers.get(el);
  if (held) return held;
  const handle = controller(el);
  const destroy = handle.destroy;
  handle.destroy = () => {
    if (controllers.get(el) === handle) controllers.delete(el);
    destroy();
  };
  controllers.set(el, handle);
  return handle;
}

define('ailabel', {
  attribute: 'data-ds-ailabel',
  init(el) {
    return controllerOf(el);
  },
});

/**
 * The controller of an AI label's toggletip driven from the page: the same
 * one the attribute path makes (one per button).
 * @param {Element} el
 */
export function create(el) {
  return controllerOf(el);
}
