/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The duration input (DS.duration): a text field that reads a length of
 * time the way people write it ("1h 30m", "90 min", "1:30", "1.5h", "2
 * days 4 hours", PT1H30M) and writes it back in the locale's short form
 * once it is left. A spinbutton: the arrow keys step it.
 *
 *   <input class="ds-input ds-duration" type="text" aria-labelledby="timeout-label" data-ds-duration
 *          data-ds-value="PT1H30M" [data-ds-duration-step="15m"] [data-ds-duration-min="1m"]
 *          [data-ds-duration-max="7d"] [data-ds-duration-unit="m"] [data-ds-duration-smallest="minute"]
 *          [data-ds-duration-name="timeout"]>
 *
 *   const field = DS.duration.create(input);
 *   field.get();               // 'PT1H30M' ('' while empty or unreadable)
 *   field.ms();                // 5400000
 *   field.set('45m');          // no event; field.set(v, { emit: true }) sends ds:change
 *   DS.duration.parse('1h 30m');        // 5400000 (ms), null for nothing readable
 *   DS.duration.iso(5400000);           // 'PT1H30M'
 *
 * Reading: numbers with a unit each, in any order and with or without
 * spaces; the unit words of the locale (through Intl: "h", "hr", "hours",
 * "Std.", "Stunden") and the English ones (w, d, h, m, s, ms and their words);
 * a bare number after a unit takes the next smaller unit ("1h 30"), a bare
 * number alone takes `unit` (default minutes); a clock "1:30" (h:mm) or
 * "1:30:15"; an ISO 8601 duration (P1DT2H30M); decimals with a point or a
 * comma ("1.5h", "1,5 h").
 *
 * Writing: on leaving the field (or Enter) the text becomes the locale's
 * narrow form through DS.format.duration ("1h 30m", "1 Std., 30 Min."),
 * rounded to `smallest` (default second); an unreadable text stays as typed
 * and the field is aria-invalid, as one outside min and max.
 *
 * Keys (the WAI-ARIA spinbutton): ArrowUp and ArrowDown add and take a
 * `step` (default 1 minute), PageUp and PageDown ten steps, Home and End go
 * to min and max when set; never below zero. aria-valuenow is the value in
 * seconds, aria-valuetext its long words ("1 hour, 30 minutes").
 *
 * ds:change ({ value, ms, text, valid }) once the value changed, when the
 * field is left, Enter is pressed or a key stepped it. A name keeps a
 * hidden input with the ISO value, for a form.
 *
 * Strings: none of its own; the units come from Intl in the page's locale.
 *
 * ES2022; no progressive feature of its own.
 */
import { config, define, emit } from './core.js';
import { duration as formatDuration } from './format.js';

const UNITS = [['week', 604800000], ['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000], ['millisecond', 1]];
const SIZE = Object.fromEntries(UNITS);

/** The English words and symbols, read in every locale. */
const ENGLISH = {
  week: ['w', 'wk', 'wks', 'week', 'weeks'],
  day: ['d', 'day', 'days'],
  hour: ['h', 'hr', 'hrs', 'hour', 'hours'],
  minute: ['m', 'min', 'mins', 'minute', 'minutes'],
  second: ['s', 'sec', 'secs', 'second', 'seconds'],
  millisecond: ['ms', 'msec', 'millisecond', 'milliseconds'],
};

const aliases = new Map();

/**
 * The unit words of a locale and the English ones, lower case and without a
 * final dot (word -> unit), and the words that join a list in it.
 */
function wordsOf(locale) {
  if (aliases.has(locale)) return aliases.get(locale);
  const words = new Map();
  for (const [unit, list] of Object.entries(ENGLISH)) for (const word of list) words.set(word, unit);
  for (const [unit] of UNITS) {
    for (const unitDisplay of ['narrow', 'short', 'long']) {
      for (const count of [1, 2, 5]) {
        try {
          const text = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay }).format(count);
          const word = normal(text.replace(/[\d\s  .,]+/gu, ' ').trim());
          // English words win where a locale's word collides with them.
          if (word && !words.has(word)) words.set(word, unit);
        } catch {
          // An engine without this unit: the English words stand.
        }
      }
    }
  }
  // The words that join the parts in the locale's lists ("and", "und").
  const joiners = new Set(['and']);
  for (const type of ['unit', 'conjunction']) {
    for (const style of ['long', 'short', 'narrow']) {
      try {
        const text = new Intl.ListFormat(locale, { type, style }).format(['1', '2', '3']);
        for (const word of text.split(/[\d\s,;]+/u)) if (word) joiners.add(normal(word));
      } catch {
        // An engine without ListFormat: "and" stands.
      }
    }
  }
  const out = { words, joiners };
  aliases.set(locale, out);
  return out;
}

const normal = (word) => word.toLocaleLowerCase().replace(/\.$/, '');

function localeOf(locale) {
  return locale || config().locale || 'en';
}

const ISO = /^P(?:(\d+(?:[.,]\d+)?)W)?(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i;
const CLOCK = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/;

const number = (text) => Number(String(text).replace(',', '.'));

/**
 * The milliseconds of a duration as people write it (see the header), or
 * null when nothing in it reads as one. `unit` is what a bare number counts
 * ('day', 'hour', 'minute', 'second' or their symbols; default minute).
 * @param {string|number|null|undefined} text
 * @param {{ unit?: string, locale?: string }} [options]
 * @returns {number|null}
 */
export function parse(text, options = {}) {
  if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? text : null;
  const source = String(text ?? '').trim();
  if (!source) return null;
  const iso = ISO.exec(source.replace(/\s+/g, ''));
  if (iso && /\d/.test(source)) {
    const [, weeks, days, hours, minutes, seconds] = iso.map((part) => (part ? number(part) : 0));
    return Math.round(((weeks * 7 + days) * 24 + hours) * 3600000 + minutes * 60000 + seconds * 1000);
  }
  const clock = CLOCK.exec(source);
  if (clock) return (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0)) * 1000;
  const { words, joiners } = wordsOf(localeOf(options.locale));
  const fallback = unitOf(options.unit) ?? 'minute';
  let total = 0;
  let found = false;
  let previous = -1;
  for (const match of source.matchAll(/(\d+(?:[.,]\d+)?)\s*([\p{L}µ.]*)/gu)) {
    const word = normal(match[2]);
    let unit = word ? words.get(word) ?? null : null;
    if (word && !unit) return null;
    // A bare number: after a unit the next smaller one ("1h 30"), else the default.
    if (!unit) unit = previous >= 0 ? UNITS[Math.min(previous + 1, UNITS.length - 1)][0] : fallback;
    previous = UNITS.findIndex(([name]) => name === unit);
    total += number(match[1]) * SIZE[unit];
    found = true;
  }
  // Anything left but numbers, units, spaces and the locale's joining words: not a duration.
  const rest = source.replace(/(\d+(?:[.,]\d+)?)\s*([\p{L}µ.]*)/gu, ' ').replace(/[\s,;+&]+/g, ' ').trim();
  if (rest && !rest.split(' ').every((word) => joiners.has(normal(word)))) return null;
  return found ? Math.round(total) : null;
}

/** A unit name or symbol ('m', 'minutes') as one of UNITS, or null. */
function unitOf(name) {
  if (!name) return null;
  const word = normal(String(name));
  if (SIZE[word]) return word;
  for (const [unit, list] of Object.entries(ENGLISH)) if (list.includes(word)) return unit;
  return null;
}

/**
 * The ISO 8601 text of a duration in ms (PT1H30M, P2DT4H, PT0S), '' for
 * none.
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function iso(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  let left = Math.round(ms);
  const take = (size) => {
    const count = Math.floor(left / size);
    left -= count * size;
    return count;
  };
  const days = take(SIZE.day);
  const hours = take(SIZE.hour);
  const minutes = take(SIZE.minute);
  const seconds = left / 1000;
  const time = `${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${seconds ? `${seconds}S` : ''}`;
  if (!days && !time) return 'PT0S';
  return `P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}

/**
 * A duration in ms for people, in the locale: `style` 'narrow' (default,
 * "1h 30m"), 'short' or 'long' ("1 hour, 30 minutes"), down to `smallest`.
 * @param {number|null|undefined} ms
 * @param {{ style?: 'narrow'|'short'|'long', smallest?: string, locale?: string }} [options]
 * @returns {string}
 */
export function format(ms, options = {}) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const smallest = unitOf(options.smallest) ?? 'second';
  return formatDuration(ms, { style: options.style ?? 'narrow', parts: 5, smallest, locale: localeOf(options.locale) });
}

const controllers = new WeakMap();

function readOptions(element) {
  const data = element.dataset ?? {};
  const options = {};
  if ('dsValue' in data) options.value = data.dsValue;
  for (const key of ['step', 'min', 'max', 'unit', 'smallest', 'name']) {
    const value = data[`dsDuration${key[0].toUpperCase()}${key.slice(1)}`];
    if (value) options[key] = value;
  }
  return options;
}

/**
 * The duration input's controller, the one [data-ds-duration] makes; once
 * per element. Options: `value`, `step`, `min`, `max` (durations as text or
 * ms), `unit` (what a bare number counts), `smallest` (the unit it rounds to
 * when written back), `name` (a hidden input with the ISO value), `locale`.
 * @param {HTMLInputElement} element
 * @param {object} [options]
 * @returns {any}
 */
export function create(element, options = {}) {
  const existing = controllers.get(element);
  if (existing) {
    existing.update(options);
    return existing;
  }
  const abort = new AbortController();
  const { signal } = abort;
  const listeners = new Map();
  const doc = element.ownerDocument;
  const settings = { ...readOptions(element), ...options };
  const state = { ms: null, last: '' };

  const read = (text) => parse(text, { unit: settings.unit, locale: settings.locale });
  const bound = (key) => (settings[key] === undefined || settings[key] === '' ? null : read(settings[key]));
  const stepMs = () => read(settings.step) || SIZE.minute;
  const smallestMs = () => SIZE[unitOf(settings.smallest) ?? 'second'];
  const round = (ms) => Math.round(ms / smallestMs()) * smallestMs();
  const blocked = () => /** @type {any} */ (element).disabled || element.getAttribute('aria-disabled') === 'true' || /** @type {any} */ (element).readOnly;

  element.classList.add('ds-duration');
  element.setAttribute('role', 'spinbutton');
  if (!element.hasAttribute('inputmode')) element.setAttribute('inputmode', 'text');
  element.setAttribute('autocomplete', 'off');
  element.setAttribute('spellcheck', 'false');

  function validOf(ms, text) {
    if (ms === null) return !String(text ?? '').trim();
    const min = bound('min');
    const max = bound('max');
    return (min === null || ms >= min) && (max === null || ms <= max);
  }

  /** Writes the ARIA and the hidden input of the value. */
  function paint(valid) {
    const min = bound('min');
    const max = bound('max');
    element.setAttribute('aria-valuemin', String(Math.round((min ?? 0) / 1000)));
    if (max !== null) element.setAttribute('aria-valuemax', String(Math.round(max / 1000)));
    else element.removeAttribute('aria-valuemax');
    if (state.ms === null) {
      element.removeAttribute('aria-valuenow');
      element.removeAttribute('aria-valuetext');
    } else {
      element.setAttribute('aria-valuenow', String(Math.round(state.ms / 1000)));
      element.setAttribute('aria-valuetext', format(state.ms, { style: 'long', smallest: settings.smallest, locale: settings.locale }));
    }
    if (valid) element.removeAttribute('aria-invalid');
    else element.setAttribute('aria-invalid', 'true');
    let hidden = settings.name ? element.parentElement?.querySelector(`input[type="hidden"][data-ds-duration-for="${settings.name}"]`) : null;
    if (settings.name && !hidden && element.parentElement) {
      hidden = doc.createElement('input');
      hidden.type = 'hidden';
      hidden.name = settings.name;
      hidden.setAttribute('data-ds-duration-for', settings.name);
      element.after(hidden);
    }
    if (hidden) /** @type {HTMLInputElement} */ (hidden).value = iso(state.ms);
  }

  function fire(type, detail) {
    emit(element, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  }

  /** Reads the text, writes it back in the locale's form when it reads, and tells what changed. */
  function commit(notify = true) {
    const input = /** @type {HTMLInputElement} */ (element);
    const text = input.value;
    const parsed = read(text);
    state.ms = parsed === null ? null : round(parsed);
    if (state.ms !== null) input.value = format(state.ms, { smallest: settings.smallest, locale: settings.locale });
    const valid = validOf(state.ms, text);
    paint(valid);
    const value = iso(state.ms);
    const key = `${value}|${valid}|${state.ms === null ? text : ''}`;
    if (key === state.last) return;
    state.last = key;
    if (notify) fire('change', { value, ms: state.ms, text: input.value, valid });
  }

  /** A step by `by` ms from the value (an empty or unreadable one starts at min, else 0). */
  function step(by, to) {
    const min = bound('min');
    const max = bound('max');
    const current = read(/** @type {HTMLInputElement} */ (element).value) ?? min ?? 0;
    let next = to === 'min' ? min ?? 0 : to === 'max' ? max ?? current : current + by;
    next = Math.max(0, min ?? 0, next);
    if (max !== null) next = Math.min(max, next);
    /** @type {HTMLInputElement} */ (element).value = format(round(next), { smallest: settings.smallest, locale: settings.locale });
    commit();
  }

  element.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const moves = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 };
    if (event.key in moves) {
      event.preventDefault();
      if (!blocked()) step(moves[event.key] * stepMs());
      return;
    }
    if ((event.key === 'Home' && bound('min') !== null) || (event.key === 'End' && bound('max') !== null)) {
      event.preventDefault();
      if (!blocked()) step(0, event.key === 'Home' ? 'min' : 'max');
      return;
    }
    if (event.key === 'Enter' && !blocked()) commit();
  }, { signal });
  element.addEventListener('change', () => commit(), { signal });
  element.addEventListener('blur', () => commit(), { signal });
  // While typing the field is judged only once it is left: no error mid-word.
  element.addEventListener('input', () => {
    if (element.getAttribute('aria-invalid') === 'true' && validOf(read(/** @type {HTMLInputElement} */ (element).value), /** @type {HTMLInputElement} */ (element).value)) element.removeAttribute('aria-invalid');
  }, { signal });

  function setValue(value) {
    const ms = typeof value === 'number' ? value : read(value);
    /** @type {HTMLInputElement} */ (element).value = ms === null ? '' : format(round(ms), { smallest: settings.smallest, locale: settings.locale });
  }
  if ('value' in settings) setValue(settings.value);
  commit(false);
  doc.addEventListener('ds:config', () => {
    if (state.ms !== null) setValue(state.ms);
    commit(false);
  }, { signal });

  const controller = {
    element,
    /** The value as ISO 8601 text ('' while empty or unreadable). */
    get: () => iso(state.ms),
    /** The value in ms, or null. */
    ms: () => state.ms,
    /** Sets the value (text, ISO or ms); `{ emit: true }` sends ds:change. */
    set(value, { emit: notify = false } = {}) {
      setValue(value);
      commit(notify);
      return iso(state.ms);
    },
    /** Whether the value reads and is within min and max. */
    valid: () => validOf(state.ms, /** @type {HTMLInputElement} */ (element).value),
    /** New options (those of create()), applied at once. */
    update(next = {}) {
      Object.assign(settings, next);
      if ('value' in next) setValue(next.value);
      commit(false);
    },
    on(type, fn) {
      const key = String(type).replace(/^ds:/, '');
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key)?.delete(fn);
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      listeners.clear();
      controllers.delete(element);
    },
  };
  controllers.set(element, controller);
  return controller;
}

define('duration', {
  attribute: 'data-ds-duration',
  attributes: ['data-ds-value', 'data-ds-duration-step', 'data-ds-duration-min', 'data-ds-duration-max', 'data-ds-duration-unit', 'data-ds-duration-smallest', 'data-ds-duration-name'],
  init(element) {
    const controller = create(/** @type {HTMLInputElement} */ (element));
    return {
      ...controller,
      // Another option keeps what the person typed or picked; only a changed data-ds-value replaces it.
      update(names = []) {
        const next = readOptions(element);
        if (!names.includes('data-ds-value')) delete next.value;
        controller.update(next);
      },
    };
  },
});
