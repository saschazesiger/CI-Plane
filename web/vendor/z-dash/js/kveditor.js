/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Key-value editor (DS.kveditor): rows of a key and a value, added and
 * removed, filled by pasting KEY=value lines, a warning on a key that comes
 * twice, secret values that hide until revealed, and the whole as an
 * object.
 *
 *   <fieldset class="ds-kveditor" data-ds-kveditor data-ds-kveditor-name="env" data-ds-kveditor-secret="TOKEN|SECRET|PASSWORD"
 *             data-ds-value='{"API_URL":"https://api.example.test","API_TOKEN":"abc"}'>
 *     <legend class="ds-fieldset__legend">Environment variables</legend>
 *     <div class="ds-kveditor__head" aria-hidden="true"><span>Key</span><span>Value</span></div>
 *     <ul class="ds-kveditor__rows"></ul>                      (rows: the module's)
 *     <div class="ds-kveditor__foot"><button class="ds-btn ds-btn--text ds-kveditor__add" type="button">(plus) Add variable</button></div>
 *   </fieldset>
 *
 *   const editor = DS.get(el, 'kveditor');      // or DS.kveditor.create(el, { value })
 *   editor.toObject();                          // { API_URL: '…', API_TOKEN: 'abc' }
 *   DS.kveditor.parse('A=1\nexport B="two"');   // [{ key: 'A', value: '1' }, { key: 'B', value: 'two' }]
 *
 * The value: data-ds-value (JSON: an object, or a list of { key, value,
 * secret }) at the start, set() from the page. Rows are the module's own
 * (DOM APIs, keyed by data-ds-key); the inputs hold the state while one
 * edits. With data-ds-kveditor-name a hidden input of that name carries
 * the object as JSON (data-ds-kveditor-format="env": KEY=value lines), so a
 * plain form submits it.
 *
 * Keys: Enter in a key goes to its value; Enter in a value goes to the next
 * row's key, or adds a row after the last one. Remove moves focus to the
 * next row, else the one before, else Add. Pasting text with KEY=value
 * lines into a key (or several such lines into a value) fills the row and
 * adds the rest after it; other text pasted into a value (a certificate,
 * a JSON document) stays the value, as the field takes it.
 *
 * Strings: kv* keys of DS.core.config({ strings }) and remove.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { flip } from './motion.js';
import { announce } from './a11y.js';
import { iconElement, alert as alertGlyph, close, eye, eyeOff, plus } from './icons.js';

let serial = 0;

/** A line that assigns: `KEY=…` or `export KEY=…`. */
const ASSIGNMENT = /^\s*(export\s+)?[A-Za-z_][\w.-]*\s*=/;

/**
 * Whether pasted text is KEY=value lines (every line that is not blank or
 * a # comment assigns), not a value that happens to span lines (a PEM
 * block, a JSON document).
 */
const assignments = (text) => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  return lines.length > 0 && lines.every((line) => ASSIGNMENT.test(line));
};

/** A double-quoted value as dotenv reads it: \n, \", \\ and \t. */
const unescape = (text) => text.replace(/\\([nrt"\\])/g, (match, char) => ({ n: '\n', r: '\r', t: '\t' })[char] ?? char);

/**
 * KEY=value lines as rows: blank lines and # comments are skipped, a
 * leading `export ` goes, a value in single quotes stays as it is, one in
 * double quotes has its escapes read, an unquoted one loses a trailing
 * ` # comment` and its blanks. A line without = is a key with an empty value.
 * @param {string} text
 * @returns {{ key: string, value: string }[]}
 */
export function parse(text) {
  const rows = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.replace(/^export\s+/, '');
    const at = body.indexOf('=');
    if (at < 0) {
      rows.push({ key: body, value: '' });
      continue;
    }
    const key = body.slice(0, at).trim();
    let value = body.slice(at + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.lastIndexOf(quote) > 0) {
      const inner = value.slice(1, value.lastIndexOf(quote));
      value = quote === '"' ? unescape(inner) : inner;
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    if (key) rows.push({ key, value });
  }
  return rows;
}

/**
 * Rows as KEY=value lines; a value with blanks, quotes, # or line breaks
 * goes in double quotes with its escapes. Rows without a key are left out.
 * @param {Iterable<{ key: string, value: string }>} rows
 * @returns {string}
 */
export function stringify(rows) {
  const lines = [];
  for (const { key, value } of rows ?? []) {
    if (!String(key ?? '').trim()) continue;
    const text = String(value ?? '');
    const quoted = /[\s"'#\\]|^$/.test(text) && text !== ''
      ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
      : text;
    lines.push(`${String(key).trim()}=${quoted}`);
  }
  return lines.join('\n');
}

/**
 * The keys that come more than once (trimmed, case-sensitive, empty ones
 * aside), each with the indices of its rows.
 * @param {Iterable<{ key: string }>} rows
 * @returns {Map<string, number[]>}
 */
export function duplicates(rows) {
  const seen = new Map();
  let index = 0;
  for (const { key } of rows ?? []) {
    const name = String(key ?? '').trim();
    if (name) seen.set(name, [...(seen.get(name) ?? []), index]);
    index += 1;
  }
  for (const [name, list] of seen) if (list.length < 2) seen.delete(name);
  return seen;
}

/**
 * Rows as an object: trimmed keys, the last row of a key wins, rows without
 * a key are left out.
 * @param {Iterable<{ key: string, value: string }>} rows
 * @returns {Record<string, string>}
 */
export function toObject(rows) {
  const object = {};
  for (const { key, value } of rows ?? []) {
    const name = String(key ?? '').trim();
    if (name) object[name] = String(value ?? '');
  }
  return object;
}

/** An object, a list of rows or KEY=value text as rows. */
function rowsOf(value) {
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try {
      return rowsOf(JSON.parse(value));
    } catch {
      return parse(value);
    }
  }
  if (Array.isArray(value)) {
    return value.map((row) => (Array.isArray(row) ? { key: String(row[0] ?? ''), value: String(row[1] ?? '') } : { key: String(row?.key ?? ''), value: String(row?.value ?? ''), secret: row?.secret === true }));
  }
  if (typeof value === 'object') return Object.entries(value).map(([key, text]) => ({ key, value: String(text ?? '') }));
  return [];
}

function make(doc, tag, className, attributes = {}) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/** A pattern from an attribute or option: a RegExp, its source (case-insensitive), or null. */
function patternOf(value) {
  if (value instanceof RegExp) return value;
  if (!value) return null;
  try {
    return new RegExp(String(value), 'i');
  } catch {
    return null;
  }
}

function readOptions(el) {
  return {
    value: el.getAttribute('data-ds-value'),
    name: el.getAttribute('data-ds-kveditor-name'),
    format: el.getAttribute('data-ds-kveditor-format') === 'env' ? 'env' : 'json',
    secret: patternOf(el.getAttribute('data-ds-kveditor-secret')),
  };
}

function controller(el, options, signal) {
  const doc = el.ownerDocument;
  const listeners = new Map();
  let list = el.querySelector('.ds-kveditor__rows');
  if (!list) {
    list = make(doc, 'ul', 'ds-kveditor__rows');
    el.append(list);
  }
  let addButton = el.querySelector('.ds-kveditor__add');
  if (!addButton) {
    const foot = el.querySelector('.ds-kveditor__foot') ?? make(doc, 'div', 'ds-kveditor__foot');
    addButton = make(doc, 'button', 'ds-btn ds-btn--text ds-kveditor__add', { type: 'button' });
    addButton.append(iconElement(plus, 18, '', doc), doc.createTextNode(t('kvAdd')));
    foot.append(addButton);
    if (!foot.isConnected) el.append(foot);
  }
  let hidden = null;
  if (options.name) {
    hidden = make(doc, 'input', '', { type: 'hidden', name: options.name });
    el.append(hidden);
  }

  /** The rows that stay: one that leaves (DS.motion.flip keeps it for its exit) no longer counts. */
  const live = () => [...list.children].filter((row) => !row.hasAttribute('data-ds-leaving') && !row.inert);

  /** The rows in order: { el, key, value, secret }. */
  const read = () => live().map((row) => {
    const key = row.querySelector('.ds-kveditor__key');
    const value = row.querySelector('.ds-kveditor__input');
    return { el: row, key: key?.value ?? '', value: value?.value ?? '', secret: row.hasAttribute('data-secret') };
  });
  const rows = () => read().map(({ key, value, secret }) => ({ key, value, secret }));

  const notify = (type, detail) => {
    if (signal?.aborted) return;
    emit(el, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  };

  const isSecret = (key, given) => given === true || Boolean(options.secret?.test(String(key ?? '').trim()));

  /* ── A row ─────────────────────────────── */

  const reveal = (row, show) => {
    const input = row.querySelector('.ds-kveditor__input');
    const button = row.querySelector('.ds-kveditor__reveal');
    if (!input || !button) return;
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    button.replaceChildren(iconElement(show ? eyeOff : eye, 18, '', doc));
  };

  /** Turns a row's value into a secret one (masked, with Reveal) or back. */
  const secretRow = (row, on) => {
    if (on === row.hasAttribute('data-secret')) return;
    const group = row.querySelector('.ds-kveditor__value');
    const input = row.querySelector('.ds-kveditor__input');
    const hadFocus = doc.activeElement === input;
    if (on) {
      row.setAttribute('data-secret', '');
      input.type = 'password';
      const button = make(doc, 'button', 'ds-btn ds-btn--quiet ds-btn--icon ds-sm ds-kveditor__reveal', { type: 'button', 'aria-pressed': 'false' });
      group.append(button);
      reveal(row, false);
    } else {
      row.removeAttribute('data-secret');
      input.type = 'text';
      row.querySelector('.ds-kveditor__reveal')?.remove();
    }
    group.classList.toggle('ds-input-group', on);
    if (hadFocus) input.focus();
  };

  const build = (data) => {
    const id = `kv-${++serial}`;
    const row = make(doc, 'li', 'ds-kveditor__row', { 'data-ds-key': id });
    const key = make(doc, 'input', 'ds-input ds-kveditor__key', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    key.value = data.key ?? '';
    const group = make(doc, 'div', 'ds-kveditor__value');
    const value = make(doc, 'input', 'ds-input ds-kveditor__input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    value.value = data.value ?? '';
    group.append(value);
    const remove = make(doc, 'button', 'ds-btn ds-btn--quiet ds-btn--icon ds-kveditor__remove', { type: 'button', 'data-tip': t('remove') });
    remove.append(iconElement(close, 20, '', doc));
    const hint = make(doc, 'p', 'ds-kveditor__hint', { id: `${id}-hint` });
    hint.hidden = true;
    row.append(key, group, remove, hint);
    if (isSecret(data.key, data.secret)) secretRow(row, true);
    return row;
  };

  /** Names, warnings and the hidden input, from what the rows hold now. */
  const refresh = () => {
    const current = read();
    const twice = duplicates(current);
    current.forEach((row, index) => {
      const number = index + 1;
      const key = row.el.querySelector('.ds-kveditor__key');
      const value = row.el.querySelector('.ds-kveditor__input');
      const name = row.key.trim();
      key.setAttribute('aria-label', t('kvKeyLabel', { row: number }));
      value.setAttribute('aria-label', name ? t('kvValueOf', { key: name }) : t('kvValueLabel', { row: number }));
      row.el.querySelector('.ds-kveditor__remove').setAttribute('aria-label', name ? t('kvRemove', { key: name }) : t('kvRemoveRow', { row: number }));
      const button = row.el.querySelector('.ds-kveditor__reveal');
      if (button) button.setAttribute('aria-label', name ? t('kvShow', { key: name }) : t('kvShowRow', { row: number }));
      let message = '';
      const others = twice.get(name);
      if (others) message = t('kvDuplicate', { key: name, rows: others.filter((other) => other !== index).map((other) => other + 1).join(', ') });
      else if (!name && row.value) message = t('kvNoKey');
      const hint = row.el.querySelector('.ds-kveditor__hint');
      if (message) {
        if (hint.hidden || !hint.firstChild) hint.replaceChildren(iconElement(alertGlyph, 16, '', doc), make(doc, 'span'));
        hint.lastChild.textContent = message;
        hint.hidden = false;
        row.el.setAttribute('data-status', 'warning');
        key.setAttribute('aria-describedby', hint.id);
      } else if (!hint.hidden) {
        hint.hidden = true;
        row.el.removeAttribute('data-status');
        key.removeAttribute('aria-describedby');
      }
    });
    if (hidden) {
      const object = toObject(current);
      hidden.value = options.format === 'env' ? stringify(current) : JSON.stringify(object);
    }
    return { current, twice };
  };

  const changed = () => {
    const { current, twice } = refresh();
    const data = current.map(({ key, value, secret }) => ({ key, value, secret }));
    notify('change', { rows: data, value: toObject(data), duplicates: [...twice.keys()] });
  };

  /* ── Adding and removing ───────────────── */

  const insert = (datas, after = null) => {
    const fresh = datas.map(build);
    flip(list, () => {
      if (after) after.after(...fresh);
      else list.append(...fresh);
    });
    return fresh;
  };

  const focusRow = (row, part = '.ds-kveditor__key') => row?.querySelector(part)?.focus();

  const add = (data = {}, index) => {
    const before = Number.isInteger(index) ? live()[index] ?? null : null;
    const fresh = build(data);
    flip(list, () => {
      if (before) before.before(fresh);
      else list.append(fresh);
    });
    changed();
    return fresh;
  };

  /** Takes a row out; focus inside it moves to `part` of the next row, else the one before, else Add. */
  const removeRow = (row, part = '.ds-kveditor__key') => {
    const siblings = live();
    if (!row || !siblings.includes(row)) return Promise.resolve();
    const at = siblings.indexOf(row);
    const name = row.querySelector('.ds-kveditor__key').value.trim();
    const next = siblings[at + 1] ?? siblings[at - 1] ?? null;
    const hadFocus = row.contains(doc.activeElement);
    const done = flip(list, () => row.remove(), { refocus: false });
    if (hadFocus) {
      if (next) focusRow(next, part);
      else addButton.focus();
    }
    announce(name ? t('kvRemoved', { key: name }) : t('kvRemovedRow'));
    changed();
    return done;
  };

  /* ── Events of the rows ────────────────── */

  addButton.addEventListener('click', () => {
    focusRow(add({}));
  }, { signal });

  list.addEventListener('click', (event) => {
    const button = event.target.closest?.('.ds-kveditor__remove, .ds-kveditor__reveal');
    if (!button || !list.contains(button)) return;
    const row = button.closest('.ds-kveditor__row');
    if (button.classList.contains('ds-kveditor__reveal')) reveal(row, button.getAttribute('aria-pressed') !== 'true');
    // Focus goes to the next row's Remove, so several go one after another.
    else removeRow(row, '.ds-kveditor__remove');
  }, { signal });

  list.addEventListener('input', (event) => {
    const row = event.target.closest?.('.ds-kveditor__row');
    if (!row) return;
    if (event.target.classList.contains('ds-kveditor__key') && options.secret) {
      // A key that names a secret hides its value; the row's own choice stays.
      if (!row.hasAttribute('data-secret-given')) secretRow(row, isSecret(event.target.value));
    }
    changed();
  }, { signal });

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const field = event.target;
    const row = field.closest?.('.ds-kveditor__row');
    if (!row) return;
    if (field.classList.contains('ds-kveditor__key')) {
      event.preventDefault();
      focusRow(row, '.ds-kveditor__input');
    } else if (field.classList.contains('ds-kveditor__input')) {
      event.preventDefault();
      const rows = live();
      const next = rows[rows.indexOf(row) + 1];
      if (next) focusRow(next);
      else if (row.querySelector('.ds-kveditor__key').value.trim()) focusRow(add({}));
    }
  }, { signal });

  list.addEventListener('paste', (event) => {
    const field = event.target;
    const row = field.closest?.('.ds-kveditor__row');
    if (!row || !field.classList.contains('ds-input')) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const isKey = field.classList.contains('ds-kveditor__key');
    // Into a value only KEY=value lines spread over rows; other text (a
    // certificate, say) is the value, pasted as the field takes it.
    if (isKey ? !(text.includes('\n') || text.includes('=')) : !(text.includes('\n') && assignments(text))) return;
    const pairs = parse(text);
    if (!pairs.length) return;
    event.preventDefault();
    const key = row.querySelector('.ds-kveditor__key');
    const value = row.querySelector('.ds-kveditor__input');
    let anchor = row;
    let rest = pairs;
    if (!key.value.trim() && !value.value) {
      key.value = pairs[0].key;
      value.value = pairs[0].value;
      if (isSecret(pairs[0].key)) secretRow(row, true);
      rest = pairs.slice(1);
    }
    const fresh = rest.length ? insert(rest, anchor) : [];
    anchor = fresh.at(-1) ?? row;
    focusRow(anchor, '.ds-kveditor__input');
    announce(t('kvPasted', { count: pairs.length }));
    changed();
  }, { signal });

  /* ── Start ─────────────────────────────── */

  const start = rowsOf(options.value);
  list.replaceChildren(...start.map((data) => {
    const row = build(data);
    if (data.secret === true) row.setAttribute('data-secret-given', '');
    return row;
  }));
  refresh();

  return {
    get: rows,
    set(value) {
      const next = rowsOf(value);
      list.replaceChildren(...next.map((data) => {
        const row = build(data);
        if (data.secret === true) row.setAttribute('data-secret-given', '');
        return row;
      }));
      changed();
    },
    add(row = {}, index) {
      return add(row, index);
    },
    remove(index) {
      return removeRow(live()[index]);
    },
    toObject() {
      return toObject(rows());
    },
    toText() {
      return stringify(rows());
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    destroy() {
      listeners.clear();
      hidden?.remove();
    },
  };
}

define('kveditor', {
  attribute: 'data-ds-kveditor',
  init(el, ctx) {
    return controller(el, readOptions(el), ctx.signal);
  },
});

/**
 * A key-value editor driven from the page; the same controller the
 * attribute path makes. `options` override the attributes.
 * @param {Element} el
 * @param {{ value?: Record<string, string>|{ key: string, value: string, secret?: boolean }[]|string, name?: string, format?: 'json'|'env', secret?: RegExp|string }} [options]
 */
export function create(el, options = {}) {
  const given = { ...readOptions(el), ...options };
  if (options.secret !== undefined) given.secret = patternOf(options.secret);
  const handle = new AbortController();
  const api = controller(el, given, handle.signal);
  const destroy = api.destroy;
  api.destroy = () => {
    handle.abort();
    destroy();
  };
  return api;
}
