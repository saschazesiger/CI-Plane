/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Filter bar (DS.filterbar): a search and inline filters above a list, the
 * applied filters as chips with "Clear all", and a result count. When the
 * bar is too narrow for its filters they fold away behind a "Filters"
 * button, which opens them in a side sheet (filterbar.css has the markup).
 *
 *   <div class="ds-filterbar" data-ds-filterbar data-ds-filterbar-sheet="#filters-sheet"> ... </div>
 *
 *   const bar = DS.filterbar.create(el);
 *   bar.get();                          // { q: ['fan'], status: ['online', 'offline'] }
 *   bar.set({ status: ['online'] });    // the controls follow; tells nothing
 *   bar.clear();                        // every filter, as "Clear all"
 *   bar.count(48);                      // "48 results", "Show 48 results"
 *   el.addEventListener('ds:filter', (event) => render(event.detail.filters));
 *
 * The filters are the named form controls inside the bar (and inside its
 * folded part while that sits in the sheet): checkboxes, radios, selects,
 * text, search, number and date fields. Each filter is a list of strings:
 * the checked values of its checkboxes, the selected options of a select,
 * the value of a field; two fields of one name with data-ds-filter-bound
 * "min" and "max" make a range, [min, max] ('' for an open end). Empty
 * filters are left out. DS.filterbar.read(), write() and applied() are
 * these rules alone, for any container (DS.facets builds on them).
 *
 * Applied filters show as input chips in .ds-filterbar__chips ("Status:
 * Online"; the label from data-ds-filter-label, the fieldset's legend or
 * the field's label; the value from the option's label): one per value, a
 * range as one. A search field (type="search") and a control with
 * data-ds-filter-chip="off" have none; data-ds-filter-chip="value" leaves
 * the label out. A chip removes its value, .ds-filterbar__clear every
 * value; the focus goes to the next chip, else the one before, else the
 * search field. The applied row hides while nothing is applied.
 *
 * A change by the user (input on a text field, change on the others, a
 * chip, Clear all) sends ds:filter ({ filters, name, reason }) on the bar
 * once the filters changed; set() and write() send nothing. Removing and
 * clearing are announced ("Removed Status: Online", "Filters cleared").
 * The page writes the result count with count(): it shows at once, and
 * after a change by the user it is announced once the changes pause
 * (--ds-delay-tooltip), through the page's announcer, which also speaks
 * while the filters sit in the modal sheet.
 *
 * Folding (data-folded on the bar, written by the system): a
 * ResizeObserver measures whether the search, the filters and the count
 * fit in one row; when they do not, the filters fold and
 * .ds-filterbar__more shows (with a badge of the applied filters among
 * them). It opens the sheet of data-ds-filterbar-sheet with the filters
 * moved into its body (DS.filterbar.fold()), and puts them back once the
 * sheet has closed. Without the script nothing folds: the row wraps.
 *
 * Strings: removeFilter, filterRemoved, filtersCleared, filtersApplied,
 * filterChip, resultsOne, resultsOther, showResults, rangeMin, rangeMax and
 * rangeBetween of DS.core.config().
 *
 * ES2022.
 *
 * Progressive:
 * - moveBefore (the folded filters move into the sheet and back keeping
 *   their state, focus and running transitions): without it insertBefore.
 */
import { define, emit, get as controllerOf, t } from './core.js';
import { settled, motionDuration } from './motion.js';
import { own, disown, morphHtml } from './dom.js';
import { icon, close as closeGlyph } from './icons.js';
import { announce, canTakeFocus } from './a11y.js';
import { open as openOverlay, close as closeOverlay } from './overlay.js';
import { number, plural } from './format.js';

/** The controllers create() made, so the attribute path takes over the same one. */
const built = new WeakMap();

/** Inputs that hold no filter. */
const SKIP = new Set(['button', 'submit', 'reset', 'image', 'file']);

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** The named controls inside the roots, in document order, each once. */
function controlsIn(roots) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (!root?.querySelectorAll) continue;
    for (const node of root.querySelectorAll('input[name], select[name], textarea[name]')) {
      if (seen.has(node) || SKIP.has(/** @type {HTMLInputElement} */ (node).type) || node.disabled) continue;
      seen.add(node);
      out.push(node);
    }
  }
  return out;
}

/** The value of a checkbox or radio: 'on' without a value attribute, '' for value="" (an "Any" radio). */
const checkValue = (node) => (node.value !== '' ? node.value : node.getAttribute('value') === '' ? '' : 'on');

const kindOf = (node) => (node.tagName === 'SELECT' ? 'select' : node.type === 'checkbox' || node.type === 'radio' ? node.type : 'text');
const boundOf = (node) => {
  const bound = node.getAttribute('data-ds-filter-bound');
  return bound === 'min' || bound === 'max' ? bound : null;
};

/**
 * The filters the controls hold: name to a list of strings, empty ones left
 * out. A control's name is data (constructor, __proto__ ...): Maps collect,
 * and Object.fromEntries() makes every name an own property.
 */
function readControls(controls) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  const ranges = new Map();
  for (const node of controls) {
    const name = node.name;
    const kind = kindOf(node);
    const bound = boundOf(node);
    if (bound) {
      if (!ranges.has(name)) ranges.set(name, ['', '']);
      ranges.get(name)[bound === 'min' ? 0 : 1] = clean(node.value);
      continue;
    }
    let values = [];
    if (kind === 'checkbox' || kind === 'radio') values = node.checked && checkValue(node) !== '' ? [checkValue(node)] : [];
    else if (kind === 'select') values = [...node.selectedOptions].map((option) => option.value).filter((value) => value !== '');
    else if (clean(node.value)) values = [node.value.trim()];
    if (values.length) out.set(name, [...(out.get(name) ?? []), ...values]);
  }
  for (const [name, range] of ranges) if (range[0] !== '' || range[1] !== '') out.set(name, range);
  return Object.fromEntries(out);
}

/**
 * The filters the named controls inside `root` hold: name to a list of
 * strings (a range: [min, max], '' for an open end); empty ones left out.
 * @param {Element|Document} root
 * @returns {Record<string, string[]>}
 */
export function read(root) {
  return readControls(controlsIn([root]));
}

const listOf = (value) => (value == null ? [] : Array.isArray(value) ? value.map(String) : [String(value)]);

/** Sets the controls to `filters` (missing names: empty); returns the controls that changed. */
function writeControls(controls, filters) {
  const changed = [];
  const firstOf = new Map();
  for (const node of controls) {
    const values = listOf(filters && Object.hasOwn(filters, node.name) ? filters[node.name] : undefined);
    const kind = kindOf(node);
    const bound = boundOf(node);
    let before;
    let after;
    if (bound) {
      before = node.value;
      node.value = values[bound === 'min' ? 0 : 1] ?? '';
      after = node.value;
    } else if (kind === 'checkbox' || kind === 'radio') {
      before = node.checked;
      // An "Any" radio (value="") is the one checked while its filter is empty.
      node.checked = values.length ? values.includes(checkValue(node)) : checkValue(node) === '' && kind === 'radio';
      after = node.checked;
    } else if (kind === 'select') {
      before = [...node.selectedOptions].map((option) => option.value).join('\n');
      const choices = [...node.options];
      if (node.multiple) for (const option of choices) option.selected = values.includes(option.value);
      else {
        const match = choices.findIndex((option) => option.value === (values[0] ?? ''));
        node.selectedIndex = match >= 0 ? match : values.length ? -1 : choices.findIndex((option) => option.value === '');
      }
      after = [...node.selectedOptions].map((option) => option.value).join('\n');
    } else {
      // A name shared by several text fields: the values in turn.
      const index = firstOf.get(node.name) ?? 0;
      firstOf.set(node.name, index + 1);
      before = node.value;
      node.value = values[index] ?? '';
      after = node.value;
    }
    if (before !== after) changed.push(node);
  }
  return changed;
}

/**
 * Sets the named controls inside `root` to `filters` (a name left out is
 * emptied); sends no event. Returns the controls that changed.
 * @param {Element|Document} root
 * @param {Record<string, string|string[]>} filters
 * @returns {Element[]}
 */
export function write(root, filters) {
  return writeControls(controlsIn([root]), filters ?? {});
}

/** Text of a node without its counts, screen-reader-only parts and hidden parts. */
function textOf(node) {
  if (!node) return '';
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out += child.nodeValue;
    else if (child.nodeType === 1 && !child.matches('.ds-check__count, .ds-sr, [aria-hidden="true"], input, select, textarea, svg')) out += textOf(child);
  }
  return out;
}

function labelOf(node) {
  if (node.labels?.length) return node.labels[0];
  return node.closest('label');
}

/** The name of the filter a control belongs to. */
function groupLabel(node) {
  const marked = node.closest('[data-ds-filter-label]');
  if (marked) return clean(marked.getAttribute('data-ds-filter-label'));
  const kind = kindOf(node);
  const fieldset = node.closest('fieldset');
  const legend = fieldset?.querySelector(':scope > legend');
  if ((kind === 'checkbox' || kind === 'radio' || boundOf(node)) && legend) return clean(textOf(legend) || legend.textContent);
  if (kind !== 'checkbox' && kind !== 'radio' && !boundOf(node)) {
    const text = clean(textOf(labelOf(node)));
    if (text) return text;
  }
  if (legend) return clean(legend.textContent);
  return clean(node.getAttribute('aria-label')) || node.name;
}

/** A number in the locale when it is one, else the text as it is. */
const figure = (text) => (text !== '' && Number.isFinite(Number(text)) ? number(Number(text)) : text);

/** A range as words: "10 to 50", "from 10", "up to 50". */
function rangeText(min, max) {
  if (min !== '' && max !== '') return t('rangeBetween', { min: figure(min), max: figure(max) });
  if (min !== '') return t('rangeMin', { min: figure(min) });
  return t('rangeMax', { max: figure(max) });
}

/** The applied filters of the controls, one entry per chip. */
function appliedOf(controls) {
  const out = [];
  const ranges = new Map();
  for (const node of controls) {
    const chip = node.closest('[data-ds-filter-chip]')?.getAttribute('data-ds-filter-chip') ?? (node.type === 'search' ? 'off' : '');
    if (chip === 'off') continue;
    const label = groupLabel(node);
    const bound = boundOf(node);
    const kind = kindOf(node);
    const push = (value, text) => out.push({ key: `${node.name}=${value}`, name: node.name, value, label, text, chip: chip === 'value' ? text : t('filterChip', { label, value: text }) });
    if (bound) {
      const range = ranges.get(node.name) ?? { label, chip, min: '', max: '' };
      range[bound] = clean(node.value);
      ranges.set(node.name, range);
      continue;
    }
    if (kind === 'checkbox' || kind === 'radio') {
      if (node.checked && checkValue(node) !== '') push(checkValue(node), clean(textOf(labelOf(node))) || checkValue(node));
    } else if (kind === 'select') {
      for (const option of node.selectedOptions) if (option.value !== '') push(option.value, clean(option.textContent));
    } else if (clean(node.value)) push(node.value.trim(), node.value.trim());
  }
  for (const [name, range] of ranges) {
    if (range.min === '' && range.max === '') continue;
    const text = rangeText(range.min, range.max);
    out.push({ key: `${name}=${range.min}..${range.max}`, name, value: [range.min, range.max], label: range.label, text, chip: range.chip === 'value' ? text : t('filterChip', { label: range.label, value: text }) });
  }
  return out;
}

/**
 * The applied filters of the named controls inside `root`, one entry per
 * chip: { key, name, value, label, text, chip } ("Status: Online" in chip).
 * @param {Element|Document} root
 * @returns {{ key: string, name: string, value: string|string[], label: string, text: string, chip: string }[]}
 */
export function applied(root) {
  return appliedOf(controlsIn([root]));
}

/** Moves `node` before `reference` in `parent`, keeping its state where the engine can. */
function move(parent, node, reference = null) {
  if (typeof parent.moveBefore === 'function') {
    try {
      parent.moveBefore(node, reference);
      return;
    } catch {
      // Not allowed here (another document, a disconnected parent): insert it.
    }
  }
  parent.insertBefore(node, reference);
}

/**
 * Opens `sheet` (DS.overlay.open) with `part` moved into its body, and moves
 * the part back where it was once the sheet has closed (its exit settled).
 * Resolves when the sheet is open.
 * @param {Element} part
 * @param {Element} sheet  a .ds-sheet
 * @param {{ opener?: Element|null, into?: Element|null, back?: () => void }} [options]
 * @returns {Promise<void>}
 */
export function fold(part, sheet, options = {}) {
  const into = options.into ?? sheet.querySelector('.ds-sheet__body') ?? sheet;
  if (into.contains(part)) return openOverlay(sheet, { opener: options.opener ?? null });
  const home = part.parentNode;
  const next = part.nextSibling;
  move(into, part);
  const back = () => {
    if (!part.isConnected || !into.contains(part)) return;
    if (home?.isConnected) move(home, part, next?.parentNode === home ? next : null);
    options.back?.();
  };
  const closed = () => {
    const panel = sheet.querySelector('.ds-sheet__panel') ?? sheet;
    settled(panel).then(() => {
      // Opened again meanwhile: it stays.
      if (sheet.getAttribute('data-state') === 'open' || (sheet.matches('dialog') && /** @type {HTMLDialogElement} */ (sheet).open && sheet.getAttribute('data-state') !== 'closed')) {
        sheet.addEventListener('ds:close', closed, { once: true });
        return;
      }
      back();
    });
  };
  sheet.addEventListener('ds:close', closed, { once: true });
  return openOverlay(sheet, { opener: options.opener ?? null });
}

/** Options from the attributes. */
function readOptions(el) {
  return { sheet: el.getAttribute('data-ds-filterbar-sheet') };
}

/**
 * The filter engine of a container: its controls, the applied chips, Clear
 * all, the result count, ds:filter and the announcements. The bar's
 * controller adds folding; DS.facets adds its facets.
 */
function engine(el, options, signal) {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const listeners = new Map();
  /** Parts that hold controls outside `el` (folded into a sheet). */
  const away = new Set();
  /** Every match in the element, its parts away and the extra roots (a chips row beside the list, the sheet), each once. */
  const parts = (selector) => (selector ? [...new Set([el, ...away, ...(options.extra?.() ?? [])].flatMap((root) => (root ? [...root.querySelectorAll(selector)] : [])))] : []);
  const controls = () => controlsIn([el, ...away]);
  let last = JSON.stringify(readControls(controls()));
  let quiet = 0;
  /** The result count the page gave, and whether a change by the user came since it was last said. */
  let total = null;
  let forms = null;
  let asked = false;
  let speak = 0;

  const tell = (type, detail) => (listeners.get(type) ?? new Set()).forEach((fn) => fn(detail));

  /** The chips of the applied filters in every chips row, keyed; an applied row hides while there are none. */
  const paint = () => {
    const list = appliedOf(controls());
    const html = list.map((entry) => `<button class="ds-chip ds-chip--input" type="button" data-ds-key="${esc(entry.key)}" data-ds-filter-key="${esc(entry.key)}">` +
      `<span class="ds-chip__body"><span class="ds-chip__label"><span class="ds-sr">${esc(t('removeFilter'))} </span>${esc(entry.chip)}</span>` +
      `${icon(closeGlyph, 18, 'ds-chip__trailing')}</span></button>`).join('');
    for (const chips of parts(options.chips)) morphHtml(chips, html);
    for (const row of parts(options.applied)) {
      const hide = list.length === 0;
      if (hide !== row.hidden) {
        own(row, 'attrs', 'hidden');
        row.hidden = hide;
      }
    }
    for (const button of parts(options.clear)) {
      if (list.length) {
        button.removeAttribute('aria-disabled');
        disown(button, 'attrs', 'aria-disabled');
      } else {
        own(button, 'attrs', 'aria-disabled');
        button.setAttribute('aria-disabled', 'true');
      }
    }
    options.paint?.(list);
    return list;
  };

  /**
   * The result count in words, in the count and on the sheet's results
   * button at once. Said through announce() (the toast region, which stays
   * usable above the modal sheet, where a live region in the inert page
   * would be silent) once the changes pause (--ds-delay-tooltip, so typing
   * in the search says it once), and only after a change by the user: the
   * first count and set() stay quiet.
   */
  const paintCount = () => {
    if (total == null) return '';
    const shown = number(total);
    const text = forms ? plural(total, forms) : plural(total, { one: t('resultsOne', { count: shown }), other: t('resultsOther', { count: shown }) });
    for (const node of parts(options.count)) if (node.textContent !== text) node.textContent = text;
    const label = t('showResults', { results: text });
    for (const node of parts(options.results)) {
      const slot = node.querySelector('.ds-btn__label') ?? node;
      if (slot.textContent !== label) slot.textContent = label;
    }
    return text;
  };
  const count = (value, given) => {
    total = Number(value);
    forms = given ?? null;
    const text = paintCount();
    if (!asked || !text) return;
    asked = false;
    view?.clearTimeout(speak);
    speak = view?.setTimeout(() => {
      if (!signal?.aborted) announce(text);
    }, motionDuration(el, '--ds-delay-tooltip')) ?? 0;
  };

  /** Tells the page when the filters changed. */
  const changed = (name, reason) => {
    const filters = readControls(controls());
    const now = JSON.stringify(filters);
    paint();
    // The events a removal dispatches on its controls: the removal itself tells once.
    if (quiet) return;
    if (now === last) return;
    last = now;
    if (signal?.aborted) return;
    const detail = { filters, name, reason };
    asked = true;
    emit(el, 'filter', detail);
    tell('change', detail);
  };

  /** Where focus goes when the chip or button that had it went (the controls folded away: `fallback`, the button that opens them). */
  const home = () => /** @type {HTMLElement|null} */ ([...el.querySelectorAll(options.home ?? 'input, select, button, textarea')].find((node) => canTakeFocus(node)) ?? [options.fallback?.()].find((node) => node && canTakeFocus(node)) ?? null);

  /** Empties the controls of one applied entry (by key), or all; tells and announces. */
  const clear = (key, user = true) => {
    const list = appliedOf(controls());
    const entries = key == null ? null : list.filter((entry) => entry.key === key);
    if (entries && !entries.length) return;
    const all = controls();
    const next = readControls(all);
    if (entries) {
      for (const entry of entries) {
        if (Array.isArray(entry.value)) delete next[entry.name];
        else {
          next[entry.name] = (next[entry.name] ?? []).filter((value) => value !== entry.value);
          if (!next[entry.name].length) delete next[entry.name];
        }
      }
    }
    // Clear all empties what has a chip: a search field keeps its text.
    const target = entries ? next : Object.fromEntries(all.filter((node) => node.type === 'search' && clean(node.value)).map((node) => [node.name, [node.value.trim()]]));
    quiet += 1;
    let touched = [];
    try {
      touched = writeControls(all, target);
      for (const node of touched) {
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } finally {
      quiet -= 1;
    }
    if (!user) {
      // From the page (the controller's clear()): silent, as set().
      last = JSON.stringify(readControls(controls()));
      paint();
      return;
    }
    changed(entries ? entries[0].name : null, entries ? 'remove' : 'clear');
    if (user) announce(entries ? t('filterRemoved', { filter: entries[0].chip }) : t('filtersCleared'));
  };

  const on = (target, type, fn) => target?.addEventListener(type, fn, { signal });
  const onControl = (event) => {
    const node = /** @type {HTMLInputElement} */ (event.target);
    if (!node?.name || !controls().includes(node)) return;
    // Text fields tell as they are typed in; the others (and a range's bounds) when they change.
    const typed = kindOf(node) === 'text' && !boundOf(node) && node.type !== 'number' && node.type !== 'date';
    if (event.type === 'input' && !typed) return;
    changed(node.name, event.type);
  };
  const onClick = (event) => {
    const target = /** @type {Element} */ (event.target);
    const chip = target?.closest?.('[data-ds-filter-key]');
    const host = chip ? parts(options.chips).find((node) => node.contains(chip)) : null;
    if (host) {
      const chips = [...host.querySelectorAll('[data-ds-filter-key]')];
      const index = chips.indexOf(chip);
      const hadFocus = doc.activeElement === chip || event.detail === 0;
      clear(chip.getAttribute('data-ds-filter-key'));
      if (hadFocus || doc.activeElement === doc.body || !doc.activeElement?.isConnected) {
        const left = [...host.querySelectorAll('[data-ds-filter-key]')];
        /** @type {HTMLElement|null} */ (left[index] ?? left[index - 1] ?? home())?.focus();
      }
      return;
    }
    const button = options.clear ? target?.closest?.(options.clear) : null;
    if (button && button.getAttribute('aria-disabled') !== 'true') {
      const hadFocus = doc.activeElement === button;
      clear(null);
      if (hadFocus && (button.closest('[hidden]') || !canTakeFocus(button))) home()?.focus();
    }
  };
  for (const type of ['input', 'change']) on(el, type, onControl);
  on(el, 'click', onClick);
  on(doc, 'ds:config', () => {
    paint();
    paintCount();
  });
  signal?.addEventListener('abort', () => view?.clearTimeout(speak));

  return {
    paint,
    clear,
    count,
    controls,
    away,
    /** Listens on a part outside the element (a folded part in a sheet, a chips row beside the list), until `off` aborts. */
    watch(root, off) {
      const listen = off ? { signal: off } : {};
      for (const type of ['input', 'change']) root.addEventListener(type, onControl, listen);
      root.addEventListener('click', onClick, listen);
    },
    get() {
      return readControls(controls());
    },
    set(value) {
      writeControls(controls(), value ?? {});
      last = JSON.stringify(readControls(controls()));
      paint();
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    destroy() {
      listeners.clear();
      view?.clearTimeout(speak);
    },
  };
}

function controller(el, given, signal) {
  const doc = el.ownerDocument;
  let options = { ...readOptions(el), ...given };
  const sheetOf = () => (options.sheet ? (typeof options.sheet === 'string' ? doc.querySelector(options.sheet) : options.sheet) : null);
  const base = engine(el, {
    chips: '.ds-filterbar__chips',
    applied: '.ds-filterbar__applied',
    clear: '.ds-filterbar__clear',
    count: '.ds-filterbar__count',
    results: '.ds-filterbar__results',
    home: 'input[type="search"], input, select, button',
    extra: () => [sheetOf()].filter(Boolean),
    paint: (list) => badge(list),
  }, signal);
  const row = el.querySelector('.ds-filterbar__row');
  const filters = /** @type {HTMLElement|null} */ (el.querySelector('.ds-filterbar__filters'));
  const more = /** @type {HTMLElement|null} */ (el.querySelector('.ds-filterbar__more'));
  let needed = 0;
  let folding = null;
  /** While the filters sit in the sheet: where they came from and the listeners on the sheet. */
  let away = null;

  /** The badge of the "Filters" button: how many applied filters sit in the folded part. */
  function badge(list) {
    const holder = more?.querySelector('.ds-filterbar__badge');
    if (!holder || !filters) return;
    const inside = new Set(controlsIn([filters]).map((node) => node.name));
    const count = list.filter((entry) => inside.has(entry.name)).length;
    const text = count ? String(count) : '';
    if (holder.getAttribute('data-count') !== text) {
      holder.setAttribute('data-count', text);
      holder.replaceChildren();
      if (count) {
        const shown = doc.createElement('span');
        shown.setAttribute('aria-hidden', 'true');
        shown.textContent = number(count);
        const said = doc.createElement('span');
        said.className = 'ds-sr';
        said.textContent = ` ${t('filtersApplied', { count: number(count) })}`;
        holder.append(shown, said);
      }
    }
    own(holder, 'attrs', 'hidden');
    holder.hidden = !count;
  }

  /** Folds the filters when the row cannot hold them in one line, unfolds when it can again. */
  const measure = () => {
    if (!row || !filters || !more || signal?.aborted) return;
    const folded = el.hasAttribute('data-folded');
    // While they sit in the sheet the bar stays folded.
    if (folding) return;
    const width = row.clientWidth;
    if (!folded) {
      const search = row.querySelector('.ds-filterbar__search');
      // On one line the row's items share their bottom edge (they align at the end).
      const bottom = (search ?? filters).getBoundingClientRect().bottom;
      const wrapped = Math.abs(filters.getBoundingClientRect().bottom - bottom) > 1 || filters.scrollWidth > filters.clientWidth + 1;
      if (!wrapped) return;
      const style = doc.defaultView.getComputedStyle(row);
      const gap = parseFloat(style.columnGap) || 0;
      const min = search ? parseFloat(doc.defaultView.getComputedStyle(search).minWidth) || 0 : 0;
      const count = row.querySelector('.ds-filterbar__count');
      needed = min + filters.scrollWidth + gap * (search ? 1 : 0) + (count ? count.getBoundingClientRect().width + gap : 0);
      el.setAttribute('data-folded', '');
      base.paint();
    } else if (needed && width >= needed) {
      el.removeAttribute('data-folded');
      // Measured again, in case it still does not fit (the filters changed meanwhile).
      measure();
    }
  };

  const View = doc.defaultView;
  const observer = typeof View?.ResizeObserver === 'function' ? new View.ResizeObserver(() => measure()) : null;
  if (row) observer?.observe(row);
  if (filters) observer?.observe(filters);
  signal?.addEventListener('abort', () => observer?.disconnect());

  const openSheet = () => {
    const sheet = sheetOf();
    if (!sheet || !filters || folding) return;
    const off = new AbortController();
    away = { off, sheet, home: filters.parentNode, next: filters.nextSibling };
    base.away.add(filters);
    base.watch(sheet, off.signal);
    folding = fold(filters, sheet, {
      opener: more,
      back() {
        base.away.delete(filters);
        off.abort();
        away = null;
        folding = null;
        measure();
      },
    });
    base.paint();
  };

  /** Destroyed with the filters in the sheet: they go back now, the sheet's listeners go, and the sheet closes. */
  const unfold = () => {
    if (!away || !filters) return;
    const { off, sheet, home, next } = away;
    away = null;
    folding = null;
    off.abort();
    base.away.delete(filters);
    if (sheet.contains(filters) && home?.isConnected) move(home, filters, next?.parentNode === home ? next : null);
    closeOverlay(sheet);
  };
  more?.addEventListener('click', openSheet, { signal });
  if (more && !more.hasAttribute('aria-haspopup')) more.setAttribute('aria-haspopup', 'dialog');

  base.paint();
  measure();

  return {
    get: base.get,
    set: base.set,
    on: base.on,
    clear(key) {
      base.clear(key ?? null, false);
    },
    count(value, forms) {
      base.count(value, forms);
    },
    fold() {
      el.setAttribute('data-folded', '');
      openSheet();
    },
    update() {
      options = { ...options, ...readOptions(el), ...given };
      base.paint();
      measure();
    },
    destroy() {
      observer?.disconnect();
      unfold();
      base.destroy();
    },
  };
}

define('filterbar', {
  attribute: 'data-ds-filterbar',
  attributes: ['data-ds-filterbar-sheet'],
  init(el, ctx) {
    return built.get(el) ?? controller(el, {}, ctx.signal);
  },
});

/**
 * A filter bar driven from the page; the same controller data-ds-filterbar
 * makes (an element that has one returns it).
 * @param {Element} el  the .ds-filterbar element
 * @param {{ sheet?: string|Element|null }} [options]
 */
export function create(el, options = {}) {
  const existing = controllerOf(el, 'filterbar') ?? built.get(el);
  if (existing) return /** @type {any} */ (existing);
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const made = controller(el, options, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
    built.delete(el);
  };
  built.set(el, made);
  return made;
}

/**
 * The filter engine of any container of named controls (applied chips in
 * every `chips` row, Clear all buttons `clear`, the applied rows `applied`,
 * the result count in `count` and on the `results` buttons, ds:filter and
 * the announcements), for a component that builds on the bar's rules:
 * DS.facets. The selectors match inside `el` and the roots `extra` returns
 * (a chips row beside the list, the sheet); `home` finds where focus goes
 * when its chip went, else `fallback()`. Its handle: get(), set(), on(),
 * clear(key), paint(), count(value, forms), watch(root, signal) (listens
 * for chips and Clear all on a root outside `el`) and destroy().
 * @param {Element} el
 * @param {{ chips?: string, clear?: string, applied?: string, count?: string, results?: string, home?: string, fallback?: () => Element|null, extra?: () => Element[], paint?: (list: object[]) => void }} options
 * @param {AbortSignal|null} [signal]
 */
export function filters(el, options, signal = null) {
  const base = engine(el, options, signal);
  return {
    get: base.get,
    set: base.set,
    on: base.on,
    clear: (key) => base.clear(key ?? null, false),
    paint: base.paint,
    count: base.count,
    watch: base.watch,
    destroy: base.destroy,
  };
}
