/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The segmented date field (DS.datefield): a date, a time, a date and a
 * time, or a range of dates, typed segment by segment (the WAI-ARIA
 * spinbutton pattern, one spinbutton per part), in the order, separators
 * and hour cycle of the page's locale.
 *
 *   <div class="ds-datefield" role="group" aria-labelledby="due-label" data-ds-datefield
 *        data-ds-value="2026-11-04" [data-ds-datefield-type="date | time | datetime | range"]
 *        [data-ds-datefield-min] [data-ds-datefield-max] [data-ds-datefield-name="due"]
 *        [data-ds-datefield-seconds] [data-ds-datefield-hour-cycle="h12 | h23"]
 *        [data-ds-datefield-zone="local | UTC"]></div>
 *
 *   const field = DS.datefield.create(el, { type: 'datetime' });
 *   field.get();                       // '2026-11-04T09:30' ('' while a part is missing)
 *   field.set('2026-11-04T18:00');     // no event; field.set(v, { emit: true }) sends ds:change
 *   field.instant();                   // the Date of that wall time in its zone
 *
 * Values are ISO text: 2026-11-04 (date), 09:30 or 09:30:15 (time),
 * 2026-11-04T09:30 (datetime, a wall time; the zone is the field's), and
 * 2026-11-01/2026-11-07 (range).
 *
 * Every segment is a focusable spinbutton (contenteditable, so a phone
 * opens its number pad; inputmode numeric) whose text the script writes:
 * ArrowUp and ArrowDown step it (wrapping), PageUp and PageDown take a
 * bigger step, Home and End go to its least and greatest value, digits
 * type it (and move on once no further digit could fit), a separator moves
 * on, Backspace and Delete clear it (and go back once it is empty),
 * ArrowLeft and ArrowRight move between segments (in the writing
 * direction). A day period takes the first letter of its words (a, p).
 * Pasting a whole date fills every part. A click on the field outside the
 * segments, or on its label, focuses the first empty segment.
 *
 * ds:change ({ value, valid }) on the field whenever the value changes,
 * also to '' when a part is cleared; `valid` is false outside min and max,
 * on a day the `disabled` option blocks (the days a picker's calendar
 * blocks: typed or pasted, they count as invalid too), for a range that
 * ends before it starts, and for an unfinished value.
 * aria-invalid on the group follows. A name (data-ds-datefield-name) keeps
 * a hidden input with the value, for a form.
 *
 * The zone (datetime): data-ds-datefield-zone shows the zone of the wall
 * time at the field's end (.ds-datefield__zone: its offset, the long name
 * as its description), and instant() turns the value into a Date in it.
 *
 * Strings: the segment names, the month names, the day periods and the
 * zone names come from Intl; empty (an empty segment's value text),
 * rangeStart and rangeEnd from DS.core.config().
 *
 * ES2022; no progressive feature of its own.
 */
import { config, define, emit, t } from './core.js';
import { parse as parseDate, iso, daysIn, compare, today, available } from './calendar.js';

const DATE_PARTS = ['year', 'month', 'day'];
const TIME_PARTS = ['hour', 'minute', 'second', 'dayPeriod'];
const NUMERIC = new Set(['year', 'month', 'day', 'hour', 'minute', 'second']);

/** How far PageUp and PageDown step each part. */
const BIG_STEP = { year: 10, month: 3, day: 7, hour: 3, minute: 15, second: 15, dayPeriod: 1 };

/* ── Locale ─────────────────────────────────────────── */

const accepted = new Map();

function localeOf(locale) {
  const wanted = locale || config().locale || 'en';
  if (!accepted.has(wanted)) {
    let good = 'en';
    try {
      good = Intl.getCanonicalLocales(wanted)[0] ?? 'en';
      new Intl.DateTimeFormat(good);
    } catch {
      good = 'en';
    }
    accepted.set(wanted, good);
  }
  return accepted.get(wanted);
}

/**
 * The hour cycle of a locale, as 'h12' or 'h23' ('h11' and 'h24' fold into
 * them); `wanted` overrides it.
 * @param {string} [locale]
 * @param {string} [wanted]
 * @returns {'h12'|'h23'}
 */
export function hourCycle(locale, wanted) {
  if (wanted === 'h12' || wanted === 'h11') return 'h12';
  if (wanted === 'h23' || wanted === 'h24') return 'h23';
  const cycle = new Intl.DateTimeFormat(localeOf(locale), { hour: 'numeric' }).resolvedOptions().hourCycle;
  return cycle === 'h11' || cycle === 'h12' ? 'h12' : 'h23';
}

/**
 * The parts of a field in the locale's order: { type } for a segment
 * (year, month, day, hour, minute, second, dayPeriod; a range's carry
 * `group` 'start' or 'end'), { type: 'literal', value } for what stands
 * between them.
 * @param {'date'|'time'|'datetime'|'range'} type
 * @param {string} [locale]
 * @param {{ hourCycle?: string, seconds?: boolean }} [options]
 * @returns {{ type: string, value?: string, group?: string }[]}
 */
export function layout(type, locale, options = {}) {
  const loc = localeOf(locale);
  const date = { year: 'numeric', month: '2-digit', day: '2-digit' };
  const cycle = hourCycle(loc, options.hourCycle);
  const time = { hour: '2-digit', minute: '2-digit', ...(options.seconds ? { second: '2-digit' } : {}), hourCycle: cycle };
  const settings = type === 'time' ? time : type === 'datetime' ? { ...date, ...time } : date;
  const sample = new Date(Date.UTC(2026, 10, 24, 21, 45, 30));
  const parts = [];
  for (const part of new Intl.DateTimeFormat(loc, { ...settings, timeZone: 'UTC' }).formatToParts(sample)) {
    if (NUMERIC.has(part.type) || part.type === 'dayPeriod') parts.push({ type: part.type });
    else if (parts.at(-1)?.type === 'literal') parts.at(-1).value += part.value;
    else if (parts.length) parts.push({ type: 'literal', value: part.value });
  }
  while (parts.at(-1)?.type === 'literal') parts.pop();
  if (type !== 'range') return parts;
  return [
    ...parts.map((part) => (part.type === 'literal' ? part : { ...part, group: 'start' })),
    { type: 'literal', value: ' – ', between: true },
    ...parts.map((part) => (part.type === 'literal' ? part : { ...part, group: 'end' })),
  ];
}

/* ── Values ─────────────────────────────────────────── */

const pad = (number, size = 2) => String(number).padStart(size, '0');

const ISO_TIME = /^(\d{2}):(\d{2})(?::(\d{2}))?/;

/** The parts of a value (ISO text) of a type, as numbers: { year, month, day, hour, minute, second } (hour 0-23). */
function partsOf(type, value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (type === 'time') {
    const match = ISO_TIME.exec(text.includes('T') ? text.slice(text.indexOf('T') + 1) : text);
    if (!match) return null;
    const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    return hour < 24 && minute < 60 && second < 60 ? { hour, minute, second } : null;
  }
  const date = parseDate(text);
  if (!date) return null;
  if (type !== 'datetime') return { ...date };
  const time = partsOf('time', text.includes('T') ? text.slice(text.indexOf('T') + 1) : '00:00');
  return time ? { ...date, ...time } : null;
}

/** The ISO text of parts of a type (seconds only when the field shows them). */
function textOf(type, parts, seconds) {
  const time = () => `${pad(parts.hour)}:${pad(parts.minute)}${seconds ? `:${pad(parts.second ?? 0)}` : ''}`;
  if (type === 'time') return time();
  const date = iso(parts);
  return type === 'datetime' ? `${date}T${time()}` : date;
}

/* ── Zones ──────────────────────────────────────────── */

/** The zone a field names: 'local' (or empty) is the browser's. */
function zoneOf(zone) {
  if (!zone || zone === 'local') return Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone;
}

/**
 * A zone for people: `short` its offset ("GMT+1"), `long` its name
 * ("Central European Standard Time"), at `at` (default now).
 * @param {string} [timeZone]  an IANA name, 'local' or nothing: the browser's
 * @param {{ locale?: string, at?: Date }} [options]
 * @returns {{ id: string, short: string, long: string }}
 */
export function zoneName(timeZone, options = {}) {
  const id = zoneOf(timeZone);
  const at = options.at ?? new Date();
  const name = (style) => {
    try {
      return new Intl.DateTimeFormat(localeOf(options.locale), { timeZone: id, timeZoneName: style }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? id;
    } catch {
      return id;
    }
  };
  return { id, short: name('shortOffset'), long: name('long') };
}

/** The offset (ms) of a zone at an instant: the zone's wall time minus UTC. */
function offsetAt(id, epoch) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: id, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(epoch));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - Math.floor(epoch / 1000) * 1000;
}

/**
 * The instant of a wall time (ISO text 2026-11-04T09:30, or a date: its
 * midnight) in a zone (an IANA name; 'local' or nothing: the browser's).
 * A wall time that a change of clocks skips moves forward with it.
 * @param {string} value
 * @param {string} [timeZone]
 * @returns {Date|null}
 */
export function toInstant(value, timeZone) {
  const parts = partsOf('datetime', String(value ?? '').includes('T') ? value : `${value}T00:00`);
  if (!parts) return null;
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
  if (!timeZone || timeZone === 'local') {
    return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
  }
  try {
    // Twice: the offset at the first guess may differ from the one at the answer.
    let epoch = wall - offsetAt(timeZone, wall);
    epoch = wall - offsetAt(timeZone, epoch);
    return new Date(epoch);
  } catch {
    return null;
  }
}

/* ── Segments ───────────────────────────────────────── */

/** The least and greatest value of a segment, given the other parts so far. */
function bounds(type, values, cycle) {
  switch (type) {
    case 'year': return [1, 9999];
    case 'month': return [1, 12];
    case 'day': return [1, values.month ? daysIn(values.year ?? 2000, values.month) : 31];
    case 'hour': return cycle === 'h12' ? [1, 12] : [0, 23];
    case 'minute':
    case 'second': return [0, 59];
    default: return [0, 1];
  }
}

/**
 * One digit typed into a numeric segment: the new value and what was typed
 * so far, and whether the segment is done (no further digit could fit).
 * @param {{ min: number, max: number, typed: string, digit: string, size?: number }} input
 * @returns {{ value: number|null, typed: string, done: boolean }}
 */
export function typeDigit(input) {
  const { min, max, typed, digit, size } = input;
  const width = size ?? String(max).length;
  let next = `${typed}${digit}`;
  if (Number(next) > max || next.length > width) next = digit;
  const number = Number(next);
  const done = next.length >= width || number * 10 > max;
  return { value: number < min ? null : number, typed: next, done: done && number >= min };
}

const formats = new Map();

function numberFormat(locale, size) {
  const key = `${locale}|${size}`;
  if (!formats.has(key)) formats.set(key, new Intl.NumberFormat(locale, { minimumIntegerDigits: size, useGrouping: false }));
  return formats.get(key);
}

/** The words of the day periods of a locale: [am, pm]. */
function dayPeriods(locale) {
  const format = new Intl.DateTimeFormat(locale, { hour: 'numeric', hourCycle: 'h12', timeZone: 'UTC' });
  const word = (hour) => format.formatToParts(new Date(Date.UTC(2026, 0, 1, hour))).find((part) => part.type === 'dayPeriod')?.value ?? (hour < 12 ? 'AM' : 'PM');
  return [word(9), word(21)];
}

/** The name of a part ("month"), through Intl.DisplayNames. */
function fieldName(locale, type) {
  try {
    return new Intl.DisplayNames(locale, { type: 'dateTimeField' }).of(type) ?? type;
  } catch {
    return type;
  }
}

/* ── The field ──────────────────────────────────────── */

const controllers = new WeakMap();
let serial = 0;

function readOptions(element) {
  const data = element.dataset ?? {};
  const options = {};
  if ('dsValue' in data) options.value = data.dsValue;
  if (data.dsDatefieldType) options.type = data.dsDatefieldType;
  if (data.dsDatefieldMin) options.min = data.dsDatefieldMin;
  if (data.dsDatefieldMax) options.max = data.dsDatefieldMax;
  if (data.dsDatefieldName) options.name = data.dsDatefieldName;
  if ('dsDatefieldSeconds' in data) options.seconds = data.dsDatefieldSeconds !== 'off';
  if (data.dsDatefieldHourCycle) options.hourCycle = data.dsDatefieldHourCycle;
  if ('dsDatefieldZone' in data) options.zone = data.dsDatefieldZone || 'local';
  return options;
}

/**
 * The field's controller, the one [data-ds-datefield] makes; once per
 * element. Options: `type` ('date', 'time', 'datetime', 'range'), `value`,
 * `min`, `max` (ISO text of the type), `disabled` (blocked days, as in
 * DS.calendar.available(): a date's, a datetime's day, a range's ends),
 * `name`, `seconds`, `hourCycle`
 * ('h12', 'h23'), `zone`, `locale`, `invalid` (the page's own verdict:
 * aria-invalid holds whatever the value), `silent` (no ds: events on the
 * element, only on() listeners: a picker around it sends its own).
 * @param {Element} element
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
  const id = `ds-field-${serial += 1}`;
  /** @type {any} */
  const state = { options: { type: 'date', ...readOptions(element), ...options }, values: new Map(), typed: { key: '', text: '' }, advanced: '', last: '' };

  const type = () => state.options.type;
  const locale = () => localeOf(state.options.locale);
  const cycle = () => hourCycle(locale(), state.options.hourCycle);
  const blocked = () => element.getAttribute('aria-disabled') === 'true';
  const readOnly = () => element.getAttribute('aria-readonly') === 'true';

  /** The segment keys of the layout ('year', or 'start.year' in a range). */
  let parts = [];
  const keyOf = (part) => (part.group ? `${part.group}.${part.type}` : part.type);
  const segments = () => [...element.querySelectorAll('.ds-datefield__segment')];

  /** The values of one group (or the field) as { year, month, ... } with hour in 0-23. */
  function groupValues(group) {
    const prefix = group ? `${group}.` : '';
    const out = {};
    for (const name of [...DATE_PARTS, ...TIME_PARTS]) out[name] = state.values.get(`${prefix}${name}`) ?? null;
    if (out.hour !== null && cycle() === 'h12') {
      if (out.dayPeriod === null) out.hour24 = null;
      else out.hour24 = (out.hour % 12) + (out.dayPeriod ? 12 : 0);
    } else out.hour24 = out.hour;
    return out;
  }

  const groups = () => (type() === 'range' ? ['start', 'end'] : ['']);

  /** The value of one group as ISO text, or '' while a part is missing. */
  function groupText(group) {
    const values = groupValues(group);
    const own = parts.filter((part) => part.type !== 'literal' && (part.group ?? '') === group);
    if (own.some((part) => state.values.get(keyOf(part)) === null || state.values.get(keyOf(part)) === undefined)) return '';
    const kind = type() === 'range' ? 'date' : type();
    if (kind !== 'time') {
      // A day the month does not have (31 in a month of 30) is no date.
      if (values.day > daysIn(values.year, values.month)) return '';
    }
    return textOf(kind, { ...values, hour: values.hour24, second: values.second ?? 0 }, state.options.seconds);
  }

  /** The value: ISO text, '' while unfinished. */
  function value() {
    if (type() !== 'range') return groupText('');
    const start = groupText('start');
    const end = groupText('end');
    return start && end ? `${start}/${end}` : '';
  }

  /** Whether the value is whole, within min and max and on no blocked day (a range: in order). */
  function validity(text) {
    if (!text) return !parts.some((part) => part.type !== 'literal' && state.values.get(keyOf(part)) !== null && state.values.get(keyOf(part)) !== undefined);
    const kind = type();
    const values = kind === 'range' ? text.split('/') : [text];
    const order = (a, b) => (kind === 'time' ? a.localeCompare(b) : compare(parseDate(a), parseDate(b)));
    const within = (item) => {
      const min = state.options.min;
      const max = state.options.max;
      if (kind === 'datetime') return (!min || item >= min) && (!max || item <= max);
      return (!min || order(item, min) >= 0) && (!max || order(item, max) <= 0);
    };
    if (!values.every(within)) return false;
    // A day the calendar blocks is no better typed.
    if (kind !== 'time' && state.options.disabled && !values.every((item) => available(parseDate(item), { disabled: state.options.disabled }))) return false;
    return kind !== 'range' || order(values[0], values[1]) <= 0;
  }

  /** Fills the parts from a value (ISO text); '' or null clears them. */
  function fill(text) {
    state.values.clear();
    state.typed = { key: '', text: '' };
    const items = type() === 'range' ? String(text ?? '').split('/') : [text];
    groups().forEach((group, index) => {
      const values = partsOf(type() === 'range' ? 'date' : type(), items[index]);
      if (!values) return;
      const prefix = group ? `${group}.` : '';
      for (const [name, number] of Object.entries(values)) {
        if (name === 'hour' && cycle() === 'h12') {
          state.values.set(`${prefix}hour`, number % 12 || 12);
          state.values.set(`${prefix}dayPeriod`, number >= 12 ? 1 : 0);
        } else state.values.set(`${prefix}${name}`, number);
      }
    });
  }

  /** The segment markup of the layout; built once per layout. */
  function build() {
    const loc = locale();
    parts = layout(type(), loc, { hourCycle: state.options.hourCycle, seconds: state.options.seconds });
    let host = element.querySelector(':scope > .ds-datefield__input');
    if (!host) {
      host = doc.createElement('span');
      host.className = 'ds-datefield__input';
      element.insertBefore(host, element.querySelector(':scope > .ds-datefield__zone, :scope > button, :scope > .ds-datefield__toggle'));
    }
    host.replaceChildren();
    let groupEl = null;
    for (const part of parts) {
      if (part.type === 'literal') {
        const literal = doc.createElement('span');
        literal.className = part.between ? 'ds-datefield__literal ds-datefield__between' : 'ds-datefield__literal';
        literal.setAttribute('aria-hidden', 'true');
        literal.textContent = part.value;
        if (part.between) groupEl = null;
        (groupEl ?? host).append(literal);
        continue;
      }
      if (part.group && (!groupEl || groupEl.getAttribute('data-group') !== part.group)) {
        groupEl = doc.createElement('span');
        groupEl.className = 'ds-datefield__group';
        groupEl.setAttribute('role', 'group');
        groupEl.setAttribute('data-group', part.group);
        groupEl.setAttribute('aria-label', t(part.group === 'start' ? 'rangeStart' : 'rangeEnd'));
        host.append(groupEl);
      }
      const segment = doc.createElement('span');
      segment.className = 'ds-datefield__segment';
      segment.setAttribute('role', 'spinbutton');
      segment.setAttribute('data-segment', keyOf(part));
      segment.setAttribute('aria-label', fieldName(loc, part.type));
      segment.setAttribute('inputmode', part.type === 'dayPeriod' ? 'text' : 'numeric');
      segment.setAttribute('enterkeyhint', 'next');
      segment.setAttribute('autocapitalize', 'off');
      segment.setAttribute('autocorrect', 'off');
      segment.setAttribute('spellcheck', 'false');
      (groupEl ?? host).append(segment);
    }
    // The zone of a wall time, at the end of the field.
    let zone = element.querySelector(':scope > .ds-datefield__zone');
    if (type() === 'datetime' && state.options.zone) {
      if (!zone) {
        zone = doc.createElement('span');
        zone.className = 'ds-datefield__zone';
        zone.id = `${id}-zone`;
        host.after(zone);
      }
      const names = zoneName(state.options.zone, { locale: loc });
      zone.textContent = names.short;
      zone.setAttribute('data-tip', names.long);
      // The long name is the field's description.
      const described = new Set((element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
      described.add(zone.id);
      element.setAttribute('aria-describedby', [...described].join(' '));
    } else zone?.remove();
    // A hidden input for a form.
    let input = element.querySelector(':scope > input[type="hidden"]');
    if (state.options.name) {
      if (!input) {
        input = doc.createElement('input');
        input.type = 'hidden';
        element.append(input);
      }
      input.name = state.options.name;
    } else input?.remove();
  }

  /** Writes every segment's text and ARIA, and the field's state. */
  function paint() {
    const loc = locale();
    const periods = dayPeriods(loc);
    const months = new Intl.DateTimeFormat(loc, { month: 'long', timeZone: 'UTC' });
    const off = blocked();
    for (const segment of segments()) {
      const key = segment.getAttribute('data-segment');
      const [group, name] = key.includes('.') ? key.split('.') : ['', key];
      const values = groupValues(group);
      const number = state.values.get(key);
      const [min, max] = bounds(name, values, cycle());
      const typing = state.typed.key === key ? state.typed.text : '';
      let text;
      let valueText;
      if (name === 'dayPeriod') {
        text = number === null || number === undefined ? '––' : periods[number];
        valueText = number === null || number === undefined ? t('empty') : periods[number];
      } else if (typing) {
        text = typing;
        valueText = typing;
      } else if (number === null || number === undefined) {
        const letter = fieldName(loc, name).charAt(0).toLocaleLowerCase(loc) || '–';
        text = letter.repeat(name === 'year' ? 4 : 2);
        valueText = t('empty');
      } else {
        text = numberFormat(loc, name === 'year' ? 4 : 2).format(number);
        valueText = name === 'month' ? `${number} – ${months.format(new Date(Date.UTC(2026, number - 1, 1)))}` : String(number);
      }
      const empty = (number === null || number === undefined) && !typing;
      if (segment.textContent !== text) segment.textContent = text;
      segment.toggleAttribute('data-placeholder', empty);
      segment.setAttribute('aria-valuemin', String(min));
      segment.setAttribute('aria-valuemax', String(max));
      if (empty) segment.removeAttribute('aria-valuenow');
      else segment.setAttribute('aria-valuenow', String(number ?? Number(typing)));
      segment.setAttribute('aria-valuetext', valueText);
      segment.tabIndex = off ? -1 : 0;
      segment.setAttribute('contenteditable', off || readOnly() ? 'false' : 'true');
      if (off) segment.setAttribute('aria-disabled', 'true');
      else segment.removeAttribute('aria-disabled');
      if (readOnly()) segment.setAttribute('aria-readonly', 'true');
      else segment.removeAttribute('aria-readonly');
    }
    const text = value();
    const valid = validity(text);
    const finished = Boolean(text) || !parts.some((part) => part.type !== 'literal' && state.values.get(keyOf(part)) !== null && state.values.get(keyOf(part)) !== undefined);
    // `invalid`: the page's own verdict (a range whose end is in another field) holds as well.
    const invalid = Boolean(state.options.invalid) || (!valid && (finished || !element.contains(doc.activeElement)));
    if (invalid) element.setAttribute('aria-invalid', 'true');
    else element.removeAttribute('aria-invalid');
    for (const segment of segments()) {
      if (invalid) segment.setAttribute('aria-invalid', 'true');
      else segment.removeAttribute('aria-invalid');
    }
    const input = element.querySelector(':scope > input[type="hidden"]');
    if (input) input.value = text;
    return { text, valid };
  }

  function fire(type, detail) {
    if (!state.options.silent) emit(element, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  }

  /**
   * Paints, and sends ds:change when the value changed. Not while a part is
   * being typed (the "2" of "2027"): the value counts once the part is done,
   * left, or the field loses focus.
   */
  function changed(notify = true) {
    const { text, valid } = paint();
    if (notify && state.typed.key) return;
    if (text === state.last) return;
    state.last = text;
    if (notify) fire('change', { value: text, valid });
  }

  /** The value a step starts from on an empty segment: now's. */
  function startingValue(name, group) {
    const now = new Date();
    const values = groupValues(group);
    const date = today();
    switch (name) {
      case 'year': return date.year;
      case 'month': return date.month;
      case 'day': return Math.min(date.day, bounds('day', values, cycle())[1]);
      case 'hour': return cycle() === 'h12' ? (now.getHours() % 12 || 12) : now.getHours();
      case 'minute': return now.getMinutes();
      case 'second': return now.getSeconds();
      default: return now.getHours() >= 12 ? 1 : 0;
    }
  }

  function step(segment, by, to) {
    const key = segment.getAttribute('data-segment');
    const [group, name] = key.includes('.') ? key.split('.') : ['', key];
    const [min, max] = bounds(name, groupValues(group), cycle());
    const current = state.values.get(key);
    let next;
    if (to === 'min') next = min;
    else if (to === 'max') next = max;
    else if (current === null || current === undefined) next = startingValue(name, group);
    else {
      const span = max - min + 1;
      next = ((current - min + by) % span + span) % span + min;
    }
    state.typed = { key: '', text: '' };
    state.values.set(key, next);
    constrain(group);
    changed();
  }

  /** A day the new month or year does not have becomes its last. */
  function constrain(group) {
    const prefix = group ? `${group}.` : '';
    const day = state.values.get(`${prefix}day`);
    const month = state.values.get(`${prefix}month`);
    if (day && month) {
      const last = daysIn(state.values.get(`${prefix}year`) ?? 2000, month);
      if (day > last && !state.typed.key) state.values.set(`${prefix}day`, last);
    }
  }

  function moveFocus(segment, by) {
    const list = segments();
    const index = list.indexOf(segment) + by;
    if (index >= 0 && index < list.length) list[index].focus();
    return index >= 0 && index < list.length;
  }

  /** Ends typing in a segment: a short year becomes this century's (or the last one's). */
  function settleTyping() {
    const { key, text } = state.typed;
    if (!key) return;
    state.typed = { key: '', text: '' };
    if (key.endsWith('year') && text.length <= 2) {
      const short = Number(text);
      const century = Math.floor(today().year / 100) * 100;
      state.values.set(key, short <= (today().year % 100) + 20 ? century + short : century - 100 + short);
    }
    constrain(key.includes('.') ? key.split('.')[0] : '');
  }

  /** Typed text in a segment: digits, a separator, or a day period's letter. */
  function typeInto(segment, data) {
    if (blocked() || readOnly()) return;
    const key = segment.getAttribute('data-segment');
    const [group, name] = key.includes('.') ? key.split('.') : ['', key];
    for (const char of data) {
      if (name === 'dayPeriod') {
        const periods = dayPeriods(locale()).map((word) => word.toLocaleLowerCase(locale()));
        const lower = char.toLocaleLowerCase(locale());
        const match = periods.findIndex((word) => word.startsWith(lower));
        if (match >= 0) {
          state.values.set(key, match);
          changed();
          moveFocus(segment, 1);
        }
        continue;
      }
      if (!/\d/.test(char)) {
        // A separator right after the part before moved on by itself ("3/" in a month) is that move.
        if (state.advanced === key) {
          state.advanced = '';
          continue;
        }
        // A separator moves on, once something was typed.
        if (/[\s/.,:\-–]/.test(char) && (state.typed.key === key || state.values.get(key) !== undefined)) {
          settleTyping();
          changed();
          moveFocus(segment, 1);
        }
        continue;
      }
      state.advanced = '';
      const [min, max] = bounds(name, groupValues(group), cycle());
      const typed = state.typed.key === key ? state.typed.text : '';
      const result = typeDigit({ min, max, typed, digit: char, size: name === 'year' ? 4 : 2 });
      state.typed = { key, text: result.typed };
      state.values.set(key, result.value);
      if (result.done) {
        settleTyping();
        changed();
        if (moveFocus(segment, 1)) state.advanced = /** @type {Element} */ (doc.activeElement)?.getAttribute?.('data-segment') ?? '';
      } else changed();
    }
  }

  function clear(segment) {
    const key = segment.getAttribute('data-segment');
    if (state.typed.key === key && state.typed.text.length > 1) {
      const text = state.typed.text.slice(0, -1);
      state.typed = { key, text };
      state.values.set(key, Number(text));
      changed();
      return;
    }
    const had = state.values.get(key) !== null && state.values.get(key) !== undefined;
    state.typed = { key: '', text: '' };
    state.values.set(key, null);
    changed();
    if (!had) moveFocus(segment, -1);
  }

  /** A pasted text: a whole value (ISO, or the digits in the field's order). */
  function paste(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return;
    const kind = type() === 'range' ? 'range' : type();
    const iso = kind === 'range' ? trimmed.split('/').every((item) => partsOf('date', item)) : partsOf(kind, trimmed);
    if (iso) {
      fill(trimmed);
      changed();
      return;
    }
    const numbers = trimmed.match(/\d+/g) ?? [];
    const keys = parts.filter((part) => NUMERIC.has(part.type)).map(keyOf);
    if (numbers.length < keys.length) return;
    keys.forEach((key, index) => state.values.set(key, Number(numbers[index])));
    const period = parts.find((part) => part.type === 'dayPeriod');
    if (period) {
      const periods = dayPeriods(locale()).map((word) => word.toLocaleLowerCase(locale()));
      const lower = trimmed.toLocaleLowerCase(locale());
      const match = periods.findIndex((word) => lower.includes(word));
      if (match >= 0) state.values.set(keyOf(period), match);
    }
    changed();
  }

  const segmentOf = (target) => /** @type {Element} */ (target)?.closest?.('.ds-datefield__segment');

  element.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    const segment = segmentOf(event.target);
    if (!segment || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const rtl = /** @type {HTMLElement} */ (segment).matches(':dir(rtl)');
    const name = segment.getAttribute('data-segment').split('.').pop();
    const editable = !blocked() && !readOnly();
    if (event.key.length > 1) state.advanced = '';
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        event.preventDefault();
        if (editable) step(segment, event.key === 'ArrowUp' ? 1 : -1);
        return;
      case 'PageUp':
      case 'PageDown':
        event.preventDefault();
        if (editable) step(segment, (event.key === 'PageUp' ? 1 : -1) * BIG_STEP[name]);
        return;
      case 'Home':
      case 'End':
        event.preventDefault();
        if (editable) step(segment, 0, event.key === 'Home' ? 'min' : 'max');
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        event.preventDefault();
        settleTyping();
        changed();
        moveFocus(segment, (event.key === 'ArrowRight') !== rtl ? 1 : -1);
        return;
      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        if (editable) clear(segment);
        return;
      default:
    }
  }, { signal });

  // Text goes through the script: the segment's own text never changes by editing.
  element.addEventListener('beforeinput', (/** @type {InputEvent} */ event) => {
    const segment = segmentOf(event.target);
    if (!segment) return;
    if (event.inputType === 'insertCompositionText') return;
    event.preventDefault();
    if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') typeInto(segment, event.data ?? '');
    else if (event.inputType.startsWith('delete') && !blocked() && !readOnly()) clear(segment);
  }, { signal });
  // Whatever slipped through (an IME's composition) is written back.
  element.addEventListener('input', (event) => {
    const segment = segmentOf(event.target);
    if (!segment) return;
    const data = /** @type {any} */ (event).data;
    if (data) typeInto(segment, data);
    paint();
  }, { signal });
  element.addEventListener('compositionend', (/** @type {CompositionEvent} */ event) => {
    const segment = segmentOf(event.target);
    if (segment) {
      typeInto(segment, event.data ?? '');
      paint();
    }
  }, { signal });
  element.addEventListener('paste', (/** @type {ClipboardEvent} */ event) => {
    if (!segmentOf(event.target) || blocked() || readOnly()) return;
    event.preventDefault();
    paste(event.clipboardData?.getData('text') ?? '');
  }, { signal });
  element.addEventListener('focusout', (/** @type {FocusEvent} */ event) => {
    const segment = segmentOf(event.target);
    if (segment && state.advanced === segment.getAttribute('data-segment')) state.advanced = '';
    if (!segment || state.typed.key !== segment.getAttribute('data-segment')) return;
    settleTyping();
    changed();
  }, { signal });
  // A focused segment selects nothing and shows no caret (the stylesheet hides it).
  element.addEventListener('focusin', (event) => {
    const segment = segmentOf(event.target);
    if (!segment) return;
    const selection = doc.getSelection?.();
    if (selection && segment.firstChild) selection.collapse(segment.firstChild, segment.textContent.length);
    if (!element.contains(/** @type {Node} */ (event.relatedTarget))) paint();
  }, { signal });
  element.addEventListener('focusout', (/** @type {FocusEvent} */ event) => {
    if (!element.contains(/** @type {Node} */ (event.relatedTarget))) paint();
  }, { signal });
  // A press on the field, not on a part of it: the first empty segment.
  element.addEventListener('mousedown', (/** @type {MouseEvent} */ event) => {
    const target = /** @type {Element} */ (event.target);
    if (segmentOf(target) || target.closest?.('button, a, input, [data-tip]') || blocked()) return;
    event.preventDefault();
    focusFirst();
  }, { signal });
  for (const labelId of (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) {
    doc.getElementById(labelId)?.addEventListener('click', () => {
      if (!blocked()) focusFirst();
    }, { signal });
  }
  doc.addEventListener('ds:config', () => {
    build();
    paint();
  }, { signal });

  function focusFirst() {
    const list = segments();
    (list.find((segment) => segment.hasAttribute('data-placeholder')) ?? list[0])?.focus();
  }

  element.classList.add('ds-datefield');
  if (!element.hasAttribute('role')) element.setAttribute('role', 'group');
  build();
  fill(state.options.value);
  state.last = paint().text;

  const controller = {
    element,
    /** The value (ISO text), '' while a part is missing. */
    get() {
      return value();
    },
    /** Sets the value (ISO text); `{ emit: true }` sends ds:change as if typed. */
    set(next, { emit: notify = false } = {}) {
      fill(next);
      changed(notify);
      return value();
    },
    /** Whether the value is whole, within min and max and on no blocked day. */
    valid() {
      return validity(value());
    },
    /** The value as a Date: a datetime's wall time in its zone, a date's local midnight; null while unfinished. */
    instant() {
      const text = value();
      if (!text || type() === 'range') return null;
      if (type() === 'time') return toInstant(`${iso(today())}T${text}`, state.options.zone ? zoneOf(state.options.zone) : 'local');
      return toInstant(text, state.options.zone ? zoneOf(state.options.zone) : 'local');
    },
    /** Focuses a segment: its key ('day', 'end.month'), else the first empty one. */
    focus(key) {
      const target = key ? element.querySelector(`.ds-datefield__segment[data-segment="${key}"]`) : null;
      if (target) /** @type {HTMLElement} */ (target).focus();
      else focusFirst();
    },
    /** New options (those of create()), applied at once. */
    update(next = {}) {
      const before = value();
      Object.assign(state.options, next);
      if (Object.keys(next).every((key) => key === 'invalid' || key === 'disabled')) {
        paint();
        return;
      }
      build();
      fill('value' in next ? next.value : before);
      state.last = paint().text;
    },
    on(kind, fn) {
      const key = String(kind).replace(/^ds:/, '');
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

define('datefield', {
  attribute: 'data-ds-datefield',
  attributes: ['data-ds-value', 'data-ds-datefield-type', 'data-ds-datefield-min', 'data-ds-datefield-max', 'data-ds-datefield-seconds', 'data-ds-datefield-hour-cycle', 'data-ds-datefield-zone', 'data-ds-datefield-name'],
  init(element) {
    const controller = create(element);
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
