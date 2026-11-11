/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The listbox (DS.listbox): a list of options to choose one or several from,
 * standalone (the WAI listbox pattern) and the list engine of the combobox
 * and the select panel, which pass it the element that keeps the focus.
 *
 *   <div class="ds-listbox" role="listbox" aria-label="Device" data-ds-listbox>
 *     <div class="ds-listbox__option" role="option" aria-selected="false" data-value="laptop-14">
 *       <span class="ds-listbox__name">Laptop 14</span><span class="ds-listbox__check" aria-hidden="true">(check)</span></div>
 *   </div>
 *
 *   const list = DS.listbox.create(el, { items, multiple: true, virtual: true });
 *   list.get();  list.set(['laptop-14']);  list.on('change', ({ value }) => ...);
 *   DS.listbox.fuzzy('lap 14', 'Laptop 14');   // { score, ranges } or null
 *   DS.listbox.filter(items, 'lap');           // the matches, best first
 *
 * Two sources. Markup: the options are in the page (role="option"), a filter
 * sets `hidden` on those that do not match and marks the matched letters in
 * their name. Data: `items` (strings or { value, label, description, meta,
 * group, disabled }) are rendered by the module through DS.dom.morphHtml,
 * best match first; beyond VIRTUAL_FROM of them, or with `virtual: true`,
 * only those near the viewport exist (DS.virtual, without its keyboard: the
 * focus stays where it is, aria-activedescendant names the active option).
 *
 * Focus: the element named `focus` (default the listbox itself, which then
 * becomes a tab stop) holds the focus and aria-activedescendant. The active
 * option carries data-active. Keys (APG listbox): ArrowUp and ArrowDown move,
 * Home and End go to the ends, PageUp and PageDown ten options; one choice:
 * the selection follows the focus (`follow`, default on for a standalone
 * listbox); several: Space toggles, Shift with an arrow moves and toggles,
 * Ctrl+A (Cmd+A) selects all or none. Type-ahead on a standalone listbox:
 * the letters typed within --ds-delay-tooltip of each other. Blocked options
 * (aria-disabled="true") are passed by. A combobox gives its own keys to
 * key(event), with Home, End and Space left to its field.
 *
 * Events on the listbox: ds:change ({ value, item, selected }) when the
 * user changed the choice (not on set()).
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit } from './core.js';
import { motionDuration } from './motion.js';
import { morphHtml, own, disown, scrollEdges } from './dom.js';
import { typeaheadMatch } from './a11y.js';
import { create as createWindow } from './virtual.js';
import { icon, check } from './icons.js';

/** A data list longer than this is windowed unless `virtual: false`. */
export const VIRTUAL_FROM = 100;

/** Options a PageUp or PageDown passes. */
const PAGE = 10;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** The live controllers. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

let sequence = 0;

/* ── Matching ───────────────────────────────────────── */

/**
 * A text folded for matching: lower case, accents gone, with the index in
 * the original text of every folded character (a ligature may fold to two).
 */
function fold(text) {
  const chars = [];
  const at = [];
  const source = String(text ?? '');
  let index = 0;
  for (const char of source) {
    const folded = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const part of folded) {
      chars.push(part);
      at.push(index);
    }
    index += char.length;
  }
  return { text: chars.join(''), at, length: source.length };
}

const isWordStart = (text, index) => index === 0 || /[\s\-_/.,:;()[\]]/.test(text[index - 1]) || (/[a-z]/.test(text[index - 1]) && /[0-9]/.test(text[index]));

/** Whether the letters of `token` from `k` on still occur in order in `target` after `pos`. */
function canFinish(token, k, target, pos) {
  let at = pos;
  for (let i = k; i < token.length; i += 1) {
    at = target.indexOf(token[i], at + 1);
    if (at < 0) return false;
  }
  return true;
}

/** One token against the folded text: a substring first, else the letters in order. */
function matchToken(token, target) {
  const found = target.indexOf(token);
  if (found >= 0) {
    // Earlier and at a word start is better; a whole prefix best.
    let score = 100 - Math.min(found, 40);
    if (found === 0) score += 60;
    else if (isWordStart(target, found)) score += 30;
    return { score: score + token.length * 4, ranges: [[found, found + token.length]] };
  }
  const ranges = [];
  let score = 0;
  let last = -1;
  for (let k = 0; k < token.length; k += 1) {
    const char = token[k];
    let index = target.indexOf(char, last + 1);
    if (index < 0) return null;
    // Neither next to the last letter nor at a word start: a later word
    // start with that letter is better, when the rest still fits after it.
    if (index !== last + 1 && !isWordStart(target, index)) {
      for (let i = index + 1; i < target.length; i += 1) {
        if (target[i] === char && isWordStart(target, i) && canFinish(token, k + 1, target, i)) {
          index = i;
          break;
        }
      }
    }
    if (ranges.length && index === last + 1) {
      ranges[ranges.length - 1][1] = index + 1;
      score += 6;
    } else {
      ranges.push([index, index + 1]);
      score += isWordStart(target, index) ? 8 : 1;
    }
    last = index;
  }
  // Scattered letters count far less than a substring.
  return { score: score - ranges.length * 2, ranges };
}

/** Sorted, merged ranges. */
function merge(ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const range of sorted) {
    const prev = out[out.length - 1];
    if (prev && range[0] <= prev[1]) prev[1] = Math.max(prev[1], range[1]);
    else out.push([range[0], range[1]]);
  }
  return out;
}

/**
 * How well `query` matches `text`: every word of the query must be found,
 * as a substring (better at the start and at a word start) or as its letters
 * in order. Case and accents do not count. Returns `{ score, ranges }`, the
 * ranges in the original text as [start, end), or null; an empty query
 * matches with score 0 and no ranges.
 * @param {string} query
 * @param {string} text
 * @returns {{ score: number, ranges: Array<[number, number]> }|null}
 */
export function fuzzy(query, text) {
  const tokens = fold(query).text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { score: 0, ranges: [] };
  const target = fold(text);
  let score = 0;
  const found = [];
  for (const token of tokens) {
    const hit = matchToken(token, target.text);
    if (!hit) return null;
    score += hit.score;
    found.push(...hit.ranges);
  }
  // The whole text typed: the best there is.
  if (target.text === fold(query).text.trim()) score += 200;
  const ranges = merge(found).map(([start, end]) => /** @type {[number, number]} */ ([target.at[start], end < target.at.length ? target.at[end] : target.length]));
  return { score, ranges: merge(ranges) };
}

/**
 * The items that match `query`, best first (equal scores keep their order):
 * `{ item, index, score, ranges }`. `label(item)` gives the text (default an
 * item's label, else the item itself as text); `limit` cuts the result.
 * @template T
 * @param {T[]} items
 * @param {string} query
 * @param {{ label?: (item: T) => string, limit?: number }} [options]
 * @returns {Array<{ item: T, index: number, score: number, ranges: Array<[number, number]> }>}
 */
export function filter(items, query, options = {}) {
  const label = options.label ?? ((item) => (item && typeof item === 'object' ? item.label ?? String(item.value ?? '') : String(item ?? '')));
  const out = [];
  (items ?? []).forEach((item, index) => {
    const hit = fuzzy(query, label(item));
    if (hit) out.push({ item, index, score: hit.score, ranges: hit.ranges });
  });
  out.sort((a, b) => b.score - a.score || a.index - b.index);
  return options.limit ? out.slice(0, options.limit) : out;
}

/**
 * `text` as markup with the ranges in <mark class="<className>">, escaped.
 * @param {string} text
 * @param {Array<[number, number]>} ranges
 * @param {string} [className]
 * @returns {string}
 */
export function highlight(text, ranges, className = 'ds-listbox__match') {
  const source = String(text ?? '');
  let out = '';
  let last = 0;
  for (const [start, end] of ranges ?? []) {
    if (start < last || end <= start) continue;
    out += `${esc(source.slice(last, start))}<mark class="${esc(className)}">${esc(source.slice(start, end))}</mark>`;
    last = end;
  }
  return out + esc(source.slice(last));
}

/* ── Items ──────────────────────────────────────────── */

/** An item of `items` as an entry. */
function entryOf(item, index) {
  if (item === null || typeof item !== 'object') {
    const text = String(item ?? '');
    return { index, value: text, label: text, description: '', meta: '', group: '', disabled: false, item, el: null };
  }
  const value = String(item.value ?? item.label ?? '');
  return {
    index,
    value,
    label: String(item.label ?? value),
    description: item.description ? String(item.description) : '',
    meta: item.meta ? String(item.meta) : '',
    group: item.group ? String(item.group) : '',
    disabled: Boolean(item.disabled),
    className: item.className ? String(item.className) : '',
    pinned: item.pinned ?? false,
    item,
    el: null,
  };
}

/** The value of `data-ds-value`: a JSON list, else the text itself. */
function parseValue(text, multiple) {
  if (text === null || text === undefined) return undefined;
  if (multiple) {
    try {
      const list = JSON.parse(text);
      if (Array.isArray(list)) return list.map(String);
    } catch {
      // A plain list: comma-separated.
    }
    return String(text).split(',').map((part) => part.trim()).filter(Boolean);
  }
  return String(text);
}

/* ── The controller ─────────────────────────────────── */

/**
 * The controller of a listbox, the one [data-ds-listbox] makes; once per
 * element (a second call returns it, and gives it new `items` when they are
 * passed). Options: `items` (data; without them the options are the
 * markup's), `multiple` (default aria-multiselectable), `value` (default
 * data-ds-value, else the options marked aria-selected), `focus` (the element
 * that keeps the focus and aria-activedescendant; default the listbox),
 * `follow` (one choice follows the active option; default on when the
 * listbox keeps the focus itself), `virtual` (true, false, or the number of
 * items from which a data list is windowed; default VIRTUAL_FROM), `scroller`
 * (what scrolls; default the listbox), `prefix` (the class block of the
 * parts; default ds-listbox), `check` (render the check mark; default on
 * for ds-listbox), `wrap` (the arrows go round; default off), `render(entry,
 * name)` (the inner markup of a data option), `name` (hidden inputs of that
 * name carry the value in a form), `pinned(option)` (a markup option that
 * comes last whatever the query: true, or a function of the query and the
 * number of matches; a "Create" option). A listbox with
 * aria-disabled="true" leaves the tab order while it is blocked.
 * @param {Element} element
 * @param {object} [options]
 * @returns {any}
 */
export function create(element, options = {}) {
  const existing = controllers.get(element);
  if (existing) {
    if (options.items) existing.setItems(options.items);
    return existing;
  }
  if (!element?.ownerDocument) return null;
  const doc = element.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  const prefix = options.prefix ?? 'ds-listbox';
  const part = (name) => `${prefix}__${name}`;
  const multiple = options.multiple ?? element.getAttribute('aria-multiselectable') === 'true';
  const focusEl = /** @type {HTMLElement} */ (options.focus ?? element);
  const standalone = focusEl === element;
  const follow = !multiple && (options.follow ?? standalone);
  /* The keys a field keeps for itself: Home, End and Space move its caret
     and type; letters filter instead of jumping. */
  const homeEnd = options.homeEnd ?? standalone;
  const typeaheadOn = options.typeahead ?? standalone;
  const spaceChooses = options.space ?? standalone;
  const wrap = options.wrap ?? false;
  const withCheck = options.check ?? prefix === 'ds-listbox';
  const scroller = /** @type {HTMLElement} */ (options.scroller ?? element);
  const baseId = element.id || `ds-listbox-${(sequence += 1)}`;
  const optionTag = element.localName === 'ul' || element.localName === 'ol' ? 'li' : 'div';
  const virtualFrom = options.virtual === true ? 0 : options.virtual === false ? Infinity : typeof options.virtual === 'number' ? options.virtual : VIRTUAL_FROM;

  /** @type {any[]|null} */
  let data = null;
  /** @type {any[]} */
  let entries = [];
  /** Entry indices that show, in their order. @type {number[]} */
  let visible = [];
  /** Each shown entry's position in `visible`, so a lookup never scans the list. @type {Map<number, number>} */
  let positions = new Map();
  /** Every entry's value, so the value of thousands of choices is one pass. @type {Set<string>} */
  let known = new Set();
  /** Ranges of the query in each shown entry's label. @type {Map<number, Array<[number, number]>>} */
  let marks = new Map();
  let query = '';
  let active = -1;
  /** The last option toggled by Space or a click: a Shift move toggles from there. */
  const selected = new Set();
  let windowed = null;
  let destroyed = false;
  let typed = '';
  let typedAt = 0;
  /** Names of the page's markup this module changed, to give back on destroy. */
  const marked = new WeakSet();
  let hidden = null;
  /** The options whose data-active this module owns, so a page's re-render keeps it. */
  const ownsActive = new WeakSet();
  const ownsTab = standalone && !element.hasAttribute('tabindex');
  const isDisabled = () => element.getAttribute('aria-disabled') === 'true';

  /* A blocked listbox leaves the tab order, and comes back with its use. */
  const syncTab = () => {
    const tab = isDisabled() ? '-1' : '0';
    if (element.getAttribute('tabindex') !== tab) element.setAttribute('tabindex', tab);
  };
  let tabWatch = null;
  if (ownsTab) {
    syncTab();
    own(element, 'attrs', 'tabindex');
    const Observer = doc.defaultView?.MutationObserver;
    if (Observer) {
      tabWatch = new Observer(syncTab);
      tabWatch.observe(element, { attributes: true, attributeFilter: ['aria-disabled'] });
    }
  }
  own(focusEl, 'attrs', 'aria-activedescendant');
  const optionId = (entry) => entry.el?.id || `${baseId}-o${entry.index}`;

  /* Markup source. */
  function scan() {
    const optionEls = [...element.querySelectorAll('[role="option"]')];
    entries = optionEls.map((el, index) => {
      if (!el.id) el.id = `${baseId}-o${index}`;
      const name = el.querySelector(`.${part('name')}`);
      const label = (name ?? el).textContent.trim();
      return {
        index,
        value: /** @type {HTMLElement} */ (el).dataset.value ?? label,
        label,
        description: '',
        meta: '',
        group: '',
        disabled: el.getAttribute('aria-disabled') === 'true',
        pinned: options.pinned?.(el) ?? false,
        item: null,
        el,
      };
    });
    known = new Set(entries.map((entry) => entry.value));
  }

  function selectedFromMarkup() {
    for (const entry of entries) if (entry.el?.getAttribute('aria-selected') === 'true') selected.add(entry.value);
  }

  /* Data source. */
  function setData(items) {
    data = [...(items ?? [])];
    entries = data.map(entryOf);
    known = new Set(entries.map((entry) => entry.value));
    active = -1;
  }

  /** Who shows, in order; the positions follow. */
  function show(list) {
    visible = list;
    positions = new Map(list.map((index, at) => [index, at]));
  }

  const positionOf = (index) => positions.get(index) ?? -1;

  function useWindow() {
    return data !== null && visible.length >= virtualFrom;
  }

  function checkHtml() {
    return withCheck ? `<span class="${part('check')}" aria-hidden="true">${icon(check, 16)}</span>` : '';
  }

  function optionHtml(entry) {
    const id = optionId(entry);
    const ranges = marks.get(entry.index) ?? [];
    const name = highlight(entry.label, ranges, part('match'));
    const inner = typeof options.render === 'function'
      ? options.render(entry.item, name)
      : `<span class="${part('name')}">${name}</span>`
        + (entry.description ? `<span class="${part('description')}">${esc(entry.description)}</span>` : '')
        + (entry.meta ? `<span class="${part('meta')}">${esc(entry.meta)}</span>` : '');
    return `<${optionTag} class="${part('option')}${entry.className ? ` ${esc(entry.className)}` : ''}" id="${esc(id)}" data-ds-key="${esc(id)}" data-value="${esc(entry.value)}" role="option" aria-selected="${selected.has(entry.value)}"`
      + `${entry.disabled ? ' aria-disabled="true"' : ''}${entry.index === active ? ' data-active=""' : ''}>${checkHtml()}${inner}</${optionTag}>`;
  }

  /** Renders the data entries that show: grouped in order of first appearance, or windowed. */
  function render() {
    if (data === null) return;
    if (useWindow()) {
      const count = visible.length;
      const position = Math.max(0, positionOf(active));
      if (!windowed) {
        element.replaceChildren();
        windowed = createWindow(scroller, { content: element, count, keyboard: false, active: position, estimate: estimateOf(), render: (index) => optionHtml(entries[visible[index]]) });
      } else windowed.set({ count, active: position, forget: true });
      return;
    }
    if (windowed) {
      windowed.destroy();
      windowed = null;
    }
    const groups = new Map();
    const loose = [];
    for (const index of visible) {
      const entry = entries[index];
      if (!entry.group) {
        loose.push(entry);
        continue;
      }
      if (!groups.has(entry.group)) groups.set(entry.group, []);
      groups.get(entry.group).push(entry);
    }
    let html = loose.map(optionHtml).join('');
    let g = 0;
    for (const [group, list] of groups) {
      const head = `${baseId}-g${(g += 1)}`;
      const tag = optionTag === 'li' ? 'ul' : 'div';
      const headTag = optionTag;
      html += `<${tag} class="${part('group')}" role="group" aria-labelledby="${head}" data-ds-key="${head}">`
        + `<${headTag} class="${part('heading')}" id="${head}" role="presentation">${esc(group)}</${headTag}>${list.map(optionHtml).join('')}</${tag}>`;
    }
    morphHtml(element, html);
    const byId = new Map([...element.querySelectorAll('[role="option"]')].map((el) => [el.id, el]));
    for (const index of visible) entries[index].el = byId.get(optionId(entries[index])) ?? null;
  }

  /** A rendered option's height for the window, from the option's own rule. */
  function estimateOf() {
    const probe = doc.createElement(optionTag);
    probe.className = part('option');
    probe.setAttribute('role', 'option');
    const name = doc.createElement('span');
    name.className = part('name');
    name.textContent = 'M';
    probe.append(name);
    element.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height || undefined;
  }

  /** Markup source: hide what does not match, mark the letters that do. */
  function applyMarkupFilter() {
    for (const entry of entries) {
      const shows = positions.has(entry.index);
      if (entry.el.hidden === shows) entry.el.hidden = !shows;
      const name = entry.el.querySelector(`.${part('name')}`);
      if (!name) continue;
      const ranges = marks.get(entry.index) ?? [];
      if (!ranges.length && !marked.has(name)) continue;
      // DOM nodes, never markup: the page's text stays text.
      const nodes = [];
      let last = 0;
      for (const [start, end] of ranges) {
        if (start > last) nodes.push(doc.createTextNode(entry.label.slice(last, start)));
        const mark = doc.createElement('mark');
        mark.className = part('match');
        mark.textContent = entry.label.slice(start, end);
        nodes.push(mark);
        last = end;
      }
      nodes.push(doc.createTextNode(entry.label.slice(last)));
      name.replaceChildren(...nodes);
      if (ranges.length) marked.add(name);
      else marked.delete(name);
    }
  }

  /** The element of the entry at `index`, rendering it first when the list is windowed. */
  function elementOf(index, reveal) {
    const entry = entries[index];
    if (!entry) return null;
    if (windowed) {
      const position = positionOf(index);
      if (position < 0) return null;
      const row = reveal ? windowed.scrollTo(position) : windowed.row(position);
      entry.el = row;
      return row;
    }
    return entry.el;
  }

  /** Brings an option into the scroller's view without moving the page. */
  function reveal(el) {
    if (!el || !scroller.isConnected || scroller.clientHeight === 0) return;
    const box = scroller.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const style = doc.defaultView.getComputedStyle(scroller);
    const padTop = parseFloat(style.scrollPaddingBlockStart) || 0;
    const padBottom = parseFloat(style.scrollPaddingBlockEnd) || 0;
    if (rect.top < box.top + padTop) scroller.scrollTop -= box.top + padTop - rect.top;
    else if (rect.bottom > box.bottom - padBottom) scroller.scrollTop += rect.bottom - (box.bottom - padBottom);
  }

  /* The active option. */
  function setActive(index, { scroll = true } = {}) {
    const before = entries[active];
    if (before?.el && before.el.isConnected) before.el.removeAttribute('data-active');
    active = index;
    const entry = entries[index];
    if (!entry) {
      active = -1;
      focusEl.removeAttribute('aria-activedescendant');
      if (windowed) windowed.set({});
      return;
    }
    if (windowed) windowed.set({ active: positionOf(index) });
    const el = elementOf(index, scroll);
    if (el) {
      el.setAttribute('data-active', '');
      if (!ownsActive.has(el)) {
        ownsActive.add(el);
        own(el, 'attrs', 'data-active');
      }
      focusEl.setAttribute('aria-activedescendant', el.id);
      if (scroll && !windowed) reveal(el);
    }
    if (scroll && windowed) keepInView(index, 3);
  }

  /*
   * A windowed jump lands on estimated heights: the rows it renders are
   * measured afterwards, and when they differ (descriptions that wrap, a
   * font that arrives) the active option can end up outside the box. For a
   * few frames, while the measurements settle, bring it back.
   */
  let viewFrame = 0;
  function keepInView(index, frames) {
    const view = doc.defaultView;
    if (!view) return;
    view.cancelAnimationFrame(viewFrame);
    viewFrame = view.requestAnimationFrame(() => {
      if (destroyed || active !== index || !windowed || !scroller.isConnected || scroller.clientHeight === 0) return;
      const el = entries[index]?.el;
      const box = scroller.getBoundingClientRect();
      const rect = el?.isConnected ? el.getBoundingClientRect() : null;
      if (!rect || (rect.height <= box.height && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1))) {
        windowed.scrollTo(positionOf(index));
        setActive(index, { scroll: false });
      }
      if (frames > 1) keepInView(index, frames - 1);
    });
  }

  const usable = (index) => !entries[index]?.disabled;

  /** The next usable shown entry from the active one, `step` positions on. */
  function stepFrom(step) {
    const list = visible.filter(usable);
    if (!list.length) return -1;
    const at = list.indexOf(active);
    if (at < 0) return step > 0 ? list[0] : list[list.length - 1];
    let next = at + step;
    if (wrap && Math.abs(step) === 1) next = (next + list.length) % list.length;
    return list[Math.max(0, Math.min(list.length - 1, next))];
  }

  /** The first or the last usable shown entry, or -1. */
  function edge(which) {
    const list = visible.filter(usable);
    return (which === 'first' ? list[0] : list[list.length - 1]) ?? -1;
  }

  /* The value. */
  function syncSelected() {
    if (windowed) {
      // Only the rendered rows exist; the others render from `selected` when they come.
      for (const el of element.querySelectorAll('[role="option"]')) el.setAttribute('aria-selected', String(selected.has(/** @type {HTMLElement} */ (el).dataset.value)));
    } else {
      for (const entry of data === null ? entries : visible.map((index) => entries[index])) entry.el?.setAttribute('aria-selected', String(selected.has(entry.value)));
    }
    writeHidden();
  }

  function writeHidden() {
    const name = options.name ?? element.getAttribute('data-ds-listbox-name');
    if (!name) return;
    if (!hidden) {
      hidden = doc.createElement('span');
      hidden.hidden = true;
      hidden.setAttribute('data-ds-keep', '');
      element.after(hidden);
    }
    hidden.replaceChildren(...[...selected].map((value) => {
      const input = doc.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      return input;
    }));
  }

  /* The entries' order first, then values no entry has (set by the page, or gone with new data). */
  const value = () => (multiple ? entries.filter((entry) => selected.has(entry.value)).map((entry) => entry.value).concat([...selected].filter((each) => !known.has(each))) : [...selected][0] ?? null);

  function changed(entry, isSelected) {
    emit(element, 'change', { value: value(), item: entry ? entry.item ?? entry.value : null, selected: isSelected });
  }

  /** Chooses (one) or toggles (several) the entry at `index`, as the user did. */
  function choose(index, { toggle = multiple } = {}) {
    const entry = entries[index];
    if (!entry || entry.disabled || isDisabled()) return false;
    let isSelected = true;
    if (multiple && toggle) {
      isSelected = !selected.has(entry.value);
      if (isSelected) selected.add(entry.value);
      else selected.delete(entry.value);
    } else if (multiple) {
      selected.add(entry.value);
    } else {
      if (selected.size === 1 && selected.has(entry.value)) return true;
      selected.clear();
      selected.add(entry.value);
    }
    syncSelected();
    changed(entry, isSelected);
    return true;
  }

  function selectAll() {
    const list = visible.filter(usable);
    const all = list.every((index) => selected.has(entries[index].value));
    for (const index of list) {
      if (all) selected.delete(entries[index].value);
      else selected.add(entries[index].value);
    }
    syncSelected();
    changed(null, !all);
  }

  /** Runs a query: who shows, and the marks. */
  function runFilter(text, how = {}) {
    query = String(text ?? '');
    marks = new Map();
    const pinned = entries.filter((entry) => entry.pinned);
    const pool = entries.filter((entry) => !entry.pinned);
    let list;
    if (!query.trim()) list = pool.map((entry) => entry.index);
    else if (how.keep) {
      // Matched elsewhere (a server): every entry stays, in its order, marked where the query is found.
      list = pool.map((entry) => entry.index);
      for (const entry of pool) {
        const hit = fuzzy(query, entry.label);
        if (hit?.ranges.length) marks.set(entry.index, hit.ranges);
      }
    } else {
      const hits = filter(pool, query, { label: (entry) => entry.label });
      // The page's markup keeps its order; data comes best first.
      if (data === null) hits.sort((a, b) => a.index - b.index);
      list = hits.map((hit) => hit.item.index);
      for (const hit of hits) marks.set(hit.item.index, hit.ranges);
    }
    // Pinned entries (a "Create" option) come last, when they say so.
    const matches = list.length;
    for (const entry of pinned) if (typeof entry.pinned !== 'function' || entry.pinned(query, matches)) list.push(entry.index);
    show(list);
    if (data === null) applyMarkupFilter();
    else render();
    if (!positions.has(active)) setActive(-1);
    return visible.length;
  }

  /* Keys. */
  function key(event) {
    if (event.defaultPrevented || event.isComposing || isDisabled()) return false;
    const mod = event.ctrlKey || event.metaKey;
    const k = event.key;
    let target = -1;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      if (event.altKey) return false;
      target = stepFrom(k === 'ArrowDown' ? 1 : -1);
    } else if ((k === 'Home' || k === 'End') && homeEnd) target = edge(k === 'Home' ? 'first' : 'last');
    else if (k === 'PageDown' || k === 'PageUp') target = stepFrom(k === 'PageDown' ? PAGE : -PAGE);
    else if (k === 'Enter' && !mod) {
      if (active < 0) return false;
      choose(active);
      return true;
    } else if (k === ' ' && spaceChooses && !mod) {
      if (active < 0) target = stepFrom(1);
      else {
        choose(active);
        return true;
      }
    } else if (multiple && mod && !event.shiftKey && (k === 'a' || k === 'A') && standalone) {
      selectAll();
      return true;
    } else if (typeaheadOn && k.length === 1 && !mod && !event.altKey) {
      return typeahead(k);
    } else return false;
    if (target < 0) return k === 'ArrowDown' || k === 'ArrowUp';
    setActive(target);
    if (follow) choose(target);
    else if (multiple && event.shiftKey && (k === 'ArrowDown' || k === 'ArrowUp')) choose(target);
    return true;
  }

  function typeahead(char) {
    if (char === ' ' && !typed) return false;
    const now = Date.now();
    if (now - typedAt > motionDuration(element, '--ds-delay-tooltip')) typed = '';
    typedAt = now;
    typed += char.toLowerCase();
    const list = visible.filter(usable).map((index) => entries[index]);
    const match = typeaheadMatch(list, entries[active] ?? null, typed, (entry) => entry.label.toLowerCase());
    if (!match) return true;
    setActive(match.index);
    if (follow) choose(match.index);
    return true;
  }

  /* Pointer. */
  const indexOfNode = (node) => {
    const el = /** @type {Element} */ (node)?.closest?.('[role="option"]');
    if (!el || !element.contains(el)) return -1;
    const entry = entries.find((each) => each.el === el || (el.id && optionId(each) === el.id));
    return entry ? entry.index : -1;
  };

  element.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const index = indexOfNode(event.target);
    if (index < 0 || !usable(index) || isDisabled()) return;
    setActive(index, { scroll: false });
    if (multiple && event.shiftKey && standalone) choose(index, { toggle: false });
    else choose(index);
    if (!standalone) return;
    if (doc.activeElement !== element) element.focus({ preventScroll: true });
  }, { signal });

  if (!standalone) {
    // The pointer is the active option too: one layer for keys and pointer.
    element.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      const index = indexOfNode(event.target);
      if (index >= 0 && index !== active && usable(index)) setActive(index, { scroll: false });
    }, { signal });
    // A press in the list keeps the focus where it is.
    element.addEventListener('mousedown', (event) => event.preventDefault(), { signal });
  } else {
    element.addEventListener('keydown', (event) => {
      if (key(event)) event.preventDefault();
    }, { signal });
    element.addEventListener('focus', () => {
      if (active >= 0 && positions.has(active)) {
        setActive(active);
        return;
      }
      // The first chosen option, else the first one.
      const first = visible.find((index) => selected.has(entries[index].value) && usable(index)) ?? visible.find(usable);
      if (first !== undefined) setActive(first);
    }, { signal });
  }

  /* Start. The box of a standalone listbox fades its cut edges. */
  const edges = prefix === 'ds-listbox' && !element.classList.contains('ds-listbox--plain') && !element.hasAttribute('data-ds-edges') ? scrollEdges(scroller, { axis: 'block' }) : null;
  if (Array.isArray(options.items)) setData(options.items);
  else scan();
  const initial = options.value !== undefined ? options.value : parseValue(element.getAttribute('data-ds-value'), multiple);
  if (initial !== undefined && initial !== null) for (const each of multiple ? [].concat(initial) : [initial]) selected.add(String(each));
  else if (data === null) selectedFromMarkup();
  if (!multiple && selected.size > 1) {
    const first = [...selected][0];
    selected.clear();
    selected.add(first);
  }
  show(entries.map((entry) => entry.index));
  render();
  syncSelected();

  const controller = {
    element,
    /** The value: one choice's value or null, several as a list. */
    get: value,
    /** Sets the value from the page (no ds:change). */
    set(next) {
      selected.clear();
      if (next !== null && next !== undefined) for (const each of multiple ? [].concat(next) : [next]) selected.add(String(each));
      syncSelected();
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === element) fn(event.detail);
      };
      element.addEventListener(`ds:${type}`, listener);
      return () => element.removeEventListener(`ds:${type}`, listener);
    },
    /** New data: rendered again, the query kept (`keep`: matched elsewhere, only marked). */
    setItems(items, how = {}) {
      setData(items);
      return runFilter(how.query ?? query, how);
    },
    /** Shows the options that match `text` (marks in their names); returns how many show. */
    filter: runFilter,
    /** The entries that show, in their order: { value, label, item, disabled }. */
    shown: () => visible.map((index) => entries[index]),
    /** Everything known: the data's entries, or the markup's options. */
    entries: () => entries.slice(),
    /** The active entry, or null. */
    active: () => entries[active] ?? null,
    /** Makes the entry with `value` (or the first or last: 'first', 'last') active; null clears it. */
    activate(which) {
      if (which === null) return setActive(-1);
      if (which === 'first' || which === 'last') return setActive(edge(which));
      const entry = entries.find((each) => each.value === String(which));
      return setActive(entry && positions.has(entry.index) ? entry.index : -1);
    },
    /** Moves the active option `step` usable options on (wrapping with `wrap`). */
    move(step) {
      const target = stepFrom(step);
      if (target >= 0) setActive(target);
      return entries[active] ?? null;
    },
    /** Chooses (or with several, toggles) the active entry or the one with `value`, as the user did. */
    pick(which) {
      const entry = which === undefined ? entries[active] : entries.find((each) => each.value === String(which));
      return entry ? choose(entry.index) : false;
    },
    /** Handles a key a field passed on; true when it was the listbox's. */
    key,
    /** Reads the markup's options again (the page changed them). */
    refresh() {
      if (ownsTab) syncTab();
      if (data !== null) return render();
      scan();
      runFilter(query);
      syncSelected();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      doc.defaultView?.cancelAnimationFrame(viewFrame);
      abort.abort();
      tabWatch?.disconnect();
      controllers.delete(element);
      windowed?.destroy();
      edges?.destroy();
      hidden?.remove();
      focusEl.removeAttribute('aria-activedescendant');
      disown(focusEl, 'attrs', 'aria-activedescendant');
      if (entries[active]?.el) entries[active].el.removeAttribute('data-active');
      if (ownsTab) {
        element.removeAttribute('tabindex');
        disown(element, 'attrs', 'tabindex');
      }
    },
  };
  controllers.set(element, controller);
  return controller;
}

define('listbox', {
  attribute: 'data-ds-listbox',
  init: (element) => create(element, {
    virtual: element.hasAttribute('data-ds-listbox-virtual') ? element.getAttribute('data-ds-listbox-virtual') !== 'false' : undefined,
  }),
});
