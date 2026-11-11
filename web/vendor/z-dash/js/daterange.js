/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The date range picker (DS.daterange): a segmented field of two dates
 * (DS.datefield, type range) and a popover (DS.picker) with presets and two
 * months side by side (DS.calendar, range mode) that preview the range under
 * the pointer and the keys.
 *
 *   <div class="ds-picker" data-ds-daterange data-ds-value="last-7-days"
 *        [data-ds-daterange-presets="today,yesterday,last-7-days,last-30-days,this-month,last-month"]
 *        [data-ds-daterange-min] [data-ds-daterange-max] [data-ds-daterange-weeks] [data-ds-daterange-name="period"]>
 *     <div class="ds-datefield" role="group" aria-labelledby="period-label">
 *       <button class="ds-btn ds-btn--quiet ds-btn--icon ds-datefield__toggle" type="button" aria-label="Choose dates">(calendarRange)</button>
 *     </div>
 *   </div>
 *
 *   const range = DS.daterange.create(root);
 *   range.get();               // 'last-7-days' (a preset in force) or '2026-11-01/2026-11-07'
 *   range.range();             // { start: '2026-10-29', end: '2026-11-04', preset: 'last-7-days' }
 *   DS.daterange.resolve('this-month');   // { start, end } today
 *
 * Values: ISO text '<start>/<end>', or a relative preset that is resolved
 * against today whenever it is read, so a saved "last 7 days" is the last
 * seven days tomorrow too: today, yesterday, last-<n>-days (today and the
 * n - 1 days before), this-week, last-week, this-month, last-month,
 * this-year, last-year (this-*: from the period's start to today; last-*:
 * the whole period before). Weeks start on the locale's first day.
 *
 * The popover: the presets (the one in force aria-current) and the
 * calendar (two months on a wide screen, one on a phone). The first pick
 * starts the range, the pointer or the keys preview it, the second pick
 * ends it, puts it into the field and closes the popover. A preset applies
 * at once. Escape closes without a change. Typing into the field changes
 * the range too (the preset no longer holds).
 *
 * ds:change ({ value, start, end, preset, valid }) on the root.
 *
 * Strings: chooseDates, lastSpan ("Last {span}"), clear and presets of
 * DS.core.config(); the other preset names come from
 * Intl.RelativeTimeFormat, the spans from Intl.NumberFormat units.
 *
 * ES2022; no progressive feature of its own.
 */
import { config, define, emit, t } from './core.js';
import { create as createCalendar, parse, iso, today, add, weekInfo, rangeLabel } from './calendar.js';
import { create as createField } from './datefield.js';
import { create as createPicker } from './picker.js';

/** The presets offered when the markup names none. */
const DEFAULT_PRESETS = ['today', 'yesterday', 'last-7-days', 'last-30-days', 'this-month', 'last-month', 'this-year'];

const LAST_DAYS = /^last-(\d{1,4})-days$/;

/**
 * The range a preset stands for today (or on `today`), as ISO text, or
 * null for no preset.
 * @param {string} preset
 * @param {{ today?: any, locale?: string, firstDay?: number }} [options]
 * @returns {{ start: string, end: string }|null}
 */
export function resolve(preset, options = {}) {
  const now = parse(options.today) ?? today();
  const firstDay = options.firstDay ?? weekInfo(options.locale ?? config().locale).firstDay;
  const weekStart = (date) => add(date, { days: -((weekdayOf(date) - firstDay + 7) % 7) });
  const out = (start, end) => ({ start: iso(start), end: iso(end) });
  const days = LAST_DAYS.exec(preset ?? '');
  if (days) return out(add(now, { days: 1 - Math.max(1, Number(days[1])) }), now);
  switch (preset) {
    case 'today': return out(now, now);
    case 'yesterday': {
      const day = add(now, { days: -1 });
      return out(day, day);
    }
    case 'this-week': return out(weekStart(now), now);
    case 'last-week': {
      const start = add(weekStart(now), { days: -7 });
      return out(start, add(start, { days: 6 }));
    }
    case 'this-month': return out({ ...now, day: 1 }, now);
    case 'last-month': {
      const start = add({ ...now, day: 1 }, { months: -1 });
      return out(start, add(start, { months: 1, days: -1 }));
    }
    case 'this-year': return out({ year: now.year, month: 1, day: 1 }, now);
    case 'last-year': return out({ year: now.year - 1, month: 1, day: 1 }, { year: now.year - 1, month: 12, day: 31 });
    default: return null;
  }
}

/** The ISO weekday (1 Monday ... 7 Sunday). */
function weekdayOf(date) {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The name of a preset for people ("Last 7 days", "This month"), from Intl
 * and the lastSpan string.
 * @param {string} preset
 * @param {{ locale?: string }} [options]
 * @returns {string}
 */
export function presetLabel(preset, options = {}) {
  const locale = options.locale || config().locale || 'en';
  const capital = (text) => (text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text);
  const relative = (amount, unit) => {
    try {
      return capital(new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(amount, unit));
    } catch {
      return preset;
    }
  };
  const days = LAST_DAYS.exec(preset ?? '');
  if (days) {
    let span = `${days[1]}`;
    try {
      span = new Intl.NumberFormat(locale, { style: 'unit', unit: 'day', unitDisplay: 'long' }).format(Number(days[1]));
    } catch {
      // The bare number.
    }
    return t('lastSpan', { span });
  }
  const table = {
    today: [0, 'day'], yesterday: [-1, 'day'], 'this-week': [0, 'week'], 'last-week': [-1, 'week'],
    'this-month': [0, 'month'], 'last-month': [-1, 'month'], 'this-year': [0, 'year'], 'last-year': [-1, 'year'],
  };
  return table[preset] ? relative(...table[preset]) : String(preset ?? '');
}

const controllers = new WeakMap();
let serial = 0;

function readOptions(root) {
  const data = root.dataset ?? {};
  const options = {};
  if ('dsValue' in data) options.value = data.dsValue;
  if (data.dsDaterangePresets !== undefined) options.presets = data.dsDaterangePresets ? data.dsDaterangePresets.split(',').map((item) => item.trim()).filter(Boolean) : [];
  if (data.dsDaterangeMin) options.min = data.dsDaterangeMin;
  if (data.dsDaterangeMax) options.max = data.dsDaterangeMax;
  if (data.dsDaterangeDisabled) options.disabled = data.dsDaterangeDisabled;
  if ('dsDaterangeWeeks' in data) options.weeks = data.dsDaterangeWeeks !== 'off';
  if (data.dsDaterangeName) options.name = data.dsDaterangeName;
  return options;
}

/**
 * The date range picker's controller, the one [data-ds-daterange] makes;
 * once per root. Options: `value` (ISO text '<start>/<end>' or a preset),
 * `presets` (keys; [] for none), `min`, `max`, `disabled`
 * (DS.calendar.available()), `weeks`, `name`, `locale`.
 * @param {Element} root
 * @param {object} [options]
 * @returns {any}
 */
export function create(root, options = {}) {
  const existing = controllers.get(root);
  if (existing) return existing;
  const settings = { presets: DEFAULT_PRESETS, ...readOptions(root), ...options };
  const doc = root.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const listeners = new Set();
  const abort = new AbortController();
  root.classList.add('ds-picker');
  let preset = '';

  /** ISO text of a value: a preset resolves against today. */
  function rangeText(value) {
    const resolved = resolve(value, { locale: settings.locale });
    if (resolved) return `${resolved.start}/${resolved.end}`;
    return String(value ?? '');
  }

  let fieldEl = root.querySelector('.ds-datefield');
  if (!fieldEl) {
    fieldEl = doc.createElement('div');
    fieldEl.className = 'ds-datefield';
    root.prepend(fieldEl);
  }
  const toggle = fieldEl.querySelector('.ds-datefield__toggle') ?? root.querySelector('.ds-datefield__toggle');
  if (toggle && !toggle.hasAttribute('aria-label')) toggle.setAttribute('aria-label', t('chooseDates'));
  if (resolve(settings.value)) preset = settings.value;
  const field = createField(fieldEl, { type: 'range', value: rangeText(settings.value), min: settings.min, max: settings.max, disabled: settings.disabled, name: settings.name, locale: settings.locale, silent: true });

  // The preset in force, named inside the field (and its description).
  const badge = doc.createElement('span');
  badge.className = 'ds-daterange__preset';
  badge.id = `ds-range-preset-${serial += 1}`;
  fieldEl.insertBefore(badge, toggle && toggle.parentElement === fieldEl ? toggle : null);

  const panel = doc.createElement('div');
  panel.className = 'ds-picker__popover';
  panel.hidden = true;
  panel.setAttribute('aria-label', toggle?.getAttribute('aria-label') ?? t('chooseDates'));
  const panes = doc.createElement('div');
  panes.className = 'ds-picker__panes';
  const presets = doc.createElement('div');
  presets.className = 'ds-picker__presets';
  presets.setAttribute('role', 'group');
  presets.setAttribute('aria-label', t('presets'));
  const calendarPane = doc.createElement('div');
  calendarPane.className = 'ds-picker__pane';
  const calendarEl = doc.createElement('div');
  calendarEl.className = 'ds-calendar';
  calendarPane.append(calendarEl);
  if (settings.presets.length) panes.append(presets);
  panes.append(calendarPane);
  const foot = doc.createElement('div');
  foot.className = 'ds-picker__foot';
  const summary = doc.createElement('span');
  summary.className = 'ds-daterange__summary';
  summary.setAttribute('aria-live', 'polite');
  const spacer = doc.createElement('span');
  spacer.className = 'ds-picker__spacer';
  const clear = doc.createElement('button');
  clear.type = 'button';
  clear.className = 'ds-btn ds-btn--text';
  foot.append(summary, spacer, clear);
  panel.append(panes, foot);
  root.append(panel);

  const wide = () => typeof view.matchMedia !== 'function' || view.matchMedia('(min-width: 720px)').matches;

  let picker = null;
  const calendar = createCalendar(calendarEl, {
    mode: 'range', value: field.get(), months: wide() ? 2 : 1, min: settings.min, max: settings.max,
    disabled: settings.disabled, weeks: settings.weeks, locale: settings.locale, silent: true,
    onSelect(value) {
      commit(value, '');
      picker?.close('select');
    },
  });
  calendar.on('input', ({ start }) => {
    summary.textContent = rangeLabel(start, start, { locale: settings.locale });
  });

  function renderPresets() {
    presets.replaceChildren(...settings.presets.map((key) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'ds-picker__preset';
      button.setAttribute('data-preset', key);
      button.textContent = presetLabel(key, { locale: settings.locale });
      return button;
    }));
  }

  function paint() {
    for (const button of presets.querySelectorAll('.ds-picker__preset')) {
      if (button.getAttribute('data-preset') === preset) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
    badge.textContent = preset ? presetLabel(preset, { locale: settings.locale }) : '';
    badge.hidden = !preset;
    const described = new Set((fieldEl.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
    if (preset) described.add(badge.id);
    else described.delete(badge.id);
    if (described.size) fieldEl.setAttribute('aria-describedby', [...described].join(' '));
    else fieldEl.removeAttribute('aria-describedby');
    const [start, end] = field.get().split('/');
    summary.textContent = start && end ? rangeLabel(start, end, { locale: settings.locale }) : '';
    clear.textContent = t('clear');
  }

  function detail(valid = field.valid()) {
    const [start = '', end = ''] = field.get().split('/');
    return { value: preset || field.get(), start, end, preset, valid };
  }

  function fire() {
    const info = detail();
    emit(root, 'change', info);
    for (const fn of listeners) fn(info);
  }

  /** A range (ISO text) or a preset, as the person chose it. */
  function commit(value, key) {
    preset = key;
    field.set(rangeText(key || value));
    calendar.set(field.get());
    paint();
    fire();
  }

  presets.addEventListener('click', (event) => {
    const button = /** @type {Element} */ (event.target)?.closest?.('.ds-picker__preset');
    if (!button) return;
    commit('', button.getAttribute('data-preset'));
    picker?.close('select');
  });
  clear.addEventListener('click', () => {
    commit('', '');
    picker?.close('select');
  });
  // Typed: the range is the field's, no preset holds.
  const unsubscribe = field.on('change', () => {
    preset = '';
    paint();
    fire();
  });

  picker = createPicker(root, {
    toggle,
    panel,
    onOpen() {
      calendar.update({ months: wide() ? 2 : 1, value: field.get() });
      paint();
    },
    focus() {
      const [start] = field.get().split('/');
      calendar.show(parse(start) ?? today());
      return calendarEl.querySelector('.ds-calendar__day[tabindex="0"]');
    },
  });

  renderPresets();
  paint();
  doc.addEventListener('ds:config', () => {
    renderPresets();
    paint();
  }, { signal: abort.signal });

  const controller = {
    element: root,
    /** The preset in force, else the range as ISO text ('' while none). */
    get: () => preset || field.get(),
    /** Sets a range or a preset, without an event. */
    set(value) {
      preset = resolve(value) ? value : '';
      field.set(rangeText(value));
      calendar.set(field.get());
      paint();
      return controller.get();
    },
    /** The range today: { start, end, preset }. */
    range() {
      if (preset) field.set(rangeText(preset));
      const { start, end } = detail();
      return { start, end, preset };
    },
    open: () => picker.open(),
    close: () => picker.close(),
    on(type, fn) {
      if (String(type).replace(/^ds:/, '') !== 'change') return picker.on(type, fn);
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      abort.abort();
      unsubscribe();
      calendar.destroy();
      picker.destroy();
      field.destroy();
      panel.remove();
      badge.remove();
      controllers.delete(root);
    },
  };
  controllers.set(root, controller);
  return controller;
}

define('daterange', {
  attribute: 'data-ds-daterange',
  init: (root) => create(root),
});
