/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Toggle buttons and toggle groups (DS.toggle): a button that stays on or
 * off (aria-pressed), and a set of them where one or several are on.
 *
 *   <button class="ds-btn ds-btn--quiet" type="button" aria-pressed="false" data-ds-toggle>Only open</button>
 *
 *   <div class="ds-toggle-group" role="toolbar" aria-label="View" data-ds-toggle-group="single" [data-ds-toggle-group-required] [data-ds-value="list"]>
 *     <button class="ds-btn" type="button" aria-pressed="true" value="list">List</button>
 *     <button class="ds-btn" type="button" aria-pressed="false" value="grid">Grid</button>
 *   </div>
 *
 *   const toggle = DS.toggle.create(button);           get() true | false, set(on)
 *   const view = DS.toggle.group(element, { mode: 'single', required: true });
 *   view.get();  view.set('grid');  view.on('change', ({ value, item }) => {});
 *
 * A toggle flips aria-pressed on its click (a pointer, Enter or Space), once
 * the page's own click handlers before it ran and none prevented it, and
 * sends ds:change ({ pressed }) on the button. The action guard of
 * DS.motion keeps aria-disabled and busy toggles from ever reaching it.
 *
 * A group serves every [aria-pressed] button inside it (the items; a nested
 * group keeps its own): "single" (the default) keeps at most one item on
 * (with data-ds-toggle-group-required exactly one: the item that is on
 * stays on when pressed again), "multiple" flips each item on its own. An
 * item's value is its value attribute, else its data-value, else its
 * position. data-ds-value (single: one value; multiple: values separated by
 * spaces) is the initial state, else the markup's aria-pressed; set() drives
 * it from the page and sends nothing. A user change sends ds:change
 * ({ value, item }) on the group. A role="toolbar" group is one tab stop
 * (the APG toolbar, DS.a11y.roving: ArrowLeft and ArrowRight, Home and End
 * move focus, Space and Enter press); the stop starts on the item that is
 * on and rests on the last focused one, except in a single group, where it
 * goes back to the item that is on once focus leaves the group. A
 * role="group" keeps every item in the Tab order (a group is no composite
 * widget: nothing would say the arrow keys work).
 * data-ds-toggle-group-roving="on" or "off" (the option roving) overrides
 * either way; the role is read when the group is set up.
 *
 * create() and group() return the controller the attribute made (one per
 * element, whichever came first), with their options applied to it.
 *
 * Screen readers say the pressed state of the focused button on its own;
 * nothing is announced besides it.
 *
 * ES2022; no progressive feature.
 */
import { define, emit } from './core.js';
import { roving } from './a11y.js';

const PRESSED = 'aria-pressed';

const isOn = (button) => button.getAttribute(PRESSED) === 'true';
const blocked = (button) => Boolean(button.disabled) || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('aria-busy') === 'true';

/** An AbortController of its own that also aborts with `signal` (the behaviour's, on destroy). */
function linked(signal) {
  const local = new AbortController();
  signal?.addEventListener('abort', () => local.abort(), { once: true });
  return local;
}

/** Writes aria-pressed (only when it changes, so an observer hears real changes only). */
function press(button, on) {
  const value = on ? 'true' : 'false';
  if (button.getAttribute(PRESSED) !== value) button.setAttribute(PRESSED, value);
}

/**
 * The values a group's state names: single, one value or null; multiple, a
 * list. `text` is a data-ds-value (values separated by white space) or a
 * value the page passed.
 * @param {unknown} value
 * @param {'single'|'multiple'} mode
 * @returns {string|null|string[]}
 */
export function parseValue(value, mode) {
  const list = Array.isArray(value) ? value.map(String)
    : value === null || value === undefined || value === false ? []
      : String(value).split(/\s+/).filter(Boolean);
  if (mode === 'multiple') return [...new Set(list)];
  return list.length ? list[0] : null;
}

/** The mode a data-ds-toggle-group value names: "multiple", else "single". */
const modeOf = (text) => (String(text ?? '').trim() === 'multiple' ? 'multiple' : 'single');

/**
 * The state a group shows after a press on `item` (pure, for the tests and
 * the controller): `pressed` the values that are on before.
 * @param {string[]} pressed
 * @param {string} item
 * @param {{ mode: 'single'|'multiple', required?: boolean }} options
 * @returns {string[]}
 */
export function nextPressed(pressed, item, options) {
  const on = pressed.includes(item);
  if (options.mode === 'multiple') return on ? pressed.filter((value) => value !== item) : [...pressed, item];
  if (on) return options.required ? pressed : [];
  return [item];
}

/* ── One toggle ─────────────────────────────────────── */

/** One controller per element, shared by create(), group() and the attributes. @type {WeakMap<Element, any>} */
const toggles = new WeakMap();
const groups = new WeakMap();
/** How group() applies its options to a group's existing controller. @type {WeakMap<object, (options: object) => void>} */
const configurers = new WeakMap();

/** The element's controller in `map`, else a new one from `make()`; it leaves the map on destroy. */
function shared(map, element, make) {
  const existing = map.get(element);
  if (existing) return existing;
  const made = make();
  map.set(element, made);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    if (map.get(element) === made) map.delete(element);
  };
  return made;
}

function toggleController(button, signal) {
  const listeners = new Set();
  const local = linked(signal);
  const options = { signal: local.signal };
  if (!button.hasAttribute(PRESSED)) press(button, false);
  button.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    // An item of a group: the group decides.
    if (event.defaultPrevented || blocked(button) || button.parentElement?.closest('[data-ds-toggle-group]')) return;
    press(button, !isOn(button));
    const detail = { pressed: isOn(button) };
    emit(button, 'change', detail);
    for (const fn of [...listeners]) fn(detail);
  }, options);
  return {
    element: button,
    get: () => isOn(button),
    set(on) { press(button, Boolean(on)); },
    on(type, fn) {
      if (type !== 'change' || typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      listeners.clear();
      local.abort();
    },
  };
}

/**
 * A toggle button driven from the page; the controller data-ds-toggle makes.
 * @param {Element} button
 * @param {{ pressed?: boolean }} [options]
 */
export function create(button, options = {}) {
  const control = shared(toggles, button, () => toggleController(button, null));
  if (options.pressed !== undefined) control.set(options.pressed);
  return control;
}

define('toggle', {
  attribute: 'data-ds-toggle',
  init: (button, ctx) => shared(toggles, button, () => toggleController(button, ctx.signal)),
});

/* ── A group ────────────────────────────────────────── */

const GROUPS = '[data-ds-toggle-group], .ds-toggle-group';

/** The items of a group: its [aria-pressed] buttons, not those of a group inside it. */
function itemsOf(group) {
  return [...group.querySelectorAll('[aria-pressed]')].filter((item) => {
    const owner = item.parentElement?.closest(GROUPS);
    return !owner || owner === group || !group.contains(owner);
  });
}

/** An item's value: its value attribute, else data-value, else its position. */
function valueOf(item, items) {
  return item.getAttribute('value') || item.getAttribute('data-value') || String(items.indexOf(item));
}

function groupController(group, start, signal) {
  const listeners = new Set();
  const local = linked(signal);
  const opts = { signal: local.signal };
  const settings = { mode: start.mode, required: start.required };

  const pressedValues = () => {
    const items = itemsOf(group);
    return items.filter(isOn).map((item) => valueOf(item, items));
  };
  const write = (values) => {
    const items = itemsOf(group);
    for (const item of items) press(item, values.includes(valueOf(item, items)));
  };
  const read = () => {
    const values = pressedValues();
    return settings.mode === 'multiple' ? values : values[0] ?? null;
  };
  const apply = (value) => {
    const items = itemsOf(group);
    let values = parseValue(value, settings.mode);
    values = Array.isArray(values) ? values : values === null ? [] : [values];
    // Single and required: never none (the first enabled item, when nothing else is on).
    if (settings.mode === 'single' && settings.required && !values.length) {
      const first = items.find((item) => !blocked(item));
      if (first) values = [valueOf(first, items)];
    }
    write(values);
  };

  // The start: data-ds-value, else the markup (single: its first item that is on).
  if (start.value !== undefined && start.value !== null) apply(start.value);
  else apply(settings.mode === 'multiple' ? pressedValues() : pressedValues().slice(0, 1));

  group.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    if (event.defaultPrevented) return;
    const item = /** @type {Element} */ (event.target)?.closest?.('[aria-pressed]');
    if (!item || !itemsOf(group).includes(item) || blocked(item)) return;
    const items = itemsOf(group);
    const before = pressedValues();
    const after = nextPressed(before, valueOf(item, items), settings);
    if (after.length === before.length && after.every((value) => before.includes(value))) return;
    write(after);
    const detail = { value: read(), item };
    emit(group, 'change', detail);
    for (const fn of [...listeners]) fn(detail);
  }, opts);

  let keys = null;
  const rove = (on) => {
    if (on && !keys) keys = roving(group, { items: '[aria-pressed]', activate: false });
    if (!on && keys) {
      keys.destroy();
      keys = null;
      for (const item of itemsOf(group)) item.removeAttribute('tabindex');
    }
  };
  rove(start.roving);
  // Single: once focus leaves the group, the stop goes back to the item
  // that is on, so Tab comes back to the choice.
  group.addEventListener('focusout', (/** @type {FocusEvent} */ event) => {
    if (!keys || settings.mode !== 'single' || group.contains(/** @type {Node|null} */ (event.relatedTarget))) return;
    const items = itemsOf(group);
    const on = items.find((item) => isOn(item) && !item.matches(':disabled'));
    if (!on) return;
    for (const item of items) if (item !== on && item.getAttribute('tabindex') !== '-1') item.setAttribute('tabindex', '-1');
    on.setAttribute('tabindex', '0');
  }, opts);

  const api = {
    element: group,
    get: read,
    set(value) { apply(value); },
    on(type, fn) {
      if (type !== 'change' || typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update(names) {
      if (names.includes('data-ds-toggle-group')) settings.mode = modeOf(group.getAttribute('data-ds-toggle-group'));
      if (names.includes('data-ds-toggle-group-required')) settings.required = group.hasAttribute('data-ds-toggle-group-required');
      if (names.includes('data-ds-value')) apply(group.getAttribute('data-ds-value'));
      if (names.includes('data-ds-toggle-group-roving')) rove(rovingOf(group));
    },
    destroy() {
      listeners.clear();
      local.abort();
      keys?.destroy();
      keys = null;
    },
  };
  // The options of group() on a controller that already exists.
  configurers.set(api, (options) => {
    if (options.mode !== undefined) settings.mode = options.mode === 'multiple' ? 'multiple' : 'single';
    if (options.required !== undefined) settings.required = Boolean(options.required);
    if (options.roving !== undefined) rove(Boolean(options.roving));
    if (options.value !== undefined) apply(options.value);
  });
  return api;
}

/**
 * Whether a group is one tab stop: data-ds-toggle-group-roving "on" or
 * "off", else a role="toolbar" is and a role="group" (or none) is not.
 * @param {Element} element
 * @returns {boolean}
 */
function rovingOf(element) {
  const set = element.getAttribute('data-ds-toggle-group-roving');
  if (set === 'on' || set === 'off') return set === 'on';
  return element.getAttribute('role') === 'toolbar';
}

/**
 * A toggle group driven from the page; the controller data-ds-toggle-group
 * makes (the same one, with these options applied, when the attribute set
 * it up). `mode` 'single' (default) or 'multiple'; `required`: single, one
 * item always on; `value`: the start (else the markup); `roving`: one tab
 * stop (default: as the markup says, a role="toolbar").
 * @param {Element} element
 * @param {{ mode?: 'single'|'multiple', required?: boolean, value?: string|string[]|null, roving?: boolean }} [options]
 */
export function group(element, options = {}) {
  const existing = groups.get(element);
  if (existing) {
    configurers.get(existing)?.(options);
    return existing;
  }
  // What the options leave open, the markup says (as for the attribute).
  return shared(groups, element, () => groupController(element, {
    mode: options.mode === undefined ? modeOf(element.getAttribute('data-ds-toggle-group')) : options.mode === 'multiple' ? 'multiple' : 'single',
    required: options.required === undefined ? element.hasAttribute('data-ds-toggle-group-required') : Boolean(options.required),
    value: options.value === undefined ? element.getAttribute('data-ds-value') : options.value,
    roving: options.roving === undefined ? rovingOf(element) : Boolean(options.roving),
  }, null));
}

define('toggle-group', {
  attribute: 'data-ds-toggle-group',
  attributes: ['data-ds-toggle-group-required', 'data-ds-value', 'data-ds-toggle-group-roving'],
  init: (element, ctx) => shared(groups, element, () => groupController(element, {
    mode: modeOf(element.getAttribute('data-ds-toggle-group')),
    required: element.hasAttribute('data-ds-toggle-group-required'),
    value: element.getAttribute('data-ds-value'),
    roving: rovingOf(element),
  }, ctx.signal)),
});
