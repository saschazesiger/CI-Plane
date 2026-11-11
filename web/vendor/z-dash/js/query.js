/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Query input (DS.query): a search field whose filters become tokens, such
 * as `status:open` or `priority:>2`, with suggestions for keys, operators
 * and values, saved queries and keyboard editing of the tokens. It emits a
 * structured query.
 *
 *   <div class="ds-query" data-ds-query data-ds-query-store="tickets" data-ds-query-name="q"
 *        data-ds-query-keys='[{ "key": "status", "label": "Status", "values": ["open", "pending", "closed"] }]'>
 *     <label class="ds-field__label" for="q">Filter tickets</label>
 *     <div class="ds-query__row">
 *       <div class="ds-combo ds-combo--multi ds-query__box">
 *         <span class="ds-query__icon">(search 20)</span>
 *         <span class="ds-query__tokens"> (the tokens: .ds-chip.ds-chip--input.ds-query__token, written) </span>
 *         <input class="ds-input ds-combo__input ds-query__input" id="q" role="combobox" aria-expanded="false" aria-autocomplete="list">
 *         <button class="ds-combo__clear" type="button" hidden>(close 20)</button>
 *         <div class="ds-combo__popup" hidden>
 *           <div class="ds-combo__list" role="listbox"></div><p class="ds-combo__status" role="status"></p></div></div>
 *       <button class="ds-btn ds-btn--icon ds-query__save" type="button">(bookmark 20)</button></div></div>
 *
 *   el.addEventListener('ds:change', ({ detail }) => load(detail.filters, detail.text));
 *   const query = DS.get(el, 'query');              // or DS.query.create(el, options)
 *   query.set('status:open assignee:"Ada Lovelace"');
 *
 * The language: `key:value`, several values as `key:a,b` (any of them),
 * quotes for spaces (`key:"two words"`), `-key:value` or `key:!value` for
 * "is not", `key:>3`, `key:>=3`, `key:<3`, `key:<=3` for keys that compare
 * (type number or date, or `operators`). Words that are no filter are the
 * free text. A key the page did not name, a value outside a key's list, a
 * number or date that is none, or an operator the key does not take makes
 * an invalid token: the error tone, its icon and the reason in its name.
 *
 * Typing: the list suggests keys (with the saved queries while the field is
 * empty), then, after `key:`, the operators a key compares with and its
 * values; Enter or a click takes one. Space after a complete filter, or
 * Enter, turns the typed text into tokens; Enter in an empty field sends
 * ds:submit. Backspace in an empty field takes the last token back into
 * the field to edit it; ArrowLeft at its start moves to the tokens, where
 * the arrows, Home and End move, Backspace and Delete remove, F2 edits and
 * a press removes (an input chip). Escape closes the list, then clears the
 * typed text.
 *
 * Saved queries (DS.store, namespace `query`, the key data-ds-query-store;
 * memory only without it): .ds-query__save asks for a name
 * (DS.overlay.prompt) and keeps the query; the list shows them while the
 * field is empty; Delete on one removes it.
 *
 * Strings: query* keys of DS.core.config({ strings }).
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { morphHtml } from './dom.js';
import { open as openOverlay, close as closeOverlay, prompt } from './overlay.js';
import { announce } from './a11y.js';
import { open as openStore } from './store.js';
import { icon, alertCircle, close as closeGlyph } from './icons.js';

/** The operators and how they are written after the colon. */
const OPS = { is: '', not: '!', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** What a key compares with by its type. */
const TYPE_OPS = { number: ['is', 'not', 'gt', 'gte', 'lt', 'lte'], date: ['is', 'not', 'gt', 'gte', 'lt', 'lte'] };

/** The words of the operators (strings). */
const OP_WORD = { is: 'queryIs', not: 'queryNot', gt: 'queryGt', gte: 'queryGte', lt: 'queryLt', lte: 'queryLte' };

/** The operators a person reads in a token (is: a colon after the key). */
const OP_MARK = { not: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };

/** A filter as typed: optional minus, a key, the colon, an operator and the rest. */
const TERM = /^(-?)([A-Za-z_][\w.-]*):(>=|<=|>|<|!)?([\s\S]*)$/;

let serial = 0;

/** Text for markup. */
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/**
 * Splits text at the spaces outside quotes (and, with `separator`, at that
 * character); quotes stay in the parts. A backslash escapes the next
 * character inside quotes.
 * @param {string} text
 * @param {string} [separator]
 * @returns {string[]}
 */
function split(text, separator = '') {
  const parts = [];
  let part = '';
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quoted && char === '\\' && at + 1 < text.length) {
      part += char + text[at + 1];
      at += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && (separator ? char === separator : /\s/.test(char))) {
      if (part || separator) parts.push(part);
      part = '';
      continue;
    }
    part += char;
  }
  if (part || separator) parts.push(part);
  return parts;
}

/** A value without its quotes and escapes. */
function unquote(value) {
  const text = String(value).trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\(.)/g, '$1');
  return text.replace(/^"/, '');
}

/** A value as it is written: quoted when it holds a space, a comma, a quote or nothing. */
function quote(value) {
  const text = String(value ?? '');
  return /[\s,"\\]/.test(text) || !text || /^[-!<>]/.test(text) ? `"${text.replace(/["\\]/g, '\\$&')}"` : text;
}

/**
 * The keys a query knows, from an array of objects or of names.
 * @param {Array<string|object>|null|undefined} keys
 */
function keyMap(keys) {
  const map = new Map();
  for (const entry of keys ?? []) {
    const spec = typeof entry === 'string' ? { key: entry } : entry;
    if (!spec?.key) continue;
    const values = (spec.values ?? []).map((value) => (typeof value === 'object' ? { value: String(value.value), label: String(value.label ?? value.value), description: value.description ?? '' } : { value: String(value), label: String(value), description: '' }));
    const operators = spec.operators ?? TYPE_OPS[spec.type] ?? ['is', 'not'];
    map.set(spec.key.toLowerCase(), { key: spec.key, label: spec.label ?? spec.key, description: spec.description ?? '', type: spec.type ?? 'text', values, operators, free: Boolean(spec.free) });
  }
  return map;
}

/** Whether a value fits its key: one of its values, a number, a date. Returns the canonical value or null. */
function fit(spec, value) {
  if (!spec) return value;
  if (spec.values.length && !spec.free) {
    const lower = value.toLowerCase();
    const found = spec.values.find((entry) => entry.value.toLowerCase() === lower || entry.label.toLowerCase() === lower);
    return found ? found.value : null;
  }
  if (spec.type === 'number') return value.trim() !== '' && Number.isFinite(Number(value)) ? value : null;
  if (spec.type === 'date') return /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
  return value;
}

/**
 * Reads a query: the filters as terms `{ key, op, values }` (`op`: is, not,
 * gt, gte, lt, lte; `values`: one or more, any of them), free words as one
 * text term `{ key: null, op: 'is', values: [text] }` for each run of
 * words between filters. With `keys`, a filter of an unknown key, a value
 * outside its key's list, a number or date that is none or an operator the
 * key does not take gets `invalid` ('key', 'value' or 'op'); the key and
 * values are then as written.
 * @param {string} text
 * @param {Array<string|{ key: string, label?: string, type?: 'text'|'number'|'date', values?: Array<string|{ value: string, label?: string }>, operators?: string[], free?: boolean }>} [keys]
 * @returns {Array<{ key: string|null, op: string, values: string[], invalid?: 'key'|'value'|'op' }>}
 */
export function parse(text, keys) {
  const known = keyMap(keys);
  const strict = known.size > 0;
  const terms = [];
  let words = [];
  const flush = () => {
    if (!words.length) return;
    terms.push({ key: null, op: 'is', values: [words.join(' ')] });
    words = [];
  };
  for (const part of split(String(text ?? ''))) {
    const match = TERM.exec(part);
    if (!match) {
      const word = unquote(part);
      if (word) words.push(word);
      continue;
    }
    flush();
    const [, minus, rawKey, mark = '', rest] = match;
    const spec = known.get(rawKey.toLowerCase());
    let op = Object.keys(OPS).find((name) => OPS[name] === mark) ?? 'is';
    if (minus) op = op === 'is' ? 'not' : op;
    const values = split(rest, ',').map(unquote).filter((value) => value !== '');
    const term = { key: spec ? spec.key : rawKey, op, values };
    if (strict && !spec) term.invalid = 'key';
    else if (!values.length) term.invalid = 'value';
    else if ((minus && mark) || (spec && !spec.operators.includes(op))) term.invalid = 'op';
    else if (spec) {
      const fitted = values.map((value) => fit(spec, value));
      if (fitted.includes(null)) term.invalid = 'value';
      else term.values = fitted;
    }
    if ((op !== 'is' && op !== 'not') && term.values.length > 1 && !term.invalid) term.invalid = 'value';
    terms.push(term);
  }
  flush();
  return terms;
}

/**
 * Writes terms back as text that parse() reads the same way.
 * @param {Array<{ key: string|null, op?: string, values: string[] }>} terms
 * @returns {string}
 */
export function stringify(terms) {
  return (terms ?? []).map((term) => {
    if (!term.key) return (term.values ?? []).map((word) => split(String(word)).map((part) => (TERM.test(part) || part.includes('"') ? `"${part.replace(/["\\]/g, '\\$&')}"` : part)).join(' ')).join(' ');
    const op = term.op ?? 'is';
    const prefix = op === 'not' ? '-' : '';
    return `${prefix}${term.key}:${op === 'not' ? '' : OPS[op] ?? ''}${(term.values ?? []).map(quote).join(',')}`;
  }).filter(Boolean).join(' ');
}

/**
 * The structured query of some terms: `filters` (the valid ones with a
 * key), `text` (the free words), `invalid` and `value` (the text).
 * @param {Array<{ key: string|null, op: string, values: string[], invalid?: string }>} terms
 */
export function toQuery(terms) {
  const list = (terms ?? []).map((term) => ({ ...term, values: [...term.values] }));
  return {
    terms: list,
    filters: list.filter((term) => term.key && !term.invalid).map(({ key, op, values }) => ({ key, op, values })),
    text: list.filter((term) => !term.key).map((term) => term.values.join(' ')).join(' '),
    invalid: list.filter((term) => term.invalid),
    value: stringify(list),
  };
}

/** Whether a word of `text` starts with `start` (lower case). */
const startsWord = (text, start) => String(text).toLowerCase().split(/[\s_.-]+/).some((word) => word.startsWith(start)) || String(text).toLowerCase().startsWith(start);

/**
 * What the list offers for the text being typed: keys (`kind: 'keys'`),
 * or a key's operators and values (`kind: 'values'`). Each item is
 * `{ group, text, label, meta, commit }`: `text` replaces what is typed,
 * `commit` makes a token of it.
 * @param {string} typed
 * @param {Array<string|object>} [keys]
 * @returns {{ kind: 'keys'|'values'|'none', key: string|null, items: Array<{ group: 'keys'|'ops'|'values'|'text', text: string, label: string, meta: string, commit: boolean }> }}
 */
export function suggest(typed, keys) {
  const known = keyMap(keys);
  const text = String(typed ?? '');
  const match = TERM.exec(text);
  if (!match) {
    const plain = /^(-?)([\w.-]*)$/.exec(text);
    const items = [];
    if (plain) {
      const [, minus, start] = plain;
      const lower = start.toLowerCase();
      for (const spec of known.values()) {
        if (lower && !startsWord(spec.key, lower) && !startsWord(spec.label, lower)) continue;
        items.push({ group: 'keys', text: `${minus}${spec.key}:`, label: spec.label, meta: `${minus}${spec.key}:`, commit: false });
      }
    }
    if (text.trim()) items.push({ group: 'text', text: text.trim(), label: text.trim(), meta: '', commit: true });
    return { kind: 'keys', key: null, items };
  }
  const [, minus, rawKey, mark = '', rest] = match;
  const spec = known.get(rawKey.toLowerCase());
  if (!spec && known.size) return { kind: 'none', key: rawKey, items: [] };
  const key = spec?.key ?? rawKey;
  const items = [];
  const parts = split(rest, ',');
  const done = parts.slice(0, -1).map(unquote);
  const partial = unquote(parts.at(-1) ?? '').toLowerCase();
  const head = `${minus}${key}:${mark}${parts.slice(0, -1).map((part) => `${part},`).join('')}`;
  if (!mark && !rest && !minus && spec) {
    for (const op of spec.operators) {
      if (op === 'is') continue;
      const text = `${op === 'not' ? '-' : ''}${key}:${op === 'not' ? '' : OPS[op]}`;
      items.push({ group: 'ops', text, label: op, meta: text, commit: false });
    }
  }
  for (const value of spec?.values ?? []) {
    if (done.includes(value.value)) continue;
    if (partial && !startsWord(value.value, partial) && !startsWord(value.label, partial)) continue;
    items.push({ group: 'values', text: `${head}${quote(value.value)}`, label: value.label, meta: value.description, commit: true });
  }
  if (partial && !(spec?.values.length && !spec.free)) items.push({ group: 'values', text: `${head}${quote(unquote(parts.at(-1)))}`, label: unquote(parts.at(-1)), meta: '', commit: true });
  return { kind: 'values', key, items };
}

/** The name of a term as a person reads it: "Status is open", "Priority at least 2", "Text printer". */
function nameOf(term, known) {
  if (!term.key) return `${t('queryText')} ${term.values.join(' ')}`;
  const spec = known.get(term.key.toLowerCase());
  const values = term.values.map((value) => spec?.values.find((entry) => entry.value === value)?.label ?? value);
  const op = t(OP_WORD[term.op] ?? 'queryIs');
  return `${spec?.label ?? term.key} ${op} ${values.join(` ${t('queryOr')} `)}`.trim();
}

function controller(el, options, signal) {
  const doc = el.ownerDocument;
  const id = `ds-query-${++serial}`;
  const listeners = new Map();
  const box = el.querySelector('.ds-query__box') ?? el.querySelector('.ds-combo');
  const input = el.querySelector('.ds-query__input') ?? box?.querySelector('input');
  const clear = box?.querySelector('.ds-combo__clear') ?? null;
  const popup = box?.querySelector('.ds-combo__popup') ?? null;
  const list = popup?.querySelector('.ds-combo__list') ?? null;
  const status = popup?.querySelector('.ds-combo__status') ?? null;
  const saveButton = el.querySelector('.ds-query__save');
  let keys = options.keys ?? readJson(el.getAttribute('data-ds-query-keys')) ?? [];
  let known = keyMap(keys);
  const storeName = options.store ?? el.getAttribute('data-ds-query-store');
  const prefs = openStore('query', storeName ? {} : { storage: null });
  const storeKey = storeName || id;
  let terms = [];
  let items = [];
  let active = -1;
  let opened = false;
  let fetched = 0;

  if (!box || !input) throw new TypeError('DS.query: a .ds-query__box with an input');

  // The parts the module owns: names, ids, the hint of the tokens, the hidden input.
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('autocomplete', 'off');
  input.spellcheck = false;
  if (list) {
    if (!list.id) list.id = `${id}-list`;
    list.setAttribute('role', 'listbox');
    if (!list.hasAttribute('aria-label') && !list.hasAttribute('aria-labelledby')) list.setAttribute('aria-label', t('querySuggestions'));
    input.setAttribute('aria-controls', list.id);
  }
  if (clear && !clear.hasAttribute('aria-label')) clear.setAttribute('aria-label', t('queryClear'));
  if (saveButton && !saveButton.hasAttribute('aria-label')) saveButton.setAttribute('aria-label', t('querySave'));
  const hint = doc.createElement('span');
  hint.className = 'ds-sr';
  hint.id = `${id}-hint`;
  hint.hidden = true;
  hint.textContent = t('queryTokenHint');
  el.append(hint);
  const name = options.name ?? el.getAttribute('data-ds-query-name');
  let hidden = null;
  if (name) {
    hidden = doc.createElement('input');
    hidden.type = 'hidden';
    hidden.name = name;
    el.append(hidden);
  }

  const notify = (type, detail, emitOptions) => {
    if (signal?.aborted) return true;
    const go = emit(el, type, detail, emitOptions);
    for (const fn of listeners.get(type) ?? []) fn(detail);
    return go;
  };

  /* ── Tokens ────────────────────────────── */

  // The tokens sit in a run of their own (display: contents), so a re-render patches only them.
  const run = box.querySelector(':scope > .ds-query__tokens') ?? box.insertBefore(Object.assign(doc.createElement('span'), { className: 'ds-query__tokens' }), input);
  const tokens = () => [...run.querySelectorAll(':scope > .ds-query__token')];

  const renderTokens = () => {
    const html = terms.map((term, at) => {
      const spec = term.key ? known.get(term.key.toLowerCase()) : null;
      const shown = term.key ? term.values.map((value) => spec?.values.find((entry) => entry.value === value)?.label ?? value).join(', ') : term.values.join(' ');
      const reason = term.invalid ? ` ${t(term.invalid === 'key' ? 'queryUnknownKey' : term.invalid === 'op' ? 'queryBadOp' : 'queryBadValue')}` : '';
      const tip = term.invalid ? ` data-tip="${esc(`${nameOf(term, known)}${reason}`)}"` : '';
      return `<button class="ds-chip ds-chip--input ds-query__token${term.invalid ? ' ds-tone-error' : ''}" type="button" tabindex="-1"${input.disabled ? ' disabled' : ''} aria-describedby="${hint.id}" data-ds-key="${esc(`${at}:${stringify([term])}`)}"${tip}>` +
        `<span class="ds-chip__body">${term.invalid ? icon(alertCircle, 18, 'ds-chip__icon') : ''}<span class="ds-chip__label">` +
        `<span class="ds-sr">${esc(t('queryRemove'))} ${esc(nameOf(term, known))}${esc(reason)}</span>` +
        (term.key ? (term.op === 'is' ? `<span class="ds-query__key" aria-hidden="true">${esc(spec?.label ?? term.key)}:</span>` : `<span class="ds-query__key" aria-hidden="true">${esc(spec?.label ?? term.key)}</span><span class="ds-query__op" aria-hidden="true">${esc(OP_MARK[term.op])}</span>`) : '') +
        `<span class="ds-query__value" aria-hidden="true">${esc(shown)}</span></span>${icon(closeGlyph, 18, 'ds-chip__trailing')}</span></button>`;
    }).join('');
    morphHtml(run, html);
    if (clear) clear.hidden = (!terms.length && !input.value) || input.disabled;
    saveButton?.setAttribute('aria-disabled', String(!terms.length || input.disabled));
    if (hidden) hidden.value = stringify(terms);
  };

  const changed = () => {
    renderTokens();
    notify('change', toQuery(terms));
  };

  const focusToken = (at) => {
    const all = tokens();
    if (!all.length || at >= all.length) {
      input.focus();
      if (at >= all.length) input.setSelectionRange(0, 0);
      return;
    }
    all[Math.max(0, at)].focus();
  };

  /** `focusNext`: 'next', 'previous', 'input', or 'none' (the page removes it from elsewhere: focus stays where it is). */
  const removeAt = (at, focusNext) => {
    const term = terms[at];
    if (!term) return;
    // A token that held the focus goes: the focus must not fall to the page.
    const held = tokens()[at]?.contains(doc.activeElement) ?? false;
    terms = terms.filter((_, index) => index !== at);
    changed();
    announce(t('queryRemoved', { label: nameOf(term, known) }));
    if (focusNext === 'next') focusToken(at);
    else if (focusNext === 'previous') focusToken(at - 1 < 0 ? tokens().length : at - 1);
    else if (focusNext !== 'none' || held) input.focus();
  };

  const editAt = (at) => {
    const term = terms[at];
    if (!term) return;
    terms = terms.filter((_, index) => index !== at);
    changed();
    input.value = stringify([term]);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    announce(t('queryEditing', { label: nameOf(term, known) }));
    refresh(true);
  };

  /** Turns typed text into tokens; returns whether something came of it. */
  const commit = (text) => {
    const added = parse(text, keys);
    if (!added.length) return false;
    // Free text joins the free text already there, so the query keeps one search phrase.
    for (const term of added) {
      const words = term.key ? null : terms.find((other) => !other.key);
      if (words) words.values = [`${words.values[0]} ${term.values[0]}`];
      else terms.push(term);
    }
    input.value = '';
    changed();
    announce(added.map((term) => t('queryAdded', { label: nameOf(term, known) })).join(' '));
    return true;
  };

  /* ── The list ──────────────────────────── */

  const optionId = (at) => `${id}-option-${at}`;

  const setActive = (at) => {
    active = at;
    const rows = list ? [...list.querySelectorAll('.ds-combo__option')] : [];
    rows.forEach((option, index) => option.toggleAttribute('data-active', index === at));
    if (at >= 0 && rows[at]) {
      input.setAttribute('aria-activedescendant', rows[at].id);
      rows[at].scrollIntoView({ block: 'nearest' });
      const item = items[at];
      if (status && item?.group === 'saved') status.textContent = t('querySavedHint');
    } else input.removeAttribute('aria-activedescendant');
  };

  const saved = () => {
    const entries = prefs.get(storeKey, []);
    return Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.name === 'string' && typeof entry.value === 'string') : [];
  };

  const renderList = (result) => {
    if (!list) return;
    const typed = input.value;
    items = [];
    if (!typed) for (const entry of saved()) items.push({ group: 'saved', text: entry.value, label: entry.name, meta: entry.value, commit: true, saved: entry.name });
    items.push(...result.items);
    const heading = {
      saved: t('querySaved'),
      keys: t('queryKeys'),
      ops: t('queryOperators'),
      values: result.key ? (known.get(result.key.toLowerCase())?.label ?? result.key) : '',
      text: t('querySearch'),
    };
    const groups = [];
    items.forEach((item, at) => {
      let group = groups.at(-1);
      if (!group || group.name !== item.group) {
        group = { name: item.group, rows: [] };
        groups.push(group);
      }
      const label = item.group === 'ops' ? t(OP_WORD[item.label] ?? 'queryIs') : item.group === 'text' ? t('querySearchFor', { text: item.label }) : item.label;
      group.rows.push(`<li class="ds-combo__option" id="${optionId(at)}" role="option" aria-selected="false" data-ds-key="${esc(`${item.group}:${item.text}`)}">` +
        `<span class="ds-combo__name">${esc(label)}</span>${item.meta ? `<span class="ds-combo__meta">${esc(item.meta)}</span>` : ''}</li>`);
    });
    const html = groups.map((group, at) => `<ul class="ds-combo__group" role="group" aria-labelledby="${id}-group-${at}" data-ds-key="${group.name}">` +
      `<li class="ds-combo__heading" id="${id}-group-${at}" role="presentation">${esc(heading[group.name])}</li>${group.rows.join('')}</ul>`).join('');
    morphHtml(list, html);
    list.hidden = !items.length;
    if (status) {
      status.textContent = items.length ? t(items.length === 1 ? 'queryOne' : 'queryMany', { count: items.length }) : t(result.kind === 'none' ? 'queryUnknown' : 'queryNoMatch');
    }
    setActive(-1);
  };

  const openList = () => {
    if (opened || !popup) return;
    opened = true;
    openOverlay(popup, { opener: input });
  };

  const closeList = () => {
    setActive(-1);
    if (!opened || !popup) return;
    opened = false;
    closeOverlay(popup);
  };

  /** Suggestions for what is typed; the page's values() may add a key's values. */
  const refresh = (show) => {
    const typed = input.value;
    const result = suggest(typed, keys);
    renderList(result);
    if (clear) clear.hidden = !terms.length && !input.value;
    if (show) openList();
    const values = options.values;
    if (typeof values !== 'function' || result.kind !== 'values' || !result.key) return;
    const ticket = ++fetched;
    const partial = unquote(split(TERM.exec(typed)?.[4] ?? '', ',').at(-1) ?? '');
    list?.setAttribute('aria-busy', 'true');
    Promise.resolve(values(result.key, partial)).then((found) => {
      if (ticket !== fetched || signal?.aborted || input.value !== typed) return;
      const spec = known.get(result.key.toLowerCase());
      if (spec) {
        spec.values = (found ?? []).map((value) => (typeof value === 'object' ? { value: String(value.value), label: String(value.label ?? value.value), description: value.description ?? '' } : { value: String(value), label: String(value), description: '' }));
        spec.free = true;
      }
      renderList(suggestFrom(typed));
    }, () => {}).finally(() => {
      if (ticket === fetched) list?.removeAttribute('aria-busy');
    });
  };

  /** suggest() over the keys as they stand, values fetched included. */
  const suggestFrom = (typed) => suggest(typed, [...known.values()]);

  const choose = (at) => {
    const item = items[at];
    if (!item) return;
    if (item.group === 'saved') {
      terms = parse(item.text, keys);
      input.value = '';
      changed();
      announce(t('queryApplied', { name: item.saved }));
      closeList();
      return;
    }
    if (item.commit) {
      commit(item.text);
      refresh(true);
      return;
    }
    input.value = item.text;
    input.setSelectionRange(input.value.length, input.value.length);
    refresh(true);
  };

  const removeSaved = (at) => {
    const item = items[at];
    if (item?.group !== 'saved') return;
    prefs.set(storeKey, saved().filter((entry) => entry.name !== item.saved));
    announce(t('querySavedRemoved', { name: item.saved }));
    refresh(true);
    setActive(Math.min(at, items.length - 1));
  };

  /* ── Keys of the field ─────────────────── */

  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.defaultPrevented) return;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!opened) {
          refresh(true);
          if (event.key === 'ArrowUp') setActive(items.length - 1);
          else setActive(items.length ? 0 : -1);
          return;
        }
        if (!items.length) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive(active < 0 ? (step > 0 ? 0 : items.length - 1) : (active + step + items.length) % items.length);
        return;
      }
      case 'Enter': {
        event.preventDefault();
        if (opened && active >= 0) {
          choose(active);
          return;
        }
        if (input.value.trim()) {
          commit(input.value);
          refresh(false);
          closeList();
          return;
        }
        closeList();
        notify('submit', toQuery(terms));
        return;
      }
      case ' ': {
        const typed = input.value;
        if (input.selectionStart !== typed.length || split(typed).length !== 1 || (typed.match(/"/g)?.length ?? 0) % 2) return;
        const term = TERM.test(typed) ? parse(typed, keys)[0] : null;
        if (!term?.key || term.invalid) return;
        event.preventDefault();
        commit(typed);
        refresh(opened);
        return;
      }
      case 'Backspace': {
        if (input.value || !terms.length) return;
        event.preventDefault();
        editAt(terms.length - 1);
        return;
      }
      case 'ArrowLeft': {
        if (!atStart || !terms.length) return;
        event.preventDefault();
        closeList();
        focusToken(terms.length - 1);
        return;
      }
      case 'Delete': {
        if (!opened || active < 0 || items[active]?.group !== 'saved') return;
        event.preventDefault();
        removeSaved(active);
        return;
      }
      case 'Escape': {
        // An open list is DS.overlay's (it closes after this handler); then the typed text goes.
        if (opened || !input.value) return;
        event.preventDefault();
        input.value = '';
        refresh(false);
        return;
      }
      case 'Tab':
        closeList();
        return;
      default:
    }
  }, { signal });

  input.addEventListener('input', () => {
    refresh(true);
  }, { signal });

  // A press on the field's empty part reaches the typing field.
  box.addEventListener('mousedown', (event) => {
    if (event.target === box || event.target.closest?.('.ds-query__icon')) {
      event.preventDefault();
      input.focus();
    }
  }, { signal });

  input.addEventListener('click', () => {
    if (!opened) refresh(true);
  }, { signal });

  /* ── Keys and presses of the tokens ────── */

  box.addEventListener('keydown', (event) => {
    const token = event.target.closest?.('.ds-query__token');
    if (!token || event.defaultPrevented) return;
    const at = tokens().indexOf(token);
    const keysOf = { ArrowLeft: () => focusToken(Math.max(0, at - 1)), ArrowRight: () => focusToken(at + 1), Home: () => focusToken(0), End: () => focusToken(tokens().length), Escape: () => focusToken(tokens().length), Backspace: () => removeAt(at, 'previous'), Delete: () => removeAt(at, 'next'), F2: () => editAt(at) };
    const fn = keysOf[event.key];
    if (!fn) return;
    event.preventDefault();
    fn();
  }, { signal });

  box.addEventListener('click', (event) => {
    const token = event.target.closest?.('.ds-query__token');
    if (token) {
      removeAt(tokens().indexOf(token), event.detail === 0 && doc.activeElement === token ? 'next' : 'input');
      return;
    }
    if (event.target.closest?.('.ds-combo__clear')) {
      terms = [];
      input.value = '';
      changed();
      refresh(false);
      input.focus();
      announce(t('queryCleared'));
    }
  }, { signal });

  /* ── The list: pointer, closing ────────── */

  if (popup) {
    // Keep the field focused while an option is pressed; choose on click.
    popup.addEventListener('mousedown', (event) => event.preventDefault(), { signal });
    popup.addEventListener('click', (event) => {
      const option = event.target.closest?.('.ds-combo__option');
      if (!option) return;
      choose([...list.querySelectorAll('.ds-combo__option')].indexOf(option));
      input.focus();
    }, { signal });
    popup.addEventListener('pointermove', (event) => {
      const option = event.target.closest?.('.ds-combo__option');
      if (!option) return;
      const at = [...list.querySelectorAll('.ds-combo__option')].indexOf(option);
      if (at !== active) setActive(at);
    }, { signal });
    // DS.overlay closes it on Escape or from outside: the page's state follows.
    popup.addEventListener('ds:close', () => {
      opened = false;
      setActive(-1);
    }, { signal });
  }

  el.addEventListener('focusout', (event) => {
    if (event.relatedTarget && (el.contains(event.relatedTarget) || popup?.contains(event.relatedTarget))) return;
    closeList();
  }, { signal });

  /* ── Saved queries ─────────────────────── */

  saveButton?.addEventListener('click', () => {
    if (!terms.length) return;
    prompt({
      title: t('querySaveTitle'),
      label: t('querySaveName'),
      value: '',
      confirmLabel: t('querySaveConfirm'),
      opener: saveButton,
      input: { required: true, autocomplete: 'off' },
    }).then((label) => {
      const named = String(label ?? '').trim();
      if (!named) return;
      const value = stringify(terms);
      prefs.set(storeKey, [...saved().filter((entry) => entry.name !== named), { name: named, value }]);
      announce(t('querySavedAs', { name: named }));
      notify('saved', { name: named, value });
    });
  }, { signal });

  const unsubscribe = prefs.on('change', ({ key }) => {
    if ((key === storeKey || key === null) && opened && !input.value) refresh(false);
  });

  /* ── Start ─────────────────────────────── */

  const initial = options.value ?? el.getAttribute('data-ds-value') ?? '';
  terms = Array.isArray(initial) ? initial.map((term) => ({ ...term, values: [...term.values] })) : parse(initial, keys);
  renderTokens();

  return {
    get() {
      return toQuery(terms);
    },
    set(value) {
      terms = Array.isArray(value) ? value.map((term) => ({ ...term, values: [...(term.values ?? [])] })) : parse(String(value ?? ''), keys);
      changed();
    },
    add(value) {
      return commit(Array.isArray(value) ? stringify(value) : typeof value === 'object' && value ? stringify([value]) : String(value ?? ''));
    },
    remove(index) {
      if (index >= 0 && index < terms.length) removeAt(index, 'none');
    },
    clear() {
      terms = [];
      input.value = '';
      changed();
    },
    setKeys(next) {
      keys = next ?? [];
      known = keyMap(keys);
      terms = parse(stringify(terms), keys);
      changed();
    },
    saved() {
      return saved();
    },
    save(label) {
      const named = String(label ?? '').trim();
      if (!named || !terms.length) return false;
      prefs.set(storeKey, [...saved().filter((entry) => entry.name !== named), { name: named, value: stringify(terms) }]);
      return true;
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    destroy() {
      unsubscribe();
      prefs.destroy();
      closeList();
      hint.remove();
      hidden?.remove();
      run.replaceChildren();
      listeners.clear();
    },
  };
}

/** JSON of an attribute, or null. */
function readJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

define('query', {
  attribute: 'data-ds-query',
  init(el, ctx) {
    return controller(el, {}, ctx.signal);
  },
});

/**
 * A query input driven from the page; the same controller the attribute
 * path makes. `options` override the attributes; `values(key, typed)` may
 * return a key's values (or a promise of them) as the person types.
 * @param {Element} el
 * @param {{ keys?: Array<string|object>, value?: string|Array<object>, store?: string, name?: string, values?: (key: string, typed: string) => unknown }} [options]
 */
export function create(el, options = {}) {
  const handle = new AbortController();
  const api = controller(el, options, handle.signal);
  const destroy = api.destroy;
  api.destroy = () => {
    handle.abort();
    destroy();
  };
  return api;
}
