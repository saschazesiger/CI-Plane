/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Lists (3.0): rows that are chosen by a checkbox or a radio, rows that
 * move by drag, a window over thousands of rows, and facts whose values
 * copy.
 *
 *   <ul class="ds-list" aria-label="Devices" data-ds-list data-ds-list-select="multiple" data-ds-list-reorder>
 *     <li class="ds-list__item" data-ds-key="d42">
 *       <input class="ds-checkbox ds-list__check" type="checkbox" aria-label="Select LAPTOP-0042"> ...
 *     </li>
 *   </ul>
 *   <input class="ds-checkbox" type="checkbox" aria-label="Select all devices" aria-controls="devices" data-ds-list-all>
 *   const devices = DS.list.create(el, { virtual: { count: 5000, key: (i) => rows[i].id, render: (i) => rowHtml(rows[i]) } });
 *   devices.get();                      // the keys of the checked rows
 *
 *   <dl class="ds-facts" data-ds-facts-copy> ... </dl>   a copy button after each value
 *
 * Selection (`select`, data-ds-list-select): "multiple" for checkboxes,
 * "single" for radios (.ds-list__check in each row, keyed by the row's
 * data-ds-key, else the box's value). Shift and a click on a box checks or
 * clears every row from the last one clicked. A press on the row of a list
 * without .ds-list__action toggles its box. A checkbox with
 * data-ds-list-all and aria-controls naming the list checks or clears all
 * rows and shows mixed for some. The controller holds the checked keys, so
 * rows that a virtual window or a morph renders again come back checked.
 * Several rows at once (a range, all) are announced ("12 selected").
 *
 * Reorder (`reorder`, data-ds-list-reorder): DS.dnd moves a row by its
 * grip (.ds-list__grip, written into each row that has none), by pointer
 * and by keys; the page saves on ds:drop ({ item, from, to }).
 *
 * Virtual (`virtual`, create() only): DS.virtual windows the rows:
 * { count, render(index), key(index), estimate } and the other options of
 * DS.virtual.create; the list scrolls itself (.ds-list--scroll) unless
 * `scroller` names another element. One tab stop, the active row; the
 * arrows, Home, End, PageUp and PageDown move it. A virtual list that
 * selects is a listbox (aria-multiselectable for "multiple"): each row an
 * option with aria-selected, its box inert, Space and a press toggle it.
 *
 * Facts (data-ds-facts-copy on a .ds-facts): a .ds-facts__copy button
 * after each value (data-ds-facts-nocopy on a dd leaves it out) copies
 * the value's text (or its data-ds-facts-value), shows a check for
 * --ds-hold-status, and the announcer says "Copied".
 *
 * Events (bubbling): ds:change { keys, key, checked } on the list, the
 * drag events of DS.dnd, ds:range and ds:active of DS.virtual on the
 * scroller, ds:copy { text, label } on the facts.
 *
 * Progressive:
 * - Clipboard API (navigator.clipboard.writeText, secure contexts): without
 *   it the copy command on a hidden, read-only textarea.
 *
 * ES2022; no DOM is touched until an element is initialised.
 */
import { define, emit, t } from './core.js';
import { motionDuration } from './motion.js';
import { announce } from './a11y.js';
import { own, disown } from './dom.js';
import { create as virtualOf } from './virtual.js';
import { create as draggable } from './dnd.js';
import { copy as copyGlyph, check as checkGlyph, grip as gripGlyph, iconElement } from './icons.js';

const ITEM = '.ds-list__item';
const CHECK = '.ds-list__check';
const CONTROLS = 'a[href], button, input, select, textarea, label, summary, [tabindex]';

/**
 * The keys from `anchor` to `target` in `keys`, both included, in list
 * order; only `target` when the anchor is not in the list.
 * @param {string[]} keys
 * @param {string|null} anchor
 * @param {string} target
 * @returns {string[]}
 */
export function rangeKeys(keys, anchor, target) {
  const to = keys.indexOf(target);
  if (to < 0) return [];
  const from = anchor === null ? -1 : keys.indexOf(anchor);
  if (from < 0) return [target];
  return keys.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * What a "select all" box shows for `checked` of `total` rows.
 * @param {number} checked
 * @param {number} total
 * @returns {'true'|'false'|'mixed'}
 */
export function allState(checked, total) {
  if (!total || !checked) return 'false';
  return checked >= total ? 'true' : 'mixed';
}

/** Copies `text`: the Clipboard API, else the copy command. Resolves to whether it worked. */
async function copyText(doc, text) {
  const view = doc.defaultView;
  try {
    if (view?.navigator?.clipboard?.writeText && view.isSecureContext !== false) {
      await view.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (no permission, no focus): the copy command below.
  }
  const area = doc.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.className = 'ds-sr';
  const back = doc.activeElement;
  (doc.querySelector('.ds-theme') ?? doc.body).append(area);
  area.select();
  let ok = false;
  try {
    ok = doc.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
  return ok;
}

const lists = new WeakMap();
const factsInstances = new WeakMap();
const modeOf = (value) => (value === 'multiple' || value === 'single' ? value : null);
const flag = (value) => value !== null && value !== undefined && value !== 'false';

/* ── Lists ────────────────────────────────────────────────────── */

function controller(list, initial) {
  const doc = list.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  let options = { ...initial, select: modeOf(initial.select) };
  const selected = new Set();
  let anchor = null;
  let dnd = null;
  let windowed = null;
  /** The "select all" boxes listened to. */
  const wired = new WeakSet();
  /** The attributes this controller wrote, with the value each had before (null: none). */
  const saved = new WeakMap();

  /** Writes an attribute this controller owns (a morph leaves it); null gives the page's value back. */
  const put = (element, name, value) => {
    let names = saved.get(element);
    if (value === null) {
      if (!names?.has(name)) return;
      const before = names.get(name);
      names.delete(name);
      disown(element, 'attrs', name);
      if (before === null) element.removeAttribute(name);
      else element.setAttribute(name, before);
      return;
    }
    if (!names) saved.set(element, (names = new Map()));
    if (!names.has(name)) {
      names.set(name, element.getAttribute(name));
      own(element, 'attrs', name);
    }
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  /**
   * A virtual list that selects holds the focus on its rows, so the rows say
   * their state: a listbox of options with aria-selected, the box inert (a
   * press on it reaches the row, which toggles it).
   */
  const asListbox = () => Boolean(windowed) && Boolean(options.select);

  const rows = () => Array.from(list.querySelectorAll(`:scope > ${ITEM}`));
  const boxOf = (row) => row.querySelector(`:scope > ${CHECK}, :scope ${CHECK}`);
  const keyOf = (row) => row?.getAttribute('data-ds-key') ?? boxOf(row)?.value ?? null;
  const labelOf = (row) => (row.querySelector('.ds-list__title')?.textContent ?? row.textContent ?? '').replace(/\s+/g, ' ').trim();
  const allBoxes = () => {
    if (!list.id) return [];
    return Array.from(doc.querySelectorAll('input[data-ds-list-all]')).filter((box) => (box.getAttribute('aria-controls') ?? '').split(/\s+/).includes(list.id));
  };
  /** Every key of the list: the virtual window's, else the rows'. */
  const keys = () => {
    if (windowed && typeof options.virtual?.key === 'function') {
      const count = windowed.get().count;
      return Array.from({ length: count }, (_, index) => String(options.virtual.key(index)));
    }
    return rows().filter((row) => boxOf(row) && !boxOf(row).disabled).map(keyOf).filter((key) => key !== null);
  };

  const sync = () => {
    const listbox = asListbox();
    put(list, 'role', listbox ? 'listbox' : null);
    put(list, 'aria-multiselectable', listbox && options.select === 'multiple' ? 'true' : null);
    for (const row of rows()) {
      const box = boxOf(row);
      const key = keyOf(row);
      if (box && key !== null) box.checked = selected.has(key);
      put(row, 'role', listbox ? 'option' : null);
      put(row, 'aria-selected', listbox ? String(key !== null && selected.has(key)) : null);
      if (box) put(box, 'inert', listbox ? '' : null);
    }
    if (options.select === 'multiple') {
      const all = keys();
      const state = allState(all.filter((key) => selected.has(key)).length, all.length);
      for (const box of allBoxes()) {
        if (!wired.has(box)) {
          wired.add(box);
          box.addEventListener('change', onAll, { signal });
        }
        box.checked = state === 'true';
        box.indeterminate = state === 'mixed';
      }
    }
    if (options.reorder) addGrips();
  };

  const change = (detail, many = 0) => {
    sync();
    if (many > 1) announce(t('listSelected', { count: selected.size }));
    emit(list, 'change', { keys: handle.get(), ...detail });
  };

  /** Reads the boxes the markup checked (the uncontrolled start). */
  const read = () => {
    for (const row of rows()) {
      const box = boxOf(row);
      const key = keyOf(row);
      if (!box || key === null) continue;
      if (box.checked) {
        if (options.select === 'single') selected.clear();
        selected.add(key);
      }
    }
  };

  const toggle = (key, checked, shift) => {
    if (options.select === 'single') {
      selected.clear();
      if (checked) selected.add(key);
      anchor = key;
      change({ key, checked });
      return;
    }
    const range = shift ? rangeKeys(keys(), anchor, key) : [key];
    for (const each of range) {
      if (checked) selected.add(each);
      else selected.delete(each);
    }
    anchor = key;
    change({ key, checked }, range.length);
  };

  const onClick = (/** @type {MouseEvent} */ event) => {
    if (!options.select) return;
    const target = event.target;
    const box = target.closest?.(CHECK);
    const row = target.closest?.(ITEM);
    if (!row || row.parentElement !== list) return;
    if (box) {
      const key = keyOf(row);
      if (key !== null) toggle(key, box.checked, event.shiftKey);
      return;
    }
    // A press elsewhere on a row without an action toggles its box.
    const control = target.closest(CONTROLS);
    if (row.querySelector('.ds-list__action') || (control && control !== row)) return;
    flip(row, event.shiftKey);
  };

  /** Toggles the box of `row` as a press on it would. */
  const flip = (row, shift) => {
    const box = boxOf(row);
    if (!box || box.disabled) return;
    if (options.select === 'single' && box.checked) return;
    box.checked = !box.checked;
    const key = keyOf(row);
    if (key !== null) toggle(key, box.checked, shift);
  };

  /* A row that holds the focus itself (a virtual window's): Space toggles its box. */
  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (!options.select || event.key !== ' ' || event.defaultPrevented) return;
    const row = event.target;
    if (!row?.matches?.(ITEM) || row.parentElement !== list) return;
    event.preventDefault();
    flip(row, event.shiftKey);
  };

  const onAll = (/** @type {Event} */ event) => {
    const box = event.target;
    if (options.select !== 'multiple' || !allBoxes().includes(box)) return;
    const all = keys();
    if (box.checked) for (const key of all) selected.add(key);
    else selected.clear();
    change({ key: null, checked: box.checked }, all.length);
  };

  const addGrips = () => {
    for (const row of rows()) {
      if (row.querySelector(':scope > .ds-list__grip')) continue;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-sm ds-list__grip';
      button.setAttribute('data-ds-list-own', '');
      button.setAttribute('aria-label', t('listMove', { label: labelOf(row) }));
      button.append(iconElement(gripGlyph, 18, undefined, doc));
      row.prepend(button);
    }
  };

  const startDrag = () => {
    if (dnd || !options.reorder || windowed) return;
    addGrips();
    dnd = draggable(list, { items: ITEM, handle: '.ds-list__grip', label: labelOf });
  };
  const stopDrag = () => {
    dnd?.destroy();
    dnd = null;
    for (const grip of list.querySelectorAll('.ds-list__grip[data-ds-list-own]')) grip.remove();
  };

  const startWindow = () => {
    if (windowed || !options.virtual) return;
    const { scroller, ...rest } = options.virtual;
    const host = scroller ?? list;
    windowed = virtualOf(host, { content: list, ...rest });
    host.addEventListener('ds:range', sync, { signal });
  };

  list.addEventListener('click', onClick, { signal });
  list.addEventListener('keydown', onKey, { signal });
  const watcher = typeof doc.defaultView?.MutationObserver === 'function' ? new doc.defaultView.MutationObserver(() => sync()) : null;
  watcher?.observe(list, { childList: true });
  read();
  startWindow();
  startDrag();
  sync();

  const handle = {
    /** Multiple: the checked keys; single: the checked key or null; without selection: null. */
    get() {
      if (options.select === 'multiple') {
        // In list order; keys the list no longer holds at the end.
        const all = keys();
        const known = new Set(all);
        return [...all.filter((key) => selected.has(key)), ...[...selected].filter((key) => !known.has(key))];
      }
      if (options.select === 'single') return selected.values().next().value ?? null;
      return null;
    },
    set(value) {
      selected.clear();
      const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
      for (const key of options.select === 'single' ? list.slice(0, 1) : list) selected.add(String(key));
      sync();
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === list || event.target === (options.virtual?.scroller ?? list)) fn(event.detail);
      };
      list.addEventListener(`ds:${type}`, listener, { signal });
      return () => list.removeEventListener(`ds:${type}`, listener);
    },
    /** The DS.virtual controller of a windowed list, else null. */
    window() {
      return windowed;
    },
    /** Options again: select, reorder, virtual. */
    configure(next = {}) {
      options = { ...options, ...next, select: modeOf(next.select === undefined ? options.select : next.select) };
      if (next.virtual && !windowed) startWindow();
      else if (next.virtual && windowed) windowed.set({ count: next.virtual.count ?? windowed.get().count });
      if (options.reorder) startDrag();
      else stopDrag();
      sync();
    },
    update() {
      handle.configure(attributeOptions(list));
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      watcher?.disconnect();
      stopDrag();
      windowed?.destroy();
      windowed = null;
      // The roles and states go back to the page's.
      put(list, 'role', null);
      put(list, 'aria-multiselectable', null);
      for (const row of rows()) {
        put(row, 'role', null);
        put(row, 'aria-selected', null);
        const box = boxOf(row);
        if (box) put(box, 'inert', null);
      }
      if (lists.get(list) === handle) lists.delete(list);
    },
  };
  lists.set(list, handle);
  return handle;
}

const attributeOptions = (el) => ({ select: el.getAttribute('data-ds-list-select'), reorder: flag(el.getAttribute('data-ds-list-reorder')) });

define('list', {
  attribute: 'data-ds-list',
  attributes: ['data-ds-list-select', 'data-ds-list-reorder'],
  init(el) {
    return lists.get(el) ?? controller(el, attributeOptions(el));
  },
});

/**
 * A list driven from the page, or new options for one the attribute path
 * made: the same controller. `select`: 'multiple' or 'single'; `reorder`:
 * rows move by their grip; `virtual`: { count, render, key, estimate, ... }
 * of DS.virtual.create, plus `scroller`.
 * @param {Element} el
 * @param {{ select?: 'multiple'|'single'|null, reorder?: boolean, virtual?: { count: number, render: (index: number) => string, key?: (index: number) => string|number, scroller?: Element, [option: string]: any } }} [options]
 */
export function create(el, options = {}) {
  if (!el?.ownerDocument) return { get: () => null, set() {}, on: () => () => {}, window: () => null, configure() {}, update() {}, destroy() {} };
  const existing = lists.get(el);
  if (existing) {
    existing.configure(options);
    return existing;
  }
  return controller(el, { ...attributeOptions(el), ...options });
}

/* ── Facts that copy ──────────────────────────────────────────── */

function factsController(dl) {
  const doc = dl.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  const timers = new Map();

  const labelOf = (dd) => {
    let dt = dd.previousElementSibling;
    while (dt && dt.tagName !== 'DT') dt = dt.previousElementSibling;
    return (dt?.textContent ?? '').replace(/\s+/g, ' ').trim();
  };
  const textOf = (dd) => {
    const given = dd.getAttribute('data-ds-facts-value');
    if (given !== null) return given;
    const copy = dd.cloneNode(true);
    for (const extra of copy.querySelectorAll('.ds-facts__copy, .ds-lock')) extra.remove();
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  const sync = () => {
    for (const dd of dl.querySelectorAll('dd')) {
      if (dd.closest('dl') !== dl) continue;
      const mine = dd.querySelector(':scope > .ds-facts__copy');
      if (dd.hasAttribute('data-ds-facts-nocopy')) {
        mine?.remove();
        continue;
      }
      if (mine) continue;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-xs ds-facts__copy';
      const label = t('factsCopy', { label: labelOf(dd) });
      button.setAttribute('aria-label', label);
      button.setAttribute('data-tip', label);
      button.append(iconElement(copyGlyph, 16, undefined, doc), iconElement(checkGlyph, 16, undefined, doc));
      dd.append(button);
    }
  };

  const onClick = async (/** @type {MouseEvent} */ event) => {
    const button = event.target.closest?.('.ds-facts__copy');
    if (!button || !dl.contains(button)) return;
    const dd = button.closest('dd');
    const text = textOf(dd);
    const ok = await copyText(doc, text);
    if (!ok || signal.aborted) return;
    button.setAttribute('data-state', 'copied');
    doc.defaultView.clearTimeout(timers.get(button));
    timers.set(button, doc.defaultView.setTimeout(() => button.removeAttribute('data-state'), motionDuration(button, '--ds-hold-status')));
    announce(t('copied'));
    emit(dl, 'copy', { text, label: labelOf(dd) });
  };

  dl.addEventListener('click', onClick, { signal });
  const watcher = typeof doc.defaultView?.MutationObserver === 'function' ? new doc.defaultView.MutationObserver(() => sync()) : null;
  watcher?.observe(dl, { childList: true, subtree: true });
  sync();

  const handle = {
    /** The values, label → text, in order. */
    get() {
      return Array.from(dl.querySelectorAll('dd')).filter((dd) => dd.closest('dl') === dl).map((dd) => [labelOf(dd), textOf(dd)]);
    },
    set() {
      sync();
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => fn(event.detail);
      dl.addEventListener(`ds:${type}`, listener, { signal });
      return () => dl.removeEventListener(`ds:${type}`, listener);
    },
    update() {
      sync();
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      watcher?.disconnect();
      for (const timer of timers.values()) doc.defaultView?.clearTimeout(timer);
      for (const button of dl.querySelectorAll('.ds-facts__copy')) button.remove();
      if (factsInstances.get(dl) === handle) factsInstances.delete(dl);
    },
  };
  factsInstances.set(dl, handle);
  return handle;
}

define('facts', {
  attribute: 'data-ds-facts-copy',
  init(el) {
    return factsInstances.get(el) ?? factsController(el);
  },
});

/**
 * Copy buttons after the values of a .ds-facts list: the controller of
 * data-ds-facts-copy.
 * @param {Element} el
 */
export function facts(el) {
  if (!el?.ownerDocument) return { get: () => [], set() {}, on: () => () => {}, update() {}, destroy() {} };
  return factsInstances.get(el) ?? factsController(el);
}
