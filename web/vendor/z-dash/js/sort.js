/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Sort control (DS.sort): the field and the direction of a list or a set of
 * cards, outside a table. Inline (a select of the fields and an order
 * button) or as a menu (.ds-sort--menu: one button and a menu of the
 * fields and the two directions); sort.css has the markup.
 *
 *   <div class="ds-sort" data-ds-sort data-ds-value="-seen"> ... </div>
 *
 *   const sort = DS.sort.create(el);
 *   sort.get();                       // { field: 'seen', direction: 'descending' }
 *   sort.set('name');                 // or { field: 'name', direction: 'ascending' }, or '-name'
 *   DS.sort.parse('-seen');           // { field: 'seen', direction: 'descending' }
 *   DS.sort.stringify({ field: 'seen', direction: 'descending' });   // '-seen'
 *
 * A field is an <option> of .ds-sort__field, or an item with
 * data-ds-sort-field in the menu. Per field: data-ds-sort-type (text,
 * number, date: the words of the directions, "A to Z", "Lowest first",
 * "Oldest first"; without one "Ascending" and "Descending"), or its own
 * words in data-ds-sort-asc and data-ds-sort-desc; data-ds-sort-default
 * (ascending or descending): the direction a change to this field starts
 * in (without one the direction stays).
 *
 * The first state: data-ds-value ("name", "-name": descending), else the
 * markup's (the selected option or checked item, the checked direction
 * item, else ascending). The system writes data-state (ascending or
 * descending) on .ds-sort, the words of every .ds-sort__words, the field's
 * name into .ds-sort__value, and aria-checked of the menu items; the order
 * button flips the direction, the select and the items change the field.
 * A change the user made sends ds:sort ({ field, direction, label, words })
 * and is announced ("Sorted by Name, Z to A"); set() from the page sends
 * nothing. The strings are DS.core.config() strings (sortAscending ...).
 *
 * ES2022. No progressive feature.
 */
import { define, emit, get as controllerOf, t } from './core.js';
import { announce } from './a11y.js';

const DIRECTIONS = ['ascending', 'descending'];

/** The controllers create() made, so the attribute path takes over the same one (and the reverse). */
const built = new WeakMap();

/** The string keys of a field type's two words. */
const WORDS = {
  text: ['sortAscendingText', 'sortDescendingText'],
  number: ['sortAscendingNumber', 'sortDescendingNumber'],
  date: ['sortAscendingDate', 'sortDescendingDate'],
};

/**
 * A sort as text: "name" ascending, "-name" descending; "+name",
 * "name:asc" and "name:desc" are read too. Empty text gives null.
 * @param {string|null|undefined} text
 * @returns {{ field: string, direction: 'ascending'|'descending' }|null}
 */
export function parse(text) {
  let rest = String(text ?? '').trim();
  if (!rest) return null;
  let direction = 'ascending';
  const suffix = /:(asc|ascending|desc|descending)$/i.exec(rest);
  if (suffix) {
    direction = suffix[1].toLowerCase().startsWith('desc') ? 'descending' : 'ascending';
    rest = rest.slice(0, suffix.index);
  } else if (rest.startsWith('-')) {
    direction = 'descending';
    rest = rest.slice(1);
  } else if (rest.startsWith('+')) {
    rest = rest.slice(1);
  }
  rest = rest.trim();
  return rest ? { field: rest, direction: /** @type {'ascending'|'descending'} */ (direction) } : null;
}

/**
 * A sort as the text parse() reads: "name", or "-name" descending.
 * @param {{ field?: string|null, direction?: string }|null|undefined} state
 * @returns {string}
 */
export function stringify(state) {
  if (!state?.field) return '';
  return `${state.direction === 'descending' ? '-' : ''}${state.field}`;
}

/** A sort from what set() takes: text, or { field, direction }. */
function normal(value) {
  if (value == null) return null;
  if (typeof value === 'string') return parse(value);
  if (typeof value !== 'object') return null;
  const field = value.field == null ? null : String(value.field);
  const direction = DIRECTIONS.includes(value.direction) ? value.direction : null;
  return { field, direction };
}

/** The fields of a sort control: its select's options, else its menu's field items. */
function fieldsOf(el) {
  const select = el.querySelector('select.ds-sort__field');
  const nodes = select ? [...select.options] : [...el.querySelectorAll('[data-ds-sort-field]')];
  return nodes.map((node) => ({
    node,
    value: select ? node.value : node.getAttribute('data-ds-sort-field'),
    label: (node.querySelector?.('.ds-menu__label')?.textContent ?? node.textContent ?? '').replace(/\s+/g, ' ').trim(),
    type: node.getAttribute('data-ds-sort-type'),
    asc: node.getAttribute('data-ds-sort-asc'),
    desc: node.getAttribute('data-ds-sort-desc'),
    start: DIRECTIONS.includes(node.getAttribute('data-ds-sort-default')) ? node.getAttribute('data-ds-sort-default') : null,
  }));
}

/** A field's two words, ascending first. */
function wordsOf(field) {
  const keys = WORDS[field?.type] ?? ['sortAscending', 'sortDescending'];
  return [field?.asc || t(keys[0]), field?.desc || t(keys[1])];
}

function controller(el, signal) {
  const listeners = new Set();
  const select = /** @type {HTMLSelectElement|null} */ (el.querySelector('select.ds-sort__field'));
  let fields = fieldsOf(el);
  /** @type {{ field: string|null, direction: 'ascending'|'descending' }} */
  let state = { field: null, direction: 'ascending' };

  const fieldOf = (value) => fields.find((field) => field.value === value) ?? null;

  /** The markup's state: the selected option or checked item, the checked direction. */
  const fromMarkup = () => {
    const checked = el.querySelector('[data-ds-sort-field][aria-checked="true"]');
    const field = select ? select.value : checked?.getAttribute('data-ds-sort-field') ?? fields[0]?.value ?? null;
    const down = el.querySelector('[data-ds-sort-direction="descending"][aria-checked="true"]');
    return { field, direction: down ? 'descending' : (fieldOf(field)?.start ?? 'ascending') };
  };

  /** Writes the state into the markup. */
  const paint = () => {
    const field = fieldOf(state.field);
    const words = wordsOf(field);
    el.setAttribute('data-state', state.direction);
    if (select && state.field != null && select.value !== state.field) select.value = state.field;
    for (const holder of el.querySelectorAll('.ds-sort__words')) {
      const parts = holder.querySelectorAll('.ds-sort__word');
      if (parts.length >= 2) {
        if (parts[0].textContent !== words[0]) parts[0].textContent = words[0];
        if (parts[1].textContent !== words[1]) parts[1].textContent = words[1];
      } else {
        const text = words[state.direction === 'descending' ? 1 : 0];
        if (holder.textContent !== text) holder.textContent = text;
      }
    }
    for (const value of el.querySelectorAll('.ds-sort__value')) {
      if (field && value.textContent !== field.label) value.textContent = field.label;
    }
    for (const item of el.querySelectorAll('[data-ds-sort-field]')) {
      item.setAttribute('aria-checked', String(item.getAttribute('data-ds-sort-field') === state.field));
    }
    for (const item of el.querySelectorAll('[data-ds-sort-direction]')) {
      const direction = item.getAttribute('data-ds-sort-direction');
      item.setAttribute('aria-checked', String(direction === state.direction));
      const label = item.querySelector('.ds-menu__label') ?? item;
      const text = words[direction === 'descending' ? 1 : 0];
      if (label.textContent !== text) label.textContent = text;
    }
  };

  const detail = () => {
    const field = fieldOf(state.field);
    return { field: state.field, direction: state.direction, label: field?.label ?? '', words: wordsOf(field)[state.direction === 'descending' ? 1 : 0] };
  };

  /** Takes `next` in; a change by the user is told and spoken. */
  const commit = (next, user) => {
    const field = next.field != null && fieldOf(next.field) ? next.field : state.field ?? fields[0]?.value ?? null;
    const changedField = field !== state.field;
    const direction = next.direction ?? (changedField ? fieldOf(field)?.start : null) ?? state.direction;
    const changed = changedField || direction !== state.direction;
    state = { field, direction };
    paint();
    if (!changed || !user || signal?.aborted) return;
    const told = detail();
    emit(el, 'sort', told);
    listeners.forEach((fn) => fn(told));
    announce(t('sortAnnounce', { field: told.label, direction: told.words }));
  };

  const on = (target, type, fn) => target?.addEventListener(type, fn, { signal });
  on(select, 'change', () => commit({ field: select.value, direction: null }, true));
  on(el, 'click', (/** @type {MouseEvent} */ event) => {
    const target = /** @type {Element} */ (event.target);
    if (!target?.closest) return;
    if (target.closest('.ds-sort__order')) {
      commit({ field: state.field, direction: state.direction === 'descending' ? 'ascending' : 'descending' }, true);
      return;
    }
    const item = target.closest('[data-ds-sort-field], [data-ds-sort-direction]');
    if (!item || !el.contains(item) || item.getAttribute('aria-disabled') === 'true') return;
    const direction = item.getAttribute('data-ds-sort-direction');
    if (direction) commit({ field: state.field, direction: DIRECTIONS.includes(direction) ? direction : null }, true);
    else commit({ field: item.getAttribute('data-ds-sort-field'), direction: null }, true);
  });
  // Another locale or other strings: the words follow.
  on(el.ownerDocument, 'ds:config', paint);

  const first = parse(el.getAttribute('data-ds-value')) ?? fromMarkup();
  state = { field: fieldOf(first.field) ? first.field : fields[0]?.value ?? null, direction: first.direction };
  paint();

  return {
    get() { return { field: state.field, direction: state.direction }; },
    set(value) {
      const next = normal(value);
      if (next) commit(next, false);
    },
    on(type, fn) {
      if (type !== 'change' && type !== 'sort') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      fields = fieldsOf(el);
      commit({ field: state.field, direction: state.direction }, false);
    },
    destroy() {
      listeners.clear();
    },
  };
}

define('sort', {
  attribute: 'data-ds-sort',
  init(el, ctx) {
    return built.get(el) ?? controller(el, ctx.signal);
  },
});

/**
 * A sort control driven from the page; the same controller data-ds-sort
 * makes.
 * @param {Element} el  the .ds-sort element
 * @returns {{ get(): { field: string|null, direction: 'ascending'|'descending' }, set(value: string|{ field?: string, direction?: string }): void,
 *   on(type: 'change'|'sort', fn: (detail: object) => void): () => void, update(): void, destroy(): void }}
 */
export function create(el) {
  const existing = controllerOf(el, 'sort') ?? built.get(el);
  if (existing) return /** @type {any} */ (existing);
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const made = controller(el, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
    built.delete(el);
  };
  built.set(el, made);
  return made;
}
