/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The time range with refresh (DS.timerange): the range control of a
 * monitoring view. A button names the range ("Last 1 hour") and opens a
 * popover (DS.picker) with quick relative ranges, an absolute from and to
 * (two date-time fields, DS.datefield) and the ranges used recently
 * (remembered through DS.store); beside it a refresh button and an
 * auto-refresh interval that sends ds:refresh on the page's one clock
 * (DS.format.clock, asleep while the page is hidden).
 *
 *   <div class="ds-timerange" data-ds-timerange data-ds-timerange-from="now-1h" data-ds-timerange-to="now"
 *        [data-ds-timerange-refresh="30s"] [data-ds-timerange-intervals="5s,10s,30s,1m,5m,15m,1h"]
 *        [data-ds-timerange-quick="now-15m,now-1h,now-24h,now/d"] [data-ds-timerange-store="devices"]
 *        [data-ds-timerange-zone="local | UTC"] aria-label="Time range"></div>
 *
 *   const range = DS.timerange.create(el);
 *   range.get();                      // { from: 'now-1h', to: 'now', refresh: '30s' }
 *   range.set({ from: 'now-6h' });    // to stays
 *   range.query();                    // 'from=now-6h&to=now&refresh=30s', for the address
 *   DS.timerange.resolve({ from: 'now-1h', to: 'now' });   // { start: Date, end: Date }
 *   DS.timerange.parse('now-1d/d');   // the Date it stands for now
 *
 * Values are URL-friendly text. Relative: now, now-15m, now+1h, a unit
 * after a slash rounds (now/d the start of today; as a "to" the end of
 * it): s, m, h, d, w, M, y. Days, weeks, months, years and the rounding
 * follow the calendar of the zone (now/d in UTC is the UTC day). Absolute: an ISO date or date-time (2026-11-04,
 * 2026-11-04T09:00, with or without its offset; without one it is a wall
 * time in the zone) or milliseconds since 1970. The refresh interval is
 * '' (off) or a span: 5s, 1m, 1h.
 *
 * Events on the root: ds:change ({ from, to, start, end, label, query })
 * when the range changes, ds:refresh ({ from, to, start, end, reason })
 * whenever the page should load again: 'change' (a new range), 'manual'
 * (the refresh button), 'interval' (the auto refresh). start and end are
 * ISO instants, resolved at that moment.
 *
 * Keyboard: the trigger opens the popover (Alt+ArrowDown too); in it, Tab
 * cycles through the quick ranges, the from and to fields, Apply and the
 * recent ranges; a range applies on Enter or a click and closes it; Escape closes
 * without a change. Apply refuses a "from" after the "to" and says so in
 * the popover (role="alert").
 *
 * Strings: timeRange, absoluteRange, rangeFrom, rangeTo, apply,
 * recentRanges, quickRanges, refresh, autoRefresh, off, lastSpan and
 * rangeOrder of DS.core.config(); the spans and dates come from Intl.
 *
 * ES2022; no progressive feature of its own.
 */
import { config, define, emit, t } from './core.js';
import { clock } from './format.js';
import { open as openStore } from './store.js';
import { announce } from './a11y.js';
import { iconElement, alertCircle, clock as clockIcon, chevronDown, refresh as refreshIcon } from './icons.js';
import { weekInfo } from './calendar.js';
import { create as createField, toInstant } from './datefield.js';
import { create as createPicker } from './picker.js';

const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const UNIT_NAMES = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', M: 'month', y: 'year' };

const DEFAULT_QUICK = ['now-5m', 'now-15m', 'now-30m', 'now-1h', 'now-3h', 'now-6h', 'now-12h', 'now-24h', 'now-2d', 'now-7d', 'now-30d', 'now-90d', 'now/d', 'now-1d/d', 'now/w', 'now/M'];
const DEFAULT_INTERVALS = ['5s', '10s', '30s', '1m', '5m', '15m', '30m', '1h'];
const RECENT_MAX = 5;

const RELATIVE = /^now((?:[+-]\d+[smhdwMy])*)(?:\/([smhdwMy]))?$/;

/** The zone a rounding or a calendar step works in: an IANA name the engine knows, else '' (local time). */
function zoneOf(timeZone) {
  if (!timeZone || timeZone === 'local') return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return '';
  }
}

/** The wall time of an instant in a zone ('' local), as a Date whose UTC fields are that wall time. */
function wallOf(date, zone) {
  const ms = ((date.getTime() % 1000) + 1000) % 1000;
  if (!zone) return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), ms));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'), ms));
}

/** The instant of a wall time (wallOf()) in a zone ('' local); a wall time a change of clocks skips moves forward. */
function instantOf(wall, zone) {
  if (!zone) return new Date(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds(), wall.getUTCMilliseconds());
  const instant = toInstant(wall.toISOString().slice(0, 19), zone);
  return instant ? new Date(instant.getTime() + wall.getUTCMilliseconds()) : wall;
}

/**
 * Runs `change(wall)` on the wall time of `date` in the zone (now/d in UTC
 * is the UTC day), or in local time without one, and returns the instant
 * of the result. The wall time is a Date read and set through its UTC
 * fields, which no change of clocks moves.
 */
function onCalendar(date, timeZone, change) {
  const zone = zoneOf(timeZone);
  const wall = wallOf(date, zone);
  change(wall);
  return instantOf(wall, zone);
}

/** A date moved by a number of units (days, weeks, months and years by the calendar of the zone). */
function shift(date, amount, unit, timeZone) {
  if (unit === 's' || unit === 'm' || unit === 'h') return new Date(date.getTime() + amount * UNIT_MS[unit]);
  return onCalendar(date, timeZone, (wall) => {
    if (unit === 'M') wall.setUTCMonth(wall.getUTCMonth() + amount);
    else if (unit === 'y') wall.setUTCFullYear(wall.getUTCFullYear() + amount);
    else wall.setUTCDate(wall.getUTCDate() + amount * (unit === 'w' ? 7 : 1));
  });
}

/** The start (or, `up`, the last millisecond) of the unit around a date, in the zone's calendar. */
function round(date, unit, up, firstDay = 1, timeZone = '') {
  const start = onCalendar(date, timeZone, (wall) => {
    switch (unit) {
      case 'y': wall.setUTCMonth(0, 1); wall.setUTCHours(0, 0, 0, 0); break;
      case 'M': wall.setUTCDate(1); wall.setUTCHours(0, 0, 0, 0); break;
      case 'w': wall.setUTCDate(wall.getUTCDate() - ((wall.getUTCDay() || 7) - firstDay + 7) % 7); wall.setUTCHours(0, 0, 0, 0); break;
      case 'd': wall.setUTCHours(0, 0, 0, 0); break;
      case 'h': wall.setUTCMinutes(0, 0, 0); break;
      case 'm': wall.setUTCSeconds(0, 0); break;
      default: wall.setUTCMilliseconds(0);
    }
  });
  return up ? new Date(shift(start, 1, unit, timeZone).getTime() - 1) : start;
}

/**
 * The instant a value stands for (see the header), or null.
 * @param {string} value
 * @param {{ now?: Date|number, roundUp?: boolean, timeZone?: string, firstDay?: number }} [options]
 * @returns {Date|null}
 */
export function parse(value, options = {}) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const now = new Date(options.now ?? Date.now());
  const relative = RELATIVE.exec(text);
  if (relative) {
    let date = now;
    for (const [, sign, amount, unit] of relative[1].matchAll(/([+-])(\d+)([smhdwMy])/g)) date = shift(date, Number(amount) * (sign === '-' ? -1 : 1), unit, options.timeZone);
    return relative[2] ? round(date, relative[2], Boolean(options.roundUp), options.firstDay ?? weekInfo().firstDay, options.timeZone) : date;
  }
  if (/^\d{9,}$/.test(text)) return new Date(Number(text));
  // With its offset: an instant as it stands.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  // Without: a wall time in the zone.
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(text)) return toInstant(text.includes('T') ? text : `${text}T00:00`, options.timeZone ?? 'local');
  return null;
}

/**
 * The instants of a range at `now`: { start, end }, or null where a value
 * does not parse. A rounded "to" ends with its unit (now/d: the end of today).
 * @param {{ from: string, to?: string }} range
 * @param {{ now?: Date|number, timeZone?: string, firstDay?: number }} [options]
 * @returns {{ start: Date, end: Date }|null}
 */
export function resolve(range, options = {}) {
  // One now for both ends: read twice, "last 6 hours" could span 6 hours and a millisecond.
  const now = options.now ?? Date.now();
  const start = parse(range?.from, { ...options, now });
  const end = parse(range?.to ?? 'now', { ...options, now, roundUp: true });
  return start && end ? { start, end } : null;
}

/**
 * The milliseconds of a span ('30s', '5m', '1h', '1d'), or 0 for none.
 * @param {string} span
 * @returns {number}
 */
export function spanMs(span) {
  const match = /^(\d+)([smhdw])$/.exec(String(span ?? '').trim());
  return match ? Number(match[1]) * UNIT_MS[match[2]] : 0;
}

/** Intl formatters by type, locale and options, made once: a time range names some 25 spans when it paints. */
const formats = new Map();
function format(Type, locale, options) {
  const key = `${Type.name}|${locale}|${JSON.stringify(options)}`;
  let made = formats.get(key);
  if (!made) {
    made = new Type(locale, options);
    if (formats.size >= 64) formats.clear();
    formats.set(key, made);
  }
  return made;
}

/** A span in words of the locale ("15 minutes", "5s" narrow). */
function spanWords(amount, unit, locale, display = 'long') {
  try {
    return format(Intl.NumberFormat, locale, { style: 'unit', unit: UNIT_NAMES[unit], unitDisplay: display }).format(amount);
  } catch {
    return `${amount}${unit}`;
  }
}

const capital = (text, locale) => (text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text);

/**
 * A range for people: "Last 15 minutes", "Today", "Yesterday", "This
 * week", or the two instants through Intl (formatRange).
 * @param {{ from: string, to?: string }} range
 * @param {{ locale?: string, now?: Date|number, timeZone?: string }} [options]
 * @returns {string}
 */
export function label(range, options = {}) {
  const locale = options.locale || config().locale || 'en';
  const from = String(range?.from ?? '');
  const to = String(range?.to ?? 'now');
  const last = /^now-(\d+)([smhdwMy])$/.exec(from);
  if (last && to === 'now') return t('lastSpan', { span: spanWords(Number(last[1]), last[2], locale) });
  const rounded = /^now(?:-(\d+)([dwMy]))?\/([dwMy])$/.exec(from);
  if (rounded && (to === from || to === 'now') && (!rounded[2] || rounded[2] === rounded[3])) {
    try {
      const amount = rounded[1] ? -Number(rounded[1]) : 0;
      return capital(format(Intl.RelativeTimeFormat, locale, { numeric: 'auto' }).format(amount, UNIT_NAMES[rounded[3]]), locale);
    } catch {
      // The instants below.
    }
  }
  const instants = resolve({ from, to }, options);
  if (!instants) return `${from} – ${to}`;
  return format(Intl.DateTimeFormat, locale, { dateStyle: 'medium', timeStyle: 'short', ...(options.timeZone && options.timeZone !== 'local' ? { timeZone: options.timeZone } : {}) })
    .formatRange(instants.start, instants.end);
}

/**
 * A range and its refresh as a query string (URLSearchParams): 'from=now-1h&to=now&refresh=30s'.
 * @param {{ from: string, to?: string, refresh?: string }} range
 * @returns {string}
 */
export function query(range) {
  const params = new URLSearchParams();
  params.set('from', String(range?.from ?? ''));
  params.set('to', String(range?.to ?? 'now'));
  if (range?.refresh) params.set('refresh', String(range.refresh));
  return params.toString();
}

const controllers = new WeakMap();
let serial = 0;

const list = (text) => String(text ?? '').split(',').map((item) => item.trim()).filter(Boolean);

function readOptions(root) {
  const data = root.dataset ?? {};
  const options = {};
  if (data.dsTimerangeFrom) options.from = data.dsTimerangeFrom;
  if (data.dsTimerangeTo) options.to = data.dsTimerangeTo;
  if ('dsTimerangeRefresh' in data) options.refresh = data.dsTimerangeRefresh === 'off' ? '' : data.dsTimerangeRefresh;
  if (data.dsTimerangeIntervals) options.intervals = list(data.dsTimerangeIntervals);
  if (data.dsTimerangeQuick) options.quick = list(data.dsTimerangeQuick);
  if (data.dsTimerangeStore) options.store = data.dsTimerangeStore;
  if ('dsTimerangeZone' in data) options.zone = data.dsTimerangeZone || 'local';
  return options;
}

/** The "to" of a quick range: now, or for a rounded one the same expression (its end). */
const quickTo = (from) => (/\/[smhdwMy]$/.test(from) ? from : 'now');

/** An ISO wall time ('2026-11-04T09:30') of an instant in a zone. */
function wallTime(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { ...(zone && zone !== 'local' ? { timeZone: zone } : {}), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
}

/**
 * The time range's controller, the one [data-ds-timerange] makes; once per
 * root. Options: `from`, `to` (default now-1h and now), `refresh` (a span,
 * '' off), `intervals` and `quick` (lists of spans and of "from" values),
 * `store` (the DS.store key of the recent ranges, default 'recent'),
 * `zone` (the zone of absolute times: 'local' or an IANA name), `locale`.
 * @param {Element} root
 * @param {object} [options]
 * @returns {any}
 */
export function create(root, options = {}) {
  const existing = controllers.get(root);
  if (existing) return existing;
  const settings = { from: 'now-1h', to: 'now', refresh: '', intervals: DEFAULT_INTERVALS, quick: DEFAULT_QUICK, store: 'recent', ...readOptions(root), ...options };
  const doc = root.ownerDocument;
  const abort = new AbortController();
  const { signal } = abort;
  const listeners = new Map();
  const id = `ds-timerange-${serial += 1}`;
  const state = { from: settings.from, to: settings.to, refresh: settings.refresh };
  const locale = () => settings.locale || config().locale || 'en';
  const prefs = openStore('timerange');
  const zone = () => settings.zone ?? 'local';

  root.classList.add('ds-timerange');
  if (!root.hasAttribute('role')) root.setAttribute('role', 'group');
  if (!root.hasAttribute('aria-label') && !root.hasAttribute('aria-labelledby')) root.setAttribute('aria-label', t('timeRange'));

  const make = (tag, className, attrs = {}) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };

  // The trigger and its popover.
  const wrap = make('div', 'ds-picker ds-timerange__range');
  const trigger = make('button', 'ds-btn ds-timerange__trigger', { type: 'button' });
  const triggerLabel = make('span', 'ds-btn__label ds-timerange__label');
  trigger.append(iconNode(clockIcon, 16), triggerLabel, iconNode(chevronDown, 16, 'ds-timerange__chevron'));
  const panel = make('div', 'ds-picker__popover', { 'aria-label': t('timeRange') });
  panel.hidden = true;
  const panes = make('div', 'ds-picker__panes');

  const absolute = make('div', 'ds-picker__pane ds-timerange__absolute');
  const absoluteHead = make('p', 'ds-picker__heading', { id: `${id}-abs` });
  const fromLabel = make('span', 'ds-timerange__field-label', { id: `${id}-from` });
  const fromEl = make('div', 'ds-datefield ds-datefield--block', { 'aria-labelledby': `${id}-from` });
  const toLabel = make('span', 'ds-timerange__field-label', { id: `${id}-to` });
  const toEl = make('div', 'ds-datefield ds-datefield--block', { 'aria-labelledby': `${id}-to`, 'aria-describedby': `${id}-error` });
  const error = make('p', 'ds-timerange__error', { role: 'alert', id: `${id}-error` });
  const apply = make('button', 'ds-btn ds-btn--filled ds-timerange__apply', { type: 'button' });
  const recentHead = make('p', 'ds-picker__heading', { id: `${id}-recent` });
  const recent = make('div', 'ds-picker__presets', { role: 'group', 'aria-labelledby': `${id}-recent` });
  absolute.append(absoluteHead, fromLabel, fromEl, toLabel, toEl, error, apply, recentHead, recent);

  const quick = make('div', 'ds-picker__presets ds-timerange__quick', { role: 'group', 'aria-labelledby': `${id}-quick` });
  const quickHead = make('p', 'ds-picker__heading', { id: `${id}-quick` });
  // The group's name exists from the start: its buttons come on the first open, its heading does not wait for them.
  quickHead.textContent = t('quickRanges');
  quick.append(quickHead);
  panes.append(quick, absolute);
  panel.append(panes);
  wrap.append(trigger, panel);

  // Refresh now, and every interval.
  const refreshButton = make('button', 'ds-btn ds-btn--icon', { type: 'button' });
  refreshButton.append(iconNode(refreshIcon, 20));
  const selectWrap = make('span', 'ds-timerange__interval');
  const select = make('select', 'ds-timerange__select');
  selectWrap.append(select, iconNode(chevronDown, 16, 'ds-timerange__chevron'));
  root.replaceChildren(wrap, refreshButton, selectWrap);

  // The absolute fields are made on the first open: nothing shows them before, and their Intl formats would make
  // the start of a view a long task on a slow phone.
  let fromField = null;
  let toField = null;
  let listed = false;
  function fields() {
    if (fromField) return;
    fromField = createField(fromEl, { type: 'datetime', zone: settings.zone, locale: settings.locale, silent: true });
    toField = createField(toEl, { type: 'datetime', zone: settings.zone, locale: settings.locale, silent: true });
    // A field typed again is judged again.
    for (const field of [fromField, toField]) {
      field.on('change', () => {
        fromField.update({ invalid: false });
        toField.update({ invalid: false });
        error.textContent = '';
      });
    }
  }

  function iconNode(glyph, size, extra) {
    return iconElement(glyph, size, extra, doc);
  }

  function fire(type, detail) {
    emit(root, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  }

  const timeOptions = () => ({ timeZone: zone() === 'local' ? undefined : zone() });

  function detail() {
    const instants = resolve(state, timeOptions());
    return {
      from: state.from,
      to: state.to,
      start: instants?.start.toISOString() ?? '',
      end: instants?.end.toISOString() ?? '',
      label: label(state, { locale: locale(), ...timeOptions() }),
      query: query(state),
    };
  }

  function recentList() {
    const items = prefs.get(`recent:${settings.store}`, []);
    return Array.isArray(items) ? items.filter((item) => item && typeof item.from === 'string' && typeof item.to === 'string') : [];
  }

  function remember() {
    if (settings.quick.includes(state.from) && state.to === quickTo(state.from)) return;
    const next = [{ from: state.from, to: state.to }, ...recentList().filter((item) => item.from !== state.from || item.to !== state.to)].slice(0, RECENT_MAX);
    prefs.set(`recent:${settings.store}`, next);
  }

  function rangeButton(range, current) {
    const button = make('button', 'ds-picker__preset', { type: 'button', 'data-from': range.from, 'data-to': range.to });
    button.textContent = label(range, { locale: locale(), ...timeOptions() });
    if (current) button.setAttribute('aria-current', 'true');
    return button;
  }

  /** Writes every text and list: names in the locale, the range in force. */
  function paint() {
    const loc = locale();
    triggerLabel.textContent = label(state, { locale: loc, ...timeOptions() });
    absoluteHead.textContent = t('absoluteRange');
    fromLabel.textContent = t('rangeFrom');
    toLabel.textContent = t('rangeTo');
    apply.textContent = t('apply');
    recentHead.textContent = t('recentRanges');
    quickHead.textContent = t('quickRanges');
    refreshButton.setAttribute('aria-label', t('refresh'));
    refreshButton.setAttribute('data-tip', t('refresh'));
    select.setAttribute('aria-label', t('autoRefresh'));
    // The quick and recent ranges only once the popover has opened: until then nothing shows them.
    if (listed) {
      const same = (range) => range.from === state.from && range.to === state.to;
      quick.replaceChildren(quickHead, ...settings.quick.map((from) => rangeButton({ from, to: quickTo(from) }, same({ from, to: quickTo(from) }))));
      const recents = recentList();
      recent.replaceChildren(...recents.map((range) => rangeButton(range, same(range))));
      recentHead.hidden = !recents.length;
      recent.hidden = !recents.length;
    }
    const intervals = settings.intervals.filter((span) => spanMs(span));
    select.replaceChildren(make('option', '', { value: '' }), ...intervals.map((span) => make('option', '', { value: span })));
    select.options[0].textContent = t('off');
    intervals.forEach((span, index) => {
      const [, amount, unit] = /^(\d+)([smhdw])$/.exec(span);
      select.options[index + 1].textContent = spanWords(Number(amount), unit, loc, 'narrow');
    });
    select.value = intervals.includes(state.refresh) ? state.refresh : '';
    selectWrap.toggleAttribute('data-on', Boolean(select.value));
  }

  /** The absolute fields show the range in force, as wall times in the zone. */
  function fillFields() {
    fields();
    const instants = resolve(state, timeOptions());
    fromField.set(instants ? wallTime(instants.start, zone()) : '');
    toField.set(instants ? wallTime(instants.end, zone()) : '');
    error.textContent = '';
    fromField.update({ invalid: false });
    toField.update({ invalid: false });
  }

  let stopClock = null;
  let due = 0;

  function schedule() {
    stopClock?.();
    stopClock = null;
    const every = spanMs(state.refresh);
    if (!every) return;
    due = Date.now() + every;
    stopClock = clock(() => {
      const left = due - Date.now();
      if (left > 0) return left;
      due = Date.now() + every;
      refresh('interval');
      return every;
    });
  }

  function refresh(reason) {
    const info = detail();
    fire('refresh', { from: info.from, to: info.to, start: info.start, end: info.end, reason });
  }

  /** A new range (as chosen): remembered, told, refreshed. */
  function change(next, notify = true) {
    const before = `${state.from}|${state.to}`;
    state.from = next.from ?? state.from;
    state.to = next.to ?? state.to;
    paint();
    if (!notify || before === `${state.from}|${state.to}`) return;
    remember();
    paint();
    const info = detail();
    fire('change', info);
    announce(info.label);
    refresh('change');
    if (state.refresh) schedule();
  }

  const picker = createPicker(wrap, {
    toggle: trigger,
    panel,
    onOpen() {
      listed = true;
      paint();
      fillFields();
    },
    focus: () => quick.querySelector('[aria-current="true"]') ?? fromEl.querySelector('.ds-datefield__segment'),
  });

  panel.addEventListener('click', (event) => {
    const button = /** @type {Element} */ (event.target)?.closest?.('.ds-picker__preset');
    if (!button) return;
    // Closed first, so focus goes back to the trigger before the lists are written again.
    picker.close('select');
    change({ from: button.getAttribute('data-from'), to: button.getAttribute('data-to') });
  }, { signal });

  apply.addEventListener('click', () => {
    fields();
    const from = fromField.get();
    const to = toField.get();
    const start = from ? toInstant(from, zone()) : null;
    const end = to ? toInstant(to, zone()) : null;
    if (!start || !end) {
      // An unfinished field says so itself (aria-invalid) and takes the focus.
      const missing = start ? toField : fromField;
      missing.update({ invalid: true });
      missing.focus();
      return;
    }
    if (start >= end) {
      // An icon and the words: never the colour alone.
      error.replaceChildren(iconNode(alertCircle, 16), doc.createTextNode(t('rangeOrder')));
      toField.update({ invalid: true });
      return;
    }
    // Absolute: an instant with its offset (UTC), readable in an address.
    picker.close('select');
    change({ from: start.toISOString().replace(/\.000Z$/, 'Z'), to: end.toISOString().replace(/\.000Z$/, 'Z') });
  }, { signal });

  refreshButton.addEventListener('click', () => refresh('manual'), { signal });
  select.addEventListener('change', () => {
    state.refresh = select.value;
    selectWrap.toggleAttribute('data-on', Boolean(select.value));
    schedule();
    fire('change', { ...detail(), refresh: state.refresh });
  }, { signal });
  doc.addEventListener('ds:config', () => paint(), { signal });

  paint();
  schedule();

  const controller = {
    element: root,
    /** The range in force and its refresh interval. */
    get() {
      return { from: state.from, to: state.to, refresh: state.refresh };
    },
    /** Sets the range ({ from, to }, or a "from" alone; to stays) and the refresh; no event. */
    set(value) {
      const next = typeof value === 'string' ? { from: value } : value ?? {};
      if ('refresh' in next) state.refresh = next.refresh ?? '';
      change(next, false);
      schedule();
      return controller.get();
    },
    /** The instants of the range now. */
    resolve: () => resolve(state, timeOptions()),
    /** The range as a query string, for the address. */
    query: () => query(state),
    /** Sends ds:refresh at once (reason 'manual'). */
    refresh: () => refresh('manual'),
    open: () => picker.open(),
    close: () => picker.close(),
    on(type, fn) {
      const key = String(type).replace(/^ds:/, '');
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key)?.delete(fn);
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      stopClock?.();
      picker.destroy();
      fromField?.destroy();
      toField?.destroy();
      prefs.destroy();
      listeners.clear();
      controllers.delete(root);
    },
  };
  controllers.set(root, controller);
  return controller;
}

define('timerange', {
  attribute: 'data-ds-timerange',
  init: (root) => create(root),
});
