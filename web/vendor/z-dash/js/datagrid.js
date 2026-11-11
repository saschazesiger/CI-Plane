/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The data grid (DS.datagrid): the behaviour a console table needs, on top of
 * the table's CSS (table.css stays plain; this module and datagrid.css add only
 * what a grid asks for). Every option is opt-in: a table with data-ds-datagrid
 * and no options renders as it was, and each option adds one thing.
 *
 *   <div class="ds-table-wrap">
 *     <table class="ds-table ds-datagrid" data-ds-datagrid data-ds-config='{"select":"multiple","focus":"cell"}'>
 *       <thead><tr><th scope="col" data-ds-datagrid-col="name" data-ds-datagrid-sort>Device</th> ...</tr></thead>
 *       <tbody><tr data-ds-key="d1"><td>LAPTOP-0100</td> ...</tr></tbody>
 *     </table>
 *   </div>
 *
 *   const grid = DS.datagrid.create(table, { columns, rows, select: 'multiple', focus: 'cell', virtual: true });
 *   grid.set({ sort: [{ key: 'load', dir: 'descending' }], filter: 'floor' });
 *   grid.on('select', ({ count }) => ...);
 *   DS.datagrid.query(rows, { columns, sort, filter, page });   // the client pipeline alone
 *   DS.datagrid.csv(rows, columns);                             // what export writes
 *   DS.datagrid.summary(rows, column);                          // one cell of a summary row
 *
 * Data: one contract for client and server data. `rows` (an array) is
 * filtered, sorted, grouped and paged here; `source(query, { signal })` (a
 * function) gets { sort, filter, page } and returns (a promise of)
 * { rows, total, summary }, already filtered, sorted and paged by the
 * server. A table with neither is read from its markup once (the declarative
 * path): columns from its header cells, rows from its body rows.
 *
 * Rendering: the grid owns the content of the table's thead, tbody and (with
 * summaries) tfoot, and renders them from the data through DS.dom.morphHtml,
 * rows keyed by data-ds-key and cells by their column, so a re-render patches
 * in place, keeps focus and listeners, and a column moved by reorder carries
 * its cells. A user's sort or filter glides through DS.motion.flip (rows are
 * keyed); with `virtual` the rows are windowed by DS.virtual and only those
 * near the viewport exist.
 *
 * Keys: `focus: 'cell'` or `'row'` makes the table an ARIA grid (treegrid
 * with tree rows or row groups) with one tab stop and the keys of the APG
 * grid pattern; without it the table keeps its roles and Tab goes through
 * its controls. Strings come from DS.core.t(); timing from the tokens.
 *
 * ES2022.
 *
 * Progressive:
 * - navigator.clipboard (copy): without it copy() reports that it did not
 *   work (actionFailed), and CSV export still downloads.
 */
import { define, emit, t, config } from './core.js';
import { flip, crossfade, motionDuration } from './motion.js';
import { morphHtml, own, disown, typesText } from './dom.js';
import { announce } from './a11y.js';
import { number, plural, absolute } from './format.js';
import { open as openStore } from './store.js';
import { create as windowRows } from './virtual.js';
import { create as dragAndDrop } from './dnd.js';
import { fixedOrigin } from './position.js';
import { icon, arrowUp, chevronDown, chevronRight, gripHorizontal, check, alertCircle, box, search } from './icons.js';
import { open as openMenu, close as closeMenu } from './menu.js';

/** A column's least and most width when resized, in px. */
const MIN_WIDTH = 56;
const MAX_WIDTH = 960;

/** One step of a keyboard resize, and a big one (Shift, PageUp/PageDown), in px. */
const RESIZE_STEP = 8;
const RESIZE_BIG_STEP = 64;

/** Rows a PageUp or PageDown moves in the grid's keyboard model. */
const PAGE_ROWS = 10;

/** What counts as a widget inside a cell (the cell's own focus target). */
const WIDGET = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not(td, th, tr)';

const SORT_DIRS = ['ascending', 'descending'];

/** The controller of each table. @type {WeakMap<Element, any>} */
const instances = new WeakMap();

/** The grids made so far: each grid's ids start with its number. */
let gridCount = 0;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Text escaped for markup. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/* ── Columns and values (pure) ─────────────────────── */

/**
 * A column as the grid uses it: every option with its default.
 * @param {any} column
 * @param {number} index
 */
function normalizeColumn(column, index) {
  const input = typeof column === 'string' ? { key: column } : { ...column };
  const key = String(input.key ?? `c${index}`);
  const type = ['number', 'date'].includes(input.type) ? input.type : 'text';
  const edit = input.edit === true ? { type: type === 'number' ? 'number' : 'text' } : isObject(input.edit) ? { type: 'text', ...input.edit } : typeof input.edit === 'string' ? { type: input.edit } : null;
  return {
    ...input,
    key,
    label: String(input.label ?? key),
    type,
    sortable: input.sortable !== false && input.sortable !== undefined ? true : input.sortable === undefined ? null : false,
    resizable: input.resizable,
    reorderable: input.reorderable,
    hideable: input.hideable,
    hidden: Boolean(input.hidden),
    width: Number.isFinite(input.width) ? input.width : null,
    minWidth: Number.isFinite(input.minWidth) ? input.minWidth : MIN_WIDTH,
    maxWidth: Number.isFinite(input.maxWidth) ? input.maxWidth : MAX_WIDTH,
    className: String(input.className ?? (type === 'number' ? 'ds-num' : '')),
    edit,
    filterable: input.filterable !== false,
  };
}

/** The raw value of a row in a column. */
function valueOf(column, row) {
  if (typeof column.value === 'function') return column.value(row);
  return row?.[column.key];
}

/** The value as text: the column's format, else Intl for numbers and dates. */
function textOf(column, row, locale) {
  const value = valueOf(column, row);
  if (typeof column.format === 'function') return String(column.format(value, row) ?? '');
  if (value === null || value === undefined) return '';
  if (column.type === 'number' && typeof value === 'number') return number(value, { locale });
  if (column.type === 'date' && (value instanceof Date || typeof value === 'number')) return absolute(value, { locale, dateStyle: 'medium' });
  return String(value);
}

const isEmpty = (value) => value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));

function timeOf(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/** Compares two values of one type; empty values go last whatever the direction (sortRows handles that). */
function compareValues(a, b, type, collator) {
  if (type === 'number') return Number(a) - Number(b);
  if (type === 'date') return (timeOf(a) ?? 0) - (timeOf(b) ?? 0);
  return collator.compare(String(a), String(b));
}

function collatorFor(locale) {
  try {
    return new Intl.Collator(locale || undefined, { numeric: true, sensitivity: 'base' });
  } catch {
    return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  }
}

/** A sort as a list of { key, dir }: one entry, a list, or nothing. */
function normalizeSort(sort) {
  const list = Array.isArray(sort) ? sort : sort ? [sort] : [];
  const out = [];
  for (const entry of list) {
    const key = typeof entry === 'string' ? entry : entry?.key;
    if (key === undefined || key === null || out.some((item) => item.key === String(key))) continue;
    const dir = SORT_DIRS.includes(entry?.dir) ? entry.dir : entry?.dir === 'desc' ? 'descending' : 'ascending';
    out.push({ key: String(key), dir });
  }
  return out;
}

/**
 * Sorts a copy of `list` by `sort` (stable; empty values last in either
 * direction). `rowOf` reads the row of an entry (tree nodes sort as they are).
 */
function sortRows(list, sort, columns, locale, rowOf = (entry) => entry) {
  const keys = sort.map((entry) => ({ entry, column: columns.find((column) => column.key === entry.key) })).filter((item) => item.column);
  if (!keys.length) return list.slice();
  const collator = collatorFor(locale);
  return list.map((entry, index) => ({ entry, row: rowOf(entry), index })).sort((a, b) => {
    for (const { entry, column } of keys) {
      const va = column.sortValue ? column.sortValue(a.row) : valueOf(column, a.row);
      const vb = column.sortValue ? column.sortValue(b.row) : valueOf(column, b.row);
      const ea = isEmpty(va);
      const eb = isEmpty(vb);
      if (ea || eb) {
        if (ea && eb) continue;
        return ea ? 1 : -1;
      }
      const order = compareValues(va, vb, column.type, collator);
      if (order) return entry.dir === 'descending' ? -order : order;
    }
    return a.index - b.index;
  }).map((item) => item.entry);
}

/** Whether a row passes `filter`: text (any filterable column contains it), a function, or { key: value | fn }. */
function matches(row, filter, columns, locale) {
  if (filter === null || filter === undefined || filter === '') return true;
  if (typeof filter === 'function') return Boolean(filter(row));
  if (isObject(filter)) {
    return Object.entries(filter).every(([key, wanted]) => {
      const column = columns.find((item) => item.key === key) ?? normalizeColumn({ key }, 0);
      const value = valueOf(column, row);
      if (typeof wanted === 'function') return Boolean(wanted(value, row));
      if (Array.isArray(wanted)) return !wanted.length || wanted.map(String).includes(String(value));
      if (wanted === null || wanted === undefined || wanted === '') return true;
      return String(value) === String(wanted);
    });
  }
  const needle = String(filter).trim().toLocaleLowerCase();
  if (!needle) return true;
  return columns.some((column) => column.filterable && textOf(column, row, locale).toLocaleLowerCase().includes(needle));
}

/**
 * One summary of `rows` in `column`: 'sum', 'avg', 'min', 'max', 'count' or a
 * function of the rows; null where nothing can be summed.
 * @param {any[]} rows
 * @param {any} column
 * @returns {number|string|null}
 */
export function summary(rows, column) {
  const col = column?.key !== undefined ? normalizeColumn(column, 0) : null;
  const kind = column?.summary;
  if (!col || !kind) return null;
  if (typeof kind === 'function') return kind(rows);
  if (kind === 'count') return rows.length;
  // An empty value is no figure: Number(null) and Number('') would count as 0.
  const values = rows.map((row) => valueOf(col, row)).filter((value) => !isEmpty(value)).map(Number).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  if (kind === 'sum') return values.reduce((sum, value) => sum + value, 0);
  if (kind === 'avg') return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (kind === 'min') return Math.min(...values);
  if (kind === 'max') return Math.max(...values);
  return null;
}

/** The key of a row: a property name or a function (default `id`, else its index). */
function keyFn(key) {
  if (typeof key === 'function') return (row, index) => String(key(row, index));
  const name = key ?? 'id';
  return (row, index) => String(row?.[name] ?? index);
}

/**
 * The client pipeline, without a DOM: filter, sort, group or tree, page.
 * Returns the rows of the page as display items ({ kind: 'row' | 'group',
 * row, key, level, setsize, posinset, parent, expanded, children, group }),
 * the data rows of the page, the number of rows that pass the filter (roots
 * for a tree) and every filtered row.
 * @param {any[]} rows
 * @param {{ columns?: any[], sort?: any, filter?: any, page?: { index?: number, size?: number }|null, key?: string|((row: any, index: number) => string),
 *   tree?: boolean|{ children?: string|((row: any) => any[]) }|null, expanded?: Iterable<string>, group?: string|{ by: string }|null, collapsed?: Iterable<string>, locale?: string }} [options]
 * @returns {{ items: any[], rows: any[], total: number, filtered: any[] }}
 */
export function query(rows, options = {}) {
  const columns = (options.columns ?? []).map(normalizeColumn);
  const sort = normalizeSort(options.sort);
  const locale = options.locale ?? undefined;
  const keyOf = keyFn(options.key);
  const all = Array.isArray(rows) ? rows : [];
  const tree = options.tree ? (isObject(options.tree) ? options.tree : {}) : null;

  if (tree) {
    const childrenOf = typeof tree.children === 'function' ? tree.children : (row) => row?.[tree.children ?? 'children'];
    const expanded = new Set([...(options.expanded ?? [])].map(String));
    // A row stays when it or a descendant passes the filter; a match opens its ancestors for the view.
    const keep = (row, index, parentKey) => {
      const key = keyOf(row, index);
      const kids = (childrenOf(row) ?? []).map((child, at) => keep(child, at, key)).filter(Boolean);
      const self = matches(row, options.filter, columns, locale);
      if (!self && !kids.length) return null;
      return { row, key, kids, self, hasChildren: (childrenOf(row) ?? []).length > 0, forced: !self || kids.some((kid) => !kid.self || kid.forced) };
    };
    const filtering = options.filter !== null && options.filter !== undefined && options.filter !== '';
    // The nodes sort as they are: mapping sorted rows back to their nodes would be quadratic.
    const order = (nodes) => sortRows(nodes, sort, columns, locale, (node) => node.row);
    const roots = order(all.map((row, index) => keep(row, index, null)).filter(Boolean));
    const total = roots.length;
    const size = options.page?.size;
    const start = size ? Math.max(0, options.page.index ?? 0) * size : 0;
    const pageRoots = size ? roots.slice(start, start + size) : roots;
    const items = [];
    const filtered = [];
    const walk = (nodes, level, parent) => {
      nodes.forEach((node, at) => {
        const open = node.kids.length > 0 && (expanded.has(node.key) || (filtering && node.forced));
        items.push({ kind: 'row', row: node.row, key: node.key, level, setsize: nodes.length, posinset: at + 1, parent, expanded: node.hasChildren ? open : null, children: node.kids.length });
        if (open) walk(order(node.kids), level + 1, node.key);
      });
    };
    walk(pageRoots, 1, null);
    const collect = (nodes) => nodes.forEach((node) => { filtered.push(node.row); collect(node.kids); });
    collect(roots);
    return { items, rows: items.map((item) => item.row), total, filtered };
  }

  const passing = all.map((row, index) => ({ row, index })).filter(({ row }) => matches(row, options.filter, columns, locale));
  const keys = new Map(passing.map(({ row, index }) => [row, keyOf(row, index)]));
  const sorted = sortRows(passing.map(({ row }) => row), sort, columns, locale);
  const total = sorted.length;
  const size = options.page?.size;
  const start = size ? Math.max(0, options.page.index ?? 0) * size : 0;
  const paged = size ? sorted.slice(start, start + size) : sorted;
  const groupBy = typeof options.group === 'string' ? options.group : options.group?.by;
  if (!groupBy) {
    const items = paged.map((row, at) => ({ kind: 'row', row, key: keys.get(row), level: 1, setsize: total, posinset: start + at + 1, parent: null, expanded: null, children: 0 }));
    return { items, rows: paged, total, filtered: sorted };
  }
  // Groups in the order of their first row, unless the sort names the grouping column.
  const column = columns.find((item) => item.key === groupBy) ?? normalizeColumn({ key: groupBy }, 0);
  const collapsed = new Set([...(options.collapsed ?? [])].map(String));
  const groups = new Map();
  for (const row of paged) {
    const value = valueOf(column, row);
    const id = isEmpty(value) ? '' : String(value);
    if (!groups.has(id)) groups.set(id, { id, value, label: textOf(column, row, locale), rows: [] });
    groups.get(id).rows.push(row);
  }
  let list = [...groups.values()];
  if (!sort.some((entry) => entry.key === groupBy)) {
    const collator = collatorFor(locale);
    list = list.sort((a, b) => (isEmpty(a.value) ? 1 : isEmpty(b.value) ? -1 : compareValues(a.value, b.value, column.type, collator)));
  }
  const items = [];
  list.forEach((group, at) => {
    const open = !collapsed.has(group.id);
    items.push({ kind: 'group', key: group.id, group, level: 1, setsize: list.length, posinset: at + 1, parent: null, expanded: open, children: group.rows.length });
    if (open) group.rows.forEach((row, index) => items.push({ kind: 'row', row, key: keys.get(row), level: 2, setsize: group.rows.length, posinset: index + 1, parent: group.id, expanded: null, children: 0 }));
  });
  return { items, rows: paged, total, filtered: sorted };
}

/**
 * A negative figure as text: the minus, digits with their grouping and
 * decimal marks (spaces, no-break spaces, apostrophes), a currency sign
 * before or after, a percent sign. A spreadsheet reads it as a number, never
 * as a formula.
 */
const FIGURE = /^-(?:\p{Sc}[ \u00a0\u202f]?)?\d[\d.,' \u00a0\u202f\u2019]*(?:%|[ \u00a0\u202f]?\p{Sc})?$/u;

/** One field of CSV: quoted when it holds the separator, a quote or a line break; a formula start is defused. */
function csvField(text, separator, safe) {
  let value = String(text ?? '');
  // A spreadsheet runs a cell that starts with = + - @ (or a tab or return) as a formula.
  if (safe && /^[=+\-@\t\r]/.test(value) && !FIGURE.test(value)) value = `'${value}`;
  return /["\n\r]/.test(value) || value.includes(separator) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Rows as CSV (RFC 4180, CRLF), a header line of the column labels first.
 * `separator` (default ','; '\t' for the clipboard), `header` (default true),
 * `safe` (default true: a field that a spreadsheet would run as a formula
 * starts with an apostrophe), `locale` for the formatted values; `raw: true`
 * writes the values instead of their text.
 * @param {any[]} rows
 * @param {any[]} columns
 * @param {{ separator?: string, header?: boolean, safe?: boolean, raw?: boolean, locale?: string }} [options]
 * @returns {string}
 */
export function csv(rows, columns, options = {}) {
  const separator = options.separator ?? ',';
  const safe = options.safe !== false;
  const list = (columns ?? []).map(normalizeColumn).filter((column) => column.export !== false);
  const lines = [];
  if (options.header !== false) lines.push(list.map((column) => csvField(column.label, separator, safe)).join(separator));
  for (const row of rows ?? []) {
    lines.push(list.map((column) => {
      if (typeof column.exportValue === 'function') return csvField(column.exportValue(row), separator, safe);
      const value = options.raw ? valueOf(column, row) : textOf(column, row, options.locale);
      return csvField(value instanceof Date ? value.toISOString() : value, separator, safe);
    }).join(separator));
  }
  return lines.join('\r\n');
}

/* ── The declarative path: a table read from its markup ── */

/** Hidden fields of a row read from markup: the cells' markup and classes, the detail, the parent. */
const CELLS = Symbol('ds.grid.cells');

/** The text of a node as a reader would take it, collapsed. */
const textIn = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Whether a header cell shows a label (not only .ds-sr text). */
function visibleLabel(th) {
  const clone = th.cloneNode(true);
  for (const hidden of clone.querySelectorAll('.ds-sr, svg')) hidden.remove();
  return textIn(clone).length > 0;
}

/** Columns, rows and the initial state of a table from its markup. */
function readTable(table) {
  const headRow = table.tHead?.rows[0] ?? null;
  const columns = [];
  const sort = [];
  for (const [index, th] of Array.from(headRow?.cells ?? []).entries()) {
    const key = th.getAttribute('data-ds-datagrid-col') || `c${index}`;
    const button = th.querySelector('.ds-table__sort');
    let head = '';
    if (button) {
      const copy = button.cloneNode(true);
      for (const arrow of copy.querySelectorAll('svg')) arrow.remove();
      head = copy.innerHTML.trim();
    } else head = th.innerHTML.trim();
    const type = th.getAttribute('data-ds-datagrid-type') || (th.classList.contains('ds-num') ? 'number' : 'text');
    const locked = !visibleLabel(th);
    const editAttr = th.getAttribute('data-ds-datagrid-edit');
    columns.push({
      key,
      label: textIn(th),
      head,
      type,
      sortable: Boolean(button) || th.hasAttribute('data-ds-datagrid-sort'),
      resizable: locked ? false : undefined,
      reorderable: locked ? false : undefined,
      hideable: locked ? false : undefined,
      hidden: th.hidden,
      className: [...th.classList].join(' '),
      summary: th.getAttribute('data-ds-datagrid-summary') || undefined,
      edit: editAttr === null ? undefined : editAttr || true,
      declared: true,
    });
    const dir = th.getAttribute('aria-sort');
    if (dir === 'ascending' || dir === 'descending') sort.push({ key, dir });
  }
  const rows = [];
  const expanded = [];
  const selected = [];
  for (const [index, tr] of Array.from(table.tBodies[0]?.rows ?? []).entries()) {
    if (tr.classList.contains('ds-table__detail')) continue;
    const key = tr.getAttribute('data-ds-key') || `r${index}`;
    const row = { [CELLS]: { cells: {}, detail: null, parent: tr.getAttribute('data-ds-datagrid-parent'), className: [...tr.classList].filter((name) => name !== 'ds-table__row--selected').join(' ') }, __key: key };
    Array.from(tr.cells).forEach((cell, at) => {
      const column = columns[at];
      if (!column) return;
      const value = cell.hasAttribute('data-value') ? cell.getAttribute('data-value') : textIn(cell);
      row[column.key] = column.type === 'number' ? (value === '' ? null : Number(String(value).replace(/[^\d.eE+-]/g, ''))) : value;
      row[CELLS].cells[column.key] = { html: cell.innerHTML, className: [...cell.classList].join(' ') };
    });
    const next = tr.nextElementSibling;
    if (next?.classList.contains('ds-table__detail')) {
      row[CELLS].detail = next.querySelector('.ds-table__expand > *')?.innerHTML ?? next.cells[0]?.innerHTML ?? '';
      if (tr.querySelector('.ds-table__toggle[aria-expanded="true"]')) expanded.push(key);
    }
    if (tr.getAttribute('aria-expanded') === 'true') expanded.push(key);
    if (tr.classList.contains('ds-table__row--selected') || tr.getAttribute('aria-selected') === 'true') selected.push(key);
    rows.push(row);
  }
  // Tree rows by data-ds-datagrid-parent: the children go under their parent, in order.
  const byKey = new Map(rows.map((row) => [row.__key, row]));
  const roots = [];
  let tree = false;
  for (const row of rows) {
    const parent = row[CELLS].parent ? byKey.get(row[CELLS].parent) : null;
    if (parent) {
      tree = true;
      (parent.__children ??= []).push(row);
    } else roots.push(row);
  }
  return { columns, rows: tree ? roots : rows, sort, expanded, selected, tree };
}

/** Reads the grid's options from data-ds-config (JSON); a bad value is reported and ignored. */
function readConfig(table) {
  const text = table.getAttribute('data-ds-config');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : {};
  } catch (error) {
    globalThis.console?.warn?.(`DS.datagrid: data-ds-config is no JSON object (${error.message})`);
    return {};
  }
}

const elementOf = (table, value) => {
  if (!value) return null;
  if (typeof value !== 'string') return value?.nodeType === 1 ? value : null;
  const root = table.getRootNode?.() ?? table.ownerDocument;
  try {
    return root.querySelector?.(value) ?? table.ownerDocument.querySelector(value);
  } catch {
    return null;
  }
};

/* ── The controller ─────────────────────────────────── */

/**
 * The grid of a table: the same controller that data-ds-datagrid makes (a
 * second call returns it, and passes `options` to set()).
 * @param {HTMLTableElement} table
 * @param {any} [options]
 * @returns {any}
 */
export function create(table, options = {}) {
  if (!table?.ownerDocument || table.localName !== 'table') throw new TypeError('DS.datagrid.create: a <table> element');
  const existing = instances.get(table);
  if (existing) {
    if (options && Object.keys(options).length) existing.set(options);
    return existing;
  }
  const controller = makeGrid(table, options);
  instances.set(table, controller);
  return controller;
}

function makeGrid(table, input) {
  const doc = table.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const abort = new AbortController();
  const signal = abort.signal;
  const listeners = new Map();
  gridCount += 1;
  const uid = `ds-datagrid-${gridCount}`;

  // Declarative markup unless the page gives data.
  const markup = !input.rows && typeof input.source !== 'function' && !input.columns ? readTable(table) : null;
  const options = { ...input };
  if (markup) {
    options.columns = markup.columns;
    options.rows = markup.rows;
    options.key = (row) => row.__key;
    if (markup.tree && !options.tree) options.tree = { children: '__children' };
    if (!options.detail && markup.rows.some((row) => row[CELLS].detail !== null)) options.detail = (row) => row[CELLS].detail ?? '';
  }
  const server = typeof options.source === 'function';
  const keyOf = keyFn(options.key);
  const detailOf = typeof options.detail === 'function' ? options.detail : null;
  const treeOn = Boolean(options.tree);
  const groupKey = () => (typeof state.group === 'string' ? state.group : state.group?.by ?? null);
  const multiple = options.select === 'multiple' || options.select === true;
  const selecting = multiple || options.select === 'single';

  const state = {
    columns: (options.columns ?? []).map(normalizeColumn),
    order: [],
    hidden: new Set(),
    widths: new Map(),
    sort: normalizeSort(options.sort ?? markup?.sort),
    filter: options.filter ?? null,
    page: options.page ? { index: Math.max(0, options.page.index ?? 0), size: Math.max(1, options.page.size ?? 50) } : null,
    group: options.group ?? null,
    selection: { keys: new Set((options.selected ?? markup?.selected ?? []).map(String)), all: false, except: new Set() },
    anchor: null,
    expanded: new Set((options.expanded ?? markup?.expanded ?? []).map(String)),
    collapsed: new Set((options.collapsed ?? []).map(String)),
    rows: server ? [] : (options.rows ?? []),
    total: 0,
    serverSummary: null,
    status: server ? 'loading' : 'idle',
    error: null,
    view: { items: [], rows: [], total: 0, filtered: [] },
    items: [],
    focus: options.focus === 'row' || options.focus === 'cell' ? options.focus : (treeOn || options.group) && options.focus !== false ? 'row' : null,
    active: { index: 0, col: 0, header: false },
    inside: null,
    editing: null,
    menuKey: null,
    layout: 'auto',
  };
  const defaults = { order: state.columns.map((column) => column.key), hidden: new Set(state.columns.filter((column) => column.hidden).map((column) => column.key)) };
  state.order = [...defaults.order];
  state.hidden = new Set(defaults.hidden);
  /** The columns a person or the page sized: only their widths are remembered and reported (the rest are measured). */
  const sized = new Set();
  for (const column of state.columns) {
    if (!column.width) continue;
    state.widths.set(column.key, column.width);
    sized.add(column.key);
  }
  const sizedWidths = () => Object.fromEntries([...state.widths].filter(([key]) => sized.has(key)));

  const byKey = (key) => state.columns.find((column) => column.key === key) ?? null;
  const locale = () => config().locale ?? undefined;
  const can = (column, what) => {
    if (column[what] === false) return false;
    if (what === 'sortable') return column.sortable === true || (column.sortable === null && options.sortable === true);
    if (what === 'resizable') return Boolean(options.resize) && column.resizable !== false;
    if (what === 'reorderable') return Boolean(options.reorder) && column.reorderable !== false && !pinned(column);
    if (what === 'hideable') return Boolean(options.chooser) && column.hideable !== false;
    return true;
  };
  /** A pinned first or last column keeps its place. */
  const pinned = (column) => {
    const shown = visibleColumns();
    return (table.classList.contains('ds-table--pin-first') && shown[0] === column) || (table.classList.contains('ds-table--pin-last') && shown.at(-1) === column);
  };
  const visibleColumns = () => state.order.map(byKey).filter((column) => column && !state.hidden.has(column.key));
  const rowLabel = (row) => {
    if (typeof options.label === 'function') return String(options.label(row));
    const column = visibleColumns()[0] ?? state.columns[0];
    return column ? textOf(column, row, locale()) : '';
  };
  const systemBefore = () => (selecting ? 1 : 0) + (detailOf ? 1 : 0);
  const hasActions = () => typeof options.actions === 'function';
  const columnCount = () => systemBefore() + visibleColumns().length + (hasActions() ? 1 : 0);

  /* Preferences (DS.store). */
  const prefs = options.persist ? openStore(String(options.persist).replace(/:/g, '-')) : null;
  if (prefs) {
    const saved = prefs.get('columns', null);
    if (isObject(saved)) {
      const known = new Set(defaults.order);
      if (Array.isArray(saved.order)) {
        const kept = saved.order.filter((key) => known.has(key));
        state.order = [...kept, ...defaults.order.filter((key) => !kept.includes(key))];
      }
      if (Array.isArray(saved.hidden)) state.hidden = new Set(saved.hidden.filter((key) => known.has(key)));
    }
    const widths = prefs.get('widths', null);
    if (isObject(widths)) {
      for (const [key, width] of Object.entries(widths)) {
        if (!byKey(key) || !Number.isFinite(width)) continue;
        state.widths.set(key, width);
        sized.add(key);
      }
    }
    const sort = prefs.get('sort', null);
    if (Array.isArray(sort)) state.sort = normalizeSort(sort).filter((entry) => byKey(entry.key));
    const size = prefs.get('size', null);
    if (state.page && Number.isFinite(size) && size > 0) state.page.size = size;
  }
  const saveColumns = () => {
    prefs?.set('columns', { order: state.order, hidden: [...state.hidden] });
    prefs?.set('widths', sizedWidths());
  };

  /* Events. */
  const fire = (type, detail, cancelable = false) => {
    const go = emit(table, type, detail, { cancelable });
    for (const fn of listeners.get(type) ?? []) {
      try {
        fn(detail);
      } catch (error) {
        globalThis.reportError?.(error);
      }
    }
    return go;
  };

  /* ── The parts ───────────────────────────────────── */

  const head = table.tHead ?? table.createTHead();
  const body = table.tBodies[0] ?? table.createTBody();
  let foot = null;
  let footMine = false;
  /** The page's own summary row, given back on destroy. */
  let footBefore = null;
  /**
   * The page's header and body rows the grid read its columns and rows
   * from: given back on destroy, so destroy() and a new init read the same
   * markup again (a re-created controller, React's StrictMode).
   */
  const markupBefore = markup ? { head: Array.from(head.childNodes, (node) => node.cloneNode(true)), body: Array.from(body.childNodes, (node) => node.cloneNode(true)) } : null;
  const wrap = table.parentElement?.closest('.ds-table-wrap') ?? table.parentElement;

  // What the grid writes on the table: owned, so a morph of the page keeps it; given back on destroy.
  const written = new Map();
  const write = (element, name, value) => {
    if (!written.has(element)) written.set(element, new Map());
    const mine = written.get(element);
    if (!mine.has(name)) {
      mine.set(name, element.getAttribute(name));
      own(element, 'attrs', name);
    }
    if (value === null) element.removeAttribute(name);
    else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  const giveBack = () => {
    for (const [element, names] of written) {
      for (const [name, before] of names) {
        if (before === null) element.removeAttribute(name);
        else element.setAttribute(name, before);
        disown(element, 'attrs', name);
      }
    }
    written.clear();
  };

  const role = () => (state.focus ? (treeOn || groupKey() ? 'treegrid' : 'grid') : null);

  /* ── The view ────────────────────────────────────── */

  const compute = () => {
    const columns = state.columns;
    if (server) {
      const rows = state.rows;
      const groupBy = groupKey();
      const result = groupBy || treeOn
        ? query(rows, { columns, key: keyOf, tree: options.tree, expanded: state.expanded, group: state.group, collapsed: state.collapsed, locale: locale() })
        : { items: rows.map((row, at) => ({ kind: 'row', row, key: keyOf(row, at), level: 1, setsize: state.total, posinset: (state.page ? state.page.index * state.page.size : 0) + at + 1, parent: null, expanded: null, children: 0 })), rows, total: state.total, filtered: rows };
      result.total = state.total;
      state.view = result;
    } else {
      state.view = query(state.rows, { columns, sort: state.sort, filter: state.filter, page: state.page, key: keyOf, tree: options.tree, expanded: state.expanded, group: state.group, collapsed: state.collapsed, locale: locale() });
      state.total = state.view.total;
    }
    // A page past the end (rows went): back to the last one.
    if (state.page && !server && state.page.index > 0 && state.page.index * state.page.size >= state.total) {
      state.page.index = Math.max(0, Math.ceil(state.total / state.page.size) - 1);
      return compute();
    }
    const items = [];
    for (const item of state.view.items) {
      items.push(item);
      if (item.kind === 'row' && detailOf && (!options.virtual || state.expanded.has(item.key))) items.push({ kind: 'detail', row: item.row, key: item.key, level: item.level });
    }
    if (!items.length) items.push({ kind: 'state', key: 'state' });
    state.items = items;
  };

  /* ── Markup ──────────────────────────────────────── */

  const sortEntry = (key) => state.sort.find((entry) => entry.key === key) ?? null;
  const sortRank = (key) => state.sort.findIndex((entry) => entry.key === key);
  const isSelected = (key) => (state.selection.all ? !state.selection.except.has(key) : state.selection.keys.has(key));
  const pageKeys = () => state.view.items.filter((item) => item.kind === 'row').map((item) => item.key);
  const cellTab = () => (state.focus === 'cell' ? ' tabindex="-1"' : '');
  const widthStyle = (column) => {
    const width = state.widths.get(column.key);
    return state.layout === 'fixed' && width ? ` style="width:${width}px"` : '';
  };
  /** A system column's width once the layout is fixed (measured by freeze()). */
  const systemStyle = (key) => {
    const width = systemWidths.get(key);
    return state.layout === 'fixed' && width ? ` style="width:${width}px"` : '';
  };

  /** The id of a header's label, which names the header cell. */
  const headId = (key) => `${uid}-h-${String(key).replace(/[^\w-]/g, '_')}`;
  /** The widths of the columns as laid out (no width set), for their separators' values. */
  const measured = new Map();

  const headHtml = () => {
    let html = '<tr data-ds-key="head">';
    if (selecting) {
      const keys = pageKeys();
      const count = keys.filter(isSelected).length;
      const all = keys.length > 0 && count === keys.length;
      html += `<th scope="col" class="ds-datagrid__select" data-ds-key="ds:select"${systemStyle('ds:select')}${cellTab()}>`;
      html += multiple ? `<input type="checkbox" aria-label="${esc(t('datagridSelectAll'))}" data-ds-datagrid-all${all ? ' checked' : ''}${keys.length ? '' : ' disabled'}>` : `<span class="ds-sr">${esc(t('datagridSelect'))}</span>`;
      html += '</th>';
    }
    if (detailOf) html += `<th scope="col" class="ds-datagrid__toggle" data-ds-key="ds:detail"${systemStyle('ds:detail')}${cellTab()}><span class="ds-sr">${esc(t('datagridDetails'))}</span></th>`;
    const shown = visibleColumns();
    for (const column of shown) {
      const entry = sortEntry(column.key);
      const rank = sortRank(column.key);
      const primary = rank === 0;
      const sortable = can(column, 'sortable');
      const attrs = [`scope="col"`, `data-ds-key="c:${esc(column.key)}"`, `data-ds-datagrid-col="${esc(column.key)}"`];
      const cls = [column.headClass ?? column.className].filter(Boolean).join(' ');
      if (cls) attrs.push(`class="${esc(cls)}"`);
      if (entry && primary) attrs.push(`aria-sort="${entry.dir}"`);
      if (entry) attrs.push(`data-ds-datagrid-dir="${entry.dir}"`);
      let inner = '';
      const label = column.head ?? esc(column.label);
      const grip = can(column, 'reorderable');
      const resizable = can(column, 'resizable');
      // A grip or a separator would join the header's name (taken from its content): the label names it alone.
      const named = grip || resizable ? headId(column.key) : null;
      if (named) attrs.push(`aria-labelledby="${named}"`);
      const labelId = named ? ` id="${named}"` : '';
      if (grip) inner += `<button class="ds-grip ds-datagrid__grip" type="button" aria-label="${esc(t('datagridMove', { column: column.label }))}">${icon(gripHorizontal, 16)}</button>`;
      if (sortable) {
        let extra = '';
        if (entry) extra += icon(arrowUp, 16, 'ds-table__sort-arrow');
        if (entry && state.sort.length > 1) extra += `<span class="ds-datagrid__rank" aria-hidden="true">${rank + 1}</span>`;
        if (entry && !primary) extra += `<span class="ds-sr">${esc(t('datagridSortRank', { rank: rank + 1, direction: t(entry.dir === 'descending' ? 'datagridDescending' : 'datagridAscending') }))}</span>`;
        inner += `<button class="ds-table__sort" type="button"${labelId} data-ds-datagrid-sort>${label}${extra}</button>`;
      } else inner += named ? `<span${labelId}>${label}</span>` : label;
      if (resizable) {
        // Its value: the width set, else the one measured after the last render (syncSeparators()).
        const width = Math.round(state.widths.get(column.key) ?? measured.get(column.key) ?? 0);
        inner += `<span class="ds-datagrid__resize" role="separator" aria-orientation="vertical" aria-label="${esc(t('datagridResize', { column: column.label }))}" aria-valuemin="${column.minWidth}" aria-valuemax="${column.maxWidth}"${width ? ` aria-valuenow="${width}"` : ''} tabindex="${state.focus === 'cell' ? '-1' : '0'}"></span>`;
      }
      html += `<th ${attrs.join(' ')}${widthStyle(column)}${cellTab()}>${inner}</th>`;
    }
    if (hasActions()) html += `<th scope="col" class="ds-datagrid__actions" data-ds-key="ds:actions"${systemStyle('ds:actions')}${cellTab()}><span class="ds-sr">${esc(t('datagridActions'))}</span></th>`;
    return `${html}</tr>`;
  };

  const editorHtml = (column, row) => {
    const editing = state.editing;
    const value = editing.draft ?? valueOf(column, row);
    const name = esc(`${column.label}, ${rowLabel(row)}`);
    const invalid = editing.error ? ` aria-invalid="true" aria-describedby="${uid}-error"` : '';
    let field;
    if (column.edit.type === 'select') {
      const choices = (column.edit.options ?? []).map((choice) => (isObject(choice) ? choice : { value: choice, label: choice }));
      field = `<select class="ds-input ds-datagrid__editor" aria-label="${name}" data-ds-datagrid-editor${invalid}>${choices.map((choice) => `<option value="${esc(choice.value)}"${String(choice.value) === String(value ?? '') ? ' selected' : ''}>${esc(choice.label ?? choice.value)}</option>`).join('')}</select>`;
    } else {
      const type = column.edit.type === 'number' ? 'text" inputmode="decimal' : 'text';
      // size="1": the field fills its cell and never widens the column (its default size would).
      field = `<input class="ds-input ds-datagrid__editor" type="${type}" size="1" aria-label="${name}" value="${esc(value ?? '')}" data-ds-datagrid-editor autocomplete="off"${invalid}>`;
    }
    const message = editing.error ? `<span class="ds-datagrid__message" id="${uid}-error" role="alert">${icon(alertCircle, 16)}<span>${esc(editing.error)}</span></span>` : '';
    return `<span class="ds-datagrid__field">${field}${message}</span>`;
  };

  const cellHtml = (column, row, item, first) => {
    const cells = row?.[CELLS];
    const own = cells?.cells?.[column.key];
    const editing = state.editing && state.editing.key === item.key && state.editing.col === column.key;
    let content;
    if (editing) content = editorHtml(column, row);
    else if (typeof column.render === 'function') content = String(column.render(row, column) ?? '');
    else if (own) content = own.html;
    else content = esc(textOf(column, row, locale()));
    if (first && treeOn && !editing) {
      const twist = item.expanded === null
        ? '<span class="ds-datagrid__twist-room" aria-hidden="true"></span>'
        : `<button class="ds-btn ds-btn--quiet ds-btn--icon ds-table__toggle ds-datagrid__twist" type="button"${state.focus ? ' tabindex="-1"' : ''} aria-expanded="${item.expanded}" aria-label="${esc(t(item.expanded ? 'collapse' : 'expand'))} ${esc(rowLabel(row))}" data-ds-datagrid-twist>${icon(chevronRight, 20, 'ds-datagrid__chevron')}</button>`;
      content = `<span class="ds-datagrid__tree" style="--ds-datagrid-level:${item.level - 1}">${twist}<span class="ds-datagrid__label">${content}</span></span>`;
    }
    const cls = [column.className, own?.className, column.edit && !editing ? 'ds-datagrid__editable' : '', editing ? 'ds-datagrid__editing' : ''].filter(Boolean).join(' ');
    const classes = cls ? ` class="${esc([...new Set(cls.split(/\s+/))].join(' '))}"` : '';
    const editable = column.edit && options.edit !== false;
    const tab = editable && !state.focus ? ' tabindex="0"' : cellTab();
    return `<td data-ds-key="c:${esc(column.key)}"${classes} data-label="${esc(column.label)}"${editable ? ' data-ds-datagrid-edit' : ''}${tab}>${content}</td>`;
  };

  const detailId = (key) => `${uid}-d-${String(key).replace(/[^\w-]/g, '_')}`;

  const rowHtml = (item, index) => {
    if (item.kind === 'state') return stateHtml();
    if (item.kind === 'group') return groupHtml(item, index);
    if (item.kind === 'detail') {
      const open = state.expanded.has(item.key);
      return `<tr class="ds-table__detail" id="${detailId(item.key)}" data-ds-key="d:${esc(item.key)}"${open ? '' : ' inert'}><td colspan="${columnCount()}"${cellTab()}><div class="ds-table__expand"><div>${String(detailOf(item.row) ?? '')}</div></div></td></tr>`;
    }
    const row = item.row;
    const key = item.key;
    const selected = selecting && isSelected(key);
    const attrs = [`data-ds-key="r:${esc(key)}"`, `data-ds-datagrid-row="${esc(key)}"`];
    const cls = [row?.[CELLS]?.className, typeof options.rowClass === 'function' ? options.rowClass(row) : '', selected ? 'ds-table__row--selected' : ''].filter(Boolean).join(' ');
    if (cls) attrs.push(`class="${esc(cls)}"`);
    if (state.focus && selecting) attrs.push(`aria-selected="${selected}"`);
    if (role() === 'treegrid') {
      attrs.push(`aria-level="${item.level}"`, `aria-setsize="${item.setsize}"`, `aria-posinset="${item.posinset}"`);
      if (item.expanded !== null) attrs.push(`aria-expanded="${item.expanded}"`);
    }
    if (state.focus === 'row') attrs.push('tabindex="-1"');
    let html = `<tr ${attrs.join(' ')}>`;
    if (selecting) {
      // One row at a time is a radio's meaning: a set of radios, one per row.
      const input = multiple ? 'type="checkbox"' : `type="radio" class="ds-radio-input" name="${uid}-select"`;
      html += `<td class="ds-datagrid__select"${cellTab()}><input ${input} aria-label="${esc(t('datagridSelectRow', { label: rowLabel(row) }))}" data-ds-datagrid-check${selected ? ' checked' : ''}></td>`;
    }
    if (detailOf) {
      const open = state.expanded.has(key);
      html += `<td class="ds-datagrid__toggle"${cellTab()}><button class="ds-btn ds-btn--quiet ds-btn--icon ds-table__toggle" type="button" aria-expanded="${open}" aria-controls="${detailId(key)}" aria-label="${esc(t('datagridDetailsOf', { label: rowLabel(row) }))}" data-ds-datagrid-detail>${icon(chevronDown, 20, 'ds-chevron')}</button></td>`;
    }
    visibleColumns().forEach((column, at) => {
      html += cellHtml(column, row, item, at === 0);
    });
    if (hasActions()) html += `<td class="ds-table__actions"${cellTab()}>${String(options.actions(row) ?? '')}</td>`;
    return `${html}</tr>`;
  };

  /** The label cell of a group or summary row spans the columns before the first one with a figure. */
  const spanBefore = (figures) => {
    const shown = visibleColumns();
    let lead = shown.findIndex((column) => figures.has(column.key));
    if (lead < 0) lead = shown.length;
    return { span: Math.max(1, systemBefore() + lead), skip: Math.max(0, 1 - systemBefore() - lead) + lead };
  };

  /** A summary figure as text: the column's summaryFormat, else its format of the rounded figure, else Intl. */
  const summaryText = (column, value) => {
    if (value === null || value === undefined) return '';
    if (typeof column.summaryFormat === 'function') return String(column.summaryFormat(value));
    if (typeof value !== 'number') return String(value);
    const rounded = Math.round(value * (column.summary === 'avg' ? 10 : 100)) / (column.summary === 'avg' ? 10 : 100);
    if (typeof column.format === 'function') return String(column.format(rounded, null) ?? '');
    return number(rounded, { locale: locale(), maximumFractionDigits: 2 });
  };

  const summaryCells = (rows, given, skip) => {
    let html = '';
    visibleColumns().forEach((column, at) => {
      if (at < skip) return;
      const value = given ? given[column.key] : summary(rows, column);
      const text = summaryText(column, value);
      html += `<td data-ds-key="c:${esc(column.key)}"${column.className ? ` class="${esc(column.className)}"` : ''} data-label="${esc(column.label)}"${cellTab()}>${esc(text)}</td>`;
    });
    if (hasActions()) html += `<td${cellTab()}></td>`;
    return html;
  };

  const groupHtml = (item) => {
    const figures = new Set(state.columns.filter((column) => column.summary).map((column) => column.key));
    const { span, skip } = spanBefore(figures);
    const open = item.expanded;
    const attrs = [`class="ds-datagrid__group"`, `data-ds-key="g:${esc(item.key)}"`, `data-ds-datagrid-group="${esc(item.key)}"`];
    if (role() === 'treegrid') attrs.push(`aria-level="1"`, `aria-setsize="${item.setsize}"`, `aria-posinset="${item.posinset}"`, `aria-expanded="${open}"`);
    if (state.focus === 'row') attrs.push('tabindex="-1"');
    const label = item.group.label || t('datagridNoValue');
    const count = plural(item.children, { one: t('datagridRowsOne'), other: t('datagridRowsOther') }, { locale: locale() });
    const toggle = `<button class="ds-btn ds-btn--quiet ds-btn--icon ds-table__toggle ds-datagrid__twist" type="button"${state.focus ? ' tabindex="-1"' : ''} aria-expanded="${open}" aria-label="${esc(t(open ? 'collapse' : 'expand'))} ${esc(label)}" data-ds-datagrid-twist>${icon(chevronRight, 20, 'ds-datagrid__chevron')}</button>`;
    return `<tr ${attrs.join(' ')}><th scope="row" colspan="${span}"${cellTab()}><span class="ds-datagrid__tree">${toggle}<span class="ds-datagrid__label">${esc(label)} <span class="ds-datagrid__count">${esc(count)}</span></span></span></th>${summaryCells(item.group.rows, null, skip)}</tr>`;
  };

  const templateOf = (name) => {
    const host = wrap ?? table.parentElement;
    const found = host?.querySelector?.(`:scope > template[data-ds-datagrid-state="${name}"]`);
    return found ? found.innerHTML : null;
  };

  const stateHtml = () => {
    const span = columnCount();
    let inner;
    if (state.status === 'loading') {
      inner = templateOf('loading') ?? `<div class="ds-loading" role="status"><span class="ds-loader ds-sm" aria-hidden="true"></span>${esc(options.loadingText ?? t('loading'))}</div>`;
    } else if (state.status === 'error') {
      inner = templateOf('error') ?? `<div class="ds-empty ds-empty--inline ds-empty--error" role="alert"><span class="ds-empty__disc" aria-hidden="true">${icon(alertCircle, 16)}</span><p class="ds-empty__title">${esc(options.errorText ?? t('datagridError'))}</p><button class="ds-btn ds-btn--text" type="button" data-ds-datagrid-command="retry">${esc(t('datagridRetry'))}</button></div>`;
    } else if (state.filter !== null && state.filter !== '' && state.filter !== undefined) {
      inner = templateOf('no-results') ?? `<div class="ds-empty ds-empty--inline ds-empty--no-results"><span class="ds-empty__disc" aria-hidden="true">${icon(search, 16)}</span><p class="ds-empty__title">${esc(t('noResults'))}</p><p class="ds-empty__text">${esc(t('datagridNoResultsText'))}</p></div>`;
    } else {
      inner = templateOf('empty') ?? `<div class="ds-empty ds-empty--inline ds-empty--no-data"><span class="ds-empty__disc" aria-hidden="true">${icon(box, 16)}</span><p class="ds-empty__title">${esc(options.emptyText ?? t('datagridEmpty'))}</p></div>`;
    }
    return `<tr class="ds-datagrid__state" data-ds-key="ds:state"><td colspan="${span}">${inner}</td></tr>`;
  };

  const footHtml = () => {
    const figures = new Set(state.columns.filter((column) => column.summary).map((column) => column.key));
    if (!figures.size || options.foot === false) return null;
    const { span, skip } = spanBefore(figures);
    const rows = server ? [] : state.view.filtered;
    const given = server ? state.serverSummary ?? {} : null;
    return `<tr data-ds-key="foot"><th scope="row" colspan="${span}"${cellTab()}>${esc(options.footLabel ?? t('datagridTotal'))}</th>${summaryCells(rows, given, skip)}</tr>`;
  };

  /* ── Render ──────────────────────────────────────── */

  let windowed = null;
  let rendering = false;
  /** Whether the view was computed once (render({ keep }) needs it). */
  let computed = false;
  /** Rows that carry an aria-rowindex of the grid's (paged data). */
  const indexed = new WeakSet();

  const renderHead = () => morphHtml(head, headHtml());

  const renderFoot = () => {
    const html = footHtml();
    if (html === null) {
      if (foot && footMine) {
        foot.remove();
        foot = null;
        footMine = false;
      }
      return;
    }
    if (!foot) {
      foot = table.tFoot;
      if (foot) footMine = false;
      else {
        foot = table.createTFoot();
        footMine = true;
      }
      // The page's own summary row gives way to the grid's: it is kept and put back on destroy.
      if (!footMine) {
        footBefore = Array.from(foot.childNodes, (node) => node.cloneNode(true));
      }
    }
    morphHtml(foot, html);
  };

  const decorate = () => {
    // The table's own attributes: role, multiselectable, busy, the layout.
    write(table, 'role', role());
    write(table, 'aria-multiselectable', state.focus && multiple ? 'true' : null);
    write(table, 'aria-busy', state.status === 'loading' ? 'true' : null);
    write(table, 'data-ds-datagrid-layout', state.layout === 'fixed' ? 'fixed' : null);
    if (state.layout === 'fixed') table.style.setProperty('--ds-datagrid-width', `${tableWidth()}px`);
    else table.style.removeProperty('--ds-datagrid-width');
    // DS.virtual tells the count of windowed rows itself.
    if ((state.page || server) && !windowed) write(table, 'aria-rowcount', String(state.total + 1 + (foot ? 1 : 0)));
    // A refresh with rows on screen: they dim (after the loader delay) while the new ones come.
    const stale = state.status === 'loading' && state.items[0]?.kind !== 'state';
    if (stale !== body.classList.contains('ds-stale')) {
      if (stale) {
        own(body, 'classes', 'ds-stale');
        body.classList.add('ds-stale');
      } else {
        body.classList.remove('ds-stale');
        disown(body, 'classes', 'ds-stale');
      }
    }
    // The header's mixed box is a property, not markup.
    const all = head.querySelector('[data-ds-datagrid-all]');
    if (all) {
      const keys = pageKeys();
      const count = keys.filter(isSelected).length;
      all.indeterminate = count > 0 && count < keys.length;
    }
    syncSeparators();
    if (state.focus) rove();
    syncBar();
    syncPager();
    syncChooser();
  };

  /**
   * A focusable separator needs its value from the start: a column with no
   * width set reports the width it is laid out at (measured after each
   * render, whenever its header cell changes size, and on focus).
   */
  const watched = new WeakSet();
  const sizes = typeof view.ResizeObserver === 'function'
    ? new view.ResizeObserver((entries) => {
      for (const entry of entries) {
        const handle = entry.target.querySelector(':scope > .ds-datagrid__resize');
        if (handle) syncSeparator(handle);
      }
    })
    : null;
  const syncSeparators = () => {
    for (const handle of head.querySelectorAll('.ds-datagrid__resize')) {
      syncSeparator(handle);
      const th = handle.parentElement;
      if (sizes && !watched.has(th)) {
        watched.add(th);
        sizes.observe(th);
      }
    }
  };
  const syncSeparator = (handle) => {
    const th = handle.closest('th');
    const key = th?.getAttribute('data-ds-datagrid-col');
    if (!key || state.widths.has(key)) return;
    const width = Math.round(th.getBoundingClientRect?.().width ?? 0);
    if (width <= 0) return;
    measured.set(key, width);
    if (handle.getAttribute('aria-valuenow') !== String(width)) handle.setAttribute('aria-valuenow', String(width));
  };

  /**
   * Renders everything; `glide` (a user's sort or filter) moves the rows
   * through DS.motion.flip. `keep`: the view is as it was (a selection or the
   * columns changed), so the pipeline does not run again: with ten thousand
   * rows a checkbox would take as long as a sort.
   */
  const render = ({ glide = false, keep = false } = {}) => {
    if (signal.aborted) return;
    rendering = true;
    try {
      const again = !keep || !computed;
      if (again) compute();
      computed = true;
      renderHead();
      renderFoot();
      if (options.virtual) {
        ensureWindow();
        if (again) windowed.set({ count: state.items.length, total: state.page || server ? state.total : null, forget: true });
        windowed.refresh();
      } else {
        const html = state.items.map((item, index) => rowHtml(item, index)).join('');
        if (glide) flip(body, (morph) => morphHtml(body, html, morph), { items: ':scope > tr' });
        else morphHtml(body, html);
      }
      if (state.page || server) {
        const offset = state.page ? state.page.index * state.page.size : 0;
        if (!windowed) {
          let at = 0;
          for (const tr of body.rows) {
            if (tr.classList.contains('ds-table__detail') || tr.classList.contains('ds-datagrid__state')) continue;
            at += 1;
            if (!indexed.has(tr)) {
              indexed.add(tr);
              own(tr, 'attrs', 'aria-rowindex');
            }
            tr.setAttribute('aria-rowindex', String(offset + at + 1));
          }
        }
      }
      decorate();
    } finally {
      rendering = false;
    }
  };

  const ensureWindow = () => {
    if (windowed) return;
    const scroller = wrap ?? table.parentElement;
    const config = isObject(options.virtual) ? options.virtual : {};
    windowed = windowRows(scroller, {
      content: body,
      count: state.items.length,
      estimate: config.estimate,
      overscan: config.overscan,
      keyboard: false,
      render: (index) => rowHtml(state.items[index], index),
    });
    // Windowed rows need fixed columns: the automatic layout would size them by the rows that exist.
    view.requestAnimationFrame?.(() => {
      if (!signal.aborted) freeze();
    });
  };

  /** Fixes every column at its current width (before a resize, and for windowed rows). */
  const freeze = () => {
    if (state.layout === 'fixed') return;
    const cells = Array.from(head.rows[0]?.cells ?? []);
    for (const cell of cells) {
      const key = cell.getAttribute('data-ds-datagrid-col');
      const width = cell.getBoundingClientRect().width;
      if (key && width > 0 && !state.widths.has(key)) state.widths.set(key, Math.round(width));
      if (!key && width > 0) systemWidths.set(cell.getAttribute('data-ds-key'), Math.round(width));
    }
    state.layout = 'fixed';
    renderHead();
    decorate();
  };
  const systemWidths = new Map();
  /** The table's width with fixed columns: the columns it shows now (a dropped secondary column takes none). */
  const tableWidth = () => {
    let sum = 0;
    for (const cell of head.rows[0]?.cells ?? []) {
      if (view.getComputedStyle(cell).display === 'none') continue;
      const key = cell.getAttribute('data-ds-datagrid-col');
      sum += key ? state.widths.get(key) ?? cell.getBoundingClientRect().width : systemWidths.get(cell.getAttribute('data-ds-key')) ?? cell.getBoundingClientRect().width;
    }
    return Math.round(sum);
  };

  /* ── Server data ─────────────────────────────────── */

  let loadGen = 0;
  let loading = null;
  const load = async () => {
    if (!server) return;
    const gen = ++loadGen;
    loading?.abort();
    loading = new AbortController();
    const query = { sort: state.sort.map((entry) => ({ ...entry })), filter: state.filter, page: state.page ? { ...state.page } : null };
    state.status = 'loading';
    state.error = null;
    render();
    try {
      const result = await options.source(query, { signal: loading.signal });
      if (gen !== loadGen || signal.aborted) return;
      state.rows = Array.isArray(result) ? result : result?.rows ?? [];
      state.total = Number.isFinite(result?.total) ? result.total : state.rows.length;
      state.serverSummary = result?.summary ?? null;
      state.status = 'idle';
      render();
      fire('load', { rows: state.rows, total: state.total });
    } catch (error) {
      if (gen !== loadGen || signal.aborted || error?.name === 'AbortError') return;
      state.status = 'error';
      state.error = error;
      state.rows = [];
      render();
      // The default error state is an alert itself; a page's own template may not be.
      if (templateOf('error') !== null) announce(options.errorText ?? t('datagridError'), { assertive: true });
      fire('error', { error });
    }
  };
  const refreshData = () => (server ? load() : render());

  /* ── Sort, filter, page ──────────────────────────── */

  const sortBy = (key, { add = false } = {}) => {
    const column = byKey(key);
    if (!column || !can(column, 'sortable')) return;
    const current = sortEntry(key);
    let next;
    if (add && options.multiSort) {
      // Shift: adds the column, turns it, then takes it off.
      if (!current) next = [...state.sort, { key, dir: 'ascending' }];
      else if (current.dir === 'ascending') next = state.sort.map((entry) => (entry.key === key ? { key, dir: 'descending' } : entry));
      else next = state.sort.filter((entry) => entry.key !== key);
    } else {
      const dir = current && sortRank(key) === 0 && current.dir === 'ascending' ? 'descending' : 'ascending';
      next = [{ key, dir }];
    }
    applySort(next);
  };

  const applySort = (next, { quiet = false } = {}) => {
    state.sort = normalizeSort(next).filter((entry) => byKey(entry.key));
    if (state.page) state.page.index = 0;
    prefs?.set('sort', state.sort);
    fire('sort', { sort: state.sort.map((entry) => ({ ...entry })) });
    if (server) load();
    else render({ glide: true });
    if (quiet) return;
    const first = state.sort[0];
    if (!first) announce(t('datagridUnsorted'));
    else announce(t('datagridSorted', { column: byKey(first.key).label, direction: t(first.dir === 'descending' ? 'datagridDescending' : 'datagridAscending') }));
  };

  const applyFilter = (filter) => {
    state.filter = filter;
    if (state.page) state.page.index = 0;
    fire('filter', { filter });
    if (server) {
      load();
      return;
    }
    render({ glide: true });
    announce(plural(state.total, { one: t('datagridRowsOne'), other: t('datagridRowsOther') }, { locale: locale() }));
  };

  const pageCount = () => (state.page ? Math.max(1, Math.ceil(state.total / state.page.size)) : 1);
  const goPage = (index, size) => {
    if (!state.page) return;
    if (size && size !== state.page.size) {
      // The first row on screen stays on screen.
      const first = state.page.index * state.page.size;
      state.page.size = size;
      state.page.index = Math.floor(first / size);
      prefs?.set('size', size);
    } else state.page.index = Math.min(Math.max(0, index), pageCount() - 1);
    fire('page', { index: state.page.index, size: state.page.size, total: state.total, pages: pageCount() });
    if (server) load();
    else render();
    announce(t('datagridPage', { page: number(state.page.index + 1, { locale: locale() }), pages: number(pageCount(), { locale: locale() }) }));
  };

  /* ── Selection ───────────────────────────────────── */

  const selectionDetail = () => {
    const sel = state.selection;
    const count = sel.all ? Math.max(0, state.total - sel.except.size) : sel.keys.size;
    return { count, keys: sel.all ? [] : [...sel.keys], all: sel.all, except: [...sel.except] };
  };
  const selectionChanged = () => {
    render({ keep: true });
    fire('select', selectionDetail());
  };
  const setSelected = (key, on) => {
    const sel = state.selection;
    if (!multiple) {
      sel.all = false;
      sel.except.clear();
      sel.keys = new Set(on ? [key] : []);
      return;
    }
    if (sel.all) {
      if (on) sel.except.delete(key);
      else sel.except.add(key);
    } else if (on) sel.keys.add(key);
    else sel.keys.delete(key);
  };
  const rowKeysInOrder = () => state.items.filter((item) => item.kind === 'row').map((item) => item.key);
  const toggleRow = (key, { range = false, on } = {}) => {
    if (!selecting) return;
    const next = on ?? !isSelected(key);
    if (range && multiple && state.anchor !== null) {
      const keys = rowKeysInOrder();
      const from = keys.indexOf(state.anchor);
      const to = keys.indexOf(key);
      if (from >= 0 && to >= 0) {
        const [low, high] = from < to ? [from, to] : [to, from];
        for (const each of keys.slice(low, high + 1)) setSelected(each, next);
      } else setSelected(key, next);
    } else {
      setSelected(key, next);
      state.anchor = key;
    }
    selectionChanged();
  };
  const selectPage = (on) => {
    for (const key of pageKeys()) setSelected(key, on);
    if (!on && state.selection.all) clearSelection(true);
    else selectionChanged();
  };
  const selectEvery = () => {
    if (!multiple) return;
    state.selection = { keys: new Set(), all: true, except: new Set() };
    selectionChanged();
    announce(t('datagridSelectedEvery', { total: number(state.total, { locale: locale() }) }));
  };
  const clearSelection = (quiet = false) => {
    state.selection = { keys: new Set(), all: false, except: new Set() };
    state.anchor = null;
    selectionChanged();
    if (!quiet) head.querySelector('[data-ds-datagrid-all]')?.focus({ preventScroll: true });
  };

  /* The selection bar: its count, "Select all N" and the swap with the toolbar. */
  const bar = elementOf(table, options.bar);
  /** The slot the bar shares with the toolbar (DS.motion.crossfade()), and the toolbar it stands in for. */
  const slot = bar?.parentElement?.classList.contains('ds-swap') ? bar.parentElement : null;
  const toolbar = slot ? [...slot.children].find((child) => child !== bar) ?? null : null;
  let barShown = bar ? !bar.hidden : false;
  // The bar waits outside its slot until something is selected.
  if (slot && toolbar && bar.hidden) bar.remove();
  let everyButton = null;
  const syncBar = () => {
    if (!bar) return;
    const { count, all, except } = selectionDetail();
    const counter = bar.querySelector('.ds-selection-bar__count');
    const total = number(state.total, { locale: locale() });
    // Every row, but some unchecked since: the count says how many are left.
    const text = all && !except.length ? t('datagridSelectedEvery', { total }) : t('datagridSelected', { count: number(count, { locale: locale() }) });
    if (counter && counter.textContent !== text) counter.textContent = text;
    // The whole page is selected and more rows exist: offer them all.
    const keys = pageKeys();
    const offer = multiple && !all && keys.length > 0 && keys.every(isSelected) && state.total > keys.length;
    if (offer) {
      if (!everyButton) {
        everyButton = doc.createElement('button');
        everyButton.type = 'button';
        everyButton.className = 'ds-link-btn ds-datagrid__every';
        everyButton.setAttribute('data-ds-datagrid-command', 'every');
      }
      everyButton.textContent = t('datagridSelectEvery', { total });
      if (!everyButton.isConnected) {
        if (counter) counter.after(everyButton);
        else bar.append(everyButton);
      }
    } else everyButton?.remove();
    const show = count > 0;
    if (show === barShown) return;
    barShown = show;
    const focusInBar = bar.contains(doc.activeElement);
    if (slot && toolbar) {
      bar.hidden = false;
      crossfade(slot, show ? bar : toolbar);
    } else bar.hidden = !show;
    if (!show && focusInBar) head.querySelector('[data-ds-datagrid-all]')?.focus({ preventScroll: true });
  };

  /* The pager: buttons with data-ds-datagrid-page, the range, the size select. */
  const pager = elementOf(table, options.pager);
  const syncPager = () => {
    if (!pager || !state.page) return;
    const pages = pageCount();
    const index = state.page.index;
    for (const button of pager.querySelectorAll('[data-ds-datagrid-page]')) {
      const to = button.getAttribute('data-ds-datagrid-page');
      const blocked = (to === 'first' || to === 'previous') ? index <= 0 : (to === 'next' || to === 'last') ? index >= pages - 1 : false;
      if (blocked) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
    const range = pager.querySelector('.ds-pagination__range');
    if (range) {
      const from = state.total ? index * state.page.size + 1 : 0;
      const to = Math.min(state.total, (index + 1) * state.page.size);
      const text = t('datagridRange', { from: number(from, { locale: locale() }), to: number(to, { locale: locale() }), total: number(state.total, { locale: locale() }) });
      if (range.textContent !== text) range.textContent = text;
    }
    const size = pager.querySelector('select[data-ds-datagrid-size]');
    if (size && size.value !== String(state.page.size)) size.value = String(state.page.size);
  };
  if (pager) {
    pager.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-ds-datagrid-page]');
      if (!button || button.getAttribute('aria-disabled') === 'true') return;
      const to = button.getAttribute('data-ds-datagrid-page');
      const index = state.page?.index ?? 0;
      goPage({ first: 0, previous: index - 1, next: index + 1, last: pageCount() - 1 }[to] ?? Number(to) - 1);
    }, { signal });
    pager.addEventListener('change', (event) => {
      if (!event.target.matches?.('select[data-ds-datagrid-size]')) return;
      goPage(0, Number(event.target.value));
    }, { signal });
  }

  /* ── Columns: chooser, presets, reorder, resize ──── */

  const presets = () => {
    const list = [
      { id: 'default', label: t('datagridPresetDefault'), order: defaults.order, hidden: [...defaults.hidden] },
      { id: 'all', label: t('datagridPresetAll'), order: defaults.order, hidden: [] },
    ];
    for (const preset of options.presets ?? []) {
      if (!preset || !Array.isArray(preset.columns)) continue;
      const shown = preset.columns.map(String).filter(byKey);
      list.push({ id: String(preset.id ?? preset.label), label: String(preset.label ?? preset.id), order: [...shown, ...defaults.order.filter((key) => !shown.includes(key))], hidden: defaults.order.filter((key) => !shown.includes(key)) });
    }
    return list;
  };
  const presetMatches = (preset) => {
    const shownNow = visibleColumns().map((column) => column.key);
    const shownThen = preset.order.filter((key) => !preset.hidden.includes(key));
    return shownNow.length === shownThen.length && shownNow.every((key, at) => key === shownThen[at]);
  };

  const columnsChanged = (announceText) => {
    saveColumns();
    // The view does not depend on the columns shown, their order or widths (a sort of a hidden column went with it).
    render({ keep: !sortDropped });
    sortDropped = false;
    fire('columns', { order: [...state.order], hidden: [...state.hidden], widths: sizedWidths() });
    if (announceText) announce(announceText);
  };

  const applyPreset = (id) => {
    const preset = presets().find((item) => item.id === id);
    if (!preset) return;
    state.order = [...preset.order];
    state.hidden = new Set(preset.hidden);
    columnsChanged(t('datagridPresetApplied', { preset: preset.label }));
  };

  /** A column that went took its sort with it: the rows sort again. */
  let sortDropped = false;
  const toggleColumn = (key, show) => {
    const column = byKey(key);
    if (!column || !can(column, 'hideable')) return;
    const visible = show ?? state.hidden.has(key);
    if (!visible && visibleColumns().length <= 1) return;
    if (visible) state.hidden.delete(key);
    else state.hidden.add(key);
    // The sort of a column that went goes with it.
    if (!visible && sortEntry(key)) {
      state.sort = state.sort.filter((entry) => entry.key !== key);
      sortDropped = true;
    }
    columnsChanged(t(visible ? 'datagridColumnShown' : 'datagridColumnHidden', { column: column.label }));
  };

  const chooser = elementOf(table, options.chooser);
  const syncChooser = () => {
    if (!chooser) return;
    const presetList = presets();
    const shownCount = visibleColumns().length;
    let html = `<div role="group" aria-labelledby="${uid}-presets"><p class="ds-menu__heading" id="${uid}-presets">${esc(t('datagridPresets'))}</p>`;
    for (const preset of presetList) {
      html += `<button class="ds-menu__item" role="menuitemradio" type="button" aria-checked="${presetMatches(preset)}" data-ds-datagrid-preset="${esc(preset.id)}" data-ds-key="p:${esc(preset.id)}">${icon(check, 20, 'ds-menu__check')}<span class="ds-menu__label">${esc(preset.label)}</span></button>`;
    }
    html += `</div><div class="ds-menu__divider" role="separator"></div><div role="group" aria-labelledby="${uid}-columns"><p class="ds-menu__heading" id="${uid}-columns">${esc(t('datagridColumns'))}</p>`;
    for (const key of state.order) {
      const column = byKey(key);
      if (!column || !can(column, 'hideable')) continue;
      const shown = !state.hidden.has(key);
      const last = shown && shownCount <= 1;
      html += `<button class="ds-menu__item" role="menuitemcheckbox" type="button" aria-checked="${shown}"${last ? ' aria-disabled="true"' : ''} data-ds-datagrid-toggle="${esc(key)}" data-ds-key="t:${esc(key)}">${icon(check, 20, 'ds-menu__check')}<span class="ds-menu__label">${esc(column.label)}</span></button>`;
    }
    html += '</div>';
    morphHtml(chooser, html);
  };
  if (chooser) {
    // A column's box toggles and the chooser stays open, as a list of checkboxes would; a preset closes it.
    chooser.addEventListener('click', (event) => {
      const item = event.target.closest?.('[data-ds-datagrid-toggle], [data-ds-datagrid-preset]');
      if (!item || !chooser.contains(item)) return;
      if (item.hasAttribute('data-ds-datagrid-preset')) {
        applyPreset(item.getAttribute('data-ds-datagrid-preset'));
        return;
      }
      event.stopPropagation();
      if (item.getAttribute('aria-disabled') === 'true') return;
      toggleColumn(item.getAttribute('data-ds-datagrid-toggle'));
    }, { signal, capture: true });
  }

  /* Reorder: a grip in each header cell, through DS.dnd (pointer and keys). */
  let reorder = null;
  if (options.reorder) {
    const headRow = () => head.rows[0];
    reorder = dragAndDrop(head, {
      // Only the cells with a grip move or make room: a pinned column (and one that cannot move) is no place to drop at.
      items: 'th[data-ds-datagrid-col]:has(> .ds-datagrid__grip)',
      handle: '.ds-datagrid__grip',
      axis: 'inline',
      label: (th) => byKey(th.getAttribute('data-ds-datagrid-col'))?.label ?? '',
      accept: () => true,
    });
    head.addEventListener('ds:drop', () => {
      // The header cells are in their new order: the rows follow.
      const now = Array.from(headRow()?.cells ?? []).map((cell) => cell.getAttribute('data-ds-datagrid-col')).filter(Boolean);
      // A pinned column stays where it was: put it back at its end.
      const shown = visibleColumns();
      const first = table.classList.contains('ds-table--pin-first') ? shown[0]?.key : null;
      const last = table.classList.contains('ds-table--pin-last') && shown.length > 1 ? shown.at(-1)?.key : null;
      const middle = now.filter((key) => key !== first && key !== last);
      const placed = [...(first && now.includes(first) ? [first] : []), ...middle, ...(last && now.includes(last) ? [last] : [])];
      const queue = [...placed];
      state.order = state.order.map((key) => (placed.includes(key) ? queue.shift() : key));
      columnsChanged('');
    }, { signal });
  }

  /* Resize: the separator at a header cell's end edge, by pointer and keys. */
  const resizeTo = (key, width, { save = true } = {}) => {
    const column = byKey(key);
    if (!column) return;
    freeze();
    const next = Math.round(Math.min(column.maxWidth, Math.max(column.minWidth, width)));
    state.widths.set(key, next);
    sized.add(key);
    const th = head.querySelector(`th[data-ds-datagrid-col="${cssEscape(key)}"]`);
    if (th) th.style.width = `${next}px`;
    th?.querySelector('.ds-datagrid__resize')?.setAttribute('aria-valuenow', String(next));
    table.style.setProperty('--ds-datagrid-width', `${tableWidth()}px`);
    if (save) columnsChanged('');
  };
  const resetWidth = (key) => {
    state.widths.delete(key);
    sized.delete(key);
    // No column sized any more: the automatic layout again, measured afresh next time.
    if (!sized.size && !options.virtual) {
      state.layout = 'auto';
      state.widths.clear();
      systemWidths.clear();
    }
    columnsChanged('');
  };

  const rtl = (node) => view.getComputedStyle(node).direction === 'rtl';
  let dragging = null;
  head.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest?.('.ds-datagrid__resize');
    if (!handle || event.button !== 0) return;
    const th = handle.closest('th');
    const key = th?.getAttribute('data-ds-datagrid-col');
    if (!key) return;
    event.preventDefault();
    freeze();
    handle.setPointerCapture?.(event.pointerId);
    // Right to left the separator sits at the left edge: a move to the left widens.
    dragging = { key, handle, pointer: event.pointerId, x: event.clientX, width: th.getBoundingClientRect().width, sign: rtl(th) ? -1 : 1 };
    write(handle, 'data-ds-datagrid-resizing', '');
  }, { signal });
  head.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== dragging.pointer) return;
    resizeTo(dragging.key, dragging.width + dragging.sign * (event.clientX - dragging.x), { save: false });
  }, { signal });
  const endDrag = (event) => {
    if (!dragging || event.pointerId !== dragging.pointer) return;
    const { key, handle } = dragging;
    dragging = null;
    handle.removeAttribute('data-ds-datagrid-resizing');
    columnsChanged('');
    void key;
  };
  head.addEventListener('pointerup', endDrag, { signal });
  // A separator about to be read (focus) reports the width the column has now.
  head.addEventListener('focusin', (event) => {
    if (event.target.matches?.('.ds-datagrid__resize')) syncSeparator(event.target);
  }, { signal });
  head.addEventListener('pointercancel', endDrag, { signal });
  head.addEventListener('dblclick', (event) => {
    const handle = event.target.closest?.('.ds-datagrid__resize');
    const key = handle?.closest('th')?.getAttribute('data-ds-datagrid-col');
    if (key) resetWidth(key);
  }, { signal });

  const onResizeKey = (event, handle) => {
    const key = handle.closest('th')?.getAttribute('data-ds-datagrid-col');
    const column = byKey(key);
    if (!column) return false;
    const now = state.widths.get(key) ?? handle.closest('th').getBoundingClientRect().width;
    // The arrow toward the separator's side widens: ArrowRight left to right, ArrowLeft right to left.
    const step = (event.shiftKey ? RESIZE_BIG_STEP : RESIZE_STEP) * (rtl(handle) ? -1 : 1);
    const to = { ArrowRight: now + step, ArrowLeft: now - step, PageUp: now + RESIZE_BIG_STEP, PageDown: now - RESIZE_BIG_STEP, Home: column.minWidth, End: column.maxWidth }[event.key];
    if (to !== undefined) {
      resizeTo(key, to);
      handle.focus({ preventScroll: true });
      return true;
    }
    if (event.key === 'Enter') {
      resetWidth(key);
      head.querySelector(`th[data-ds-datagrid-col="${cssEscape(key)}"] .ds-datagrid__resize`)?.focus({ preventScroll: true });
      return true;
    }
    return false;
  };

  /* ── Expand: detail rows, tree rows, groups ─────── */

  const toggleExpand = (key, open, kind) => {
    const set = kind === 'group' ? state.collapsed : state.expanded;
    const isOpen = kind === 'group' ? !set.has(key) : set.has(key);
    const next = open ?? !isOpen;
    if (next === isOpen) return false;
    if (kind === 'group') {
      if (next) set.delete(key);
      else set.add(key);
    } else if (next) set.add(key);
    else set.delete(key);
    render();
    fire('expand', { key, open: next, kind });
    return true;
  };

  /* ── Editing ─────────────────────────────────────── */

  const findItem = (key) => state.items.find((item) => item.kind === 'row' && item.key === key) ?? null;
  const rowElement = (key) => body.querySelector(`:scope > tr[data-ds-key="r:${cssEscape(key)}"]`);
  const cellElement = (key, colKey) => rowElement(key)?.querySelector(`:scope > td[data-ds-key="c:${cssEscape(colKey)}"]`) ?? null;

  const startEdit = (key, colKey) => {
    const column = byKey(colKey);
    const item = findItem(key);
    if (!column?.edit || options.edit === false || !item) return false;
    if (state.editing) commitEdit({ move: 0 });
    state.editing = { key, col: colKey, draft: null, error: '' };
    renderRow(key);
    const editor = cellElement(key, colKey)?.querySelector('[data-ds-datagrid-editor]');
    editor?.focus({ preventScroll: false });
    editor?.select?.();
    return true;
  };

  const parse = (column, text) => {
    if (column.edit.type === 'number' || column.type === 'number') {
      const value = String(text).trim();
      if (!value) return null;
      const parsed = Number(value.replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    return text;
  };

  /** Ends the edit: `cancel`, else validates and asks the page (ds:edit, cancelable). `move`: -1, 0 or 1 editable cells on. */
  const commitEdit = ({ cancel = false, move = 0, refocus = true } = {}) => {
    const editing = state.editing;
    if (!editing) return true;
    const column = byKey(editing.col);
    const item = findItem(editing.key);
    const editor = cellElement(editing.key, editing.col)?.querySelector('[data-ds-datagrid-editor]');
    if (cancel || !column || !item) {
      state.editing = null;
      renderRow(editing.key);
      if (refocus) focusCell(editing.key, editing.col);
      return true;
    }
    const text = editor ? editor.value : editing.draft;
    const value = parse(column, text ?? '');
    const previous = valueOf(column, item.row);
    let error = '';
    if (Number.isNaN(value)) error = t('datagridInvalidNumber');
    else if (column.edit.required && (value === null || value === '')) error = t('valueRequired');
    else if (typeof column.edit.validate === 'function') error = String(column.edit.validate(value, item.row) || '');
    if (error) {
      editing.draft = text;
      editing.error = error;
      renderRow(editing.key);
      const again = cellElement(editing.key, editing.col)?.querySelector('[data-ds-datagrid-editor]');
      again?.focus({ preventScroll: true });
      announce(error, { assertive: true });
      return false;
    }
    state.editing = null;
    const changed = String(value ?? '') !== String(previous ?? '');
    if (changed) {
      const allowed = fire('edit', { key: editing.key, row: item.row, column: column.key, value, previous }, true);
      if (allowed) {
        if (typeof column.set === 'function') column.set(item.row, value);
        else item.row[column.key] = value;
        const cells = item.row[CELLS];
        if (cells?.cells?.[column.key]) cells.cells[column.key].html = esc(textOf(column, item.row, locale()));
        announce(t('datagridEditSaved', { column: column.label }));
      } else announce(t('datagridEditRefused', { column: column.label }));
    }
    // A sort or filter by the edited column applies on the next user action, so the row stays under the hand.
    renderRow(editing.key);
    if (move) {
      const editable = visibleColumns().filter((each) => each.edit);
      const at = editable.findIndex((each) => each.key === column.key) + move;
      if (editable[at]) return startEdit(editing.key, editable[at].key);
    }
    if (refocus) focusCell(editing.key, editing.col);
    return true;
  };

  /** One row again (an edit), without moving any other. */
  const renderRow = (key) => {
    const index = state.items.findIndex((item) => item.kind === 'row' && item.key === key);
    if (index < 0) return;
    rendering = true;
    try {
      if (windowed) windowed.refresh(index);
      else morphHtml(body, state.items.map((item, at) => rowHtml(item, at)).join(''));
    } finally {
      rendering = false;
    }
    if (state.focus) rove();
  };

  /* ── Focus: the APG grid ─────────────────────────── */

  /** The rows the keys move through: the header (cell mode), then every item of the view. */
  const navRows = () => state.items.map((item, index) => ({ item, index })).filter(({ item }) => item.kind !== 'detail' || state.expanded.has(item.key));
  const rowAt = (index) => {
    if (index < 0) return head.rows[0] ?? null;
    if (windowed) return windowed.row(index) ?? windowed.scrollTo(index);
    const item = state.items[index];
    if (!item) return null;
    const prefix = item.kind === 'row' ? 'r' : item.kind === 'group' ? 'g' : item.kind === 'detail' ? 'd' : 'ds';
    const domKey = item.kind === 'state' ? 'ds:state' : `${prefix}:${item.key}`;
    return body.querySelector(`:scope > tr[data-ds-key="${cssEscape(domKey)}"]`);
  };
  const indexOfRow = (tr) => {
    if (!tr) return null;
    if (tr.parentElement === head) return -1;
    if (tr.parentElement !== body) return null;
    if (windowed) {
      const at = windowed.indexOf(tr);
      return at < 0 ? null : at;
    }
    const domKey = tr.getAttribute('data-ds-key') ?? '';
    const at = state.items.findIndex((item) => {
      if (item.kind === 'state') return domKey === 'ds:state';
      const prefix = item.kind === 'row' ? 'r' : item.kind === 'group' ? 'g' : 'd';
      return domKey === `${prefix}:${item.key}`;
    });
    return at < 0 ? null : at;
  };
  /** The cell of `tr` that covers column `col` (colspans counted). */
  const cellAt = (tr, col) => {
    let at = 0;
    let last = null;
    for (const cell of tr?.cells ?? []) {
      last = cell;
      if (col < at + cell.colSpan) return cell;
      at += cell.colSpan;
    }
    return last;
  };
  const colOf = (cell) => {
    let at = 0;
    for (const each of cell.parentElement.cells) {
      if (each === cell) return at;
      at += each.colSpan;
    }
    return 0;
  };
  const widgetsIn = (node) => Array.from(node?.querySelectorAll(WIDGET) ?? []).filter((widget) => !widget.disabled && widget.getAttribute('aria-hidden') !== 'true' && widget.getClientRects().length > 0 && !widget.closest('[inert]'));
  /** Where focus goes for a cell: its one widget, else the cell (several widgets, text, an editable value). */
  const targetOf = (cell) => {
    if (!cell) return null;
    // Row mode: the row (`cell` may be the row itself, focused without a cell).
    if (state.focus === 'row') return cell.closest('tr');
    const widgets = widgetsIn(cell).filter((widget) => !widget.matches('.ds-datagrid__twist, .ds-datagrid__resize, .ds-datagrid__grip'));
    if (widgets.length === 1 && !cell.hasAttribute('data-ds-datagrid-edit') && !cell.querySelector('.ds-datagrid__resize, .ds-datagrid__grip')) return widgets[0];
    return cell;
  };

  let stop = null;
  const setStop = (target) => {
    if (stop && stop !== target && stop.isConnected) stop.setAttribute('tabindex', '-1');
    stop = target;
    if (!target) return;
    if (!target.hasAttribute('data-ds-datagrid-stop')) {
      own(target, 'attrs', 'tabindex');
      own(target, 'attrs', 'data-ds-datagrid-stop');
      target.setAttribute('data-ds-datagrid-stop', '');
    }
    target.setAttribute('tabindex', '0');
  };

  /** One tab stop: every widget in the grid waits at -1 (owned, given back on destroy), the active cell or row is the stop. */
  const parked = new Map();
  const rove = () => {
    const scope = state.focus === 'row' ? [body] : [head, body, foot].filter(Boolean);
    for (const part of scope) {
      for (const widget of part.querySelectorAll(WIDGET)) {
        if (state.inside && state.inside.contains(widget)) continue;
        if (widget.matches('td, th, tr')) continue;
        if (!parked.has(widget)) {
          parked.set(widget, widget.getAttribute('tabindex'));
          own(widget, 'attrs', 'tabindex');
        }
        if (widget !== stop && widget.getAttribute('tabindex') !== '-1') widget.setAttribute('tabindex', '-1');
      }
    }
    // The stop: the active position, still there after the render (else the nearest row).
    const { index, col, header } = state.active;
    const rows = navRows();
    let tr = header && state.focus === 'cell' ? head.rows[0] : rowAt(index);
    if (!tr && rows.length) {
      const near = rows.reduce((best, entry) => (Math.abs(entry.index - index) < Math.abs(best.index - index) ? entry : best), rows[0]);
      state.active.index = near.index;
      state.active.header = false;
      tr = rowAt(near.index);
    }
    if (!tr) {
      setStop(null);
      return;
    }
    const target = targetOf(cellAt(tr, col));
    // The stop that held the focus went with a render (its row left the window or the data): the focus follows.
    const focused = doc.activeElement;
    const lost = Boolean(stop) && !stop.isConnected && (!focused || focused === doc.body);
    setStop(target);
    if (lost && target) target.focus({ preventScroll: true });
  };

  const focusAt = (index, col, { header = false } = {}) => {
    state.inside = null;
    const tr = header ? head.rows[0] : rowAt(index);
    if (!tr) return;
    if (windowed && !header) {
      windowed.set({ active: index });
      windowed.scrollTo(index);
    }
    const row = header ? head.rows[0] : rowAt(index);
    const cell = cellAt(row, col);
    state.active = { index: header ? state.active.index : index, col: cell ? colOf(cell) : col, header };
    const target = targetOf(cell);
    setStop(target);
    target?.focus({ preventScroll: false });
    if (!header) target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
  const focusCell = (key, colKey) => {
    const index = state.items.findIndex((item) => item.kind === 'row' && item.key === key);
    if (index < 0) return;
    const cell = cellElement(key, colKey);
    if (!state.focus) {
      (cell?.hasAttribute('tabindex') ? cell : widgetsIn(cell)[0] ?? cell)?.focus({ preventScroll: true });
      return;
    }
    focusAt(index, cell ? colOf(cell) : state.active.col);
  };

  const moveRow = (from, delta) => {
    const rows = navRows();
    let at = rows.findIndex((entry) => entry.index === from);
    if (at < 0) at = 0;
    const to = Math.min(rows.length - 1, Math.max(0, at + delta));
    return rows[to]?.index ?? null;
  };

  const lastCol = (tr) => Array.from(tr?.cells ?? []).reduce((sum, cell) => sum + cell.colSpan, 0) - 1;

  /** The keys of the grid in cell or row mode. Returns whether it handled the key. */
  const navigate = (event) => {
    const { key } = event;
    const ctrl = event.ctrlKey || event.metaKey;
    const header = state.active.header && state.focus === 'cell';
    const index = state.active.index;
    const col = state.active.col;
    const item = header ? null : state.items[index];
    const tr = header ? head.rows[0] : rowAt(index);

    // Tree rows and groups: Right opens, Left closes or goes to the parent.
    const treeItem = item && (item.kind === 'group' || (item.kind === 'row' && item.expanded !== null));
    // A group's head cell spans the selection and details columns as well: anywhere on it counts.
    const onTreeColumn = state.focus === 'row' || col === systemBefore() || (item?.kind === 'group' && Boolean(tr) && cellAt(tr, col) === tr.cells[0]);
    if (!header && item && (key === 'ArrowRight' || key === 'ArrowLeft') && onTreeColumn && (treeItem || (item.kind === 'row' && item.parent !== null && key === 'ArrowLeft') || (state.focus === 'row' && detailOf && item.kind === 'row'))) {
      if (treeItem) {
        const kind = item.kind === 'group' ? 'group' : 'tree';
        const open = item.expanded;
        if (key === 'ArrowRight' && !open) {
          toggleExpand(item.key, true, kind);
          focusAt(state.items.findIndex((each) => each.kind === item.kind && each.key === item.key), col);
          return true;
        }
        if (key === 'ArrowLeft' && open) {
          toggleExpand(item.key, false, kind);
          focusAt(state.items.findIndex((each) => each.kind === item.kind && each.key === item.key), col);
          return true;
        }
        if (key === 'ArrowRight' && open && state.focus === 'row') {
          focusAt(moveRow(index, 1), col);
          return true;
        }
      }
      if (key === 'ArrowLeft' && item.parent !== null) {
        const parent = state.items.findIndex((each) => (each.kind === 'row' || each.kind === 'group') && each.key === item.parent && each.level === item.level - 1);
        if (parent >= 0) {
          focusAt(parent, col);
          return true;
        }
      }
      if (state.focus === 'row' && detailOf && item.kind === 'row') {
        toggleExpand(item.key, key === 'ArrowRight', 'detail');
        focusAt(state.items.findIndex((each) => each.kind === 'row' && each.key === item.key), col);
        return true;
      }
      if (state.focus === 'row') return true;
    }

    if (state.focus === 'row') {
      const rows = { ArrowDown: 1, ArrowUp: -1, PageDown: PAGE_ROWS, PageUp: -PAGE_ROWS }[key];
      if (rows !== undefined) {
        const to = moveRow(index, rows);
        if (to === null) return true;
        if (event.shiftKey && multiple && state.items[to]?.kind === 'row') {
          state.anchor ??= item?.key ?? null;
          focusAt(to, col);
          toggleRow(state.items[to].key, { range: true, on: true });
          return true;
        }
        focusAt(to, col);
        return true;
      }
      if (key === 'Home' || key === 'End') {
        const rowsList = navRows();
        const to = key === 'Home' ? rowsList[0]?.index : rowsList.at(-1)?.index;
        if (to !== undefined) focusAt(to, col);
        return true;
      }
      return false;
    }

    // Cell mode.
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      const cell = cellAt(tr, col);
      const at = colOf(cell);
      const to = key === 'ArrowRight' ? at + cell.colSpan : at - 1;
      if (to < 0 || to > lastCol(tr)) return true;
      if (header) focusAt(index, to, { header: true });
      else focusAt(index, to);
      return true;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'PageDown' || key === 'PageUp') {
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: PAGE_ROWS, PageUp: -PAGE_ROWS }[key];
      if (header) {
        if (step > 0) {
          const first = navRows()[Math.min(step - 1, navRows().length - 1)];
          if (first) focusAt(first.index, col);
        }
        return true;
      }
      const rows = navRows();
      const at = rows.findIndex((entry) => entry.index === index);
      if (step < 0 && at + step < 0) {
        if (head.rows[0]) focusAt(index, col, { header: true });
        return true;
      }
      const to = moveRow(index, step);
      if (to !== null) focusAt(to, col);
      return true;
    }
    if (key === 'Home' || key === 'End') {
      if (ctrl) {
        const rows = navRows();
        if (key === 'Home') focusAt(rows[0]?.index ?? 0, 0, { header: Boolean(head.rows[0]) });
        else focusAt(rows.at(-1)?.index ?? 0, lastCol(rowAt(rows.at(-1)?.index ?? 0)));
        return true;
      }
      const to = key === 'Home' ? 0 : lastCol(tr);
      if (header) focusAt(index, to, { header: true });
      else focusAt(index, to);
      return true;
    }
    return false;
  };

  /** The row's context menu (DS.overlay through DS.menu), at a point or at an opener. */
  const menu = elementOf(table, options.menu);
  let point = null;
  const openRowMenu = (key, { opener = null, x = null, y = null, returnTo = null } = {}) => {
    if (!menu || key === null) return false;
    const item = findItem(key);
    if (!item) return false;
    const keys = isSelected(key) && selecting ? (state.selection.all ? null : [...state.selection.keys]) : [key];
    if (!fire('menu', { key, row: item.row, keys }, true)) return false;
    state.menuKey = key;
    const back = returnTo?.() ?? doc.activeElement;
    let anchor = opener;
    if (!anchor) {
      // A point to open at: the pointer, or the focused cell's lower start corner.
      if (!point) {
        point = doc.createElement('span');
        point.className = 'ds-datagrid__point';
        point.setAttribute('aria-hidden', 'true');
        point.setAttribute('data-ds-keep', '');
        // Inert: the overlay hands focus back to an opener it can focus, and this one only places the menu.
        point.inert = true;
      }
      (wrap?.parentElement ?? table.parentElement).append(point);
      const origin = fixedOrigin(point);
      point.style.setProperty('--ds-datagrid-point-x', `${Math.round(x - origin.left)}px`);
      point.style.setProperty('--ds-datagrid-point-y', `${Math.round(y - origin.top)}px`);
      anchor = point;
    }
    openMenu(menu, { opener: anchor, returnTo: () => back });
    return true;
  };
  if (menu) {
    menu.addEventListener('click', (event) => {
      const action = event.target.closest?.('.ds-menu__item');
      if (!action || state.menuKey === null || action.getAttribute('aria-disabled') === 'true' || action.disabled) return;
      const item = findItem(state.menuKey);
      if (!item) return;
      const keys = isSelected(item.key) && selecting ? selectionDetail() : null;
      fire('action', { action: action.getAttribute('data-ds-action') ?? action.value ?? textIn(action), key: item.key, row: item.row, keys: keys ? keys.keys : [item.key], all: Boolean(keys?.all), item: action });
    }, { signal });
    menu.addEventListener('ds:close', () => {
      state.menuKey = null;
    }, { signal });
  }

  /* ── Input ───────────────────────────────────────── */

  const keyOfRow = (node) => node?.closest?.('tr[data-ds-datagrid-row]')?.getAttribute('data-ds-datagrid-row') ?? null;

  table.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest?.('[data-ds-datagrid-sort]')) {
      const th = target.closest('th');
      sortBy(th.getAttribute('data-ds-datagrid-col'), { add: event.shiftKey });
      return;
    }
    if (target.matches?.('[data-ds-datagrid-all]')) {
      selectPage(target.checked);
      return;
    }
    if (target.matches?.('[data-ds-datagrid-check]')) {
      // A radio reports through change (the arrow keys check one without a click).
      if (target.type !== 'radio') toggleRow(keyOfRow(target), { range: event.shiftKey, on: target.checked });
      return;
    }
    const detail = target.closest?.('[data-ds-datagrid-detail]');
    if (detail) {
      toggleExpand(keyOfRow(detail), undefined, 'detail');
      return;
    }
    const twist = target.closest?.('[data-ds-datagrid-twist]');
    if (twist) {
      const group = twist.closest('tr[data-ds-datagrid-group]');
      if (group) toggleExpand(group.getAttribute('data-ds-datagrid-group'), undefined, 'group');
      else toggleExpand(keyOfRow(twist), undefined, 'tree');
      return;
    }
    const opener = target.closest?.('[data-ds-datagrid-menu]');
    if (opener && menu) {
      openRowMenu(keyOfRow(opener), { opener });
      return;
    }
    const command = target.closest?.('[data-ds-datagrid-command]');
    if (command) {
      runCommand(command.getAttribute('data-ds-datagrid-command'));
      return;
    }
    // Single selection: a click on the row (not on one of its controls) selects it.
    if (options.select === 'single' && !target.closest?.(WIDGET)) {
      const key = keyOfRow(target);
      if (key !== null) toggleRow(key, { on: true });
    }
  }, { signal });

  table.addEventListener('change', (event) => {
    const radio = event.target;
    if (radio.type === 'radio' && radio.checked && radio.matches?.('[data-ds-datagrid-check]')) toggleRow(keyOfRow(radio), { on: true });
  }, { signal });

  table.addEventListener('dblclick', (event) => {
    const cell = event.target.closest?.('td[data-ds-datagrid-edit]');
    if (!cell || cell.querySelector('[data-ds-datagrid-editor]')) return;
    startEdit(keyOfRow(cell), cell.getAttribute('data-ds-key').slice(2));
  }, { signal });

  table.addEventListener('contextmenu', (event) => {
    if (!menu || event.target.closest?.('input, textarea, select, [contenteditable]') || event.shiftKey) return;
    const key = keyOfRow(event.target);
    if (key === null) return;
    const cell = event.target.closest('td, th');
    const x = event.clientX || (cell?.getBoundingClientRect().left ?? 0);
    const y = event.clientY || (cell?.getBoundingClientRect().bottom ?? 0);
    if (openRowMenu(key, { x, y, returnTo: () => (state.focus ? stop : cell?.querySelector(WIDGET) ?? null) })) event.preventDefault();
  }, { signal });

  table.addEventListener('focusin', (event) => {
    const target = /** @type {Element} */ (event.target);
    if (!state.focus) return;
    const cell = target.closest('td, th');
    const tr = target.closest('tr');
    if (!tr || (tr.parentElement !== head && tr.parentElement !== body)) return;
    if (state.focus === 'row' && tr.parentElement === head) return;
    const index = indexOfRow(tr);
    if (index === null) return;
    const col = cell ? colOf(cell) : state.active.col;
    state.active = { index: index < 0 ? state.active.index : index, col, header: index < 0 };
    if (windowed && index >= 0) windowed.set({ active: index });
    // A widget inside a cell with several (a click on it): the cell is entered.
    const stopTarget = targetOf(cell ?? tr);
    if (target !== stopTarget && stopTarget && stopTarget.contains(target)) state.inside = stopTarget;
    else if (target === stopTarget) state.inside = null;
    if (stopTarget && stop !== stopTarget) setStop(stopTarget);
  }, { signal });

  table.addEventListener('focusout', (event) => {
    const next = /** @type {Element|null} */ (event.relatedTarget);
    if (state.inside && !state.inside.contains(next)) state.inside = null;
    // An editor that loses focus to elsewhere commits, or cancels when its value is invalid.
    if (state.editing && event.target.matches?.('[data-ds-datagrid-editor]') && !rendering) {
      const cell = event.target.closest('td');
      if (next && cell?.contains(next)) return;
      queueMicrotask(() => {
        if (!state.editing || cell?.contains(doc.activeElement)) return;
        if (!commitEdit({ refocus: false })) commitEdit({ cancel: true, refocus: false });
      });
    }
  }, { signal });

  /** Each keydown once, though it may reach two listeners (below). */
  const keysSeen = new WeakSet();
  const onKeydown = (/** @type {KeyboardEvent} */ event) => {
    if (keysSeen.has(event)) return;
    keysSeen.add(event);
    if (event.defaultPrevented || event.isComposing) return;
    const target = /** @type {Element} */ (event.target);
    const key = event.key;
    const ctrl = event.ctrlKey || event.metaKey;

    // The editor: Enter commits, Escape cancels, Tab commits and goes to the next editable cell.
    if (target.matches?.('[data-ds-datagrid-editor]')) {
      if (key === 'Enter' && !event.altKey) {
        event.preventDefault();
        commitEdit({ move: 0 });
      } else if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        commitEdit({ cancel: true });
      } else if (key === 'Tab') {
        event.preventDefault();
        commitEdit({ move: event.shiftKey ? -1 : 1 });
      }
      return;
    }

    // A column's separator: arrows resize, Enter puts its width back.
    if (target.matches?.('.ds-datagrid__resize') && onResizeKey(event, target)) {
      event.preventDefault();
      return;
    }

    // The row menu: Shift+F10 or the context menu key, on a row.
    if (menu && ((key === 'F10' && event.shiftKey) || key === 'ContextMenu')) {
      const rowKey = keyOfRow(target);
      if (rowKey !== null) {
        const cell = target.closest('td, th') ?? target;
        const rect = cell.getBoundingClientRect();
        const opener = target.closest('tr')?.querySelector('[data-ds-datagrid-menu]');
        if (openRowMenu(rowKey, opener && !state.focus ? { opener } : { x: rect.left, y: rect.bottom, returnTo: () => target })) event.preventDefault();
        return;
      }
    }

    // Copy: the selected rows, else the focused cell's text (row mode: the focused row).
    if (ctrl && key.toLowerCase() === 'c' && state.focus && !typesText(target) && !String(view.getSelection?.() ?? '')) {
      event.preventDefault();
      const cell = state.focus === 'cell' ? target.closest('td, th') : null;
      const item = cell ? null : findItem(keyOfRow(target));
      if (selectionDetail().count) copy({ selected: true });
      else if (cell) writeClipboard(textIn(cell), 1);
      else if (item) writeClipboard(csv([item.row], exportColumns(), { separator: '\t', locale: locale() }), 1);
      else writeClipboard(textIn(target.closest('tr')), 1);
      return;
    }

    // An editable cell (table mode: the cell is a tab stop): Enter or F2 edits.
    const editCell = target.matches?.('td[data-ds-datagrid-edit]') ? target : null;
    if (editCell && (key === 'Enter' || key === 'F2')) {
      event.preventDefault();
      startEdit(keyOfRow(editCell), editCell.getAttribute('data-ds-key').slice(2));
      return;
    }

    if (!state.focus) return;

    // Inside a cell (its widgets): Tab goes round them, Escape or F2 back to the cell.
    if (state.inside && state.inside !== target) {
      if (key === 'Escape' || key === 'F2') {
        event.preventDefault();
        const cell = state.inside;
        state.inside = null;
        cell.focus({ preventScroll: true });
        return;
      }
      if (key === 'Tab') {
        const widgets = widgetsIn(state.inside);
        const at = widgets.indexOf(target.closest(WIDGET) ?? target);
        if (widgets.length > 1) {
          event.preventDefault();
          widgets[(at + (event.shiftKey ? -1 : 1) + widgets.length) % widgets.length].focus();
        }
        return;
      }
      return;
    }

    if (typesText(target) || target.matches?.('select')) return;

    // Select all (Ctrl+A), a row's selection (Space in row mode, Shift+Space in cell mode).
    if (ctrl && key.toLowerCase() === 'a' && multiple) {
      event.preventDefault();
      selectPage(true);
      return;
    }
    const rowKey = keyOfRow(target);
    if (key === ' ' && selecting && rowKey !== null && (state.focus === 'row' ? target.matches('tr') : event.shiftKey || target.matches('td'))) {
      event.preventDefault();
      toggleRow(rowKey, { range: event.shiftKey && state.focus === 'row' });
      return;
    }

    // Enter or F2: edit, enter a cell with several widgets, or (row mode) follow the row link.
    if (key === 'Enter' || key === 'F2') {
      const cell = target.matches('td, th') ? target : null;
      if (cell && cell.hasAttribute('data-ds-datagrid-edit')) {
        event.preventDefault();
        startEdit(rowKey, cell.getAttribute('data-ds-key').slice(2));
        return;
      }
      if (cell?.closest('thead') && key === 'Enter') {
        const sorter = cell.querySelector('[data-ds-datagrid-sort]');
        if (sorter) {
          event.preventDefault();
          sortBy(cell.getAttribute('data-ds-datagrid-col'), { add: event.shiftKey });
          return;
        }
      }
      const host = cell ?? (target.matches('tr') ? target : null);
      if (host) {
        if (key === 'Enter' && host.matches('tr')) {
          const link = host.querySelector('.ds-table__row-link');
          if (link) {
            event.preventDefault();
            link.click();
            return;
          }
        }
        const widgets = widgetsIn(host);
        if (widgets.length) {
          event.preventDefault();
          state.inside = host;
          for (const widget of widgets) widget.setAttribute('tabindex', '-1');
          widgets[0].focus();
        }
        return;
      }
    }

    if (navigate(event)) event.preventDefault();
  };
  // Windowed rows: DS.virtual listens for its row keys on the body, so the
  // grid's keys go first there (a listener on the body added before it).
  if (options.virtual) body.addEventListener('keydown', onKeydown, { signal });
  table.addEventListener('keydown', onKeydown, { signal });

  /* ── Commands, export ────────────────────────────── */

  /** The rows an export writes: every row that passes the filter, in order (tree rows with their children), or the selected ones. */
  const exportRows = ({ selected = false } = {}) => {
    const rows = state.view.filtered;
    if (!selected || !selectionDetail().count) return rows.slice();
    const index = new Map(state.rows.map((row, at) => [row, at]));
    return rows.filter((row) => isSelected(keyOf(row, index.get(row) ?? 0)));
  };

  /**
   * Server data: the grid holds one page, so an export asks the source again
   * for every row (`page: null`, `{ export: true }` in its context), unless
   * every selected row is on the page already.
   */
  let exporting = null;
  const serverExportRows = async ({ selected = false } = {}) => {
    const sel = state.selection;
    const pick = selected && selectionDetail().count > 0;
    if (pick && !sel.all) {
      const here = state.rows.filter((row, at) => sel.keys.has(keyOf(row, at)));
      if (here.length === sel.keys.size) return here;
    }
    exporting?.abort();
    const control = new AbortController();
    exporting = control;
    const result = await options.source({ sort: state.sort.map((entry) => ({ ...entry })), filter: state.filter, page: null }, { signal: control.signal, export: true });
    if (control.signal.aborted || signal.aborted) throw Object.assign(new Error('The export was aborted'), { name: 'AbortError' });
    const all = Array.isArray(result) ? result : result?.rows ?? [];
    return pick ? all.filter((row, at) => isSelected(keyOf(row, at))) : all;
  };
  /** The export rows of either kind of data: a list (client), a promise of one (server). */
  const rowsToExport = (opts) => (server ? serverExportRows(opts) : exportRows(opts));
  const exportColumns = () => visibleColumns().filter((column) => column.export !== false);
  const csvOf = (rows, opts = {}) => csv(rows, exportColumns(), { separator: opts.separator, locale: locale(), header: opts.header });
  /** CSV of the export rows: text (client) or a promise of it (server). */
  const toCsv = (opts = {}) => (server ? serverExportRows(opts).then((rows) => csvOf(rows, opts)) : csvOf(exportRows(opts), opts));

  const writeClipboard = (text, count) => {
    const clipboard = view.navigator?.clipboard;
    if (typeof clipboard?.writeText !== 'function') {
      announce(t('actionFailed'), { assertive: true });
      return Promise.resolve(false);
    }
    return clipboard.writeText(text).then(() => {
      announce(plural(count, { one: t('datagridCopiedOne'), other: t('datagridCopiedOther') }, { locale: locale() }));
      return true;
    }, () => {
      announce(t('actionFailed'), { assertive: true });
      return false;
    });
  };
  /** An export of server data that did not come: said, and the promise answers what it would have. */
  const exportFailed = (error, value) => {
    if (error?.name !== 'AbortError') announce(t('actionFailed'), { assertive: true });
    return value;
  };
  const copy = (opts = {}) => {
    const write = (rows) => writeClipboard(csv(rows, exportColumns(), { separator: '\t', locale: locale(), header: opts.header ?? true }), rows.length);
    const rows = rowsToExport({ selected: opts.selected ?? true });
    return Array.isArray(rows) ? write(rows) : rows.then(write, (error) => exportFailed(error, false));
  };
  const download = (name, opts = {}) => {
    const text = toCsv(opts);
    if (typeof text !== 'string') return text.then((done) => save(done, name), (error) => exportFailed(error, ''));
    return save(text, name);
  };
  const save = (text, name) => {
    if (signal.aborted) return text;
    // A byte-order mark, so a spreadsheet reads the file as UTF-8.
    const blob = new view.Blob([`\ufeff${text}`], { type: 'text/csv;charset=utf-8' });
    const url = view.URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = name || options.file || `${table.id || 'table'}.csv`;
    link.hidden = true;
    (table.closest('.ds-theme') ?? doc.body).append(link);
    link.click();
    link.remove();
    setTimeout(() => view.URL.revokeObjectURL(url), motionDuration(table, '--ds-dur-long'));
    return text;
  };

  const runCommand = (command) => {
    if (command === 'retry') load();
    else if (command === 'every') selectEvery();
    else if (command === 'clear') clearSelection();
    else if (command === 'copy') copy();
    else if (command === 'csv') download();
    else if (command === 'reset') applyPreset('default');
  };
  if (bar) {
    bar.addEventListener('click', (event) => {
      const command = event.target.closest?.('[data-ds-datagrid-command]');
      if (command && bar.contains(command)) runCommand(command.getAttribute('data-ds-datagrid-command'));
    }, { signal });
  }

  /* ── The controller ──────────────────────────────── */

  const controller = {
    /** The state: sort, filter, page, selection, columns, total, status. */
    get() {
      return {
        sort: state.sort.map((entry) => ({ ...entry })),
        filter: state.filter,
        page: state.page ? { ...state.page, pages: pageCount() } : null,
        selection: selectionDetail(),
        columns: { order: [...state.order], hidden: [...state.hidden], widths: sizedWidths() },
        expanded: [...state.expanded],
        total: state.total,
        status: state.status,
        rows: state.view.rows.slice(),
      };
    },
    set(value = {}) {
      let glide = false;
      let reload = false;
      if (value.rows !== undefined && !server) state.rows = value.rows ?? [];
      if (value.sort !== undefined) {
        state.sort = normalizeSort(value.sort).filter((entry) => byKey(entry.key));
        prefs?.set('sort', state.sort);
        glide = true;
        reload = true;
      }
      if (value.filter !== undefined) {
        applyFilter(value.filter);
        if (Object.keys(value).length === 1) return;
      }
      if (value.page !== undefined && state.page) {
        const next = typeof value.page === 'number' ? { index: value.page } : value.page ?? {};
        if (next.size) state.page.size = next.size;
        if (Number.isFinite(next.index)) state.page.index = Math.max(0, next.index);
        reload = true;
      }
      if (value.group !== undefined) state.group = value.group;
      if (value.selected !== undefined) state.selection = { keys: new Set([...value.selected].map(String)), all: false, except: new Set() };
      if (value.expanded !== undefined) state.expanded = new Set([...value.expanded].map(String));
      if (value.columns) {
        if (Array.isArray(value.columns.order)) state.order = [...value.columns.order.filter(byKey), ...state.order.filter((key) => !value.columns.order.includes(key))];
        if (Array.isArray(value.columns.hidden)) state.hidden = new Set(value.columns.hidden.filter(byKey));
        if (isObject(value.columns.widths)) for (const [key, width] of Object.entries(value.columns.widths)) if (byKey(key)) resizeTo(key, width, { save: false });
        saveColumns();
      }
      if (server && reload) load();
      else render({ glide });
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    /** Renders again (the page changed rows in place), or loads again from the source. */
    refresh: () => refreshData(),
    select(keys) {
      if (keys === 'all') selectEvery();
      else if (keys === 'page') selectPage(true);
      else if (keys === 'none' || keys === null) clearSelection(true);
      else {
        state.selection = { keys: new Set([...keys].map(String)), all: false, except: new Set() };
        selectionChanged();
      }
    },
    expand: (key, open = true) => toggleExpand(String(key), open, findItem(String(key))?.expanded !== null && treeOn ? 'tree' : 'detail'),
    edit: (key, column) => startEdit(String(key), String(column)),
    focus(key, column) {
      if (key === undefined) {
        (stop ?? table).focus?.();
        return;
      }
      focusCell(String(key), String(column ?? visibleColumns()[0]?.key));
    },
    sort: (key, dir) => applySort(dir ? [{ key, dir }] : []),
    page: (index) => goPage(index),
    preset: (id) => applyPreset(id),
    toggleColumn: (key, show) => toggleColumn(String(key), show),
    resize: (key, width) => resizeTo(String(key), width),
    csv: (opts) => toCsv(opts),
    copy: (opts) => copy(opts),
    download: (name, opts) => download(name, opts),
    menu: (key, opts = {}) => {
      const cell = rowElement(String(key))?.cells[systemBefore()];
      const rect = cell?.getBoundingClientRect();
      return openRowMenu(String(key), { x: opts.x ?? rect?.left ?? 0, y: opts.y ?? rect?.bottom ?? 0, opener: opts.opener ?? null });
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      loading?.abort();
      exporting?.abort();
      sizes?.disconnect();
      instances.delete(table);
      windowed?.destroy();
      reorder?.destroy();
      prefs?.destroy();
      if (menu && state.menuKey !== null) closeMenu(menu);
      point?.remove();
      everyButton?.remove();
      if (slot && toolbar && !bar.isConnected) {
        bar.hidden = true;
        if (!toolbar.isConnected) slot.append(toolbar);
        slot.append(bar);
      }
      for (const [widget, before] of parked) {
        if (before === null) widget.removeAttribute('tabindex');
        else widget.setAttribute('tabindex', before);
        disown(widget, 'attrs', 'tabindex');
      }
      parked.clear();
      if (stop?.hasAttribute('data-ds-datagrid-stop')) {
        stop.removeAttribute('data-ds-datagrid-stop');
        disown(stop, 'attrs', 'data-ds-datagrid-stop');
        disown(stop, 'attrs', 'tabindex');
      }
      giveBack();
      table.style.removeProperty('--ds-datagrid-width');
      if (foot && footMine) foot.remove();
      else if (foot && footBefore) foot.replaceChildren(...footBefore);
      if (markupBefore) {
        head.replaceChildren(...markupBefore.head);
        body.replaceChildren(...markupBefore.body);
      }
      if (body.classList.contains('ds-stale')) {
        body.classList.remove('ds-stale');
        disown(body, 'classes', 'ds-stale');
      }
    },
  };

  // Fixed widths given by the page or remembered: the layout starts fixed.
  if (state.widths.size) state.layout = 'fixed';
  if (server) load();
  else render();
  if (state.layout === 'fixed') {
    view.requestAnimationFrame?.(() => {
      if (!signal.aborted) decorate();
    });
  }
  return controller;
}

/** CSS.escape where it exists (every browser); a plain quote escape in Node. */
function cssEscape(value) {
  return typeof globalThis.CSS?.escape === 'function' ? globalThis.CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&');
}

/* The data-ds-datagrid attribute, and the commands of buttons outside the table (aria-controls names it). */
define('datagrid', {
  attribute: 'data-ds-datagrid',
  init: (table) => create(table, readConfig(table)),
  global(root) {
    const onClick = (/** @type {MouseEvent} */ event) => {
      const button = /** @type {Element} */ (event.target)?.closest?.('[data-ds-datagrid-command][aria-controls]');
      if (!button || button.getAttribute('aria-disabled') === 'true') return;
      const doc = button.ownerDocument;
      const table = doc.getElementById(button.getAttribute('aria-controls') ?? '');
      const grid = table ? instances.get(table) : null;
      if (!grid) return;
      const command = button.getAttribute('data-ds-datagrid-command');
      if (command === 'csv') grid.download(button.getAttribute('data-ds-datagrid-file') ?? undefined);
      else if (command === 'copy') grid.copy();
      else if (command === 'every') grid.select('all');
      else if (command === 'clear') grid.select('none');
      else if (command === 'reset') grid.preset('default');
      else if (command === 'retry') grid.refresh();
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  },
});
