/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The time picker (DS.timepicker): a segmented time field (DS.datefield,
 * type time) and a list of times in a popover (DS.picker), in the hour
 * cycle of the page's locale (12 or 24 hours) unless the markup names one.
 *
 *   <div class="ds-picker" data-ds-timepicker data-ds-value="09:30"
 *        [data-ds-timepicker-step="15"] [data-ds-timepicker-min="08:00"] [data-ds-timepicker-max="18:00"]
 *        [data-ds-timepicker-hour-cycle="h12 | h23"] [data-ds-timepicker-seconds] [data-ds-timepicker-name="start"]>
 *     <div class="ds-datefield" role="group" aria-labelledby="start-label">
 *       <button class="ds-btn ds-btn--quiet ds-btn--icon ds-datefield__toggle" type="button" aria-label="Choose time">(clock)</button>
 *     </div>
 *   </div>
 *
 *   const picker = DS.timepicker.create(root);   // get(), set('14:00'), open(), close(), on(), destroy()
 *   DS.timepicker.list(el, { step: 30, onSelect })  // the list alone (the date-time picker's pane)
 *   DS.timepicker.times({ step: 30, min: '08:00', max: '18:00' })  // ['08:00', '08:30', ...]
 *
 * The list is a listbox (the WAI-ARIA listbox pattern, focus on the list,
 * aria-activedescendant on the option): ArrowUp and ArrowDown move, Home and
 * End go to the ends, PageUp and PageDown move an hour, digits jump to the
 * first time that starts with them, Enter or Space (or a click) picks the
 * time, puts it into the field and closes the popover; focus goes back to
 * the button. Opening shows the chosen time, else the one nearest to now.
 *
 * ds:change ({ value, valid }) on the root, whether the time was typed or
 * picked (the field inside sends none of its own).
 *
 * ES2022; no progressive feature of its own.
 */
import { config, define, emit, t } from './core.js';
import { typeahead } from './a11y.js';
import { create as createField, hourCycle } from './datefield.js';
import { create as createPicker } from './picker.js';

const pad = (number) => String(number).padStart(2, '0');

/** Minutes since midnight of 'HH:mm', or null. */
function minutesOf(text) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(text ?? '').trim());
  if (!match) return null;
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

/**
 * The times of a day from `min` to `max` ('HH:mm', default the whole day),
 * every `step` minutes (default 30), as 'HH:mm'.
 * @param {{ step?: number, min?: string, max?: string }} [options]
 * @returns {string[]}
 */
export function times(options = {}) {
  const step = Math.max(1, Math.min(720, Number(options.step) || 30));
  const from = minutesOf(options.min) ?? 0;
  const to = minutesOf(options.max) ?? 24 * 60 - 1;
  const out = [];
  for (let minute = from; minute <= to; minute += step) out.push(`${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`);
  return out;
}

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

/** A time ('HH:mm') for people, in the locale and hour cycle. */
function timeLabel(value, locale, cycle) {
  const minutes = minutesOf(value) ?? 0;
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hourCycle: cycle, timeZone: 'UTC' })
    .format(new Date(Date.UTC(2026, 0, 1, Math.floor(minutes / 60), minutes % 60)));
}

let serial = 0;

/**
 * The list of times alone, in `element` (made a listbox): the date-time
 * picker's pane, or a page's own. Options: those of times(), `value`,
 * `hourCycle`, `locale`, `label` (its name), `onSelect(value)`.
 * Returns { element, get(), set(value), focus(), destroy() }.
 * @param {Element} element
 * @param {object} [options]
 * @returns {any}
 */
export function list(element, options = {}) {
  const abort = new AbortController();
  const { signal } = abort;
  const doc = element.ownerDocument;
  const id = `ds-times-${serial += 1}`;
  const settings = { ...options };
  let value = settings.value ?? '';
  let active = -1;

  element.classList.add('ds-timepicker__list');
  element.setAttribute('role', 'listbox');
  element.setAttribute('tabindex', '0');
  element.setAttribute('aria-label', settings.label ?? t('chooseTime'));

  const options_ = () => [...element.querySelectorAll('.ds-timepicker__option')];

  function render() {
    const loc = localeOf(settings.locale);
    const cycle = hourCycle(loc, settings.hourCycle);
    const items = times(settings).map((time, index) => {
      const option = doc.createElement('div');
      option.className = 'ds-timepicker__option';
      option.id = `${id}-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('data-value', time);
      option.textContent = timeLabel(time, loc, cycle);
      return option;
    });
    element.replaceChildren(...items);
    mark();
  }

  /** The chosen option and the active one. */
  function mark() {
    const items = options_();
    items.forEach((item, index) => {
      item.setAttribute('aria-selected', String(item.getAttribute('data-value') === value.slice(0, 5)));
      item.toggleAttribute('data-active', index === active);
    });
    const current = items[active];
    if (current) element.setAttribute('aria-activedescendant', current.id);
    else element.removeAttribute('aria-activedescendant');
  }

  /** Makes an option active and scrolls it into the list's view. */
  function activate(index, center = false) {
    const items = options_();
    if (!items.length) return;
    active = Math.max(0, Math.min(items.length - 1, index));
    mark();
    const item = items[active];
    const scroller = element.closest('.ds-picker__pane--scroll') ?? element;
    const top = item.offsetTop - (scroller === element ? 0 : element.offsetTop);
    if (center) scroller.scrollTop = top - (scroller.clientHeight - item.offsetHeight) / 2;
    else if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + item.offsetHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + item.offsetHeight - scroller.clientHeight;
  }

  /** The option of the value, else the one nearest to now. */
  function home() {
    const items = options_();
    const wanted = minutesOf(value) ?? (() => {
      const now = new Date();
      return now.getHours() * 60 + now.getMinutes();
    })();
    let best = 0;
    items.forEach((item, index) => {
      if (Math.abs(minutesOf(item.getAttribute('data-value')) - wanted) < Math.abs(minutesOf(items[best].getAttribute('data-value')) - wanted)) best = index;
    });
    return best;
  }

  function choose(index) {
    const item = options_()[index];
    if (!item) return;
    value = item.getAttribute('data-value');
    active = index;
    mark();
    settings.onSelect?.(value);
  }

  element.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const items = options_();
    const perHour = Math.max(1, Math.round(60 / Math.max(1, Number(settings.step) || 30)));
    const moves = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: items.length - 1, PageDown: active + perHour, PageUp: active - perHour };
    if (event.key in moves) {
      event.preventDefault();
      activate(active < 0 ? home() : moves[event.key]);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(active < 0 ? home() : active);
    }
  }, { signal });
  element.addEventListener('click', (event) => {
    const item = /** @type {Element} */ (event.target)?.closest?.('.ds-timepicker__option');
    if (item && element.contains(item)) choose(options_().indexOf(item));
  }, { signal });
  element.addEventListener('pointermove', (event) => {
    const item = /** @type {Element} */ (event.target)?.closest?.('.ds-timepicker__option');
    const index = item ? options_().indexOf(item) : -1;
    if (index >= 0 && index !== active) {
      active = index;
      mark();
    }
  }, { signal });
  element.addEventListener('focus', () => {
    if (active < 0) activate(home(), true);
  }, { signal });
  // Digits jump to the first time that starts with them (typed as shown).
  const search = typeahead(element, {
    items: '.ds-timepicker__option',
    label: (item) => item.textContent.toLowerCase(),
    onMatch: (item) => activate(options_().indexOf(item)),
    current: () => options_()[active] ?? null,
  });

  render();

  return {
    element,
    get() {
      return value;
    },
    set(next) {
      value = next ? String(next).slice(0, 5) : '';
      active = -1;
      mark();
      return value;
    },
    /** New options (those of list()), rendered at once. */
    update(next = {}) {
      Object.assign(settings, next);
      if ('value' in next) value = next.value ?? '';
      render();
    },
    /** Scrolls the chosen time (else the one nearest to now) into the middle, without focus. */
    reveal() {
      activate(home(), true);
      active = -1;
      mark();
    },
    /** Focuses the list on the chosen time (else the nearest to now), centred. */
    focus() {
      /** @type {HTMLElement} */ (element).focus({ preventScroll: true });
      activate(home(), true);
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      search.destroy();
    },
  };
}

const controllers = new WeakMap();

function readOptions(root) {
  const data = root.dataset ?? {};
  const options = {};
  if ('dsValue' in data) options.value = data.dsValue;
  if (data.dsTimepickerStep) options.step = Number(data.dsTimepickerStep);
  if (data.dsTimepickerMin) options.min = data.dsTimepickerMin;
  if (data.dsTimepickerMax) options.max = data.dsTimepickerMax;
  if (data.dsTimepickerHourCycle) options.hourCycle = data.dsTimepickerHourCycle;
  if ('dsTimepickerSeconds' in data) options.seconds = data.dsTimepickerSeconds !== 'off';
  if (data.dsTimepickerName) options.name = data.dsTimepickerName;
  return options;
}

/**
 * The time picker's controller, the one [data-ds-timepicker] makes; once
 * per root. Options: `value` ('HH:mm'), `step` (minutes between the
 * listed times, default 30), `min`, `max`, `hourCycle`, `seconds`, `name`,
 * `locale`.
 * @param {Element} root
 * @param {object} [options]
 * @returns {any}
 */
export function create(root, options = {}) {
  const existing = controllers.get(root);
  if (existing) return existing;
  const settings = { ...readOptions(root), ...options };
  const doc = root.ownerDocument;
  root.classList.add('ds-picker');
  let fieldEl = root.querySelector('.ds-datefield');
  if (!fieldEl) {
    fieldEl = doc.createElement('div');
    fieldEl.className = 'ds-datefield';
    root.prepend(fieldEl);
  }
  const toggle = fieldEl.querySelector('.ds-datefield__toggle') ?? root.querySelector('.ds-datefield__toggle');
  if (toggle && !toggle.hasAttribute('aria-label')) toggle.setAttribute('aria-label', t('chooseTime'));
  const field = createField(fieldEl, { type: 'time', value: settings.value, min: settings.min, max: settings.max, hourCycle: settings.hourCycle, seconds: settings.seconds, name: settings.name, locale: settings.locale, silent: true });

  const panel = doc.createElement('div');
  panel.className = 'ds-picker__popover ds-timepicker__popover';
  panel.hidden = true;
  panel.setAttribute('aria-label', toggle?.getAttribute('aria-label') ?? t('chooseTime'));
  const pane = doc.createElement('div');
  pane.className = 'ds-picker__pane ds-picker__pane--scroll';
  const listEl = doc.createElement('div');
  pane.append(listEl);
  panel.append(pane);
  root.append(panel);

  let picker = null;
  const timeList = list(listEl, {
    step: settings.step,
    min: settings.min,
    max: settings.max,
    hourCycle: settings.hourCycle,
    locale: settings.locale,
    value: field.get(),
    label: panel.getAttribute('aria-label'),
    onSelect(value) {
      field.set(settings.seconds ? `${value}:00` : value, { emit: true });
      picker?.close('select');
    },
  });
  picker = createPicker(root, {
    toggle,
    panel,
    onOpen: () => {
      timeList.set(field.get());
      timeList.reveal();
    },
    focus: () => {
      queueMicrotask(() => timeList.focus());
      return listEl;
    },
  });
  const listeners = new Set();
  const unsubscribe = field.on('change', (detail) => {
    emit(root, 'change', detail);
    for (const fn of listeners) fn(detail);
    timeList.set(detail.value);
  });

  const controller = {
    element: root,
    get: () => field.get(),
    set(value) {
      const result = field.set(value);
      timeList.set(result);
      return result;
    },
    open: () => picker.open(),
    close: () => picker.close(),
    on(type, fn) {
      if (String(type).replace(/^ds:/, '') !== 'change') return picker.on(type, fn);
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      unsubscribe();
      timeList.destroy();
      picker.destroy();
      field.destroy();
      panel.remove();
      controllers.delete(root);
    },
  };
  controllers.set(root, controller);
  return controller;
}

define('timepicker', {
  attribute: 'data-ds-timepicker',
  init: (root) => create(root),
});
