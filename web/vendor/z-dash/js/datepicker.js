/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The date picker (DS.datepicker): a segmented date field (DS.datefield)
 * and a calendar in a popover (DS.calendar in DS.picker), the WAI-ARIA date
 * picker dialog. With type datetime the field takes the time as well, the
 * popover a list of times beside the calendar, and the field can name the
 * zone of its wall time.
 *
 *   <div class="ds-picker" data-ds-datepicker data-ds-value="2026-11-04"
 *        [data-ds-datepicker-type="datetime"] [data-ds-datepicker-min] [data-ds-datepicker-max]
 *        [data-ds-datepicker-disabled="6,7"] [data-ds-datepicker-weeks] [data-ds-datepicker-zone="local"]
 *        [data-ds-datepicker-step="30"] [data-ds-datepicker-name="due"]>
 *     <div class="ds-datefield" role="group" aria-labelledby="due-label">
 *       <button class="ds-btn ds-btn--quiet ds-btn--icon ds-datefield__toggle" type="button" aria-label="Choose date">(calendar)</button>
 *     </div>
 *   </div>
 *
 *   const picker = DS.datepicker.create(root);   // get(), set(), open(), close(), on(), destroy()
 *
 * The button opens the popover with focus on the chosen day (else today);
 * the calendar's keys move it, Enter or a click picks it, puts it into the
 * field and closes the popover, and focus is back on the button. Escape
 * closes without a change. "Today" (the date picker) or "Now" (date and
 * time) picks that at once; "Clear" empties the field. Alt+ArrowDown in
 * the field opens the popover too. A date and time picks the day in the
 * calendar (the popover stays) and the time in the list (it closes).
 *
 * ds:change ({ value, valid }) on the root, whether the value was typed
 * or picked (the field inside sends none of its own).
 *
 * Strings: chooseDate and clear of DS.core.config(); "Today" and "Now"
 * come from Intl.RelativeTimeFormat.
 *
 * ES2022; no progressive feature of its own.
 */
import { config, define, emit, t } from './core.js';
import { create as createCalendar, parse, iso, today, available } from './calendar.js';
import { create as createField } from './datefield.js';
import { create as createPicker } from './picker.js';
import { list as timeList } from './timepicker.js';

const controllers = new WeakMap();

/** "Today" or "Now", through Intl.RelativeTimeFormat, with a capital. */
function relativeWord(locale, unit) {
  let word = '';
  try {
    word = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, unit);
  } catch {
    word = '';
  }
  return word ? word.charAt(0).toLocaleUpperCase(locale) + word.slice(1) : '';
}

function readOptions(root) {
  const data = root.dataset ?? {};
  const options = {};
  if ('dsValue' in data) options.value = data.dsValue;
  if (data.dsDatepickerType) options.type = data.dsDatepickerType;
  if (data.dsDatepickerMin) options.min = data.dsDatepickerMin;
  if (data.dsDatepickerMax) options.max = data.dsDatepickerMax;
  if (data.dsDatepickerDisabled) options.disabled = data.dsDatepickerDisabled;
  if ('dsDatepickerWeeks' in data) options.weeks = data.dsDatepickerWeeks !== 'off';
  if ('dsDatepickerZone' in data) options.zone = data.dsDatepickerZone || 'local';
  if (data.dsDatepickerStep) options.step = Number(data.dsDatepickerStep);
  if (data.dsDatepickerName) options.name = data.dsDatepickerName;
  if (data.dsDatepickerHourCycle) options.hourCycle = data.dsDatepickerHourCycle;
  return options;
}

/**
 * The date picker's controller, the one [data-ds-datepicker] makes; once
 * per root. Options: `type` ('date' or 'datetime'), `value`, `min`, `max`
 * (ISO text of the type), `disabled` (DS.calendar.available()), `weeks`,
 * `zone`, `step` (the minutes between listed times), `name`, `hourCycle`,
 * `locale`.
 * @param {Element} root
 * @param {object} [options]
 * @returns {any}
 */
export function create(root, options = {}) {
  const existing = controllers.get(root);
  if (existing) return existing;
  const settings = { type: 'date', ...readOptions(root), ...options };
  const datetime = settings.type === 'datetime';
  const doc = root.ownerDocument;
  const locale = () => settings.locale || config().locale || 'en';
  root.classList.add('ds-picker');

  let fieldEl = root.querySelector('.ds-datefield');
  if (!fieldEl) {
    fieldEl = doc.createElement('div');
    fieldEl.className = 'ds-datefield';
    root.prepend(fieldEl);
  }
  const toggle = fieldEl.querySelector('.ds-datefield__toggle') ?? root.querySelector('.ds-datefield__toggle');
  if (toggle && !toggle.hasAttribute('aria-label')) toggle.setAttribute('aria-label', t('chooseDate'));
  const field = createField(fieldEl, {
    type: datetime ? 'datetime' : 'date', value: settings.value, min: settings.min, max: settings.max, disabled: settings.disabled,
    zone: settings.zone, name: settings.name, hourCycle: settings.hourCycle, locale: settings.locale, silent: true,
  });

  // The popover: the calendar (and the times), and the foot.
  const panel = doc.createElement('div');
  panel.className = 'ds-picker__popover';
  panel.hidden = true;
  panel.setAttribute('aria-label', toggle?.getAttribute('aria-label') ?? t('chooseDate'));
  const panes = doc.createElement('div');
  panes.className = 'ds-picker__panes';
  const calendarEl = doc.createElement('div');
  calendarEl.className = 'ds-calendar';
  const calendarPane = doc.createElement('div');
  calendarPane.className = 'ds-picker__pane';
  calendarPane.append(calendarEl);
  panes.append(calendarPane);
  let timesEl = null;
  if (datetime) {
    const pane = doc.createElement('div');
    pane.className = 'ds-picker__pane ds-picker__pane--scroll ds-datepicker__times';
    timesEl = doc.createElement('div');
    pane.append(timesEl);
    panes.append(pane);
  }
  const foot = doc.createElement('div');
  foot.className = 'ds-picker__foot';
  const now = doc.createElement('button');
  now.type = 'button';
  now.className = 'ds-btn ds-btn--text';
  now.setAttribute('data-action', 'now');
  const spacer = doc.createElement('span');
  spacer.className = 'ds-picker__spacer';
  const clear = doc.createElement('button');
  clear.type = 'button';
  clear.className = 'ds-btn ds-btn--text';
  clear.setAttribute('data-action', 'clear');
  foot.append(now, spacer, clear);
  panel.append(panes, foot);
  root.append(panel);

  // A read-only or disabled field: the calendar shows the value, nothing changes it.
  const locked = () => fieldEl.getAttribute('aria-readonly') === 'true' || fieldEl.getAttribute('aria-disabled') === 'true';
  const datePart = () => field.get().slice(0, 10);
  const timePart = () => (datetime ? field.get().slice(11, 16) : '');
  const rules = () => ({ min: settings.min?.slice(0, 10), max: settings.max?.slice(0, 10), disabled: settings.disabled });

  let picker = null;
  const calendar = createCalendar(calendarEl, {
    value: datePart(), min: rules().min, max: rules().max, disabled: settings.disabled, weeks: settings.weeks,
    locale: settings.locale, silent: true,
    onSelect(value) {
      if (locked()) {
        picker?.close('select');
        return;
      }
      if (!datetime) {
        field.set(value, { emit: true });
        picker?.close('select');
        return;
      }
      // Date and time: the day goes in, the time stays (or becomes the list's first look).
      const time = timePart() || times?.get() || '00:00';
      field.set(`${value}T${time}`, { emit: true });
      times?.focus();
    },
  });
  const times = timesEl ? timeList(timesEl, {
    step: settings.step, hourCycle: settings.hourCycle, locale: settings.locale, value: timePart(),
    onSelect(value) {
      if (locked()) {
        picker?.close('select');
        return;
      }
      const date = datePart() || iso(today());
      field.set(`${date}T${value}`, { emit: true });
      picker?.close('select');
    },
  }) : null;

  function labels() {
    now.textContent = relativeWord(locale(), datetime ? 'second' : 'day');
    clear.textContent = t('clear');
    const todayBlocked = !available(today(), rules());
    if (todayBlocked) now.setAttribute('aria-disabled', 'true');
    else now.removeAttribute('aria-disabled');
    foot.hidden = locked();
  }
  labels();

  foot.addEventListener('click', (event) => {
    const button = /** @type {Element} */ (event.target)?.closest?.('[data-action]');
    if (!button || button.getAttribute('aria-disabled') === 'true') return;
    if (button.getAttribute('data-action') === 'clear') {
      field.set('', { emit: true });
      calendar.set('');
      times?.set('');
      picker?.close('select');
      return;
    }
    // Today and now in the field's zone (a wall time there), else locally.
    const timeZone = settings.zone && settings.zone !== 'local' ? settings.zone : undefined;
    const date = iso(today({ timeZone }));
    if (datetime) {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
      const part = (type) => (parts.find((entry) => entry.type === type)?.value ?? '00').replace(/^24$/, '00');
      field.set(`${date}T${part('hour')}:${part('minute')}`, { emit: true });
    } else field.set(date, { emit: true });
    picker?.close('select');
  });

  picker = createPicker(root, {
    toggle,
    panel,
    onOpen() {
      labels();
      calendar.set(datePart());
      times?.set(timePart());
      times?.reveal();
    },
    focus() {
      const day = parse(datePart()) ?? today();
      calendar.show(day);
      return calendarEl.querySelector('.ds-calendar__day[tabindex="0"]');
    },
  });
  const listeners = new Set();
  const unsubscribe = field.on('change', (detail) => {
    emit(root, 'change', detail);
    for (const fn of listeners) fn(detail);
    const { value } = detail;
    if (picker.get()) {
      calendar.set(value.slice(0, 10));
      times?.set(datetime ? value.slice(11, 16) : '');
    }
  });

  const controller = {
    element: root,
    get: () => field.get(),
    set(value) {
      const result = field.set(value);
      calendar.set(result.slice(0, 10));
      times?.set(datetime ? result.slice(11, 16) : '');
      return result;
    },
    /** The value as a Date (a datetime's wall time in its zone). */
    instant: () => field.instant(),
    open: () => picker.open(),
    close: () => picker.close(),
    on(type, fn) {
      if (String(type).replace(/^ds:/, '') !== 'change') return picker.on(type, fn);
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      unsubscribe();
      times?.destroy();
      calendar.destroy();
      picker.destroy();
      field.destroy();
      panel.remove();
      controllers.delete(root);
    },
  };
  controllers.set(root, controller);
  return controller;
}

define('datepicker', {
  attribute: 'data-ds-datepicker',
  init: (root) => create(root),
});
