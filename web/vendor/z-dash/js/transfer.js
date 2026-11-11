/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The transfer list (DS.transfer): two listboxes, the available options and
 * the chosen ones, and buttons that move the marked options across.
 *
 *   <div class="ds-transfer" data-ds-transfer>
 *     <div class="ds-transfer__side" data-ds-transfer-side="source"> [search] <div class="ds-listbox ds-transfer__list" role="listbox" aria-multiselectable="true"> options </div></div>
 *     <div class="ds-transfer__actions"><button data-ds-transfer-add>(right)</button><button data-ds-transfer-remove>(left)</button></div>
 *     <div class="ds-transfer__side" data-ds-transfer-side="target"> ... </div>
 *   </div>
 *
 *   const group = DS.transfer.create(el, { items, value: ['d-1'] });
 *   group.get();  group.set(['d-1', 'd-2']);  group.on('change', ({ value }) => ...);
 *
 * Every option lives on one side: the value is the target's options, in the
 * order they came. Marking is each list's own choice (DS.listbox: Space,
 * Shift with an arrow, Ctrl+A, a press, a Shift-press); the add button moves
 * the source's marked options to the end of the target, the remove button
 * the target's back to the source (in their first order). Enter in a list
 * moves its marked options, or the active one when none is marked; a
 * double-click moves the option under the pointer. A button is disabled
 * while its side has nothing marked. Each move is announced ("Moved 3 to
 * Chosen") and sends ds:change ({ value }). The options come from the
 * markup of both lists (the value: the target's) or from `items` and
 * `value`; long sides are windowed (DS.virtual through DS.listbox). A
 * .ds-transfer__search above a list filters it.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { announce } from './a11y.js';
import { create as createList } from './listbox.js';

/** The live controllers. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

/**
 * The two sides after a move: `moving` (values) goes from `from` to the end
 * of `to`, or, going back to the source, into `to` in the order of `all`.
 * Returns `{ from, to }`, new lists.
 * @param {string[]} from
 * @param {string[]} to
 * @param {string[]} moving
 * @param {string[]|null} [all]  the first order, when `to` keeps it (the source)
 * @returns {{ from: string[], to: string[] }}
 */
export function move(from, to, moving, all = null) {
  const going = new Set(moving.filter((each) => from.includes(each)));
  const left = from.filter((each) => !going.has(each));
  if (!all) return { from: left, to: [...to, ...from.filter((each) => going.has(each))] };
  const now = new Set([...to, ...going]);
  return { from: left, to: all.filter((each) => now.has(each)) };
}

/** An option of the markup as an item. */
function itemOf(option) {
  const name = option.querySelector('.ds-listbox__name');
  const label = (name ?? option).textContent.trim();
  return {
    value: /** @type {HTMLElement} */ (option).dataset.value ?? label,
    label,
    description: option.querySelector('.ds-listbox__description')?.textContent.trim() ?? '',
    meta: option.querySelector('.ds-listbox__meta')?.textContent.trim() ?? '',
    disabled: option.getAttribute('aria-disabled') === 'true',
  };
}

/**
 * The controller of a transfer list, the one [data-ds-transfer] makes; once
 * per element. Options: `items` (every option, as DS.listbox; default the
 * markup's of both lists), `value` (the target's values; default the
 * target list's markup), `virtual` (as DS.listbox).
 * @param {Element} element
 * @param {object} [options]
 * @returns {any}
 */
export function create(element, options = {}) {
  const existing = controllers.get(element);
  if (existing) return existing;
  const sourceSide = element?.querySelector?.('[data-ds-transfer-side="source"]');
  const targetSide = element?.querySelector?.('[data-ds-transfer-side="target"]');
  const sourceEl = /** @type {HTMLElement|null} */ (sourceSide?.querySelector('.ds-transfer__list') ?? null);
  const targetEl = /** @type {HTMLElement|null} */ (targetSide?.querySelector('.ds-transfer__list') ?? null);
  if (!sourceEl || !targetEl) return null;
  const abort = new AbortController();
  const signal = abort.signal;
  const addButton = /** @type {HTMLButtonElement|null} */ (element.querySelector('[data-ds-transfer-add]'));
  const removeButton = /** @type {HTMLButtonElement|null} */ (element.querySelector('[data-ds-transfer-remove]'));
  let destroyed = false;

  /* Every option, in its first order, by value. */
  const markupSource = [...sourceEl.querySelectorAll('[role="option"]')].map(itemOf);
  const markupTarget = [...targetEl.querySelectorAll('[role="option"]')].map(itemOf);
  const all = options.items ? options.items.map((item) => (item && typeof item === 'object' ? item : { value: String(item), label: String(item) })) : [...markupSource, ...markupTarget];
  const byValue = new Map(all.map((item) => [String(item.value ?? item.label), item]));
  const firstOrder = [...byValue.keys()];
  let target = (options.value ?? markupTarget.map((item) => item.value)).map(String).filter((each) => byValue.has(each));
  let source = firstOrder.filter((each) => !target.includes(each));

  const nameOf = (side) => side.querySelector('.ds-transfer__title')?.textContent.trim() || side.querySelector('.ds-transfer__list')?.getAttribute('aria-label') || '';
  const common = { multiple: true, value: [], virtual: options.virtual };
  const left = createList(sourceEl, { ...common, items: source.map((each) => byValue.get(each)) });
  const right = createList(targetEl, { ...common, items: target.map((each) => byValue.get(each)) });

  function syncButtons() {
    if (addButton) addButton.disabled = !left.get().length;
    if (removeButton) removeButton.disabled = !right.get().length;
  }

  /** Moves `values` across; `toTarget` says which way. */
  function transfer(values, toTarget) {
    const usable = values.filter((each) => !byValue.get(each)?.disabled);
    if (!usable.length) return false;
    if (toTarget) ({ from: source, to: target } = move(source, target, usable));
    else ({ from: target, to: source } = move(target, source, usable, firstOrder));
    render();
    // The moved options stay marked on their new side, so a move back is one press.
    (toTarget ? right : left).set(usable);
    (toTarget ? left : right).set([]);
    syncButtons();
    announce(t('transferMoved', { count: usable.length, list: nameOf(toTarget ? targetSide : sourceSide) }));
    emit(element, 'change', { value: [...target] });
    return true;
  }

  function render() {
    left.setItems(source.map((each) => byValue.get(each)));
    right.setItems(target.map((each) => byValue.get(each)));
  }

  /** What Enter or a button moves from a side: its marked options, else the active one. */
  function moving(list) {
    const marked = list.get();
    if (marked.length) return marked;
    const active = list.active();
    return active ? [active.value] : [];
  }

  addButton?.addEventListener('click', () => transfer(left.get(), true), { signal });
  removeButton?.addEventListener('click', () => transfer(right.get(), false), { signal });

  for (const [list, el, toTarget] of /** @type {const} */ ([[left, sourceEl, true], [right, targetEl, false]])) {
    el.addEventListener('ds:change', (event) => {
      event.stopPropagation();
      syncButtons();
    }, { signal });
    // Enter moves (before the listbox's own Enter, which would mark).
    el.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const values = moving(list);
      const active = list.active()?.value;
      if (!transfer(values, toTarget)) return;
      // The focus stays in this list, on the option after the one that went.
      const shown = list.shown();
      if (shown.length) list.activate(active && shown.some((entry) => entry.value === active) ? active : 'first');
    }, { signal, capture: true });
    el.addEventListener('dblclick', (/** @type {MouseEvent} */ event) => {
      const option = /** @type {Element} */ (event.target)?.closest?.('[role="option"]');
      if (!option) return;
      const entry = list.shown().find((each) => each.el === option || each.el?.id === option.id);
      if (entry) transfer([entry.value], toTarget);
    }, { signal });
  }

  for (const [side, list] of /** @type {const} */ ([[sourceSide, left], [targetSide, right]])) {
    const search = /** @type {HTMLInputElement|null} */ (side.querySelector('.ds-transfer__search'));
    if (!search) continue;
    search.setAttribute('autocomplete', 'off');
    search.addEventListener('input', () => list.filter(search.value), { signal });
  }

  syncButtons();

  const controller = {
    element,
    /** The chosen values (the target side), in the order they came. */
    get: () => [...target],
    /** Sets the chosen values (no event). */
    set(next) {
      target = [].concat(next ?? []).map(String).filter((each) => byValue.has(each));
      source = firstOrder.filter((each) => !target.includes(each));
      render();
      left.set([]);
      right.set([]);
      syncButtons();
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === element) fn(event.detail);
      };
      element.addEventListener(`ds:${type}`, listener);
      return () => element.removeEventListener(`ds:${type}`, listener);
    },
    /** Moves the values to the target (or back with `toTarget` false), as the buttons do. */
    move: (values, toTarget = true) => transfer([].concat(values ?? []).map(String).filter((each) => (toTarget ? source : target).includes(each)), toTarget),
    /** The two list engines (DS.listbox's controllers). */
    lists: { source: left, target: right },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      left.destroy();
      right.destroy();
      controllers.delete(element);
    },
  };
  controllers.set(element, controller);
  return controller;
}

define('transfer', {
  attribute: 'data-ds-transfer',
  init: (element) => create(element),
});
