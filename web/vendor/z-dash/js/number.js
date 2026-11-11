/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Number input (DS.number): a text field that holds a number in the page's
 * locale, with stepper buttons, a minimum, a maximum and a step, and the
 * WAI-ARIA spinbutton keys. A currency or a unit fills the field's prefix
 * or suffix from Intl, in the order the locale writes it.
 *
 *   <div class="ds-input-group ds-number" data-ds-number data-ds-number-min="0" data-ds-number-max="500"
 *        data-ds-number-step="5" data-ds-number-unit="gigabyte">
 *     <input class="ds-input" id="quota" type="text" inputmode="decimal" autocomplete="off" value="50">
 *     <span class="ds-input-group__suffix" aria-hidden="true"></span>
 *     <span class="ds-input-group__trailing">
 *       <button class="ds-btn ds-btn--quiet ds-btn--icon ds-number__step ds-number__down" type="button" tabindex="-1">(minus)</button>
 *       <button class="ds-btn ds-btn--quiet ds-btn--icon ds-number__step ds-number__up" type="button" tabindex="-1">(plus)</button>
 *     </span>
 *     <input type="hidden" name="quota">
 *   </div>
 *
 *   const quota = DS.number.create(group, { min: 0, max: 500, step: 5 });
 *   quota.set(120); quota.get();                 // 120
 *   DS.number.parse('1.234,5', { locale: 'de' }); // 1234.5
 *   DS.number.format(1234.5, { decimals: 2 });    // '1,234.50'
 *
 * Options, as data-ds-number-<option> on the group or as create()'s options:
 * min, max, step (default 1), page (PageUp and PageDown; default ten steps),
 * decimals (default the step's, or the currency's), currency (ISO 4217),
 * unit (an Intl unit such as gigabyte, else shown as written), grouping
 * ("off": no thousands separators), locale (default DS.core.config()).
 *
 * The field is the spinbutton: role, aria-valuenow, -valuemin, -valuemax and
 * -valuetext ("50 gigabytes", "19.90 euros") are written here as owned state,
 * so a re-render with DS.dom.morphHtml keeps them. ArrowUp and ArrowDown
 * step, PageUp and PageDown take big steps, Home and End go to the minimum
 * and the maximum; Enter and blur commit what was typed: parsed in the
 * locale (its digits, separators, an affix typed along), kept within min and
 * max, rounded to a given step (else to the decimals) and written back formatted. Text that is no
 * number goes back to the last value. The wheel never changes it (the field
 * is a text field). The steppers keep the focus where it is, step once per
 * press and repeat while held (after --ds-delay-tooltip, every
 * --ds-dur-instant); they are off at the ends. A mouse or a pen steps on
 * press, a finger on its lift (or when the hold repeats), so a scroll that
 * starts on a stepper steps nothing. A step from a stepper is
 * announced; a step from the keys is read by the screen reader itself.
 *
 * A change dispatches input and change on the field (so dirty tracking and
 * the page's own listeners hear it) and ds:change ({ value, text }) on the
 * group; a hidden input in the group holds the plain value ("1234.5") for a
 * form that posts.
 *
 * Strings: the steppers' names default to the system's strings decrease and
 * increase when the markup has none (DS.core.config({ strings })).
 *
 * ES2022. No Progressive: features.
 */
import { config, define, emit, t } from './core.js';
import { motionDuration } from './motion.js';
import { own } from './dom.js';
import { announce } from './a11y.js';
import { number as formatNumber, currency as formatCurrency } from './format.js';

/** The attributes of the options (a change calls update()). */
const OPTIONS = ['min', 'max', 'step', 'page', 'decimals', 'currency', 'unit', 'grouping'];

/** The minus signs a person or a locale may write. */
const MINUS = /[-−‒–﹣－]/;

/** What may stand before or after the figure: letters, currency signs, percent, spaces. */
const AFFIX = /^[\p{L}\p{Sc}%‰\s]+|[\p{L}\p{Sc}%‰\s]+$/gu;

/** Numbers the ids this module gives a field without one (aria-controls of the steppers). */
let seq = 0;

/** The separators and digits of a locale, made once per locale. */
const symbolCache = new Map();

/**
 * The group and decimal separators and the ten digits of a locale, read from
 * DS.format.number (so the locale is the page's when none is given).
 * @param {string} [locale]
 * @returns {{ group: string, decimal: string, digits: string[] }}
 */
export function symbols(locale) {
  const key = locale ?? config().locale ?? '';
  let found = symbolCache.get(key);
  if (found) return found;
  const sample = formatNumber(11111.1, { locale, useGrouping: true, minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const digits = Array.from({ length: 10 }, (_, digit) => formatNumber(digit, { locale, useGrouping: false }));
  const one = digits[1];
  const chars = [...sample];
  const lastOne = chars.lastIndexOf(one);
  const decimal = chars[lastOne - 1] ?? '.';
  // The grouping separator: what stands between the ones before the decimal (none for a locale that groups nothing).
  const integer = chars.slice(0, lastOne - 1).filter((char) => char !== one).join('');
  found = Object.freeze({ group: integer || '', decimal, digits });
  symbolCache.set(key, found);
  return found;
}

/**
 * A number typed in the locale: its digits (or ASCII ones), its separators,
 * a minus sign, and a prefix or suffix of letters or currency signs ("50 GB",
 * "€ 19,90"), which are dropped. Where the locale's decimal is no full stop
 * and the full stop is not its group separator, a full stop counts as the
 * decimal too. Empty text gives null; text that is no number NaN.
 * @param {string|null|undefined} text
 * @param {{ locale?: string }} [options]
 * @returns {number|null}
 */
export function parse(text, options = {}) {
  if (text == null) return null;
  // Without the direction marks some locales write around a sign (Arabic: U+061C before the minus).
  let rest = String(text).replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim();
  if (!rest) return null;
  const { group, decimal, digits } = symbols(options.locale);
  rest = [...rest].map((char) => {
    const index = digits.indexOf(char);
    return index >= 0 ? String(index) : char;
  }).join('');
  let negative = false;
  // A sign before or after a prefix ("-€5", "€-5"), or a trailing one ("5-").
  rest = rest.replace(/^\s*([+]|[-−‒–﹣－])/u, (sign) => {
    negative = MINUS.test(sign);
    return '';
  });
  rest = rest.replace(AFFIX, '');
  rest = rest.replace(/^([+]|[-−‒–﹣－])/u, (sign) => {
    negative = negative !== MINUS.test(sign);
    return '';
  });
  rest = rest.replace(/([-−‒–﹣－])$/u, () => {
    negative = !negative;
    return '';
  });
  if (!rest) return Number.NaN;
  // Space-like group separators: any space, also a plain one typed by hand.
  const spaceGroup = /^\s$/u.test(group);
  let integer = '';
  let fraction = null;
  for (const char of rest) {
    if (/[0-9]/.test(char)) {
      if (fraction === null) integer += char;
      else fraction += char;
    } else if (char === decimal || (char === '.' && decimal !== '.' && group !== '.')) {
      if (fraction !== null) return Number.NaN;
      fraction = '';
    } else if (char === group || (spaceGroup && /\s/u.test(char)) || char === '’' && group === "'") {
      if (fraction !== null) return Number.NaN;
    } else {
      return Number.NaN;
    }
  }
  if (!integer && !fraction) return Number.NaN;
  const value = Number(`${integer || '0'}.${fraction || '0'}`);
  return negative ? -value : value;
}

/** How many decimals a number is written with ("0.25": 2). */
function decimalsOf(value) {
  if (!Number.isFinite(value)) return 0;
  const text = String(value);
  const exponent = /e-(\d+)$/.exec(text);
  if (exponent) return Number(exponent[1]);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** The fraction digits of a currency in this locale (2 for EUR, 0 for JPY). */
function currencyDecimals(code, locale) {
  try {
    const text = formatCurrency(0, code, { locale, useGrouping: false });
    const { decimal } = symbols(locale);
    const at = text.lastIndexOf(decimal);
    if (at < 0) return 0;
    return [...text.slice(at + 1)].filter((char) => symbols(locale).digits.includes(char) || /\d/.test(char)).length;
  } catch {
    return 2;
  }
}

/**
 * A number as the field writes it: in the locale, with `decimals` fraction
 * digits (default as many as it has), grouped unless `grouping` is false.
 * null and NaN give ''.
 * @param {number|null|undefined} value
 * @param {{ locale?: string, decimals?: number, grouping?: boolean }} [options]
 * @returns {string}
 */
export function format(value, options = {}) {
  if (value == null || !Number.isFinite(value)) return '';
  const decimals = options.decimals ?? Math.min(20, decimalsOf(value));
  return formatNumber(value, {
    locale: options.locale,
    useGrouping: options.grouping !== false,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * `value` kept within `min` and `max` and rounded to `step` counted from
 * `min` (or 0), at the step's precision, so 0.1 + 0.2 stays 0.3.
 * @param {number} value
 * @param {{ min?: number|null, max?: number|null, step?: number|null, decimals?: number }} [options]
 * @returns {number}
 */
export function clamp(value, options = {}) {
  if (!Number.isFinite(value)) return value;
  const { min = null, max = null, step = null } = options;
  let next = value;
  // At the step's precision; without a step or decimals, only the float noise goes (0.1 + 0.2).
  const precision = options.decimals ?? (step ? Math.max(decimalsOf(step), decimalsOf(min ?? 0)) : 12);
  if (step && step > 0) {
    const base = min ?? 0;
    next = base + Math.round((next - base) / step) * step;
    // Rounding up past the maximum steps back below it.
    if (max != null && next > max) next -= step;
  }
  if (min != null && next < min) next = min;
  if (max != null && next > max) next = max;
  return Number(next.toFixed(Math.min(20, precision)));
}

/** The number an option holds, or null. */
function numberOption(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** The options of the attribute path. */
function readOptions(el) {
  const read = (name) => el.getAttribute(`data-ds-number-${name}`);
  return {
    min: read('min'),
    max: read('max'),
    step: read('step'),
    page: read('page'),
    decimals: read('decimals'),
    currency: read('currency'),
    unit: read('unit'),
    grouping: read('grouping') !== 'off',
  };
}

/** The settled options: numbers, the locale, and what the affixes and the spoken text need. */
function settle(raw) {
  const locale = raw.locale ?? undefined;
  const given = numberOption(raw.step);
  // Typed values snap to a step the page gave; the default step (1) only moves the keys and the steppers.
  const snap = given != null && given > 0;
  const step = snap ? given : 1;
  const currency = raw.currency ? String(raw.currency).toUpperCase() : null;
  const decimals = numberOption(raw.decimals) ?? (currency ? currencyDecimals(currency, locale) : snap ? decimalsOf(step) : null);
  let min = numberOption(raw.min);
  let max = numberOption(raw.max);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return {
    locale,
    min,
    max,
    step,
    snap,
    page: numberOption(raw.page) ?? step * 10,
    decimals: decimals == null ? undefined : Math.max(0, Math.min(20, Math.round(decimals))),
    currency,
    unit: raw.unit ? String(raw.unit) : null,
    grouping: raw.grouping !== false,
  };
}

/** Whether Intl knows the unit (else it is shown as written). */
function intlUnit(unit, locale) {
  try {
    formatNumber(1, { locale, style: 'unit', unit });
    return true;
  } catch {
    return false;
  }
}

/**
 * The affixes of a currency or a unit in the locale: the text before and
 * after the figure ("€" and "", or "" and "€").
 * @returns {{ prefix: string, suffix: string }}
 */
function affixes(settings) {
  const { currency, unit, locale, decimals } = settings;
  if (!currency && !unit) return { prefix: '', suffix: '' };
  const figure = formatNumber(1, { locale, useGrouping: false, minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  let whole = '';
  try {
    if (currency) whole = formatCurrency(1, currency, { locale, useGrouping: false, minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    else if (intlUnit(unit, locale)) whole = formatNumber(1, { locale, style: 'unit', unit, unitDisplay: 'short', useGrouping: false, minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  } catch {
    whole = '';
  }
  if (!whole) return { prefix: '', suffix: unit ?? '' };
  const at = whole.indexOf(figure);
  if (at < 0) return { prefix: '', suffix: currency ?? unit ?? '' };
  return { prefix: whole.slice(0, at).trim(), suffix: whole.slice(at + figure.length).trim() };
}

/** What a screen reader hears for the value: "50 gigabytes", "19.90 euros", else the figure. */
function spoken(value, settings) {
  if (value == null) return '';
  const { currency, unit, locale, decimals } = settings;
  const places = decimals ?? Math.min(20, decimalsOf(value));
  const digits = { minimumFractionDigits: places, maximumFractionDigits: places };
  try {
    if (currency) return formatCurrency(value, currency, { locale, currencyDisplay: 'name', ...digits });
    if (unit && intlUnit(unit, locale)) return formatNumber(value, { locale, style: 'unit', unit, unitDisplay: 'long', ...digits });
  } catch {
    // An unknown currency code: the figure and the code below.
  }
  const figure = format(value, { locale, decimals, grouping: settings.grouping });
  return unit || currency ? `${figure} ${unit ?? currency}` : figure;
}

/** Sets an attribute this module owns (morphHtml keeps it), only when it changes. */
function write(el, name, value) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function controller(el, rawOptions, signal) {
  const field = /** @type {HTMLInputElement|null} */ (el.querySelector('input.ds-input, input:not([type="hidden"])'));
  const hidden = /** @type {HTMLInputElement|null} */ (el.querySelector(':scope > input[type="hidden"]'));
  const down = /** @type {HTMLButtonElement|null} */ (el.querySelector('.ds-number__down'));
  const up = /** @type {HTMLButtonElement|null} */ (el.querySelector('.ds-number__up'));
  const listeners = new Set();
  let raw = { ...rawOptions };
  let settings = settle(raw);
  let value = null;
  let held = null;
  let spoke = null;
  // The stepper under a pointer press: it is disabled at its end only once the press ends, since a disabled
  // button gets no mousedown, and the default of that mousedown would take the focus from the field.
  let pressing = null;
  // The stepper of a touch press that has not stepped yet: a finger steps on its lift (or when the hold repeats),
  // so a scroll that starts on a stepper (pointercancel) changes nothing.
  let touched = null;

  if (!field) return idleController();
  for (const name of ['role', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext']) own(field, 'attrs', name);
  for (const button of [down, up]) {
    if (!button) continue;
    own(button, 'attrs', 'disabled');
    own(button, 'attrs', 'aria-controls');
  }
  if (!field.id) field.id = `ds-number-${(seq += 1)}`;
  write(field, 'role', 'spinbutton');
  if (!field.hasAttribute('inputmode')) field.setAttribute('inputmode', (settings.decimals ?? 1) > 0 || (settings.min ?? -1) < 0 ? 'decimal' : 'numeric');
  if (!field.hasAttribute('autocomplete')) field.setAttribute('autocomplete', 'off');
  if (down && !down.hasAttribute('aria-label')) down.setAttribute('aria-label', t('decrease'));
  if (up && !up.hasAttribute('aria-label')) up.setAttribute('aria-label', t('increase'));

  const blocked = () => field.disabled || field.readOnly || field.getAttribute('aria-disabled') === 'true';

  const paint = () => {
    const { min, max } = settings;
    write(field, 'aria-valuenow', value == null ? null : String(value));
    write(field, 'aria-valuemin', min == null ? null : String(min));
    write(field, 'aria-valuemax', max == null ? null : String(max));
    write(field, 'aria-valuetext', value == null ? null : spoken(value, settings));
    if (hidden) hidden.value = value == null ? '' : String(value);
    const off = blocked();
    for (const [button, end] of [[down, min], [up, max]]) {
      if (!button) continue;
      write(button, 'aria-controls', field.id);
      const atEnd = value != null && end != null && (button === down ? value <= end : value >= end);
      if (button !== pressing || off || !atEnd) button.disabled = off || atEnd;
    }
    const { prefix, suffix } = affixes(settings);
    if (settings.currency || settings.unit) {
      const before = el.querySelector(':scope > .ds-input-group__prefix');
      const after = el.querySelector(':scope > .ds-input-group__suffix');
      if (before) {
        before.textContent = prefix;
        before.hidden = !prefix;
      }
      if (after) {
        after.textContent = suffix;
        after.hidden = !suffix;
      }
    }
  };

  const text = () => format(value, settings);

  /** Puts `next` in (or null), writes the field, tells everyone when it changed. */
  const commit = (next, { fire = true, from = 'api' } = {}) => {
    const kept = next == null || Number.isNaN(next) ? next : clamp(next, { ...settings, step: settings.snap ? settings.step : null });
    if (Number.isNaN(kept)) {
      // No number: back to the last value.
      field.value = text();
      return;
    }
    const changed = kept !== value;
    value = kept ?? null;
    const shown = text();
    if (field.value !== shown) {
      field.value = shown;
      if (fire && from !== 'type') field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    paint();
    if (!changed || !fire) return;
    if (from !== 'type') field.dispatchEvent(new Event('change', { bubbles: true }));
    const detail = { value, text: shown };
    if (!signal?.aborted) emit(el, 'change', detail);
    listeners.forEach((fn) => fn(detail));
  };

  const stepBy = (count, from) => {
    if (blocked()) return;
    // Typed text counts first: a step goes on from what is in the field.
    const typed = parse(field.value, settings);
    const start = typed == null || Number.isNaN(typed) ? value : typed;
    const { min, step } = settings;
    let next;
    if (start == null) next = min ?? 0;
    else {
      // Counted on the grid from the minimum: off it (7 with a step of 5), the first step lands on it (5 or 10).
      const base = min ?? 0;
      const offset = (start - base) / step;
      const steps = count > 0 ? Math.floor(offset + 1e-9) + count : Math.ceil(offset - 1e-9) + count;
      next = base + steps * step;
    }
    commit(next, { from });
    if (from === 'button' && field.ownerDocument?.activeElement !== field) say();
  };

  const toEnd = (end) => {
    if (blocked() || end == null) return;
    commit(end, { from: 'key' });
  };

  /** The value after a stepper step, said once the steps stop. */
  const say = () => {
    clearTimeout(spoke);
    spoke = setTimeout(() => {
      if (value != null && !signal?.aborted) announce(spoken(value, settings));
    }, motionDuration(el, '--ds-delay-tooltip'));
  };

  const stopHold = () => {
    clearTimeout(held);
    held = null;
    touched = null;
    if (!pressing) return;
    pressing = null;
    paint();
  };

  const startHold = (direction) => {
    clearTimeout(held);
    const end = () => (direction > 0 ? settings.max : settings.min);
    const repeat = () => {
      touched = null;
      stepBy(direction, 'button');
      if (value != null && end() != null && (direction > 0 ? value >= end() : value <= end())) {
        clearTimeout(held);
        return;
      }
      held = setTimeout(repeat, motionDuration(el, '--ds-dur-instant'));
    };
    held = setTimeout(repeat, motionDuration(el, '--ds-delay-tooltip'));
  };

  const on = (target, type, fn, options = {}) => target?.addEventListener(type, fn, { signal, ...options });

  on(field, 'keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const { step, page, min, max } = settings;
    const keys = {
      ArrowUp: () => stepBy(1, 'key'),
      ArrowDown: () => stepBy(-1, 'key'),
      PageUp: () => stepBy(page / step, 'key'),
      PageDown: () => stepBy(-page / step, 'key'),
      Home: min == null ? null : () => toEnd(min),
      End: max == null ? null : () => toEnd(max),
      Enter: () => commit(parse(field.value, settings), { from: 'type' }),
    };
    const run = keys[event.key];
    if (!run) return;
    // Enter commits and still submits the form.
    if (event.key !== 'Enter') event.preventDefault();
    run();
  });
  on(field, 'blur', () => commit(parse(field.value, settings), { from: 'type' }));
  // While typing, the spinbutton's value follows what parses (the field keeps the text as typed).
  on(field, 'input', () => {
    const typed = parse(field.value, settings);
    if (typed != null && !Number.isNaN(typed)) write(field, 'aria-valuenow', String(typed));
  });

  for (const [button, direction] of [[down, -1], [up, 1]]) {
    // The focus stays in the field (or wherever it is): no mousedown default.
    on(button, 'mousedown', (/** @type {MouseEvent} */ event) => event.preventDefault());
    on(button, 'pointerdown', (/** @type {PointerEvent} */ event) => {
      if (event.button !== 0 || button.disabled) return;
      pressing = button;
      if (event.pointerType === 'touch') {
        touched = button;
      } else {
        stepBy(direction, 'button');
      }
      startHold(direction);
    });
    // Before stopHold (registered next), which forgets the touch press.
    on(button, 'pointerup', () => {
      if (touched === button) stepBy(direction, 'button');
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'lostpointercapture']) on(button, type, stopHold);
    // A click without a pointer press (a screen reader's, or Enter on a focused stepper) has detail 0; a
    // pointer's click stepped on its pointerdown already.
    on(button, 'click', (/** @type {MouseEvent} */ event) => {
      if (event.detail === 0) stepBy(direction, 'button');
    });
  }
  on(field.ownerDocument, 'ds:config', () => {
    settings = settle({ ...raw, locale: raw.locale });
    field.value = text();
    paint();
  });
  on(field.form, 'reset', () => setTimeout(() => commit(parse(field.defaultValue, settings), { from: 'type' })));

  // The first value, silently: the plain one of the hidden input or data-ds-value ("1234.5"), else what the
  // field holds, read in the locale.
  const plain = hidden?.value || el.getAttribute('data-ds-value');
  const first = plain ? numberOption(plain) : parse(field.value, settings);
  commit(first == null || Number.isNaN(first) ? null : first, { fire: false });

  return {
    get() { return value; },
    set(next) {
      const parsed = typeof next === 'string' ? parse(next, settings) : next;
      commit(parsed == null ? null : Number(parsed), { from: 'api' });
    },
    step(count = 1) { stepBy(count, 'api'); },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      raw = { ...raw, ...readOptions(el) };
      settings = settle(raw);
      commit(value, { fire: false });
    },
    destroy() {
      stopHold();
      clearTimeout(spoke);
      listeners.clear();
    },
  };
}

function idleController() {
  return { get: () => null, set() {}, step() {}, on: () => () => {}, update() {}, destroy() {} };
}

define('number', {
  attribute: 'data-ds-number',
  attributes: OPTIONS.map((name) => `data-ds-number-${name}`),
  init(el, ctx) {
    return controller(el, readOptions(el), ctx.signal);
  },
});

/**
 * A number input driven from the page; the same controller the attribute
 * path makes. Options as the attributes (see the header), plus `locale`.
 * @param {Element} el  the group (.ds-number)
 * @param {{ min?: number, max?: number, step?: number, page?: number, decimals?: number, currency?: string,
 *   unit?: string, grouping?: boolean, locale?: string }} [options]
 */
export function create(el, options = {}) {
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const made = controller(el, { ...readOptions(el), ...options }, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
  };
  return made;
}
