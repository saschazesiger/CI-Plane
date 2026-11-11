/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Facet filter panel (DS.facets): the filters of a list beside it, one facet
 * per field with counts, a search inside a long facet, "Show all" after a
 * limit, the applied filters as chips with Clear all; on a narrow layout it
 * folds behind a "Filters" button and opens in a side sheet (facets.css has
 * the markup).
 *
 *   <section class="ds-facets" role="complementary" data-ds-facets data-ds-facets-sheet="#facets-sheet"> ... </section>
 *
 *   const panel = DS.facets.create(el);
 *   panel.get();                                   // { status: ['online'], storage: ['', '512'] }
 *   panel.set({ owner: ['ada'] });                 // the controls follow; sends nothing
 *   panel.counts({ status: { online: 24, offline: 3 } });
 *   panel.count(27);                               // "27 results", "Show 27 results"
 *   el.addEventListener('ds:filter', (event) => render(event.detail.filters));
 *
 * The filters are the named controls of the panel, read with the filter
 * bar's rules (DS.filterbar.read: checkboxes, radios, selects, fields, a
 * range of two fields with data-ds-filter-bound); its chips, Clear all,
 * ds:filter ({ filters, name, reason }) and the announcements are the bar's
 * engine (DS.filterbar.filters). What this module adds:
 *
 * - Counts: .ds-check__count of each option, written by counts() in the
 *   locale. An option at 0 that is not checked is disabled (the default),
 *   hidden (data-ds-facets-zero="hide" on the panel) or left as it is
 *   ("show"); a checked one stays, so it can be unchecked.
 * - Limit: data-ds-facet-limit="n" on a .ds-facet shows its first n options
 *   (and every checked one); .ds-facet__more says "Show all 12" and
 *   "Show fewer", with aria-expanded.
 * - Search: the unnamed field of .ds-facet__search shows the options whose
 *   label holds the text (case and accents aside), whatever the limit;
 *   .ds-facet__empty says when none does; the number of matches is
 *   announced once typing pauses (--ds-delay-tooltip). Escape empties it
 *   (and keeps a sheet around it open).
 * - Folding: in a .ds-facets-layout, a ResizeObserver writes data-folded on
 *   the layout when the panel would wrap above the main part; the panel
 *   hides and .ds-facets__toggle shows, with a badge of the applied filters.
 *   The toggle opens the sheet of data-ds-facets-sheet with the panel moved
 *   into its body (DS.filterbar.fold) and puts it back once it closed. A
 *   .ds-facets__applied in the main part gets the same chips and Clear all
 *   (shown while folded); its last chip hands the focus to the toggle.
 * - Count: count() writes .ds-facets__count and the sheet's
 *   .ds-facets__results at once; after a change by the user it is
 *   announced once changes pause (the bar's engine), also from the sheet.
 *
 * Strings: facetShowAll, facetShowFewer, facetNoMatch, facetMatchesOne,
 * facetMatchesOther, and the bar's removeFilter, filterRemoved,
 * filtersCleared, filtersApplied, filterChip, resultsOne, resultsOther,
 * showResults and range strings (DS.core.config()).
 *
 * ES2022.
 *
 * Progressive:
 * - moveBefore (through DS.filterbar.fold: the panel moves into the sheet
 *   and back keeping its state and focus): without it insertBefore.
 */
import { define, get as controllerOf, t } from './core.js';
import { motionDuration } from './motion.js';
import { own, disown } from './dom.js';
import { announce } from './a11y.js';
import { number, plural } from './format.js';
import { close as closeOverlay } from './overlay.js';
import { filters as engineOf, fold as foldInto } from './filterbar.js';

/** The controllers create() made, so the attribute path takes over the same one. */
const built = new WeakMap();

const ZERO = ['disable', 'hide', 'show'];

/**
 * Text folded for matching: lower case, accents and repeated spaces gone.
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function foldText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which options of a facet show: an option is
 * { label, checked, count } (count null: unknown). A query shows the
 * matches only (limit aside); else the first `limit` options show, and every
 * checked one. `zero` 'hide' leaves out unchecked options counted 0. Returns
 * a list of booleans in the options' order and the numbers the facet tells:
 * { shown, matches, total, more } (more: the limit hides some).
 * @param {{ label: string, checked?: boolean, count?: number|null }[]} options
 * @param {{ query?: string, limit?: number|null, expanded?: boolean, zero?: string }} [state]
 * @returns {{ shown: boolean[], matches: number, total: number, more: boolean }}
 */
export function visible(options, state = {}) {
  const query = foldText(state.query);
  const limit = Number.isInteger(state.limit) && state.limit > 0 ? state.limit : null;
  const eligible = options.map((option) => option.checked || !(state.zero === 'hide' && option.count === 0));
  const total = eligible.filter(Boolean).length;
  if (query) {
    const shown = options.map((option, index) => eligible[index] && foldText(option.label).includes(query));
    return { shown, matches: shown.filter(Boolean).length, total, more: false };
  }
  let seen = 0;
  const shown = options.map((option, index) => {
    if (!eligible[index]) return false;
    seen += 1;
    return !limit || state.expanded || seen <= limit || Boolean(option.checked);
  });
  return { shown, matches: total, total, more: Boolean(limit && total > limit) };
}

/** Options from the attributes. */
function readOptions(el) {
  const zero = el.getAttribute('data-ds-facets-zero');
  return { sheet: el.getAttribute('data-ds-facets-sheet'), zero: ZERO.includes(zero) ? zero : 'disable' };
}

/** The label text of an option row, without its count. */
function labelText(row) {
  let out = '';
  for (const child of row.childNodes) {
    if (child.nodeType === 3) out += child.nodeValue;
    else if (child.nodeType === 1 && !child.matches('input, svg, .ds-check__count, [aria-hidden="true"]')) out += child.textContent;
  }
  return out.replace(/\s+/g, ' ').trim();
}

const rowsOf = (facet) => [...facet.querySelectorAll('.ds-facet__options > .ds-check')];
const inputOf = (row) => /** @type {HTMLInputElement|null} */ (row.querySelector('input[name]'));

function controller(el, given, signal) {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  let options = { ...readOptions(el), ...given };
  /** Each facet's search text and whether "Show all" is open. */
  const state = new WeakMap();
  /** The inputs this module disabled for a count of 0. */
  const zeroed = new WeakSet();
  const layout = el.closest('.ds-facets-layout');
  const main = layout?.querySelector(':scope > .ds-facets-layout__main') ?? null;
  const toggle = /** @type {HTMLElement|null} */ (layout?.querySelector('.ds-facets__toggle') ?? null);
  const sheetOf = () => (options.sheet ? (typeof options.sheet === 'string' ? doc.querySelector(options.sheet) : options.sheet) : null);
  let folding = null;
  /** While the panel sits in the sheet: where it came from. */
  let away = null;
  let lastWidth = -1;
  let speak = 0;

  /** The badge of the toggle: how many filters are applied. */
  const badge = (list) => {
    const holder = toggle?.querySelector('.ds-facets__badge');
    if (!holder) return;
    const count = list.length;
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
  };

  const base = engineOf(el, {
    chips: '.ds-facets__chips',
    clear: '.ds-facets__clear',
    applied: '.ds-facets__applied',
    count: '.ds-facets__count',
    results: '.ds-facets__results',
    home: 'input[name], select[name], textarea[name]',
    // Folded, the panel's controls hide: a chip removed beside the list hands the focus to the toggle.
    fallback: () => toggle,
    // A second applied row in the main part (shown while folded), the count there, the sheet's results button.
    extra: () => [main, sheetOf()].filter(Boolean),
    paint: (list) => {
      badge(list);
      for (const facet of el.querySelectorAll('.ds-facet')) paintFacet(facet);
    },
  }, signal);
  if (main) base.watch(main, signal);

  /** The count of an option, from its .ds-check__count (null: none or not a number). */
  const countOf = (row) => {
    const node = row.querySelector('.ds-check__count');
    if (!node) return null;
    const raw = node.getAttribute('data-count') ?? node.textContent.replace(/[^\d]/g, '');
    return raw === '' ? null : Number(raw);
  };

  /** Shows the options of one facet by its search, limit and counts; writes its "Show all" and empty line. */
  function paintFacet(facet) {
    const rows = rowsOf(facet);
    const facetState = state.get(facet) ?? { query: '', expanded: false };
    state.set(facet, facetState);
    const limit = Number.parseInt(facet.getAttribute('data-ds-facet-limit') ?? '', 10);
    const described = rows.map((row) => ({ label: labelText(row), checked: Boolean(inputOf(row)?.checked), count: countOf(row) }));
    // Counted 0 and not checked: disabled (the default) or left alone.
    rows.forEach((row, index) => {
      const input = inputOf(row);
      if (!input) return;
      // Never under the focus (it would drop to the page): once it leaves, focusout paints again.
      const off = options.zero === 'disable' && described[index].count === 0 && !described[index].checked && input !== doc.activeElement;
      if (off && !input.disabled) {
        own(input, 'attrs', 'disabled');
        input.disabled = true;
        zeroed.add(input);
      } else if (!off && zeroed.has(input)) {
        input.disabled = false;
        zeroed.delete(input);
        disown(input, 'attrs', 'disabled');
      }
    });
    const result = visible(described, { query: facetState.query, limit: Number.isNaN(limit) ? null : limit, expanded: facetState.expanded, zero: options.zero });
    rows.forEach((row, index) => {
      const hide = !result.shown[index];
      if (row.hidden !== hide) {
        own(row, 'attrs', 'hidden');
        row.hidden = hide;
      }
    });
    const more = /** @type {HTMLElement|null} */ (facet.querySelector('.ds-facet__more'));
    if (more) {
      own(more, 'attrs', 'hidden');
      own(more, 'attrs', 'aria-expanded');
      more.hidden = !result.more;
      more.setAttribute('aria-expanded', String(facetState.expanded));
      const label = facetState.expanded ? t('facetShowFewer') : t('facetShowAll', { count: number(result.total) });
      const slot = more.querySelector('.ds-btn__label') ?? more;
      if (slot.textContent !== label) slot.textContent = label;
    }
    const empty = /** @type {HTMLElement|null} */ (facet.querySelector('.ds-facet__empty'));
    if (empty) {
      const none = Boolean(facetState.query.trim()) && result.matches === 0;
      own(empty, 'attrs', 'hidden');
      empty.hidden = !none;
      const text = none ? t('facetNoMatch', { query: facetState.query.trim() }) : '';
      if (empty.textContent !== text) empty.textContent = text;
    }
    return result;
  }

  const paintAll = () => base.paint();

  /** The search of a facet changed: show the matches, then say how many once typing pauses. */
  const onSearch = (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    const facet = input?.closest?.('.ds-facet');
    if (!facet || !input.closest('.ds-facet__search') || input.name) return;
    const facetState = state.get(facet) ?? { query: '', expanded: false };
    facetState.query = input.value;
    state.set(facet, facetState);
    const result = paintFacet(facet);
    view?.clearTimeout(speak);
    if (!input.value.trim()) return;
    speak = view?.setTimeout(() => {
      if (signal?.aborted || !input.isConnected || input.value !== facetState.query) return;
      const shown = number(result.matches);
      announce(result.matches
        ? plural(result.matches, { one: t('facetMatchesOne', { count: shown }), other: t('facetMatchesOther', { count: shown }) })
        : t('facetNoMatch', { query: facetState.query.trim() }));
    }, motionDuration(el, '--ds-delay-tooltip')) ?? 0;
  };

  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (!input?.closest?.('.ds-facet__search') || input.name || !input.value) return;
    // The search empties first; a sheet around it stays open (the overlay's Escape waits for the page).
    event.preventDefault();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const onClick = (/** @type {MouseEvent} */ event) => {
    const more = /** @type {Element} */ (event.target)?.closest?.('.ds-facet__more');
    if (!more || !el.contains(more)) return;
    const facet = more.closest('.ds-facet');
    const facetState = state.get(facet) ?? { query: '', expanded: false };
    facetState.expanded = !facetState.expanded;
    state.set(facet, facetState);
    paintFacet(facet);
  };

  el.addEventListener('input', onSearch, { signal });
  el.addEventListener('keydown', onKey, { signal });
  el.addEventListener('click', onClick, { signal });
  el.addEventListener('focusout', (event) => {
    const facet = /** @type {Element} */ (event.target)?.closest?.('.ds-facet__options')?.closest('.ds-facet');
    if (facet) paintFacet(facet);
  }, { signal });

  /** Folds the panel when the layout would wrap it above the main part, unfolds when it fits again. */
  const measure = () => {
    if (!layout || !main || folding || signal?.aborted || !layout.contains(el)) return;
    const width = layout.clientWidth;
    if (width === lastWidth) return;
    lastWidth = width;
    const was = layout.hasAttribute('data-folded');
    if (was) layout.removeAttribute('data-folded');
    // Measured unfolded, in the same frame: a wrapped panel sits above the main part.
    const wrapped = main.getBoundingClientRect().top - el.getBoundingClientRect().top > 1;
    if (wrapped) layout.setAttribute('data-folded', '');
    if (wrapped !== was) paintAll();
  };
  const observer = typeof view?.ResizeObserver === 'function' ? new view.ResizeObserver(() => measure()) : null;
  if (layout) observer?.observe(layout);
  signal?.addEventListener('abort', () => {
    observer?.disconnect();
    view?.clearTimeout(speak);
  });

  const openSheet = () => {
    const sheet = sheetOf();
    if (!sheet || folding) return null;
    away = { sheet, home: el.parentNode, next: el.nextSibling };
    folding = foldInto(el, sheet, {
      opener: toggle,
      back() {
        away = null;
        folding = null;
        lastWidth = -1;
        measure();
      },
    });
    return folding;
  };
  toggle?.addEventListener('click', () => { openSheet(); }, { signal });
  if (toggle && !toggle.hasAttribute('aria-haspopup')) toggle.setAttribute('aria-haspopup', 'dialog');

  /** Destroyed with the panel in the sheet: it goes back now and the sheet closes. */
  const unfold = () => {
    if (!away) return;
    const { sheet, home, next } = away;
    away = null;
    folding = null;
    if (sheet.contains(el) && home?.isConnected) home.insertBefore(el, next?.parentNode === home ? next : null);
    closeOverlay(sheet);
  };

  paintAll();
  measure();

  return {
    get: base.get,
    set(value) {
      // An option disabled for its count of 0 can still be set; painting disables it again unless checked.
      for (const input of el.querySelectorAll('.ds-facet__options input[name]:disabled')) if (zeroed.has(input)) /** @type {HTMLInputElement} */ (input).disabled = false;
      base.set(value);
    },
    on: base.on,
    clear(key) {
      base.clear(key ?? null);
    },
    counts(map) {
      for (const [name, values] of Object.entries(map ?? {})) {
        for (const input of el.querySelectorAll('.ds-facet__options input[name]')) {
          if (/** @type {HTMLInputElement} */ (input).name !== name) continue;
          const value = /** @type {HTMLInputElement} */ (input).value;
          if (!Object.hasOwn(values ?? {}, value)) continue;
          const node = input.closest('.ds-check')?.querySelector('.ds-check__count');
          if (!node) continue;
          const amount = Number(values[value]);
          node.setAttribute('data-count', String(amount));
          const text = number(amount);
          if (node.textContent !== text) node.textContent = text;
        }
      }
      paintAll();
    },
    count(value, pluralForms) {
      base.count(value, pluralForms);
    },
    open() {
      return openSheet() ?? Promise.resolve();
    },
    update() {
      options = { ...options, ...readOptions(el), ...given };
      paintAll();
      lastWidth = -1;
      measure();
    },
    destroy() {
      observer?.disconnect();
      view?.clearTimeout(speak);
      unfold();
      base.destroy();
    },
  };
}

define('facets', {
  attribute: 'data-ds-facets',
  attributes: ['data-ds-facets-sheet', 'data-ds-facets-zero'],
  init(el, ctx) {
    return built.get(el) ?? controller(el, {}, ctx.signal);
  },
});

/**
 * A facet panel driven from the page; the same controller data-ds-facets
 * makes (an element that has one returns it).
 * @param {Element} el  the .ds-facets element
 * @param {{ sheet?: string|Element|null, zero?: 'disable'|'hide'|'show' }} [options]
 */
export function create(el, options = {}) {
  const existing = controllerOf(el, 'facets') ?? built.get(el);
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
