/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Formatting (3.0): numbers, bytes, durations, percentages, currency, lists
 * and plurals through Intl, and relative time on one shared ticking clock.
 *
 *   DS.format.number(1234.5);                     // '1,234.5'
 *   DS.format.bytes(1536);                        // '1.5 kB'
 *   DS.format.duration(3725000);                  // '1 hr, 2 min'
 *   DS.format.plural(3, { one: '{count} device', other: '{count} devices' });
 *   DS.format.relative(Date.now() - 180000);      // '3 minutes ago'
 *
 *   <time data-ds-time datetime="2026-11-04T09:00:00Z">Nov 4, 09:00</time>
 *
 * Locale: every function takes `locale`, else config().locale of core.js
 * (DS.core.config({ locale }), else the lang of <html>, else the browser's).
 * A locale the engine refuses counts as none, so a typo in lang never stops
 * a page. Formatters are expensive to make, so each is kept per locale and
 * options (FORMATTERS at most, then the cache starts again).
 *
 * Empty values: null, undefined, a blank text and what is no number or date
 * give `options.empty`, default '' (a page shows its own dash).
 *
 * The clock: clock(fn) adds a client to one timer of the page, shared by
 * every copy of the system through runtime.state('format'). fn(now) returns
 * how long until it next needs to run (ms), or nothing: every second. So a
 * table of a thousand times has one timer, it waits as long as the soonest
 * change allows and it sleeps while the page is hidden; on return every
 * client runs at once. Nothing bubbles on a tick.
 *
 * Declarative: [data-ds-time] (a behaviour of core.js, so DS.init() finds it;
 * time(el, options) is the imperative path, same controller) writes the
 * relative text from data-ds-time, else datetime, and keeps it current. The
 * absolute date goes into data-tip for the tooltips of DS.overlay, unless the
 * element has a data-tip of its own or data-ds-time-tip="off". Options as
 * attributes: data-ds-time-style, -numeric, -smallest, -largest. Both written
 * names survive a re-render: data-tip is owned state (Symbol.for('ds.owned'),
 * dom.js), and DS.dom.morphHtml patching the text back is put right before
 * paint by the element's own MutationObserver. A changed datetime applies at
 * once. An element without a date keeps its text.
 *
 * ES2022; no DOM is touched until time() runs.
 */

import { config, define, runtime } from './core.js';

/** Lengths in ms (a month and a year on average: relative time is an approximation by nature). */
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30.436875 * DAY;
const YEAR = 365.2425 * DAY;

/** The units of relative(), largest first. */
const RELATIVE_UNITS = Object.freeze([['year', YEAR], ['month', MONTH], ['week', WEEK], ['day', DAY], ['hour', HOUR], ['minute', MINUTE], ['second', SECOND]]);

/** The units of duration(), largest first. */
const DURATION_UNITS = Object.freeze([['day', DAY], ['hour', HOUR], ['minute', MINUTE], ['second', SECOND], ['millisecond', 1]]);

/** The units of bytes() that Intl knows at base 1000; base 1024 has no Intl unit, so its symbols are the standard's (and 'B' is whole bytes' at both). */
const BYTE_UNITS = Object.freeze(['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte', 'petabyte']);
const BINARY_SYMBOLS = Object.freeze(['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']);

/** How many formatters the cache holds before it starts again. */
const FORMATTERS = 256;

/** The clock's wait is never shorter than this, so a client that returns 0 cannot spin. */
const SHORTEST_WAIT = 200;

/** Nor longer than setTimeout can count: past this it fires at once, so a client that returns Infinity would spin. */
const LONGEST_WAIT = 2 ** 31 - 1;

/** The attributes of data-ds-time that name an option. */
const TIME_OPTIONS = Object.freeze(['style', 'numeric', 'smallest', 'largest']);

/**
 * This module's shared state: one clock for every copy on the page and the
 * controller of each element.
 * @type {{ clients: Set<{ fn: (now: number) => number|void, due: number }>, timer: any, listening: any, times: WeakMap<Element, any> }}
 */
const shared = runtime.state('format', () => ({
  clients: new Set(),
  timer: null,
  listening: null,
  times: new WeakMap(),
}));

/* ── Locale and cached formatters ───────────────────── */

const formatters = new Map();
const accepted = new Map();

/** The locale to use, or undefined (the engine's) when the engine refuses it. */
function localeFor(options) {
  const locale = options?.locale ?? config().locale;
  if (!accepted.has(locale)) {
    let good = locale;
    try {
      Intl.getCanonicalLocales(locale);
    } catch {
      good = undefined;
    }
    accepted.set(locale, good);
  }
  return accepted.get(locale);
}

/** The Intl formatter of `Type` for these settings, made once. A bad option (an unknown currency) still throws. */
function formatter(Type, name, locale, settings) {
  const key = `${name}|${locale ?? ''}|${JSON.stringify(settings)}`;
  let made = formatters.get(key);
  if (!made) {
    made = new Type(locale, settings);
    if (formatters.size >= FORMATTERS) formatters.clear();
    formatters.set(key, made);
  }
  return made;
}

/** The options for Intl: everything except the ones this module reads itself. */
function intlOptions(options, ...own) {
  const settings = { ...options };
  for (const name of ['locale', 'empty', ...own]) delete settings[name];
  return settings;
}

const numberFormat = (locale, settings) => formatter(Intl.NumberFormat, 'number', locale, settings);

/** `value` as a number or bigint to format, or null when it is none. */
function numeric(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `value` as a valid Date, or null. */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* ── Numbers ────────────────────────────────────────── */

/**
 * A number through Intl.NumberFormat: `options` are its options, plus
 * `locale` and `empty`.
 * @param {number|bigint|string|null|undefined} value
 * @param {{ locale?: string, empty?: string } & Intl.NumberFormatOptions} [options]
 * @returns {string}
 */
export function number(value, options = {}) {
  const parsed = numeric(value);
  if (parsed === null) return options.empty ?? '';
  return numberFormat(localeFor(options), intlOptions(options)).format(parsed);
}

/**
 * A share as a percentage: 0.42 gives '42%' (Intl's style: 1 is 100%).
 * @param {number|string|null|undefined} value
 * @param {{ locale?: string, empty?: string } & Intl.NumberFormatOptions} [options]
 * @returns {string}
 */
export function percent(value, options = {}) {
  return number(value, { ...options, style: 'percent' });
}

/**
 * An amount of money in the ISO 4217 currency `code`.
 * @param {number|string|null|undefined} value
 * @param {string} code
 * @param {{ locale?: string, empty?: string } & Intl.NumberFormatOptions} [options]
 * @returns {string}
 */
export function currency(value, code, options = {}) {
  return number(value, { ...options, style: 'currency', currency: code });
}

/**
 * A size in bytes in the largest unit that keeps a figure of at least 1:
 * `base` 1000 (default: kB, MB through Intl units) or 1024 (KiB, MiB, whose
 * symbols do not translate). Whole bytes read 'B' at either base, because
 * Intl's short form ('byte') sits oddly beside kB; `unitDisplay` still asks
 * Intl at base 1000. One fraction digit unless `options` say others; whole
 * bytes have none.
 * @param {number|string|null|undefined} value
 * @param {{ locale?: string, empty?: string, base?: 1000|1024 } & Intl.NumberFormatOptions} [options]
 * @returns {string}
 */
export function bytes(value, options = {}) {
  const parsed = numeric(value);
  if (parsed === null) return options.empty ?? '';
  const base = options.base === 1024 ? 1024 : 1000;
  const size = Number(parsed);
  const magnitude = Math.abs(size);
  let power = magnitude >= 1 ? Math.min(Math.floor(Math.log(magnitude) / Math.log(base)), BYTE_UNITS.length - 1) : 0;
  const digits = options.maximumFractionDigits ?? 1;
  const places = 10 ** digits;
  // 999.96 kB at one digit reads 1,000 kB: that is the next unit.
  if (power < BYTE_UNITS.length - 1 && Math.round((magnitude / base ** power) * places) / places >= base) power += 1;
  const settings = intlOptions(options, 'base');
  if (settings.maximumFractionDigits === undefined) settings.maximumFractionDigits = Math.max(power === 0 ? 0 : 1, settings.minimumFractionDigits ?? 0);
  const figure = size / base ** power;
  const locale = localeFor(options);
  if (base === 1024 || (power === 0 && !settings.unitDisplay)) return `${numberFormat(locale, settings).format(figure)} ${BINARY_SYMBOLS[power]}`;
  return numberFormat(locale, { ...settings, style: 'unit', unit: BYTE_UNITS[power] }).format(figure);
}

/**
 * A length of time given in ms. `style`: 'short' (default, '1 hr, 2 min'),
 * 'long', 'narrow' or 'clock' ('1:02:03', '2:05'). `parts` (default 2): how
 * many units at most, the last one rounded. `smallest`: the smallest unit
 * (default 'second'; under a second 'millisecond' unless named).
 * @param {number|string|null|undefined} value
 * @param {{ locale?: string, empty?: string, style?: 'short'|'long'|'narrow'|'clock', parts?: number, smallest?: 'day'|'hour'|'minute'|'second'|'millisecond' }} [options]
 * @returns {string}
 */
export function duration(value, options = {}) {
  const parsed = numeric(value);
  if (parsed === null) return options.empty ?? '';
  const ms = Number(parsed);
  if (!Number.isFinite(ms)) return options.empty ?? '';
  const negative = ms < 0;
  const locale = localeFor(options);
  const style = options.style ?? 'short';
  if (style === 'clock') {
    const total = Math.round(Math.abs(ms) / SECOND);
    const hours = Math.floor(total / 3600);
    const pad = numberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
    const plain = numberFormat(locale, { useGrouping: false });
    const minutes = Math.floor(total / 60) % 60;
    const seconds = pad.format(total % 60);
    const lead = hours || minutes;
    const first = plain.format(negative ? -lead : lead);
    return hours ? `${first}:${pad.format(minutes)}:${seconds}` : `${first}:${seconds}`;
  }
  const magnitude = Math.abs(ms);
  const named = DURATION_UNITS.findIndex(([unit]) => unit === options.smallest);
  const floor = named >= 0 ? named : magnitude > 0 && magnitude < SECOND - 0.5 ? DURATION_UNITS.length - 1 : DURATION_UNITS.length - 2;
  const parts = Math.max(1, options.parts ?? 2);
  /** The last unit that shows for an amount, and the amount rounded to it. */
  const fit = (amount) => {
    const largest = DURATION_UNITS.findIndex(([, size]) => amount >= size);
    const last = Math.min(floor, (largest < 0 ? floor : largest) + parts - 1);
    const size = DURATION_UNITS[last][1];
    return Math.round(amount / size) * size;
  };
  // Rounding may carry into a larger unit (59 min 59.7 s to two parts): fit once more.
  let left = fit(fit(magnitude));
  const pieces = [];
  for (const [index, [unit, size]] of DURATION_UNITS.entries()) {
    if (index > floor) break;
    const count = Math.floor(left / size + 1e-9);
    if (count) {
      pieces.push([unit, count]);
      left -= count * size;
    }
  }
  if (!pieces.length) pieces.push([DURATION_UNITS[floor][0], 0]);
  const formatted = pieces.map(([unit, count], index) => numberFormat(locale, { style: 'unit', unit, unitDisplay: style }).format(negative && index === 0 ? -count : count));
  return formatter(Intl.ListFormat, 'list', locale, { type: 'unit', style }).format(formatted);
}

/**
 * Items as a sentence: 'A, B, and C'. `type` 'conjunction' (default),
 * 'disjunction' or 'unit'; `style` 'long' (default), 'short' or 'narrow'.
 * Empty items are left out.
 * @param {Iterable<any>|null|undefined} items
 * @param {{ locale?: string, empty?: string, type?: 'conjunction'|'disjunction'|'unit', style?: 'long'|'short'|'narrow' }} [options]
 * @returns {string}
 */
export function list(items, options = {}) {
  const texts = Array.from(items ?? [], (item) => (item === null || item === undefined ? '' : String(item))).filter(Boolean);
  if (!texts.length) return options.empty ?? '';
  return formatter(Intl.ListFormat, 'list', localeFor(options), intlOptions(options)).format(texts);
}

/**
 * The form of `forms` for `count`: an exact `'=0'` first, then the category
 * of Intl.PluralRules (`one`, `few`, `many`, `other` ...), then `other`. A
 * form is a text with `{count}` (the count formatted) or a function of
 * `{ count, formatted }`. `type: 'ordinal'` picks ordinal categories;
 * `options` also take number options for the count.
 * @param {number} count
 * @param {Record<string, string|((vars: { count: number, formatted: string }) => string)>} forms
 * @param {{ locale?: string, empty?: string, type?: 'cardinal'|'ordinal' } & Intl.NumberFormatOptions} [options]
 * @returns {string}
 */
export function plural(count, forms, options = {}) {
  const parsed = numeric(count);
  if (parsed === null) return options.empty ?? '';
  const amount = Number(parsed);
  const locale = localeFor(options);
  const category = formatter(Intl.PluralRules, 'plural', locale, { type: options.type ?? 'cardinal' }).select(amount);
  const form = forms?.[`=${amount}`] ?? forms?.[category] ?? forms?.other;
  if (form === undefined || form === null) return options.empty ?? '';
  const formatted = numberFormat(locale, intlOptions(options, 'type')).format(amount);
  return typeof form === 'function' ? String(form({ count: amount, formatted })) : String(form).replace(/\{count\}/g, formatted);
}

/* ── Dates ──────────────────────────────────────────── */

/** The unit, the whole amount of it and the sign for a difference in ms. */
function relativeParts(difference, options) {
  const magnitude = Math.abs(difference);
  const named = (name, otherwise) => {
    const index = RELATIVE_UNITS.findIndex(([unit]) => unit === name);
    return index >= 0 ? index : otherwise;
  };
  const first = named(options.largest, 0);
  const last = Math.max(first, named(options.smallest, RELATIVE_UNITS.length - 1));
  let at = first;
  while (at < last && magnitude < RELATIVE_UNITS[at][1]) at += 1;
  const [unit, size] = RELATIVE_UNITS[at];
  return { unit, size, amount: Math.floor(magnitude / size) };
}

/**
 * How far `value` (a Date, a timestamp or a date text) is from `now`
 * (default: this moment), in the largest fitting unit, through
 * Intl.RelativeTimeFormat: '3 minutes ago', 'in 2 hours', 'yesterday'.
 * `style` 'long' (default), 'short' or 'narrow'; `numeric` 'auto' (default:
 * 'yesterday', 'now') or 'always'; `smallest` and `largest` limit the units.
 * @param {Date|number|string|null|undefined} value
 * @param {{ locale?: string, empty?: string, now?: Date|number, style?: 'long'|'short'|'narrow', numeric?: 'auto'|'always', smallest?: 'second'|'minute'|'hour'|'day'|'week'|'month'|'year', largest?: 'second'|'minute'|'hour'|'day'|'week'|'month'|'year' }} [options]
 * @returns {string}
 */
export function relative(value, options = {}) {
  const date = toDate(value);
  if (!date) return options.empty ?? '';
  const now = options.now === undefined ? Date.now() : Number(options.now);
  const difference = date.getTime() - now;
  const { unit, amount } = relativeParts(difference, options);
  const settings = { style: options.style ?? 'long', numeric: options.numeric ?? 'auto' };
  return formatter(Intl.RelativeTimeFormat, 'relative', localeFor(options), settings).format(difference < 0 ? -amount : amount, unit);
}

/**
 * `value` as a full date and time for a tooltip or a title:
 * Intl.DateTimeFormat with `options`, default a medium date and a short time.
 * @param {Date|number|string|null|undefined} value
 * @param {{ locale?: string, empty?: string } & Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
export function absolute(value, options = {}) {
  const date = toDate(value);
  if (!date) return options.empty ?? '';
  const settings = intlOptions(options);
  const named = Object.keys(settings).some((key) => key !== 'timeZone' && key !== 'hour12' && key !== 'hourCycle' && key !== 'calendar' && key !== 'numberingSystem');
  return formatter(Intl.DateTimeFormat, 'date', localeFor(options), named ? settings : { dateStyle: 'medium', timeStyle: 'short', ...settings }).format(date);
}

/* ── The shared clock ───────────────────────────────── */

const pageHidden = () => globalThis.document?.visibilityState === 'hidden';

/** Runs every client due at `now`, or all of them, and sets the timer for the soonest next one. */
function runClock(all = false) {
  shared.timer = null;
  const now = Date.now();
  for (const client of [...shared.clients]) {
    if (!all && client.due > now) continue;
    runClient(client, now);
  }
  armClock();
}

function runClient(client, now) {
  let wait;
  try {
    wait = client.fn(now);
  } catch (error) {
    if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
    else globalThis.console?.error?.(error);
  }
  client.due = now + (typeof wait === 'number' && wait >= 0 ? wait : SECOND);
}

function armClock() {
  clearTimeout(shared.timer);
  shared.timer = null;
  if (!shared.clients.size) {
    shared.listening?.();
    shared.listening = null;
    return;
  }
  const doc = globalThis.document;
  if (doc && !shared.listening && typeof doc.addEventListener === 'function') {
    const wake = () => {
      if (pageHidden()) {
        clearTimeout(shared.timer);
        shared.timer = null;
      } else runClock(true);
    };
    // Another locale changes every text now, not at its next tick. Hidden, the return brings it anyway.
    const reformat = (/** @type {CustomEvent} */ event) => {
      if (event.detail?.changed?.includes('locale') && !pageHidden()) runClock(true);
    };
    doc.addEventListener('visibilitychange', wake);
    doc.addEventListener('ds:config', reformat);
    shared.listening = () => {
      doc.removeEventListener('visibilitychange', wake);
      doc.removeEventListener('ds:config', reformat);
    };
  }
  if (pageHidden()) return;
  let soonest = Infinity;
  for (const client of shared.clients) soonest = Math.min(soonest, client.due);
  shared.timer = setTimeout(() => runClock(), Math.min(LONGEST_WAIT, Math.max(SHORTEST_WAIT, soonest - Date.now())));
  shared.timer?.unref?.();
}

/**
 * Adds `fn` to the page's one clock and runs it now; returns the function
 * that takes it off. fn(now) returns how long until it next needs to run
 * (ms), or nothing: every second. The clock sleeps while the page is hidden
 * and runs every client on return.
 * @param {(now: number) => number|void} fn
 * @returns {() => void}
 */
export function clock(fn) {
  const client = { fn, due: 0 };
  shared.clients.add(client);
  runClient(client, Date.now());
  armClock();
  return () => {
    if (shared.clients.delete(client)) armClock();
  };
}

/* ── data-ds-time ───────────────────────────────────── */

/** The owned-state record of dom.js (shared by every copy), so a morph leaves data-tip alone. */
const OWNED = Symbol.for('ds.owned');

function own(element, name) {
  const record = element[OWNED] ?? (element[OWNED] = { attrs: new Map(), classes: new Map(), props: new Map() });
  record.attrs.set(name, (record.attrs.get(name) ?? 0) + 1);
}

function disown(element, name) {
  const map = element[OWNED]?.attrs;
  const count = map?.get(name) ?? 0;
  if (count > 1) map.set(name, count - 1);
  else map?.delete(name);
}

/** How long until the relative text of a difference changes, at most an hour (a window left open crosses a day anyway). */
function nextChange(difference, size) {
  const magnitude = Math.abs(difference);
  const rest = magnitude % size;
  // Past: it grows to the next whole unit. Future: it shrinks under this one.
  return Math.min(HOUR, difference < 0 ? size - rest : rest + 1);
}

/**
 * Keeps the relative time of `el` current on the shared clock (see the
 * header) and returns its controller; once per element. `options` go before
 * the data-ds-time-* attributes. `value`: the date to start from (written to
 * the element). set(value) writes a new date; get() returns `{ value, text }`;
 * on('change', fn) runs when the text changed. A controller whose element
 * left the document stops at the next tick; one whose element never entered
 * it has its text at once and waits for it, so destroy() it if it never will.
 * @param {Element|null|undefined} el
 * @param {{ value?: Date|number|string, style?: 'long'|'short'|'narrow', numeric?: 'auto'|'always', smallest?: 'second'|'minute'|'hour'|'day'|'week'|'month'|'year', largest?: 'second'|'minute'|'hour'|'day'|'week'|'month'|'year', tip?: boolean, locale?: string }} [options]
 * @returns {{ get: () => { value: Date|null, text: string }, set: (value: Date|number|string|null) => void, on: (type: 'change', fn: (detail: { value: Date|null, text: string }) => void) => () => void, update: () => void, destroy: () => void }}
 */
export function time(el, options = {}) {
  const idle = { get: () => ({ value: null, text: '' }), set() {}, on: () => () => {}, update() {}, destroy() {} };
  if (!el?.ownerDocument) return idle;
  const existing = shared.times.get(el);
  if (existing) return existing;

  const listeners = new Set();
  let live = true;
  let seen = el.isConnected;
  let wroteTip = false;
  let stop = () => {};
  let watcher = null;

  const source = () => el.getAttribute('data-ds-time') || el.getAttribute('datetime') || null;
  const setting = (name) => options[name] ?? (el.getAttribute(`data-ds-time-${name}`) || undefined);
  const settings = () => {
    const out = {};
    for (const name of TIME_OPTIONS) {
      const value = setting(name);
      if (value !== undefined) out[name] = value;
    }
    if (options.locale) out.locale = options.locale;
    return out;
  };

  /** The tip: the absolute date, unless the page wrote one or turned it off. */
  const writeTip = (date) => {
    const off = options.tip === false || el.getAttribute('data-ds-time-tip') === 'off';
    if (off || !date) {
      if (wroteTip) {
        wroteTip = false;
        el.removeAttribute('data-tip');
        disown(el, 'data-tip');
      }
      return;
    }
    if (!wroteTip) {
      if (el.hasAttribute('data-tip')) return;
      wroteTip = true;
      own(el, 'data-tip');
    }
    const text = absolute(date, options.locale ? { locale: options.locale } : {});
    if (el.getAttribute('data-tip') !== text) el.setAttribute('data-tip', text);
  };

  /** Writes the text for `now`; returns how long until it changes. */
  const render = (now = Date.now()) => {
    const date = toDate(source());
    writeTip(date);
    if (!date) return HOUR;
    const current = settings();
    const text = relative(date, { ...current, now });
    if (el.textContent !== text) {
      // A lone text node changes in place: a screen reader's position and a selection stay.
      if (el.childNodes.length === 1 && el.firstChild.nodeType === 3) el.firstChild.nodeValue = text;
      else el.textContent = text;
      watcher?.takeRecords();
      for (const fn of [...listeners]) fn({ value: date, text });
    }
    return nextChange(date.getTime() - now, relativeParts(date.getTime() - now, current).size);
  };

  const controller = {
    get() {
      return { value: toDate(source()), text: el.textContent ?? '' };
    },
    set(value) {
      const date = toDate(value);
      const name = el.getAttribute('data-ds-time') || el.localName !== 'time' ? 'data-ds-time' : 'datetime';
      el.setAttribute(name, date ? date.toISOString() : '');
      render();
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      if (live) render();
    },
    destroy() {
      if (!live) return;
      live = false;
      stop();
      watcher?.disconnect();
      listeners.clear();
      if (wroteTip) {
        wroteTip = false;
        el.removeAttribute('data-tip');
        disown(el, 'data-tip');
      }
      if (shared.times.get(el) === controller) shared.times.delete(el);
    },
  };

  shared.times.set(el, controller);
  if (options.value !== undefined) {
    const date = toDate(options.value);
    if (date) el.setAttribute(el.getAttribute('data-ds-time') || el.localName !== 'time' ? 'data-ds-time' : 'datetime', date.toISOString());
  }

  // A morph that writes the markup's text back is corrected before paint.
  const Observer = el.ownerDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  if (typeof Observer === 'function') {
    watcher = new Observer(() => {
      if (live) render();
    });
    watcher.observe(el, { childList: true, characterData: true, subtree: true });
  }
  // Not in the document yet: the clock below only waits for it, so the text comes now.
  if (!seen) render();
  stop = clock((now) => {
    if (!el.isConnected) {
      if (seen) {
        controller.destroy();
        return HOUR;
      }
      return SECOND;
    }
    seen = true;
    return render(now);
  });
  return controller;
}

define('time', {
  attribute: 'data-ds-time',
  attributes: ['datetime', ...TIME_OPTIONS.map((name) => `data-ds-time-${name}`), 'data-ds-time-tip'],
  init: (el) => time(el),
});
