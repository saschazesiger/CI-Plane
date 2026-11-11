/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Popovers (DS.popover): an anchored, non-modal panel that DS.overlay opens
 * and closes (the stack, Escape, focus return, ds:open and ds:close stay in
 * the core, js/overlay.js); this module places it, puts it in the top layer
 * and adds what only a popover does.
 *
 *   <button aria-haspopup="dialog" aria-expanded="false" aria-controls="share" data-ds-popover="#share">Share</button>
 *   <div class="ds-popover ds-popover--arrow" id="share" role="dialog" aria-labelledby="share-t" hidden>…</div>
 *
 *   DS.popover.open(el, { opener, placement: 'top', align: 'center', focus: true });
 *   DS.popover.close(el);
 *   DS.popover.create(el)   // get(), set(), on(), destroy()
 *
 * Placement (js/position.js): on `placement` ('bottom' by default, 'top',
 * 'start', 'end') of its anchor (the opener, or `anchor`: an element or a
 * point { x, y }), aligned by `align` ('start', or 'center' for a popover
 * with an arrow); on the other side when it does not fit and that side has
 * more room, kept --ds-space-2 inside the viewport, capped to the room on its
 * side (its body scrolls). It goes into the top layer as popover="manual"
 * (no clipping box cuts it, and it sits over a modal dialog), at
 * --ds-popover-x/-y, with the arrow at --ds-popover-arrow; it follows
 * scrolling and resizing within a frame.
 *
 * Light dismiss, through DS.overlay's close: a pointerdown outside the
 * popover, its opener and every layer above it, and focus that moves out of
 * them, close it without moving focus. Escape (DS.overlay's stack) closes the
 * topmost layer and focus goes back to the opener when it was inside.
 *
 * Focus: open() moves it in ([autofocus], else the first tabbable that is no
 * close button, else that button, else the panel itself, tabindex="-1"),
 * unless `focus: false` (a toggletip or a hover card: focus stays on the
 * trigger, and the panel, placed after it in the markup, is the next Tab
 * stop). Tab past the last stop closes it and moves on from the opener;
 * Shift+Tab before the first closes it onto the opener.
 *
 * [data-ds-popover="<selector or id>"] on a trigger: a click toggles it
 * (data-ds-popover-placement, data-ds-popover-align on the trigger choose
 * the placement). With data-ds-popover-trigger="hover" it is a hover card:
 * a mouse or pen resting on the trigger opens it after --ds-delay-tooltip,
 * keyboard focus at once, never taking focus; it closes
 * --ds-delay-tooltip-skip after the pointer and focus left trigger and card,
 * so the pointer may cross onto it.
 *
 * Timing comes from the computed tokens (motionDuration). ES2022, with no
 * progressive feature of its own: popover="manual" is at the floor, and CSS
 * anchor positioning is not used (the arrow needs the script's coordinates).
 */
import { define } from './core.js';
import { motionDuration, originFrom, settled } from './motion.js';
import { computePlacement, dropProbe, fixedOrigin, place, pxOf, round, viewportBounds } from './position.js';
import { tabbables } from './a11y.js';
import { internals, open as openOverlay, close as closeOverlay } from './overlay.js';

const { overlays, stack, viewOf, flushStyle, activeIn, inside, composedContains, closeFrom, own, disown } = internals;

/** What a popover was opened with, while it shows. @type {WeakMap<Element, any>} */
const records = new WeakMap();

/** Documents with this module's listeners. */
const listening = new WeakSet();

/**
 * The opener of an open popover that had no aria-expanded of its own (a
 * hover card's link to a person): DS.overlay writes it on every popup's
 * opener, and this takes it off again, so the link is never read as
 * "collapsed". @type {WeakMap<Element, Element>}
 */
const unexpanded = new WeakMap();

/** The script coordinates this module writes (runtime properties, owned while it shows). */
const PROPS = ['--ds-popover-x', '--ds-popover-y', '--ds-popover-arrow', 'max-width'];

const SIDES = new Set(['bottom', 'top', 'start', 'end']);
const ALIGNS = new Set(['start', 'center', 'end']);

/** The overlay a trigger's value names: a selector, or an id without its #. */
function targetOf(trigger, value) {
  if (!value) return null;
  const scope = trigger.getRootNode?.() ?? trigger.ownerDocument;
  let found = null;
  try {
    found = scope.querySelector(value);
  } catch {
    // No selector: an id.
  }
  return found ?? scope.getElementById?.(value) ?? null;
}

const isTop = (element) => {
  try {
    return element.matches(':popover-open');
  } catch {
    return false;
  }
};

/** Whether `element` is open through DS.overlay (not closing). */
function isOpen(element) {
  return overlays.get(element)?.phase === 'open';
}

/** Into the top layer as popover="manual" (closing stays with DS.overlay). */
function toTopLayer(element) {
  if (typeof element.showPopover !== 'function') return;
  if (element.getAttribute('popover') !== 'manual') element.setAttribute('popover', 'manual');
  try {
    if (!isTop(element)) element.showPopover();
  } catch {
    // Not connected, or the engine refused: it stays a fixed box.
  }
}

/** Whether the anchor is an element (else a point { x, y }). */
const isElement = (anchor) => Boolean(anchor) && typeof anchor.getBoundingClientRect === 'function' && typeof anchor.nodeType === 'number';

/**
 * place() of position.js for a point: the same geometry (computePlacement)
 * and the same writes (the cap, data-placement), with the page's direction.
 */
function placeAtPoint(element, point, options) {
  const style = element.style;
  style.removeProperty('max-height');
  style.removeProperty('max-width');
  const x = Number(point?.x) || 0;
  const y = Number(point?.y) || 0;
  const size = { width: element.offsetWidth, height: element.offsetHeight };
  const rtl = viewOf(element).getComputedStyle?.(element).direction === 'rtl';
  const result = computePlacement({ left: x, right: x, top: y, bottom: y }, size, viewportBounds(element), { ...options, rtl });
  const inline = result.side === 'start' || result.side === 'end';
  if ((inline ? size.width : size.height) > result.room) style.setProperty(inline ? 'max-width' : 'max-height', `${round(result.room)}px`);
  if (result.side === 'bottom') element.removeAttribute('data-placement');
  else element.setAttribute('data-placement', result.side);
  return result;
}

/**
 * Places a popover at its anchor: position.js computes, this writes the
 * coordinates (in the viewport's terms in the top layer, else in those of
 * the box it is fixed to) and the arrow's offset along the facing edge.
 */
function position(element, record) {
  const arrow = element.matches('.ds-popover--arrow');
  const padding = pxOf(element, '--ds-space-2', 8);
  const offset = arrow ? pxOf(element, '--ds-space-3', 12) : pxOf(element, '--ds-space-1', 4);
  const options = {
    side: record.side,
    align: record.align,
    offset,
    padding,
    flip: /** @type {const} */ ('room'),
    crossFlip: record.align !== 'center',
    arrowPadding: pxOf(element, '--ds-space-4', 16),
  };
  const result = isElement(record.anchor) ? place(/** @type {HTMLElement} */ (element), record.anchor, options) : placeAtPoint(element, record.anchor, options);
  if (!result) return;
  const origin = isTop(element) ? { left: 0, top: 0 } : fixedOrigin(element);
  const style = /** @type {HTMLElement} */ (element).style;
  style.setProperty('--ds-popover-x', `${round(result.x - origin.left)}px`);
  style.setProperty('--ds-popover-y', `${round(result.y - origin.top)}px`);
  style.setProperty('--ds-popover-arrow', `${round(result.arrow)}px`);
}

/** A point of the anchor for originFrom(): the element, or the point { x, y }. */
const originOf = (anchor) => (isElement(anchor) ? anchor : { x: Number(anchor?.x) || 0, y: Number(anchor?.y) || 0 });

/**
 * The entrance again, from the anchor: DS.overlay grows every popup out of
 * its opener, so one opened at a point or at another element takes its
 * closed state at its own anchor once more and grows from there.
 */
function regrow(element, record) {
  const style = /** @type {HTMLElement} */ (element).style;
  style.setProperty('transition', 'none');
  style.setProperty('scale', 'none');
  element.setAttribute('data-state', 'closed');
  originFrom(originOf(record.anchor), element);
  style.removeProperty('scale');
  flushStyle(element);
  style.removeProperty('transition');
  element.setAttribute('data-state', 'open');
}

/** Placed at rest size, then its closed state without a transition, so it grows from its anchor. */
function prepare(element, record) {
  const style = /** @type {HTMLElement} */ (element).style;
  /** @type {HTMLElement} */ (element).hidden = false;
  element.setAttribute('data-state', 'closed');
  style.setProperty('transition', 'none');
  style.setProperty('scale', 'none');
  toTopLayer(element);
  position(element, record);
  originFrom(originOf(record.anchor), element);
  style.removeProperty('scale');
  flushStyle(element);
  style.removeProperty('transition');
}

/** Undoes what open() wrote, once the close settled. */
function release(element) {
  const record = records.get(element);
  if (!record) return;
  records.delete(element);
  if (isTop(element)) {
    try {
      /** @type {HTMLElement} */ (element).hidePopover();
    } catch {
      // Not open.
    }
  }
  element.removeAttribute('popover');
  element.removeAttribute('data-placement');
  const style = /** @type {HTMLElement} */ (element).style;
  for (const name of [...PROPS, 'max-height']) style.removeProperty(name);
  for (const name of PROPS) disown(element, 'props', name);
  if (record.tabindex) {
    element.removeAttribute('tabindex');
    disown(element, 'attrs', 'tabindex');
  }
  dropProbe(element);
}

/** Focus into a popover that asked for it: [autofocus], the first stop that is no close button, that button, else the panel. */
function focusInto(element, record) {
  if (element.contains(activeIn(element))) return;
  const stops = tabbables(element);
  const target = element.querySelector('[autofocus]') ?? stops.find((node) => !node.matches('[data-ds-close], .ds-popover__close')) ?? stops[0];
  if (target) {
    /** @type {HTMLElement} */ (target).focus({ preventScroll: true });
    return;
  }
  if (!element.hasAttribute('tabindex')) {
    element.setAttribute('tabindex', '-1');
    own(element, 'attrs', 'tabindex');
    record.tabindex = true;
  }
  /** @type {HTMLElement} */ (element).focus({ preventScroll: true });
}

/** The open popovers of this module, the topmost last. */
const openPopovers = () => stack.filter((element) => records.has(element) && isOpen(element));

/** Whether `node` lies in a layer above `element` on the stack (a menu or dialog opened from inside the popover). */
function inLayerAbove(element, node) {
  const index = stack.indexOf(element);
  return stack.slice(index + 1).some((other) => overlays.get(other)?.phase !== 'closed' && composedContains(other, node));
}

/** One set of listeners per document, from the first popover on. */
function listen(doc) {
  if (listening.has(doc)) return;
  listening.add(doc);
  const view = doc.defaultView ?? globalThis;
  // Light dismiss: a press outside the popover, its opener and what lies above it.
  doc.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
    const target = /** @type {Node} */ (event.composedPath?.()[0] ?? event.target);
    for (const element of openPopovers().reverse()) {
      const state = overlays.get(element);
      if (inside(element, event) || inside(state?.opener, event) || inLayerAbove(element, target)) continue;
      closeFrom(element, 'outside');
    }
  }, true);
  // Focus that moved out (a Tab from the trigger past a hover card, a click
  // into another widget): it closes without taking that focus back.
  doc.addEventListener('focusin', (/** @type {FocusEvent} */ event) => {
    const target = /** @type {Node} */ (event.composedPath?.()[0] ?? event.target);
    for (const element of openPopovers().reverse()) {
      const state = overlays.get(element);
      if (composedContains(element, target) || (state?.opener && composedContains(state.opener, target)) || inLayerAbove(element, target)) continue;
      closeFrom(element, 'outside');
    }
  });
  // Tab past either end of the stops closes it onto the opener (the
  // default of Tab then moves on from there).
  doc.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const element = openPopovers().at(-1);
    const active = activeIn(element);
    if (!element || !composedContains(element, active)) return;
    const stops = tabbables(element);
    const last = event.shiftKey ? stops[0] : stops.at(-1);
    if (stops.length && active !== last && active !== element) return;
    if (active === element && stops.length && !event.shiftKey) return;
    closeFrom(element, 'tab');
    // Shift+Tab lands on the opener itself.
    if (event.shiftKey) event.preventDefault();
  });
  // Following its anchor through scrolling and resizing, within one frame.
  let frame = 0;
  const follow = (/** @type {Event} */ event) => {
    const source = /** @type {Element} */ (event?.target);
    if (event?.type === 'scroll' && source?.closest?.('.ds-popover')) return;
    if (frame || !openPopovers().length) return;
    const run = () => {
      frame = 0;
      for (const element of openPopovers()) position(element, records.get(element));
    };
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(run) : 0;
    if (!frame) run();
  };
  doc.addEventListener('scroll', follow, { capture: true, passive: true });
  view.addEventListener?.('resize', follow);
  // Once a close of DS.overlay settled: out of the top layer, coordinates gone.
  doc.addEventListener('ds:close', (event) => {
    const element = /** @type {Element} */ (event.target);
    const opener = unexpanded.get(element);
    if (opener) {
      unexpanded.delete(element);
      opener.removeAttribute('aria-expanded');
    }
    if (!records.has(element)) return;
    const state = overlays.get(element);
    state?.closing?.then(() => {
      if (state.phase === 'closed') release(element);
    });
  });
}

/**
 * The options a trigger's attributes give (data-ds-popover-placement,
 * -align), and the defaults: below, aligned with the start edge (centred
 * with an arrow).
 */
function readOptions(element, options) {
  const side = SIDES.has(options.placement) ? options.placement : 'bottom';
  const fallback = element.matches('.ds-popover--arrow') ? 'center' : 'start';
  const align = ALIGNS.has(options.align) ? options.align : fallback;
  return { side, align };
}

/**
 * Opens a popover through DS.overlay.open(), placed at its anchor in the top
 * layer. A popover open from another trigger moves to this one.
 * @param {Element} element
 * @param {{ opener?: Element|null, anchor?: Element|{ x: number, y: number }|null, placement?: 'bottom'|'top'|'start'|'end', align?: 'start'|'center'|'end', focus?: boolean, returnTo?: () => Element|null|undefined }} [options]
 * @returns {Promise<void>}
 */
export function open(element, options = {}) {
  if (!element?.isConnected) return Promise.resolve();
  const doc = element.ownerDocument;
  listen(doc);
  const state = overlays.get(element);
  const opener = options.opener ?? state?.opener ?? activeIn(element) ?? null;
  if (state?.phase === 'open') {
    if (state.opener === opener) return state.opening ?? Promise.resolve();
    // Open from another trigger: closed, then opened afresh there.
    closeFrom(element, 'api');
  }
  const { side, align } = readOptions(element, options);
  const record = { anchor: options.anchor ?? opener, side, align, focus: options.focus !== false, tabindex: records.get(element)?.tabindex ?? false };
  // Taken back mid-exit by the same trigger: it turns back from where it is.
  const reverse = overlays.get(element)?.phase === 'closing' && overlays.get(element)?.opener === opener && records.has(element);
  records.set(element, record);
  for (const name of PROPS) own(element, 'props', name);
  if (!reverse) prepare(element, record);
  const expanded = opener?.getAttribute?.('aria-expanded') ?? null;
  let entrance = openOverlay(element, { opener, returnTo: options.returnTo });
  // The replayed entrance cancelled the one DS.overlay waits for: wait for this one.
  if (!reverse && record.anchor !== opener) {
    regrow(element, record);
    entrance = settled(element, { transitions: true });
  }
  // An opener that says nothing about being expanded (a hover card's link) stays so.
  if (opener && (expanded === null || unexpanded.get(element) === opener)) {
    opener.removeAttribute('aria-expanded');
    unexpanded.set(element, opener);
  } else unexpanded.delete(element);
  // Moved into an open native dialog by DS.overlay (so it is not inert): back into the top layer there.
  if (!isTop(element) && element.isConnected) {
    toTopLayer(element);
    position(element, record);
  }
  if (record.focus) focusInto(element, record);
  return entrance;
}

/**
 * Closes a popover: DS.overlay.close().
 * @param {Element} element
 * @param {{ reason?: string }} [options]
 * @returns {Promise<void>}
 */
export function close(element, options = {}) {
  return closeOverlay(element, options);
}

/**
 * The controller of a popover: get() says whether it is open, set(true |
 * false, options) opens or closes it (the options of open()), on('open' |
 * 'close', fn) hears its ds: events and returns the unsubscribe.
 * @param {Element} element
 * @returns {{ element: Element, get: () => boolean, set: (value: boolean, options?: object) => Promise<void>, on: (type: string, fn: (event: Event) => void) => () => void, destroy: () => void }}
 */
export function create(element) {
  const listeners = /** @type {Array<() => void>} */ ([]);
  return {
    element,
    get: () => isOpen(element),
    set: (value, options = {}) => (value ? open(element, options) : close(element, options)),
    on(type, fn) {
      const name = `ds:${type}`;
      element.addEventListener(name, fn);
      const off = () => element.removeEventListener(name, fn);
      listeners.push(off);
      return off;
    },
    destroy() {
      for (const off of listeners.splice(0)) off();
    },
  };
}

/** A hover card's pointer and focus (data-ds-popover-trigger="hover"). */
function hoverCard(trigger, popover, signal, optionsOf) {
  let showTimer = /** @type {any} */ (0);
  let hideTimer = /** @type {any} */ (0);
  let over = false;
  let focusing = false;
  const wired = new WeakSet();
  const time = (token) => motionDuration(trigger, token);
  const mine = () => {
    const element = popover();
    return Boolean(element) && overlays.get(element)?.opener === trigger && isOpen(element);
  };
  const cancel = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = 0;
    hideTimer = 0;
  };
  const holds = (node) => Boolean(node) && (trigger.contains(node) || Boolean(popover()?.contains(node)));
  const hideLater = () => {
    clearTimeout(showTimer);
    showTimer = 0;
    if (hideTimer || !mine()) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      const element = popover();
      const focusInCard = Boolean(element?.contains(activeIn(trigger)));
      if (!over && !focusing && !focusInCard && element && mine()) close(element, { reason: 'outside' });
    }, time('--ds-delay-tooltip-skip'));
  };
  const onCard = (/** @type {PointerEvent} */ event) => {
    if (event.pointerType === 'touch' || !mine()) return;
    over = true;
    clearTimeout(hideTimer);
    hideTimer = 0;
  };
  const offCard = (/** @type {PointerEvent} */ event) => {
    if (event.pointerType === 'touch' || !mine() || holds(/** @type {Node} */ (event.relatedTarget))) return;
    over = false;
    hideLater();
  };
  const show = () => {
    cancel();
    const element = popover();
    if (!element || mine()) return;
    // The card's own pointer: one pair of listeners per card, for this trigger.
    if (!wired.has(element)) {
      wired.add(element);
      element.addEventListener('pointerover', onCard, { signal });
      element.addEventListener('pointerout', offCard, { signal });
    }
    open(element, { ...optionsOf(), focus: false });
  };
  trigger.addEventListener('pointerover', (/** @type {PointerEvent} */ event) => {
    if (event.pointerType === 'touch') return;
    over = true;
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (mine() || showTimer) return;
    showTimer = setTimeout(show, time('--ds-delay-tooltip'));
  }, { signal });
  trigger.addEventListener('pointerout', (/** @type {PointerEvent} */ event) => {
    if (event.pointerType === 'touch' || holds(/** @type {Node} */ (event.relatedTarget))) return;
    over = false;
    hideLater();
  }, { signal });
  // Keyboard focus shows it at once; focus from a click does not hold it.
  trigger.addEventListener('focusin', (/** @type {FocusEvent} */ event) => {
    // Focus given back by the card's close (Escape from its link) reopens nothing.
    const element = popover();
    const from = /** @type {Node} */ (event.relatedTarget);
    if (element && from && element.contains(from)) return;
    let visible = true;
    try {
      visible = trigger.matches(':focus-visible');
    } catch {
      // An engine without the pseudo-class: keyboard focus assumed.
    }
    if (!visible) return;
    focusing = true;
    show();
  }, { signal });
  trigger.addEventListener('focusout', () => {
    focusing = false;
  }, { signal });
  signal?.addEventListener('abort', cancel);
}

/*
 * [data-ds-popover] on a trigger: a click toggles the popover it names; with
 * data-ds-popover-trigger="hover" it is a hover card. The controller is the
 * popover's (create()), opened from this trigger.
 */
define('popover', {
  attribute: 'data-ds-popover',
  attributes: ['data-ds-popover-placement', 'data-ds-popover-align', 'data-ds-popover-trigger'],
  init(trigger, ctx) {
    const popover = () => targetOf(trigger, trigger.getAttribute('data-ds-popover') ?? '');
    const optionsOf = () => ({
      opener: trigger,
      placement: trigger.getAttribute('data-ds-popover-placement') ?? undefined,
      align: trigger.getAttribute('data-ds-popover-align') ?? undefined,
    });
    if (trigger.getAttribute('data-ds-popover-trigger') === 'hover') hoverCard(trigger, popover, ctx.signal, optionsOf);
    else {
      trigger.addEventListener('click', (/** @type {MouseEvent} */ event) => {
        // The second click of a double click toggles nothing.
        if (event.defaultPrevented || event.detail > 1) return;
        const element = popover();
        if (!element) return;
        if (isOpen(element) && overlays.get(element)?.opener === trigger) close(element, { reason: 'close' });
        else open(element, optionsOf());
      }, { signal: ctx.signal ?? undefined });
    }
    const element = popover();
    const controller = element ? create(element) : null;
    return {
      element: trigger,
      get: () => Boolean(popover() && isOpen(popover())),
      set: (value, options = {}) => {
        const target = popover();
        if (!target) return Promise.resolve();
        return value ? open(target, { ...optionsOf(), ...options }) : close(target, options);
      },
      on: (type, fn) => controller?.on(type, fn) ?? (() => {}),
      destroy: () => controller?.destroy(),
    };
  },
});
