/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * JSON viewer (3.0): a JSON document as a tree that opens and closes, on
 * DS.tree (the APG tree: one tab stop, the arrows walk and open the rows,
 * letters jump by key). Every row copies its value or its path; a search
 * field marks the keys and values that hold the query and walks the
 * matches; numbers keep the digits of the source, so an id beyond 2^53
 * shows and copies exactly; large objects render only what opens, and a
 * container of more than 100 entries opens into ranges of them.
 *
 *   <div class="ds-jsonview" role="region" data-ds-jsonview aria-label="Response of GET /devices/42">
 *     <script type="application/json">{ "id": 42, "name": "LAPTOP-0042", "tags": ["lab", "loan"] }</script>
 *   </div>
 *   const view = DS.jsonview.create(el, { value: payload, open: 2 });
 *   view.get();                         // the value (integers beyond 2^53 as BigInt)
 *   view.text();                        // the JSON, every number as written
 *   view.search('lovelace');            // marks the hits, reveals the first
 *
 * The source: create(el, { value }) or { text }, else the text of a
 * <script type="application/json"> (or a <pre>) inside the element, which
 * stays in place, hidden. data-ds-jsonview-open (default 1): how many
 * levels show open at first. data-ds-jsonview-search="off" leaves out the
 * search bar.
 *
 * What it writes inside the element (its own parts, through DOM APIs):
 * .ds-jsonview__bar (the search field, the count of matches, previous and
 * next, expand and collapse all) and a .ds-tree.ds-jsonview__tree, whose
 * items hold .ds-jsonview__key, .ds-jsonview__value--<type> and, per row,
 * a copy button for the value and one for the path. Text that is not valid
 * JSON shows .ds-jsonview__error with the line and column (data-state
 * "error" on the element, ds:error).
 *
 * Events (bubbling, on the element; also through on(type, fn)):
 *   ds:copy    { kind: 'value'|'path', text, path }   after a copy
 *   ds:search  { query, total, index }                the matches changed
 *   ds:error   { error }                              the text is no JSON
 * and those of DS.tree on its tree (ds:toggle, ds:select).
 *
 * Progressive:
 * - Clipboard API (navigator.clipboard.writeText, secure contexts): without
 *   it the copy command on a hidden, read-only textarea.
 *
 * ES2022; no DOM is touched until an element is initialised.
 */
import { define, emit, t } from './core.js';
import { announce } from './a11y.js';
import { motionDuration } from './motion.js';
import { plural } from './format.js';
import { chevronRight, copy as copyGlyph, link as linkGlyph, chevronUp, chevronDown, expandAll as expandGlyph, collapseAll as collapseGlyph, alertCircle, iconElement } from './icons.js';
import { create as treeOf } from './tree.js';

/** A container opens into ranges above this many entries. */
const CHUNK = 100;
/** Expand all opens at most this many rows; the rest stay closed (and lazy). */
const EXPAND_LIMIT = 1500;
/** Search stops counting here. */
const MATCH_LIMIT = 1000;
/** Nesting deeper than this is refused (a stack, not a document). */
const DEPTH_LIMIT = 4000;

/* ── The model: parse, build, write ──────────────────────────── */

/**
 * A parse failure: where it happened, 1-based.
 * @param {string} source
 * @param {number} offset
 * @param {string} message
 */
function failure(source, offset, message) {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  const error = new SyntaxError(message);
  Object.assign(error, { line, column, offset });
  return error;
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * Parses JSON text into the viewer's model, keeping every number as the
 * text it was written as: `{ type: 'object'|'array', entries: [[key, node]] }`,
 * `{ type: 'string', value }`, `{ type: 'number', raw }`,
 * `{ type: 'boolean', value }`, `{ type: 'null' }`. Duplicate keys stay.
 * Throws a SyntaxError with `line`, `column` and `offset`.
 * @param {string} text
 */
export function parse(text) {
  const source = String(text ?? '');
  let at = 0;
  const space = () => {
    while (at < source.length) {
      const code = source.charCodeAt(at);
      if (code === 32 || code === 10 || code === 13 || code === 9) at += 1;
      else break;
    }
  };
  const string = () => {
    at += 1;
    let out = '';
    let start = at;
    while (at < source.length) {
      const code = source.charCodeAt(at);
      if (code === 34) {
        out += source.slice(start, at);
        at += 1;
        return out;
      }
      if (code === 92) {
        out += source.slice(start, at);
        const next = source[at + 1];
        if (next === 'u') {
          const hex = source.slice(at + 2, at + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw failure(source, at, 'bad unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          at += 6;
        } else if (next !== undefined && Object.hasOwn(ESCAPES, next)) {
          out += ESCAPES[next];
          at += 2;
        } else throw failure(source, at, 'bad escape');
        start = at;
        continue;
      }
      if (code < 32) throw failure(source, at, 'control character in a string');
      at += 1;
    }
    throw failure(source, at, 'unterminated string');
  };
  const value = (depth) => {
    if (depth > DEPTH_LIMIT) throw failure(source, at, 'nested too deep');
    space();
    const char = source[at];
    if (char === '{') {
      at += 1;
      const entries = [];
      space();
      if (source[at] === '}') {
        at += 1;
        return { type: 'object', entries };
      }
      for (;;) {
        space();
        if (source[at] !== '"') throw failure(source, at, 'expected a key');
        const key = string();
        space();
        if (source[at] !== ':') throw failure(source, at, 'expected a colon');
        at += 1;
        entries.push([key, value(depth + 1)]);
        space();
        if (source[at] === ',') {
          at += 1;
          continue;
        }
        if (source[at] === '}') {
          at += 1;
          return { type: 'object', entries };
        }
        throw failure(source, at, 'expected a comma or a closing brace');
      }
    }
    if (char === '[') {
      at += 1;
      const entries = [];
      space();
      if (source[at] === ']') {
        at += 1;
        return { type: 'array', entries };
      }
      for (;;) {
        entries.push([entries.length, value(depth + 1)]);
        space();
        if (source[at] === ',') {
          at += 1;
          continue;
        }
        if (source[at] === ']') {
          at += 1;
          return { type: 'array', entries };
        }
        throw failure(source, at, 'expected a comma or a closing bracket');
      }
    }
    if (char === '"') return { type: 'string', value: string() };
    for (const [word, node] of [['true', { type: 'boolean', value: true }], ['false', { type: 'boolean', value: false }], ['null', { type: 'null' }]]) {
      if (source.startsWith(word, at)) {
        at += word.length;
        return node;
      }
    }
    NUMBER.lastIndex = at;
    const number = NUMBER.exec(source);
    if (number) {
      at = NUMBER.lastIndex;
      return { type: 'number', raw: number[0] };
    }
    throw failure(source, at, at >= source.length ? 'unexpected end' : 'unexpected character');
  };
  const root = value(0);
  space();
  if (at < source.length) throw failure(source, at, 'unexpected text after the value');
  return root;
}

/**
 * The model of a JavaScript value, as JSON.stringify would see it: a
 * BigInt keeps its digits, toJSON() is called, undefined and functions
 * leave an object (and are null in an array), NaN and Infinity are null.
 * @param {any} input
 */
export function fromValue(input) {
  const seen = new Set();
  const node = (value, inArray) => {
    if (value && typeof value.toJSON === 'function') value = value.toJSON();
    if (value === null) return { type: 'null' };
    switch (typeof value) {
      case 'string': return { type: 'string', value };
      case 'boolean': return { type: 'boolean', value };
      case 'bigint': return { type: 'number', raw: value.toString() };
      case 'number': return Number.isFinite(value) ? { type: 'number', raw: String(value) } : { type: 'null' };
      case 'undefined':
      case 'function':
      case 'symbol': return inArray ? { type: 'null' } : undefined;
      default: break;
    }
    if (seen.has(value)) throw new TypeError('cyclic value');
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = { type: 'array', entries: value.map((item, index) => [index, node(item, true)]) };
    else {
      const entries = [];
      for (const [key, item] of Object.entries(value)) {
        const child = node(item, false);
        if (child) entries.push([key, child]);
      }
      result = { type: 'object', entries };
    }
    seen.delete(value);
    return result;
  };
  return node(input, true);
}

/** Whether a number's text is an integer a double cannot hold exactly. */
const unsafe = (raw) => /^-?\d+$/.test(raw) && !Number.isSafeInteger(Number(raw));

/**
 * The JavaScript value of a model: integers a double cannot hold become
 * BigInt, so no digit is lost.
 * @param {any} model
 */
export function toValue(model) {
  switch (model?.type) {
    case 'object': {
      const out = {};
      for (const [key, child] of model.entries) Object.defineProperty(out, key, { value: toValue(child), enumerable: true, configurable: true, writable: true });
      return out;
    }
    case 'array': return model.entries.map(([, child]) => toValue(child));
    case 'string':
    case 'boolean': return model.value;
    case 'number': return unsafe(model.raw) ? BigInt(model.raw) : Number(model.raw);
    default: return null;
  }
}

/**
 * JSON text of a model (or a value), every number as written; `indent`
 * spaces per level (0: one line).
 * @param {any} model
 * @param {number} [indent]
 */
export function stringify(model, indent = 2) {
  const root = model && typeof model === 'object' && typeof model.type === 'string' && ('entries' in model || 'raw' in model || 'value' in model || model.type === 'null') ? model : fromValue(model);
  const pad = ' '.repeat(Math.max(0, Math.min(10, Number(indent) || 0)));
  const write = (node, depth) => {
    switch (node.type) {
      case 'string': return JSON.stringify(node.value);
      case 'number': return node.raw;
      case 'boolean': return String(node.value);
      case 'null': return 'null';
      default: break;
    }
    const array = node.type === 'array';
    if (!node.entries.length) return array ? '[]' : '{}';
    const inner = pad ? `\n${pad.repeat(depth + 1)}` : '';
    const outer = pad ? `\n${pad.repeat(depth)}` : '';
    const parts = node.entries.map(([key, child]) => (array ? '' : `${JSON.stringify(String(key))}:${pad ? ' ' : ''}`) + write(child, depth + 1));
    return (array ? '[' : '{') + inner + parts.join(`,${inner}`) + outer + (array ? ']' : '}');
  };
  return write(root, 0);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The path of a value as JavaScript reads it, from `$` (the root):
 * `$.devices[0].name`, `$["display name"]`.
 * @param {Array<string|number>} segments
 */
export function pathOf(segments) {
  let out = '$';
  for (const segment of segments ?? []) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (IDENTIFIER.test(segment)) out += `.${segment}`;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

/**
 * The ranges a container of `count` entries opens into: none up to 100,
 * else buckets of 100, 10 000 ... so that no level holds more than 100.
 * @param {number} from
 * @param {number} to  exclusive
 * @returns {Array<[number, number]>}
 */
export function ranges(from, to) {
  const count = to - from;
  if (count <= CHUNK) return [];
  let size = CHUNK;
  while (count / size > CHUNK) size *= CHUNK;
  const out = [];
  for (let start = from; start < to; start += size) out.push([start, Math.min(to, start + size)]);
  return out;
}

/** A primitive's text as the row shows it (and search reads it). */
const shown = (node) => {
  switch (node.type) {
    case 'string': return JSON.stringify(node.value);
    case 'number': return node.raw;
    case 'boolean': return String(node.value);
    case 'null': return 'null';
    default: return node.type === 'array' ? '[…]' : '{…}';
  }
};

/** What a copy of a node's value gives: a string's own text, a number's digits, a container's JSON. */
const copied = (node) => (node.type === 'string' ? node.value : node.type === 'object' || node.type === 'array' ? stringify(node, 2) : shown(node));

/**
 * Every match of `query` (case-insensitive) in keys and primitive values:
 * the entry index paths, in document order, at most `limit`.
 * @param {any} model
 * @param {string} query
 * @param {number} [limit]
 * @returns {number[][]}
 */
export function search(model, query, limit = MATCH_LIMIT) {
  const needle = String(query ?? '').trim().toLowerCase();
  const out = [];
  if (!needle || !model) return out;
  const walk = (node, trail) => {
    if (out.length >= limit || !node.entries) return;
    for (let index = 0; index < node.entries.length && out.length < limit; index += 1) {
      const [key, child] = node.entries[index];
      const here = [...trail, index];
      const keyHit = typeof key === 'string' && key.toLowerCase().includes(needle);
      const valueHit = !child.entries && shown(child).toLowerCase().includes(needle);
      if (keyHit || valueHit) out.push(here);
      walk(child, here);
    }
  };
  if (model.entries) walk(model, []);
  else if (shown(model).toLowerCase().includes(needle)) out.push([]);
  return out;
}

/* ── Copy ─────────────────────────────────────────────────────── */

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

/* ── The viewer ───────────────────────────────────────────────── */

const instances = new WeakMap();
let views = 0;

function controller(el, initial) {
  const doc = el.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  views += 1;
  const prefix = `ds-json-${views}`;
  let options = { open: 1, search: true, ...initial };
  let model = null;
  let source = '';
  /** Item key → { node, trail (entry indexes), segments (keys), range? }. */
  const nodes = new Map();
  let query = '';
  let matches = [];
  let current = -1;

  const source0 = el.querySelector(':scope > script[type="application/json"], :scope > pre');
  if (source0) source0.hidden = true;

  /* Parts, built once. */
  const bar = doc.createElement('div');
  bar.className = 'ds-jsonview__bar';
  const field = doc.createElement('input');
  field.type = 'search';
  field.className = 'ds-input ds-jsonview__find';
  field.setAttribute('aria-label', t('jsonSearch'));
  field.placeholder = t('jsonFind');
  field.autocomplete = 'off';
  field.spellcheck = false;
  const count = doc.createElement('span');
  count.className = 'ds-jsonview__count';
  count.setAttribute('aria-hidden', 'true');
  const button = (glyph, label, action) => {
    const element = doc.createElement('button');
    element.type = 'button';
    element.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-sm';
    element.setAttribute('aria-label', label);
    element.setAttribute('data-tip', label);
    element.setAttribute('data-ds-jsonview-action', action);
    element.append(iconElement(glyph, 18, undefined, doc));
    return element;
  };
  const previous = button(chevronUp, t('jsonPrevious'), 'previous');
  const next = button(chevronDown, t('jsonNext'), 'next');
  const openAll = button(expandGlyph, t('jsonExpandAll'), 'expand');
  const closeAll = button(collapseGlyph, t('jsonCollapseAll'), 'collapse');
  const finder = doc.createElement('span');
  finder.className = 'ds-jsonview__search';
  finder.append(field, count, previous, next);
  bar.append(finder, openAll, closeAll);

  const list = doc.createElement('ul');
  list.className = 'ds-tree ds-jsonview__tree';
  list.setAttribute('role', 'tree');
  const name = () => el.getAttribute('aria-label');
  const named = () => el.getAttribute('aria-labelledby');
  const nameTree = () => {
    if (named()) list.setAttribute('aria-labelledby', named());
    else list.setAttribute('aria-label', name() || t('jsonTree'));
  };
  nameTree();

  const problem = doc.createElement('p');
  problem.className = 'ds-jsonview__error';
  problem.setAttribute('role', 'alert');
  problem.hidden = true;

  el.append(bar, problem, list);
  bar.hidden = !options.search;

  /* ── Rows ──────────────────────────────────── */

  const keyFor = (trail, range) => `${prefix}:${trail.join('.')}${range ? `:${range[0]}-${range[1]}` : ''}`;

  const paint = (span, text) => {
    if (!query) {
      span.textContent = text;
      return false;
    }
    const lower = text.toLowerCase();
    const needle = query.toLowerCase();
    let from = 0;
    let at = lower.indexOf(needle);
    if (at < 0) {
      span.textContent = text;
      return false;
    }
    const parts = [];
    while (at >= 0) {
      if (at > from) parts.push(doc.createTextNode(text.slice(from, at)));
      const mark = doc.createElement('mark');
      mark.className = 'ds-jsonview__mark';
      mark.textContent = text.slice(at, at + needle.length);
      parts.push(mark);
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
    if (from < text.length) parts.push(doc.createTextNode(text.slice(from)));
    span.replaceChildren(...parts);
    return true;
  };

  const countOf = (node) => {
    const total = node.entries.length;
    return node.type === 'array'
      ? plural(total, { one: t('jsonItem'), other: t('jsonItems') })
      : plural(total, { one: t('jsonKey'), other: t('jsonKeys') });
  };

  /**
   * One row: an entry of a container, or a range of its entries; open
   * `depth` levels below it while `budget.rows` lasts (shared by the rows
   * of one render).
   */
  const item = (entry, depth, budget) => {
    const { node, trail, segments, range, label } = entry;
    const key = keyFor(trail, range);
    nodes.set(key, entry);
    const li = doc.createElement('li');
    li.className = 'ds-tree__item';
    li.setAttribute('role', 'treeitem');
    li.setAttribute('data-ds-key', key);
    li.setAttribute('aria-selected', 'false');
    const folder = range ? true : Boolean(node.entries?.length);
    const row = doc.createElement('div');
    row.className = 'ds-tree__row';
    if (folder) {
      const toggle = doc.createElement('span');
      toggle.className = 'ds-tree__toggle';
      toggle.setAttribute('aria-hidden', 'true');
      toggle.append(iconElement(chevronRight, 16, undefined, doc));
      row.append(toggle);
    }
    const text = doc.createElement('span');
    text.className = 'ds-tree__label';
    if (range) {
      const span = doc.createElement('span');
      span.className = 'ds-jsonview__range';
      span.textContent = `[${range[0]} … ${range[1] - 1}]`;
      text.append(span);
    } else {
      if (label !== undefined) {
        const keySpan = doc.createElement('span');
        keySpan.className = 'ds-jsonview__key';
        // An array index is no key: search passes it by.
        if (typeof label === 'number') keySpan.textContent = String(label);
        else paint(keySpan, label);
        const colon = doc.createElement('span');
        colon.className = 'ds-jsonview__punct';
        colon.textContent = ': ';
        text.append(keySpan, colon);
      }
      const valueSpan = doc.createElement('span');
      valueSpan.className = `ds-jsonview__value ds-jsonview__value--${node.type}`;
      if (node.entries) valueSpan.textContent = node.entries.length ? shown(node) : node.type === 'array' ? '[]' : '{}';
      else paint(valueSpan, shown(node));
      text.append(valueSpan);
    }
    row.append(text);
    if (!range && node.entries?.length) {
      const meta = doc.createElement('span');
      meta.className = 'ds-tree__meta';
      meta.textContent = countOf(node);
      row.append(meta);
    }
    if (!range) {
      const actions = doc.createElement('span');
      actions.className = 'ds-tree__actions ds-jsonview__actions';
      const where = pathOf(segments);
      const what = label === undefined ? where : String(label);
      const copyValue = button(copyGlyph, t('jsonCopyValue', { label: what }), 'copy-value');
      const copyPath = button(linkGlyph, t('jsonCopyPath', { label: what }), 'copy-path');
      for (const control of [copyValue, copyPath]) {
        control.classList.replace('ds-sm', 'ds-xs');
        control.tabIndex = -1;
      }
      actions.append(copyValue, copyPath);
      row.append(actions);
    }
    li.append(row);
    budget.rows -= 1;
    if (folder) {
      const openNow = depth > 0 && budget.rows > 0;
      li.setAttribute('aria-expanded', openNow ? 'true' : 'false');
      if (openNow) li.append(group(children(entry), depth - 1, budget));
      else li.setAttribute('data-ds-tree-lazy', '');
    }
    return li;
  };

  /** The entries (or ranges) a row opens into. */
  const children = (entry) => {
    const { node, trail, segments, range } = entry;
    const from = range ? range[0] : 0;
    const to = range ? range[1] : node.entries.length;
    const buckets = ranges(from, to);
    if (buckets.length) return buckets.map((bucket) => ({ node, trail, segments, range: bucket }));
    const out = [];
    for (let index = from; index < to; index += 1) {
      const [key, child] = node.entries[index];
      out.push({ node: child, trail: [...trail, index], segments: [...segments, key], label: key });
    }
    return out;
  };

  const group = (entries, depth, budget) => {
    const ul = doc.createElement('ul');
    ul.className = 'ds-tree__group';
    ul.setAttribute('role', 'group');
    for (const entry of entries) ul.append(item(entry, depth, budget));
    return ul;
  };

  const tree = treeOf(list, {
    select: 'single',
    load: (li) => {
      const entry = nodes.get(li.getAttribute('data-ds-key'));
      if (!entry) return [];
      const budget = { rows: Infinity };
      return children(entry).map((child) => item(child, 0, budget));
    },
  });

  /** Renders the model again: `depth` levels open, at most `rows` rows. */
  const render = (depth = Number(options.open) || 0, rows = EXPAND_LIMIT) => {
    nodes.clear();
    const chosen = tree.get();
    const focused = list.contains(doc.activeElement);
    const budget = { rows };
    const below = Math.max(0, depth - 1);
    let top;
    if (!model) top = [];
    else if (model.entries?.length) top = children({ node: model, trail: [], segments: [] }).map((entry) => item(entry, below, budget));
    else top = [item({ node: model, trail: [], segments: [] }, below, budget)];
    list.replaceChildren(...top);
    if (chosen && list.querySelector(`[data-ds-key="${chosen}"]`)) tree.set(chosen);
    if (focused) tree.focus(list.querySelector('[role="treeitem"]'));
    if (query) find(query, { quiet: true });
  };

  const fail = (error) => {
    model = null;
    list.replaceChildren();
    problem.replaceChildren(iconElement(alertCircle, 20, undefined, doc), doc.createTextNode(t('jsonInvalid', { line: error.line ?? 1, column: error.column ?? 1 })));
    problem.hidden = false;
    bar.hidden = true;
    el.setAttribute('data-state', 'error');
    emit(el, 'error', { error });
  };

  const load = (next) => {
    problem.hidden = true;
    bar.hidden = !options.search;
    el.removeAttribute('data-state');
    try {
      if (Object.hasOwn(next, 'text')) {
        source = String(next.text ?? '');
        model = parse(source);
      } else {
        model = fromValue(next.value);
        source = stringify(model, 2);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
      fail(error);
      return;
    }
    render();
  };

  /* ── Search ────────────────────────────────── */

  const showCount = () => {
    count.textContent = !query ? '' : matches.length ? t('jsonMatch', { current: current + 1, total: matches.length >= MATCH_LIMIT ? `${MATCH_LIMIT}+` : matches.length }) : t('noResults');
    previous.disabled = matches.length < 2;
    next.disabled = matches.length < 2;
  };

  /** The keys of the rows from the top down to the entry at `trail`, ranges included. */
  const chain = (trail) => {
    const keys = [];
    let node = model;
    for (let depth = 0; depth < trail.length; depth += 1) {
      const index = trail[depth];
      const above = trail.slice(0, depth);
      // The ranges that hold this index, outermost first.
      let bucket = ranges(0, node.entries.length).find(([start, end]) => index >= start && index < end);
      while (bucket) {
        keys.push(keyFor(above, bucket));
        const [start, end] = bucket;
        bucket = ranges(start, end).find(([first, last]) => index >= first && index < last);
      }
      keys.push(keyFor(trail.slice(0, depth + 1)));
      node = node.entries[index][1];
    }
    return keys;
  };

  const reveal = async (index) => {
    if (!matches.length) return;
    current = (index + matches.length) % matches.length;
    showCount();
    const keys = chain(matches[current]);
    for (const key of keys.slice(0, -1)) {
      if (signal.aborted) return;
      await tree.expand(key, true);
    }
    const target = keys.at(-1);
    const row = target ? list.querySelector(`[data-ds-key="${target}"]`) : list.querySelector('[role="treeitem"]');
    if (!row) return;
    tree.set(row.getAttribute('data-ds-key'));
    row.querySelector(':scope > .ds-tree__row')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    emit(el, 'search', { query, total: matches.length, index: current });
  };

  const repaint = () => {
    for (const span of list.querySelectorAll('.ds-jsonview__key, .ds-jsonview__value:not(.ds-jsonview__value--object, .ds-jsonview__value--array)')) {
      const entry = nodes.get(span.closest('[role="treeitem"]')?.getAttribute('data-ds-key'));
      if (!entry) continue;
      if (span.classList.contains('ds-jsonview__key')) {
        if (typeof entry.label === 'string') paint(span, entry.label);
      } else paint(span, shown(entry.node));
    }
  };

  const find = (text, { quiet = false } = {}) => {
    query = String(text ?? '').trim();
    if (field.value.trim() !== query) field.value = query;
    matches = model ? search(model, query) : [];
    current = -1;
    repaint();
    showCount();
    if (!quiet && query) announce(matches.length ? t('jsonMatch', { current: 1, total: matches.length }) : t('noResults'), { key: 'jsonview-match' });
    if (matches.length) return reveal(0);
    emit(el, 'search', { query, total: 0, index: -1 });
    return Promise.resolve();
  };

  let typing = 0;
  field.addEventListener('input', () => {
    doc.defaultView.clearTimeout(typing);
    // One search per pause in typing, not per key.
    typing = doc.defaultView.setTimeout(() => find(field.value), motionDuration(el, '--ds-dur-fast'));
  }, { signal });
  field.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      doc.defaultView.clearTimeout(typing);
      if (field.value.trim() !== query) find(field.value);
      else if (matches.length) {
        reveal(current + (event.shiftKey ? -1 : 1));
        announce(t('jsonMatch', { current: current + 1, total: matches.length }), { key: 'jsonview-match' });
      }
    } else if (event.key === 'Escape' && field.value) {
      // The field clears first; a dialog around it stays open.
      event.preventDefault();
      field.value = '';
      find('');
    }
  }, { signal });

  /* ── Actions ───────────────────────────────── */

  const copyFrom = async (control, kind) => {
    const entry = nodes.get(control.closest('[role="treeitem"]')?.getAttribute('data-ds-key'));
    if (!entry) return;
    const path = pathOf(entry.segments);
    const text = kind === 'path' ? path : copied(entry.node);
    const ok = await copyText(doc, text);
    if (!ok) return;
    announce(t('copied'));
    emit(el, 'copy', { kind, text, path });
  };

  el.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const control = event.target.closest?.('[data-ds-jsonview-action]');
    if (!control || !el.contains(control) || control.disabled) return;
    const action = control.getAttribute('data-ds-jsonview-action');
    if (action === 'copy-value') copyFrom(control, 'value');
    else if (action === 'copy-path') copyFrom(control, 'path');
    else if (action === 'next') reveal(current + 1);
    else if (action === 'previous') reveal(current - 1);
    else if (action === 'expand') render(Infinity, EXPAND_LIMIT);
    else if (action === 'collapse') tree.expandAll(false);
  }, { signal });

  /* ── Start ─────────────────────────────────── */

  if (Object.hasOwn(initial, 'value')) load({ value: initial.value });
  else if (Object.hasOwn(initial, 'text')) load({ text: initial.text });
  else load({ text: source0 ? source0.textContent : '' });
  showCount();

  const handle = {
    /** The value: objects, arrays and primitives, integers beyond 2^53 as BigInt; null for text that is no JSON. */
    get() {
      return model ? toValue(model) : null;
    },
    /** A new value (any JavaScript value JSON can write). */
    set(value) {
      load({ value });
    },
    /** New JSON text; numbers keep the digits as written. */
    setText(text) {
      load({ text });
    },
    /** The JSON text, every number as written (2 spaces per level). */
    text() {
      return model ? stringify(model, 2) : source;
    },
    /** Marks the keys and values that hold `query`, reveals the first; resolves once it shows. */
    search(text) {
      return find(text);
    },
    /** The matches of the search: { query, total, index }. */
    matches() {
      return { query, total: matches.length, index: current };
    },
    /** Opens every level (at most 1500 rows), or closes all. */
    expandAll(open = true) {
      if (open) render(Infinity, EXPAND_LIMIT);
      else tree.expandAll(false);
    },
    /** The DS.tree controller of the rows. */
    tree() {
      return tree;
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === el || event.target === list) fn(event.detail);
      };
      el.addEventListener(`ds:${type}`, listener, { signal });
      return () => el.removeEventListener(`ds:${type}`, listener);
    },
    /** Options again: open, search. */
    configure(more = {}) {
      options = { ...options, ...more };
      bar.hidden = !options.search;
      if (Object.hasOwn(more, 'open')) render();
    },
    update() {
      nameTree();
      handle.configure(attributeOptions(el));
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      doc.defaultView?.clearTimeout(typing);
      tree.destroy();
      bar.remove();
      problem.remove();
      list.remove();
      if (source0) source0.hidden = false;
      el.removeAttribute('data-state');
      if (instances.get(el) === handle) instances.delete(el);
    },
  };
  instances.set(el, handle);
  return handle;
}

const attributeOptions = (el) => {
  const open = el.getAttribute('data-ds-jsonview-open');
  return {
    ...(open !== null && open !== '' && !Number.isNaN(Number(open)) ? { open: Number(open) } : {}),
    search: el.getAttribute('data-ds-jsonview-search') !== 'off',
  };
};

define('jsonview', {
  attribute: 'data-ds-jsonview',
  attributes: ['data-ds-jsonview-open', 'data-ds-jsonview-search'],
  init(el) {
    return instances.get(el) ?? controller(el, attributeOptions(el));
  },
});

/**
 * A JSON viewer driven from the page, or new options for one the attribute
 * path made: the same controller. `value` (a JavaScript value) or `text`
 * (JSON text) is the document; `open` how many levels show open (default 1);
 * `search: false` leaves out the search bar.
 * @param {Element} el
 * @param {{ value?: any, text?: string, open?: number, search?: boolean }} [options]
 */
export function create(el, options = {}) {
  if (!el?.ownerDocument) return { get: () => null, set() {}, setText() {}, text: () => '', search: () => Promise.resolve(), matches: () => ({ query: '', total: 0, index: -1 }), expandAll() {}, tree: () => null, on: () => () => {}, configure() {}, update() {}, destroy() {} };
  const existing = instances.get(el);
  if (existing) {
    if (Object.hasOwn(options, 'value')) existing.set(options.value);
    else if (Object.hasOwn(options, 'text')) existing.setText(options.text);
    const { value, text, ...rest } = options;
    if (Object.keys(rest).length) existing.configure(rest);
    return existing;
  }
  return controller(el, { ...attributeOptions(el), ...options });
}
