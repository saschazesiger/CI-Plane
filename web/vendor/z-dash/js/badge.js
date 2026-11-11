/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Badge: a count that never outgrows its pill. The figure stops at a maximum
 * and shows "99+"; nothing (an empty badge takes no room) at zero or below.
 *
 *   <span class="ds-badge" data-ds-badge="128" data-ds-badge-max="99"></span>      99+
 *   const badge = DS.badge.create(el, { value: 3, max: 99 });
 *   badge.set(4);
 *   DS.badge.format(128);                                                          '99+'
 *
 * The attribute path reads data-ds-badge (the count) and data-ds-badge-max
 * (default 99) when DS.init() finds them and whenever they change; a page
 * that re-renders with DS.dom.morphHtml writes the text as well, from
 * format(), since a patch puts back the children of its template. set()
 * drives it from the page and never writes the attributes.
 *
 * The first render is silent. After it, a count that appears pops in and one
 * that goes pops out (DS.motion.enter and leave, 'pop'); the figure itself
 * changes at once. The controller emits ds:change with { value, text } on
 * set(), on the badge.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit } from './core.js';
import { enter, leave } from './motion.js';

const DEFAULT_MAX = 99;

/**
 * The figure of a count: `value` up to `max`, then `max` and a plus; an empty
 * string at zero, below zero, or for what is no number.
 * @param {number|string} value
 * @param {number} [max]
 * @returns {string}
 */
export function format(value, max = DEFAULT_MAX) {
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > max ? `${max}+` : String(count);
}

/** The maximum an attribute names, or the default for a missing or bad one. */
function maximum(text) {
  const parsed = Number.parseInt(text ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX;
}

function controller(el, start, signal) {
  let value = start.value;
  let max = start.max;
  let leaving = false;
  const listeners = new Set();

  const write = (animate) => {
    const text = format(value, max);
    if (!text) {
      if (!el.textContent || leaving) return;
      if (!animate) {
        el.textContent = '';
        return;
      }
      // It keeps its figure while it pops out; a count set meanwhile takes over.
      leaving = true;
      leave(el, 'pop', { then: 'hide' }).then(() => {
        if (!leaving) return;
        leaving = false;
        el.textContent = '';
        el.hidden = false;
      });
      return;
    }
    const appears = !el.textContent || leaving;
    leaving = false;
    if (el.textContent !== text) el.textContent = text;
    if (animate && appears) enter(el, 'pop');
  };

  write(false);

  return {
    get() { return value; },
    set(next) {
      const changed = next !== value;
      value = next;
      write(true);
      if (changed && !signal?.aborted) {
        const detail = { value, text: format(value, max) };
        emit(el, 'change', detail);
        listeners.forEach((fn) => fn(detail));
      }
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      value = el.getAttribute('data-ds-badge') ?? value;
      max = maximum(el.getAttribute('data-ds-badge-max'));
      write(true);
    },
    destroy() { listeners.clear(); },
  };
}

define('badge', {
  attribute: 'data-ds-badge',
  attributes: ['data-ds-badge-max'],
  init(el, ctx) {
    return controller(el, { value: el.getAttribute('data-ds-badge'), max: maximum(el.getAttribute('data-ds-badge-max')) }, ctx.signal);
  },
});

/**
 * A badge driven from the page; the same controller the attribute path makes.
 * @param {Element} el
 * @param {{ value?: number|string, max?: number }} [options]
 */
export function create(el, options = {}) {
  return controller(el, { value: options.value ?? 0, max: options.max ?? DEFAULT_MAX });
}
