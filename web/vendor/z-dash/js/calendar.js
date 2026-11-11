/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The calendar (DS.calendar): the date engine every picker shares, and the
 * month grid built on it (the grid of the WAI-ARIA date picker dialog).
 *
 *   <div class="ds-calendar" data-ds-calendar data-ds-value="2026-11-04"
 *        data-ds-calendar-min="2026-01-01" data-ds-calendar-weeks></div>
 *
 *   const cal = DS.calendar.create(el, { value: '2026-11-04', months: 2, mode: 'range' });
 *   cal.get(); cal.set('2026-11-09'); cal.show('2027-01-01'); cal.focus();
 *   DS.calendar.weekInfo('de');          // { firstDay: 1, minimalDays: 4 }
 *   DS.calendar.grid(2026, 11, 1);       // six weeks of plain dates
 *
 * A plain date is { year, month, day } (month 1-12), written as ISO text
 * (2026-11-04) in attributes, values and events: no time and no time zone,
 * so a date never moves across a day line. The engine computes in UTC day
 * numbers, which have no daylight saving gaps.
 *
 * Everything the reader sees comes from Intl in the locale of
 * DS.core.config() (or `locale`): month and weekday names, the first day of
 * the week and the week numbering (Intl.Locale weekInfo, else a table of
 * regions), the digits and the full date that names each day. The only
 * strings of its own are the names of the two month buttons
 * (previousMonth, nextMonth) and the word a chosen day's name ends on
 * (selected).
 *
 * The grid: one tab stop, the focused day (roving tabindex). Arrows move a
 * day or a week (left and right follow the writing direction), Home and End
 * go to the start and end of the week, PageUp and PageDown a month,
 * Shift+PageUp and Shift+PageDown a year; Enter or Space picks the day.
 * Moving past the months on screen turns the page. A day outside min and
 * max, or one `disabled` names, is aria-disabled: focusable, read, never
 * picked. The selected days say so in their names (the focus sits on the
 * day's button, not on the gridcell that carries aria-selected). The month
 * buttons keep the focus on a turned page (a blocked one hands it to the
 * tab stop day). The month title is a polite live region, so a turned page is
 * heard. In range mode the first pick starts a range, the pointer or the
 * keys preview it (data-preview), the second pick ends it.
 *
 * Motion: a turned page slides in from its side (DS.motion.enter with
 * 'slide'), the rest is state that the stylesheet transitions.
 *
 * ES2022.
 * Progressive:
 * - Intl.Locale weekInfo (getWeekInfo() or the weekInfo getter): without
 *   it, a table of regions (CLDR) gives the first day of the week and the
 *   minimal days of the first week.
 */
import { config, define, emit, t } from './core.js';
import { enter } from './motion.js';
import { morphHtml } from './dom.js';
import { icon, chevronLeft, chevronRight } from './icons.js';

/* ── The engine: plain dates ────────────────────────── */

const DAY = 86400000;

/** Day number (days since 1970-01-01) of a plain date. */
const dayNumber = (date) => Math.round(Date.UTC(date.year, date.month - 1, date.day) / DAY);

/** The plain date of a day number. */
function fromDayNumber(number) {
  const utc = new Date(number * DAY);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

/**
 * The days of a month (month 1-12).
 * @param {number} year
 * @param {number} month
 * @returns {number}
 */
export function daysIn(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const ISO_DATE = /^([+-]?\d{4,6})-(\d{2})-(\d{2})(?:$|T)/;

/**
 * A plain date from ISO text (2026-11-04; a date-time keeps its date), a
 * Date (its local date) or a plain date; null for anything else and for a
 * day that does not exist (2026-02-30).
 * @param {unknown} value
 * @returns {{ year: number, month: number, day: number }|null}
 */
export function parse(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() };
  }
  if (typeof value === 'object') {
    const { year, month, day } = /** @type {any} */ (value);
    if (![year, month, day].every(Number.isInteger)) return null;
    return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month) ? { year, month, day } : null;
  }
  const match = ISO_DATE.exec(String(value).trim());
  if (!match) return null;
  return parse({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });
}

/**
 * The ISO text of a plain date (2026-11-04), or '' for none.
 * @param {{ year: number, month: number, day: number }|null|undefined} date
 * @returns {string}
 */
export function iso(date) {
  if (!date) return '';
  const year = date.year < 0 || date.year > 9999
    ? `${date.year < 0 ? '-' : '+'}${String(Math.abs(date.year)).padStart(6, '0')}`
    : String(date.year).padStart(4, '0');
  return `${year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/**
 * Today as a plain date: the local date, or the date in `timeZone`.
 * @param {{ timeZone?: string, now?: Date|number }} [options]
 * @returns {{ year: number, month: number, day: number }}
 */
export function today(options = {}) {
  const now = new Date(options.now ?? Date.now());
  if (!options.timeZone) return /** @type {any} */ (parse(now));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  const part = (type) => Number(parts.find((entry) => entry.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/**
 * A plain date moved by years, months and days, in that order; a month
 * step keeps the day where it can and else takes the month's last day
 * (Jan 31 plus a month is Feb 28).
 * @param {{ year: number, month: number, day: number }} date
 * @param {{ years?: number, months?: number, days?: number }} step
 * @returns {{ year: number, month: number, day: number }}
 */
export function add(date, step) {
  const months = date.year * 12 + (date.month - 1) + (step.years ?? 0) * 12 + (step.months ?? 0);
  const year = Math.floor(months / 12);
  const month = months - year * 12 + 1;
  const moved = { year, month, day: Math.min(date.day, daysIn(year, month)) };
  return step.days ? fromDayNumber(dayNumber(moved) + step.days) : moved;
}

/**
 * Negative when `a` is before `b`, 0 on the same day, positive after.
 * @param {{ year: number, month: number, day: number }} a
 * @param {{ year: number, month: number, day: number }} b
 * @returns {number}
 */
export function compare(a, b) {
  return dayNumber(a) - dayNumber(b);
}

/** The ISO weekday of a plain date: 1 Monday ... 7 Sunday. */
const weekday = (date) => ((dayNumber(date) + 3) % 7 + 7) % 7 + 1;

/* CLDR weekData (supplemental), for engines without Intl.Locale weekInfo. */
const SUNDAY_FIRST = new Set('AG AS BD BR BS BT BW BZ CA CN CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW'.split(' '));
const SATURDAY_FIRST = new Set('AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' '));
const FOUR_DAY_WEEK = new Set('AD AN AT AX BE BG CH CZ DE DK EE ES FI FJ FO FR GB GF GG GI GP GR HU IE IM IS IT JE LI LT LU MC MQ NL NO PL PT RE RU SE SJ SK SM VA'.split(' '));

/** The region of a locale, from its likely subtags when it names none ('en' is US). */
function regionOf(locale) {
  try {
    const parsed = new Intl.Locale(locale);
    return parsed.region ?? parsed.maximize().region ?? '';
  } catch {
    return '';
  }
}

/**
 * The week of a locale: `firstDay` (1 Monday ... 7 Sunday) and
 * `minimalDays` (how many days of a new year the first week needs: 4 is
 * ISO 8601, 1 the week of January 1st). A `firstDay` option overrides the
 * locale's.
 * @param {string} [locale]
 * @param {{ firstDay?: number }} [options]
 * @returns {{ firstDay: number, minimalDays: number }}
 */
export function weekInfo(locale, options = {}) {
  const tag = localeOf(locale);
  const region = regionOf(tag);
  let firstDay = SUNDAY_FIRST.has(region) ? 7 : SATURDAY_FIRST.has(region) ? 6 : region === 'MV' ? 5 : 1;
  let minimalDays = FOUR_DAY_WEEK.has(region) ? 4 : 1;
  try {
    const parsed = /** @type {any} */ (new Intl.Locale(tag));
    const info = typeof parsed.getWeekInfo === 'function' ? parsed.getWeekInfo() : parsed.weekInfo;
    if (info?.firstDay) firstDay = info.firstDay;
    if (info?.minimalDays) minimalDays = info.minimalDays;
  } catch {
    // The table stands.
  }
  const forced = Number(options.firstDay);
  if (forced >= 1 && forced <= 7) firstDay = forced;
  return { firstDay, minimalDays };
}

/** The first day of the week that holds `date`. */
function weekStart(date, firstDay) {
  return fromDayNumber(dayNumber(date) - ((weekday(date) - firstDay + 7) % 7));
}

/**
 * The week of the year of a plain date, in the numbering of `info`
 * (weekInfo()): ISO 8601 for { firstDay: 1, minimalDays: 4 }. Days before
 * week 1 belong to the last week of the year before.
 * @param {{ year: number, month: number, day: number }} date
 * @param {{ firstDay: number, minimalDays: number }} [info]
 * @returns {number}
 */
export function weekNumber(date, info = { firstDay: 1, minimalDays: 4 }) {
  const firstWeek = (year) => {
    const jan1 = { year, month: 1, day: 1 };
    const start = weekStart(jan1, info.firstDay);
    // The week that holds Jan 1 counts when enough of its days are in the year.
    const inYear = 7 - (dayNumber(jan1) - dayNumber(start));
    return inYear >= info.minimalDays ? dayNumber(start) : dayNumber(start) + 7;
  };
  const day = dayNumber(date);
  let start = firstWeek(date.year);
  if (day < start) start = firstWeek(date.year - 1);
  else if (day >= firstWeek(date.year + 1)) return 1;
  return Math.floor((day - start) / 7) + 1;
}

/**
 * Six weeks of plain dates around a month (month 1-12), from the week that
 * holds its first day: always 42 days, so a calendar keeps its height from
 * month to month.
 * @param {number} year
 * @param {number} month
 * @param {number} [firstDay]  1 Monday ... 7 Sunday
 * @returns {{ year: number, month: number, day: number }[][]}
 */
export function grid(year, month, firstDay = 1) {
  const start = dayNumber(weekStart({ year, month, day: 1 }, firstDay));
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (__, index) => fromDayNumber(start + week * 7 + index)));
}

/**
 * Whether a day may be picked: within `min` and `max` (ISO text or plain
 * dates) and not one `disabled` names: a function of the plain date, or a
 * list of ISO dates, ranges ('2026-12-24/2026-12-26') and ISO weekdays
 * (6 and 7: the weekend).
 * @param {{ year: number, month: number, day: number }} date
 * @param {{ min?: any, max?: any, disabled?: any }} [rules]
 * @returns {boolean}
 */
export function available(date, rules = {}) {
  const min = parse(rules.min);
  const max = parse(rules.max);
  if (min && compare(date, min) < 0) return false;
  if (max && compare(date, max) > 0) return false;
  return !blockedBy(rules.disabled)(date);
}

/** A test of the `disabled` rule: a function, or a list (or comma text) of dates, ranges and weekdays. */
function blockedBy(rule) {
  if (typeof rule === 'function') return (date) => Boolean(rule(date));
  const items = Array.isArray(rule) ? rule : typeof rule === 'string' ? rule.split(',') : [];
  const days = new Set();
  const weekdays = new Set();
  const ranges = [];
  for (const raw of items) {
    const item = String(raw).trim();
    if (/^[1-7]$/.test(item)) weekdays.add(Number(item));
    else if (item.includes('/')) {
      const [from, to] = item.split('/').map(parse);
      if (from && to) ranges.push([dayNumber(from), dayNumber(to)]);
    } else {
      const date = parse(item);
      if (date) days.add(dayNumber(date));
    }
  }
  if (!days.size && !weekdays.size && !ranges.length) return () => false;
  return (date) => {
    const number = dayNumber(date);
    return days.has(number) || weekdays.has(weekday(date)) || ranges.some(([from, to]) => number >= from && number <= to);
  };
}

/* ── Locale ─────────────────────────────────────────── */

const accepted = new Map();

/** The locale to use: `locale`, else the page's (DS.core.config()); one the engine refuses counts as none. */
function localeOf(locale) {
  const wanted = locale || config().locale || 'en';
  if (!accepted.has(wanted)) {
    let good = wanted;
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

const formats = new Map();

/** An Intl.DateTimeFormat, kept per locale and options. Plain dates format at noon UTC. */
function dateFormat(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let made = formats.get(key);
  if (!made) {
    made = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    formats.set(key, made);
  }
  return made;
}

const atNoon = (date) => new Date(Date.UTC(date.year, date.month - 1, date.day, 12));

/**
 * A plain date for people, through Intl (default the full date:
 * "Wednesday, November 4, 2026"); `options` are those of
 * Intl.DateTimeFormat, plus `locale`.
 * @param {{ year: number, month: number, day: number }|string} date
 * @param {{ locale?: string } & Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
export function label(date, options = {}) {
  const plain = parse(date);
  if (!plain) return '';
  const { locale, ...rest } = options;
  const settings = Object.keys(rest).length ? rest : { dateStyle: 'full' };
  return dateFormat(localeOf(locale), settings).format(atNoon(plain));
}

/**
 * A range of plain dates for people (Intl formatRange: "Nov 1 – 7, 2026").
 * @param {any} start
 * @param {any} end
 * @param {{ locale?: string } & Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
export function rangeLabel(start, end, options = {}) {
  const from = parse(start);
  const to = parse(end);
  if (!from || !to) return label(from ?? to, options);
  const { locale, ...rest } = options;
  const settings = Object.keys(rest).length ? rest : { dateStyle: 'medium' };
  return dateFormat(localeOf(locale), settings).formatRange(atNoon(from), atNoon(to));
}

/* ── The grid ───────────────────────────────────────── */

/** The controllers, one per element. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

let serial = 0;

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

const firstOf = (date) => ({ year: date.year, month: date.month, day: 1 });

/** The options of the markup: data-ds-value and data-ds-calendar-*. */
function readOptions(element) {
  const data = element.dataset ?? {};
  const options = {};
  if ('dsValue' in data) options.value = data.dsValue;
  if (data.dsCalendarMin) options.min = data.dsCalendarMin;
  if (data.dsCalendarMax) options.max = data.dsCalendarMax;
  if (data.dsCalendarDisabled) options.disabled = data.dsCalendarDisabled;
  if (data.dsCalendarMonths) options.months = Number(data.dsCalendarMonths);
  if (data.dsCalendarMode) options.mode = data.dsCalendarMode;
  if (data.dsCalendarFirstDay) options.firstDay = Number(data.dsCalendarFirstDay);
  if ('dsCalendarWeeks' in data) options.weeks = data.dsCalendarWeeks !== 'off';
  if (data.dsCalendarShow) options.show = data.dsCalendarShow;
  return options;
}

/** A range value from ISO text ('2026-11-01/2026-11-07'), an array or { start, end }. */
function parseRange(value) {
  if (!value) return { start: null, end: null };
  let start;
  let end;
  if (typeof value === 'string') [start, end] = value.split('/');
  else if (Array.isArray(value)) [start, end] = value;
  else ({ start, end } = /** @type {any} */ (value));
  const from = parse(start);
  const to = parse(end);
  if (from && to && compare(from, to) > 0) return { start: to, end: from };
  return { start: from, end: to };
}

/**
 * The calendar's controller, the one [data-ds-calendar] makes; once per
 * element (a second call returns the first, with its options updated).
 *
 * Options: `value` (ISO text; in range mode '<start>/<end>' or
 * { start, end }), `mode` ('single' or 'range'), `months` (1 or 2 side by
 * side), `min`, `max`, `disabled` (see available()), `weeks` (week
 * numbers), `firstDay` (1-7, else the locale's), `locale`, `show` (the
 * month to show first, default the value's or today's), `onSelect(value)`
 * (called after ds:change, for a picker around it), `silent` (no ds:
 * events on the element: a picker sends its own).
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
  const id = `ds-cal-${serial += 1}`;
  /** @type {any} */
  const state = {
    options: { ...readOptions(element), ...options },
    value: null,
    range: { start: null, end: null },
    anchor: null,
    preview: null,
    view: null,
    focus: null,
    rendered: '',
  };

  const range = () => state.options.mode === 'range';
  const months = () => Math.max(1, Math.min(2, Number(state.options.months) || 1));
  const locale = () => localeOf(state.options.locale);
  const info = () => weekInfo(locale(), { firstDay: state.options.firstDay });
  const rules = () => ({ min: state.options.min, max: state.options.max, disabled: state.options.disabled });
  const pickable = (date) => available(date, rules());

  function setValue(value) {
    if (range()) {
      state.range = parseRange(value);
      state.anchor = null;
      state.preview = null;
    } else state.value = parse(value);
  }
  setValue(state.options.value);

  /** The day the grid starts on: the value's, else today's, within min and max. */
  function homeDay() {
    const shown = parse(state.options.show) ?? (range() ? state.range.start : state.value) ?? today();
    return clampDay(shown);
  }

  function clampDay(date) {
    const min = parse(state.options.min);
    const max = parse(state.options.max);
    if (min && compare(date, min) < 0) return min;
    if (max && compare(date, max) > 0) return max;
    return date;
  }

  state.focus = homeDay();
  state.view = firstOf(state.focus);

  const lastShown = () => add(state.view, { months: months() - 1 });
  const visible = (date) => compare(date, state.view) >= 0 && compare(date, add(lastShown(), { months: 1 })) < 0;

  /** Whether the month before (step -1) or after (step 1) the view holds a day within min and max. */
  function canTurn(step) {
    const min = parse(state.options.min);
    const max = parse(state.options.max);
    if (step < 0) return !min || compare(add(state.view, { days: -1 }), min) >= 0;
    return !max || compare(add(lastShown(), { months: 1 }), max) <= 0;
  }

  function monthMarkup(first, index, count) {
    const loc = locale();
    const week = info();
    const titleId = `${id}-t${index}`;
    const title = dateFormat(loc, { month: 'long', year: 'numeric' }).format(atNoon(first));
    const nav = (step) => {
      const blocked = !canTurn(step);
      const name = step < 0 ? t('previousMonth') : t('nextMonth');
      return `<button class="ds-btn ds-btn--quiet ds-btn--icon ds-calendar__nav" type="button" data-step="${step}" aria-label="${escapeHtml(name)}"${blocked ? ' aria-disabled="true"' : ''}>${icon(step < 0 ? chevronLeft : chevronRight, 20)}</button>`;
    };
    const head = `<div class="ds-calendar__caption">${index === 0 ? nav(-1) : '<span class="ds-calendar__spacer"></span>'}`
      + `<span class="ds-calendar__title" id="${titleId}" aria-live="polite">${escapeHtml(title)}</span>`
      + `${index === count - 1 ? nav(1) : '<span class="ds-calendar__spacer"></span>'}</div>`;
    const weeks = grid(first.year, first.month, week.firstDay);
    const longDay = dateFormat(loc, { weekday: 'long' });
    const narrowDay = dateFormat(loc, { weekday: 'narrow' });
    const dayDigits = dateFormat(loc, { day: 'numeric' });
    const weekName = weekFieldName(loc);
    const cols = weeks[0].map((date) => `<th scope="col" abbr="${escapeHtml(longDay.format(atNoon(date)))}">${escapeHtml(narrowDay.format(atNoon(date)))}</th>`).join('');
    const weekHead = state.options.weeks ? `<th class="ds-calendar__week" scope="col" abbr="${escapeHtml(weekName)}">${escapeHtml(weekFieldName(loc, 'narrow'))}</th>` : '';
    const now = today();
    const rows = weeks.map((days) => {
      const number = weekNumber(days.find((date) => date.month === first.month) ?? days[0], week);
      const weekCell = state.options.weeks ? `<th class="ds-calendar__week" scope="row" aria-label="${escapeHtml(`${weekName} ${number}`)}">${number}</th>` : '';
      const cells = days.map((date) => {
        if (date.month !== first.month) return '<td></td>';
        const key = iso(date);
        const name = label(date, { locale: loc });
        const attrs = [`data-date="${key}"`, `data-name="${escapeHtml(name)}"`, `aria-label="${escapeHtml(name)}"`, 'tabindex="-1"'];
        if (!compare(date, now)) attrs.push('aria-current="date"');
        if (!pickable(date)) attrs.push('aria-disabled="true"');
        return `<td><button class="ds-calendar__day" type="button" ${attrs.join(' ')}>${escapeHtml(dayDigits.format(atNoon(date)))}</button></td>`;
      }).join('');
      return `<tr>${weekCell}${cells}</tr>`;
    }).join('');
    return `<div class="ds-calendar__month" data-ds-key="${iso(first)}">${head}`
      + `<table class="ds-calendar__grid" role="grid" aria-labelledby="${titleId}"${range() ? ' aria-multiselectable="true"' : ''}>`
      + `<thead><tr>${weekHead}${cols}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  /** Renders the months on screen; `turn` (-1, 1) slides the new page in from its side. */
  function render(turn = 0) {
    const count = months();
    const markup = Array.from({ length: count }, (_, index) => monthMarkup(add(state.view, { months: index }), index, count)).join('');
    const key = `${markup}|${state.options.weeks}`;
    if (key !== state.rendered) {
      state.rendered = key;
      element.classList.add('ds-calendar');
      morphHtml(element, `<div class="ds-calendar__months">${markup}</div>`);
      if (turn) {
        for (const month of element.querySelectorAll('.ds-calendar__month')) {
          month.setAttribute('data-turn', turn < 0 ? 'back' : 'next');
          enter(month, 'slide').then(() => month.removeAttribute('data-turn'));
        }
      }
    }
    paint();
  }

  /** The selection, the preview and the tab stop, written on the cells. */
  function paint() {
    const single = !range() && state.value ? dayNumber(state.value) : null;
    let from = null;
    let to = null;
    if (range()) {
      const start = state.anchor ?? state.range.start;
      const end = state.anchor ? state.preview : state.range.end;
      if (start && end) {
        [from, to] = [dayNumber(start), dayNumber(end)].sort((a, b) => a - b);
      } else if (start) from = to = dayNumber(start);
    }
    const previewing = Boolean(range() && state.anchor);
    const focusKey = iso(state.focus);
    for (const button of element.querySelectorAll('.ds-calendar__day')) {
      const date = parse(button.getAttribute('data-date'));
      const cell = button.parentElement;
      const number = dayNumber(date);
      button.tabIndex = iso(date) === focusKey ? 0 : -1;
      let selected = number === single;
      let place = '';
      if (from !== null && number >= from && number <= to) {
        place = from === to ? 'single' : number === from ? 'start' : number === to ? 'end' : 'middle';
        if (!previewing) selected = true;
        else if (number === from || number === to) selected = number === dayNumber(state.anchor);
      }
      if (selected) cell.setAttribute('aria-selected', 'true');
      else cell.removeAttribute('aria-selected');
      // The focused button is what a screen reader names: the selection goes into its name.
      const name = button.getAttribute('data-name') ?? '';
      const spoken = selected ? `${name}, ${t('selected')}` : name;
      if (button.getAttribute('aria-label') !== spoken) button.setAttribute('aria-label', spoken);
      if (place && !previewing) cell.setAttribute('data-range', place);
      else cell.removeAttribute('data-range');
      if (place && previewing) cell.setAttribute('data-preview', place);
      else cell.removeAttribute('data-preview');
    }
  }

  /** Moves the focused day (and the page when it leaves the screen); `move` focuses it. */
  function goTo(date, move = true) {
    const target = clampDay(date);
    let turn = 0;
    if (!visible(target)) {
      turn = compare(target, state.view) < 0 ? -1 : 1;
      state.view = turn < 0 ? firstOf(target) : add(firstOf(target), { months: 1 - months() });
    }
    state.focus = target;
    if (range() && state.anchor) state.preview = target;
    render(turn);
    if (move) element.querySelector(`.ds-calendar__day[data-date="${iso(target)}"]`)?.focus({ preventScroll: true });
  }

  function turnPage(step) {
    if (!canTurn(step)) return;
    // The month buttons sit in the keyed months the morph replaces: the focus goes along.
    const active = element.ownerDocument?.activeElement;
    const hadFocus = Boolean(active?.classList?.contains('ds-calendar__nav') && element.contains(active));
    state.view = add(state.view, { months: step });
    // The focused day follows to the same place in the new month.
    state.focus = clampDay(add(state.focus, { months: step }));
    if (!visible(state.focus)) state.focus = clampDay(state.view);
    render(step);
    if (!hadFocus) return;
    const nav = element.querySelector(`.ds-calendar__nav[data-step="${step}"]`);
    const target = nav && nav.getAttribute('aria-disabled') !== 'true' ? nav : element.querySelector('.ds-calendar__day[tabindex="0"]');
    /** @type {HTMLElement|null} */ (target)?.focus({ preventScroll: true });
  }

  function fire(type, detail) {
    if (!state.options.silent) emit(element, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  }

  function pick(date) {
    if (!pickable(date)) return;
    state.focus = date;
    if (!range()) {
      state.value = date;
      paint();
      const detail = { value: iso(date) };
      fire('change', detail);
      state.options.onSelect?.(detail.value);
      return;
    }
    if (!state.anchor) {
      state.anchor = date;
      state.preview = date;
      paint();
      fire('input', { start: iso(date), end: '' });
      return;
    }
    const [start, end] = compare(state.anchor, date) <= 0 ? [state.anchor, date] : [date, state.anchor];
    state.range = { start, end };
    state.anchor = null;
    state.preview = null;
    paint();
    const detail = { value: `${iso(start)}/${iso(end)}`, start: iso(start), end: iso(end) };
    fire('change', detail);
    state.options.onSelect?.(detail.value);
  }

  const dayOf = (target) => /** @type {Element} */ (target)?.closest?.('.ds-calendar__day');

  element.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const nav = /** @type {Element} */ (event.target)?.closest?.('.ds-calendar__nav');
    if (nav && element.contains(nav)) {
      if (nav.getAttribute('aria-disabled') === 'true') return;
      turnPage(Number(nav.getAttribute('data-step')));
      return;
    }
    const day = dayOf(event.target);
    if (!day || !element.contains(day)) return;
    const date = parse(day.getAttribute('data-date'));
    if (date) pick(date);
  }, { signal });

  element.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    const day = dayOf(event.target);
    if (!day || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const date = parse(day.getAttribute('data-date'));
    if (!date) return;
    const rtl = /** @type {HTMLElement} */ (day).matches(':dir(rtl)');
    const week = info();
    let next = null;
    switch (event.key) {
      case 'ArrowLeft': next = add(date, { days: rtl ? 1 : -1 }); break;
      case 'ArrowRight': next = add(date, { days: rtl ? -1 : 1 }); break;
      case 'ArrowUp': next = add(date, { days: -7 }); break;
      case 'ArrowDown': next = add(date, { days: 7 }); break;
      case 'Home': next = weekStart(date, week.firstDay); break;
      case 'End': next = add(weekStart(date, week.firstDay), { days: 6 }); break;
      case 'PageUp': next = add(date, event.shiftKey ? { years: -1 } : { months: -1 }); break;
      case 'PageDown': next = add(date, event.shiftKey ? { years: 1 } : { months: 1 }); break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        pick(date);
        return;
      default: return;
    }
    event.preventDefault();
    goTo(next);
  }, { signal });

  // The range preview follows the pointer and the focus.
  element.addEventListener('pointerover', (event) => {
    if (!range() || !state.anchor) return;
    const day = dayOf(event.target);
    const date = day && parse(day.getAttribute('data-date'));
    if (!date || (state.preview && !compare(date, state.preview))) return;
    state.preview = date;
    paint();
  }, { signal });
  element.addEventListener('focusin', (event) => {
    const day = dayOf(event.target);
    const date = day && parse(day.getAttribute('data-date'));
    if (!date) return;
    state.focus = date;
    if (range() && state.anchor) state.preview = date;
    paint();
  }, { signal });

  // Another locale: the names and the week change at once.
  element.ownerDocument?.addEventListener('ds:config', () => {
    state.rendered = '';
    render();
  }, { signal });

  render();

  const controller = {
    element,
    /** The value: ISO text (single) or '<start>/<end>' ('' while none). */
    get() {
      if (!range()) return iso(state.value);
      return state.range.start && state.range.end ? `${iso(state.range.start)}/${iso(state.range.end)}` : '';
    },
    /** Sets the value without an event, and shows its month. */
    set(value) {
      setValue(value);
      const shown = range() ? state.range.start : state.value;
      if (shown) {
        state.focus = clampDay(shown);
        if (!visible(state.focus)) state.view = firstOf(state.focus);
      }
      render();
      return controller.get();
    },
    /** Shows the month of `date` (ISO text or a plain date) and makes it the tab stop. */
    show(date) {
      const target = parse(date);
      if (target) goTo(target, false);
    },
    /** Focuses the tab stop (or `date`). */
    focus(date) {
      goTo(parse(date) ?? state.focus);
    },
    /** The months on screen and the focused day, as ISO text. */
    view() {
      return { start: iso(state.view), months: months(), focus: iso(state.focus) };
    },
    /** New options (those of create()), applied at once. */
    update(next = {}) {
      Object.assign(state.options, next);
      if ('value' in next || 'mode' in next) setValue(state.options.value);
      state.rendered = '';
      render();
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

/** The name of the week column ("week"; narrow "wk"), through Intl.DisplayNames. */
function weekFieldName(locale, style = 'long') {
  try {
    return new Intl.DisplayNames(locale, { type: 'dateTimeField', style }).of('weekOfYear') ?? '';
  } catch {
    return '';
  }
}

define('calendar', {
  attribute: 'data-ds-calendar',
  attributes: ['data-ds-value', 'data-ds-calendar-min', 'data-ds-calendar-max', 'data-ds-calendar-disabled', 'data-ds-calendar-months', 'data-ds-calendar-mode', 'data-ds-calendar-weeks', 'data-ds-calendar-first-day'],
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
