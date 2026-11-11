/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Suggestions (DS.suggestions): a row of follow-up chips, .ds-suggestions.
 *
 *   <div class="ds-suggestions ds-scroll-x" role="group" aria-label="Suggested questions"
 *     data-ds-suggestions data-ds-suggestions-for="composer-1"> (.ds-chip buttons) </div>
 *   const row = DS.suggestions.create(el);
 *   row.set(['Show the battery report', { value: 'Open a ticket', icon: DS.icons.ticket }]);
 *   row.on('select', ({ value }) => ask(value));
 *
 * - A press on a chip (a button or link in the row that is not blocked)
 *   dispatches ds:select ({ value, label, chip }): value is the chip's
 *   data-value, else its label. With data-ds-suggestions-for="<id>" (a
 *   .ds-composer with DS.composer on it) the value goes into that
 *   composer's field and the focus with it; with data-ds-suggestions-send as well, the composer sends it
 *   at once. preventDefault() on ds:select keeps the composer as it is.
 * - Drag to scroll: a mouse or pen pressed on the row and moved more than
 *   4px sideways scrolls it with the pointer (data-state="dragging"); the
 *   click that ends a drag presses nothing. Touch scrolls natively.
 * - The ends: DS.dom.scrollEdges() writes data-ds-overflow-start and
 *   -end, which .ds-scroll-x fades by and the row's grab cursor reads.
 *
 * The controller: get() (the chips as { value, label }), set(items) (new
 * chips: texts, or { value, label, icon } with a DS.icons glyph), on('select',
 * fn), destroy().
 */
import { define, emit, get } from './core.js';
import { scrollEdges } from './dom.js';
import { iconElement } from './icons.js';

/** How far a press moves before it is a drag (px, a distance). */
const DRAG_SLOP_PX = 4;

/** The events a controller's on() takes. */
const EVENTS = new Set(['select']);

const CHIPS = ':is(button, a[href], [role="button"])';

/** The label of a chip: its .ds-chip__label, else its text. */
const labelOf = (chip) => (chip.querySelector('.ds-chip__label')?.textContent ?? chip.textContent ?? '').trim();

/**
 * Items as the chips show them: a text, or { value, label, icon } (icon: a
 * glyph of DS.icons); the label falls back to the value and the other way
 * round. Empty items go.
 * @param {Array<string|{ value?: string, label?: string, icon?: string }>} list
 * @returns {{ value: string, label: string, icon: string|null }[]}
 */
export function items(list) {
  return Array.from(list ?? []).map((item) => {
    if (item && typeof item === 'object') {
      const label = String(item.label ?? item.value ?? '').trim();
      return { value: String(item.value ?? label).trim(), label, icon: item.icon ? String(item.icon) : null };
    }
    const text = String(item ?? '').trim();
    return { value: text, label: text, icon: null };
  }).filter((item) => item.label);
}

function controller(el) {
  const doc = el.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  const listeners = new Map();
  const edges = scrollEdges(el, { axis: 'inline' });
  let drag = null;
  let swallow = false;

  const chips = () => Array.from(el.querySelectorAll(CHIPS)).filter((chip) => chip.closest('.ds-suggestions') === el);

  function select(chip) {
    const value = chip.getAttribute('data-value') ?? labelOf(chip);
    const detail = { value, label: labelOf(chip), chip };
    const go = emit(el, 'select', detail, { cancelable: true });
    for (const fn of listeners.get('select') ?? []) fn(detail);
    if (!go) return;
    const id = el.getAttribute('data-ds-suggestions-for');
    const target = id ? doc.getElementById(id) : null;
    if (!target) return;
    const field = get(target, 'composer');
    if (!field) return;
    field.set({ text: value });
    if (el.hasAttribute('data-ds-suggestions-send')) field.send();
    else field.focus();
  }

  const onClick = (event) => {
    if (swallow) {
      swallow = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const chip = /** @type {Element} */ (event.target).closest?.(CHIPS);
    if (!chip || chip.closest('.ds-suggestions') !== el) return;
    if (chip.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]')) return;
    select(chip);
  };

  const onDown = (/** @type {PointerEvent} */ event) => {
    if (event.pointerType === 'touch' || event.button !== 0 || el.classList.contains('ds-suggestions--wrap')) return;
    if (el.scrollWidth <= el.clientWidth) return;
    swallow = false;
    drag = { id: event.pointerId, x: event.clientX, left: el.scrollLeft, moving: false };
  };

  const onMove = (/** @type {PointerEvent} */ event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    if (!drag.moving) {
      if (Math.abs(dx) <= DRAG_SLOP_PX) return;
      drag.moving = true;
      el.setAttribute('data-state', 'dragging');
      try {
        el.setPointerCapture(drag.id);
      } catch {
        // The pointer is gone already.
      }
    }
    event.preventDefault();
    el.scrollLeft = drag.left - dx;
  };

  const onUp = (/** @type {PointerEvent} */ event) => {
    if (!drag || event.pointerId !== drag.id) return;
    // The click that ends a drag presses nothing.
    swallow = drag.moving && event.type === 'pointerup';
    if (drag.moving) el.removeAttribute('data-state');
    drag = null;
    if (swallow) setTimeout(() => { swallow = false; });
  };

  el.addEventListener('click', onClick, { capture: true, signal });
  el.addEventListener('pointerdown', onDown, { signal });
  el.addEventListener('pointermove', onMove, { signal });
  el.addEventListener('pointerup', onUp, { signal });
  el.addEventListener('pointercancel', onUp, { signal });
  el.addEventListener('lostpointercapture', onUp, { signal });

  function chipOf(item) {
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = 'ds-chip';
    if (item.value !== item.label) chip.setAttribute('data-value', item.value);
    const body = doc.createElement('span');
    body.className = 'ds-chip__body';
    if (item.icon) body.append(iconElement(item.icon, 18, 'ds-chip__icon', doc));
    const label = doc.createElement('span');
    label.className = 'ds-chip__label';
    label.textContent = item.label;
    body.append(label);
    chip.append(body);
    return chip;
  }

  return {
    get() {
      return chips().map((chip) => ({ value: chip.getAttribute('data-value') ?? labelOf(chip), label: labelOf(chip) }));
    },
    set(next) {
      el.replaceChildren(...items(next).map(chipOf));
      el.scrollLeft = 0;
      edges.update();
    },
    on(type, fn) {
      if (!EVENTS.has(type) || typeof fn !== 'function') return () => {};
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      listeners.clear();
      if (el.getAttribute('data-state') === 'dragging') el.removeAttribute('data-state');
      edges.destroy();
    },
  };
}

/** The controller of each row, so create() and the attribute path share one. @type {WeakMap<Element, any>} */
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

define('suggestions', {
  attribute: 'data-ds-suggestions',
  init(el) {
    return controllerOf(el);
  },
});

/**
 * The controller of a row of suggestions driven from the page: the same
 * one the attribute path makes (one per element).
 * @param {Element} el
 */
export function create(el) {
  return controllerOf(el);
}
