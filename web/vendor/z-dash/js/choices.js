/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The choice list (DS.choices): a set of checkboxes with "select all"
 * (checked, unchecked or indeterminate), a count, a filter and columns.
 *
 *   <div class="ds-choices" data-ds-choices>
 *     <div class="ds-choices__tools">
 *       <input class="ds-input ds-choices__search" type="search" aria-label="Filter sites">
 *       <label class="ds-check"><input type="checkbox" data-ds-choices-all><span>Select all</span></label>
 *       <span class="ds-choices__count"></span>
 *     </div>
 *     <div class="ds-choices__list" role="group" aria-label="Sites"> .ds-check rows </div>
 *   </div>
 *
 *   const sites = DS.choices.create(el);
 *   sites.get();  sites.set(['a', 'b']);  sites.filter('north');  sites.on('change', ({ value }) => ...);
 *
 * The boxes stay native (forms, labels, Space, Tab). "Select all" acts on
 * the boxes that show and are not blocked: all of them checked turns them
 * off, else on; it is checked when all of them are, indeterminate when some
 * are. Each box it changes sends its own input and change events, then the
 * root one ds:change ({ value }); the new count is announced. The count says
 * "3 selected" or "All selected" (none: empty). The filter hides the rows
 * that do not match DS.listbox.fuzzy() (words in any order, letters in
 * order) and marks the matched letters; .ds-choices__empty shows when none
 * does; Escape in a filled filter clears it.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { scrollEdges } from './dom.js';
import { announce } from './a11y.js';
import { fuzzy } from './listbox.js';

/** The live controllers. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

/**
 * The state of a "select all" box over `boxes` ({ checked, disabled }):
 * 'all', 'none' or 'some'; blocked boxes do not count. No usable box: 'none'.
 * @param {Array<{ checked: boolean, disabled?: boolean }>} boxes
 * @returns {'all'|'none'|'some'}
 */
export function summary(boxes) {
  const usable = boxes.filter((box) => !box.disabled);
  const on = usable.filter((box) => box.checked).length;
  if (!usable.length || on === 0) return 'none';
  return on === usable.length ? 'all' : 'some';
}

/**
 * The controller of a choice list, the one [data-ds-choices] makes; once
 * per element. Options: `value` (the checked values to start with; default
 * the markup's `checked`), `count` (write the count, default when a
 * .ds-choices__count is there).
 * @param {Element} element
 * @param {object} [options]
 * @returns {any}
 */
export function create(element, options = {}) {
  const existing = controllers.get(element);
  if (existing) return existing;
  const list = /** @type {HTMLElement|null} */ (element?.querySelector?.('.ds-choices__list'));
  if (!list) return null;
  const doc = element.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  const all = /** @type {HTMLInputElement|null} */ (element.querySelector('input[data-ds-choices-all]'));
  const search = /** @type {HTMLInputElement|null} */ (element.querySelector('.ds-choices__search'));
  const count = element.querySelector('.ds-choices__count');
  let empty = element.querySelector('.ds-choices__empty');
  let query = '';
  let destroyed = false;
  let batch = false;

  const rows = () => /** @type {HTMLElement[]} */ ([...list.querySelectorAll(':scope > .ds-check')]);
  const boxOf = (row) => /** @type {HTMLInputElement|null} */ (row.querySelector('input[type="checkbox"]'));
  const boxes = () => rows().map(boxOf).filter(Boolean);
  const blocked = (box) => box.disabled || box.getAttribute('aria-disabled') === 'true';
  const shownBoxes = () => rows().filter((row) => !row.hidden).map(boxOf).filter(Boolean);
  const value = () => boxes().filter((box) => box.checked).map((box) => box.value);
  /** The text of a row: the first span after the box. */
  const nameOf = (row) => /** @type {HTMLElement|null} */ (row.querySelector(':scope > input + span') ?? row.querySelector(':scope > span'));
  const labels = new WeakMap();
  const labelOf = (row) => {
    if (!labels.has(row)) labels.set(row, nameOf(row)?.textContent ?? '');
    return labels.get(row);
  };

  if (Array.isArray(options.value)) {
    const wanted = new Set(options.value.map(String));
    for (const box of boxes()) box.checked = wanted.has(box.value);
  }

  function sync() {
    const state = summary(shownBoxes().map((box) => ({ checked: box.checked, disabled: blocked(box) })));
    if (all) {
      all.checked = state === 'all';
      all.indeterminate = state === 'some';
      all.disabled = !shownBoxes().some((box) => !blocked(box));
    }
    if (count && (options.count ?? true)) {
      const on = value().length;
      const usable = boxes().filter((box) => !blocked(box) || box.checked);
      count.textContent = !on ? '' : on === usable.length ? t('allSelected') : t('selectedCount', { count: on });
    }
  }

  function changed() {
    sync();
    emit(element, 'change', { value: value() });
  }

  /** Marks the matched letters of a row's name, as DOM nodes (the page's text stays text). */
  function mark(row, ranges) {
    const name = nameOf(row);
    if (!name) return;
    const text = labelOf(row);
    if (!ranges.length) {
      if (name.querySelector('.ds-choices__match')) name.textContent = text;
      return;
    }
    const nodes = [];
    let last = 0;
    for (const [start, end] of ranges) {
      if (start > last) nodes.push(doc.createTextNode(text.slice(last, start)));
      const match = doc.createElement('mark');
      match.className = 'ds-choices__match';
      match.textContent = text.slice(start, end);
      nodes.push(match);
      last = end;
    }
    nodes.push(doc.createTextNode(text.slice(last)));
    name.replaceChildren(...nodes);
  }

  /** Shows the rows that match `text`; returns how many show. */
  function filter(text) {
    query = String(text ?? '');
    let shown = 0;
    for (const row of rows()) {
      const hit = query.trim() ? fuzzy(query, labelOf(row)) : { ranges: [] };
      row.hidden = !hit;
      mark(row, hit?.ranges ?? []);
      if (hit) shown += 1;
    }
    if (!empty && query.trim() && !shown) {
      empty = doc.createElement('p');
      empty.className = 'ds-choices__empty';
      empty.setAttribute('role', 'status');
      list.after(empty);
    }
    if (empty) {
      empty.hidden = shown > 0 || !query.trim();
      if (!empty.hidden && !empty.textContent.trim()) empty.textContent = t('noResults');
    }
    sync();
    return shown;
  }

  /* "Select all": the boxes that show and are not blocked. */
  all?.addEventListener('change', (event) => {
    event.stopPropagation();
    const usable = shownBoxes().filter((box) => !blocked(box));
    const on = summary(usable.map((box) => ({ checked: box.checked }))) !== 'all';
    // Each box sends its own events for the page; one ds:change for the whole act.
    batch = true;
    try {
      for (const box of usable) {
        if (box.checked === on) continue;
        box.checked = on;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } finally {
      batch = false;
    }
    changed();
    const total = value().length;
    announce(total && total === boxes().filter((box) => !blocked(box) || box.checked).length ? t('allSelected') : t('selectedCount', { count: total }));
  }, { signal });
  all?.addEventListener('input', (event) => event.stopPropagation(), { signal });

  /* One box: the summary follows. A blocked box (aria-disabled) is the guard's. */
  list.addEventListener('change', (event) => {
    if (batch || !(/** @type {Element} */ (event.target)).matches?.('input[type="checkbox"]')) return;
    changed();
  }, { signal });

  if (search) {
    search.addEventListener('input', () => filter(search.value), { signal });
    search.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.key !== 'Escape' || !search.value || event.defaultPrevented) return;
      // A filled filter takes the first Escape (an overlay around it stays open).
      event.preventDefault();
      event.stopPropagation();
      search.value = '';
      filter('');
    }, { signal });
  }

  const edges = element.classList.contains('ds-choices--scroll') && !list.hasAttribute('data-ds-edges') ? scrollEdges(list, { axis: 'block' }) : null;
  if (search?.value) filter(search.value);
  else sync();

  const controller = {
    element,
    /** The checked values, in the order of the rows. */
    get: value,
    /** Checks the boxes with these values, unchecks the rest (no event). */
    set(next) {
      const wanted = new Set([].concat(next ?? []).map(String));
      for (const box of boxes()) box.checked = wanted.has(box.value);
      sync();
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === element) fn(event.detail);
      };
      element.addEventListener(`ds:${type}`, listener);
      return () => element.removeEventListener(`ds:${type}`, listener);
    },
    /** Shows the rows that match `text`; returns how many show. */
    filter,
    /** Reads the rows again (the page added or removed some). */
    refresh() {
      filter(query);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      edges?.destroy();
      controllers.delete(element);
    },
  };
  controllers.set(element, controller);
  return controller;
}

define('choices', {
  attribute: 'data-ds-choices',
  init: (element) => create(element),
});
