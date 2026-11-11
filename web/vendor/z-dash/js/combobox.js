/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The combobox (DS.combobox): the behaviour of a .ds-combo marked
 * data-ds-combobox, on the list engine of DS.listbox. Without the attribute
 * a combobox stays the page's script, as in 2.x.
 *
 *   <div class="ds-combo" data-ds-combobox [data-ds-combobox-creatable]>
 *     <input class="ds-input ds-combo__input" role="combobox" aria-expanded="false" aria-controls="list" aria-autocomplete="list">
 *     <button class="ds-combo__clear" type="button" aria-label="Clear model" hidden>(close)</button>
 *     <button class="ds-combo__toggle" type="button" tabindex="-1" aria-label="Show all">(chevronDown)</button>
 *     <div class="ds-combo__popup" hidden><ul class="ds-combo__list" id="list" role="listbox"> options </ul></div>
 *   </div>
 *
 *   const combo = DS.combobox.create(el, { items, source: (query, { signal }) => fetch(...).then(...) });
 *   combo.get(); combo.set('laptop-14'); combo.on('change', ({ value }) => ...);
 *
 * What it does: filters the options of the markup in place as the field
 * changes, with DS.listbox.fuzzy (`hidden` on the others, the matched
 * letters marked in .ds-combo__match; the options keep their content, ids
 * and order), or renders `items` (best first; windowed when long, through
 * DS.virtual), or asks `source(query, { signal })` after --ds-delay-loader
 * without a key (a spinner and aria-busy while it runs; a newer query
 * aborts the older one; with minLength 0 an open asks at once). Nothing
 * found: the list part hides and the status line says so; the list stays
 * open. Creatable (data-ds-combobox-creatable or `creatable`): a last
 * option creates the typed text when no option has that name, after a
 * cancelable ds:create. Clearable: a .ds-combo__clear shows while there is
 * something to clear. Several values (.ds-combo--multi): input chips before
 * the field, the list stays open, Backspace in the empty field removes the
 * last one (announced). Select-only (.ds-combo--select): the WAI keys of a
 * select (Enter, Space, the arrows, Home and End open, type-ahead; Tab
 * chooses the active option and moves on).
 *
 * Opening and closing go through DS.overlay (Escape, the placement, the
 * cut edges); the focus stays in the field; a press in the list never
 * takes it.
 *
 * Events on the .ds-combo: ds:change ({ value, item }), ds:create ({ text },
 * cancelable: the text stays typed), ds:search ({ query }) before a source
 * is asked.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { motionDuration } from './motion.js';
import { open as openOverlay, close as closeOverlay } from './overlay.js';
import { announce } from './a11y.js';
import { plural } from './format.js';
import { icon, iconElement, close as closeGlyph, plus } from './icons.js';
import { create as createList } from './listbox.js';

/** The value of the "Create" option: never a value of the page's. */
const CREATE = '\u0000ds-create';

/** The live controllers. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

let sequence = 0;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** The options of the markup as items: value, label, description, meta, group, disabled (the labels and the select's meta). */
function itemsOf(list) {
  return [...list.querySelectorAll('.ds-combo__option')].filter((option) => !option.classList.contains('ds-combo__option--create')).map((option) => {
    const name = option.querySelector('.ds-combo__name');
    const label = (name ?? option).textContent.trim();
    const heading = option.closest('.ds-combo__group')?.querySelector('.ds-combo__heading');
    return {
      value: /** @type {HTMLElement} */ (option).dataset.value ?? label,
      label,
      description: option.querySelector('.ds-combo__description')?.textContent.trim() ?? '',
      meta: option.querySelector('.ds-combo__meta')?.textContent.trim() ?? '',
      group: heading?.textContent.trim() ?? '',
      disabled: option.getAttribute('aria-disabled') === 'true',
      selected: option.getAttribute('aria-selected') === 'true',
    };
  });
}

/** A number of an attribute, or the fallback. */
function numberOf(element, name, fallback) {
  const value = Number(element.getAttribute(name));
  return element.hasAttribute(name) && Number.isFinite(value) ? value : fallback;
}

/**
 * The controller of a combobox, the one [data-ds-combobox] makes; once per
 * .ds-combo. Options: `items` (data; default the markup's options),
 * `source(query, { signal })` (a Promise of items, asked as the field
 * changes), `debounce` (ms; default --ds-delay-loader), `minLength` (letters
 * before a source is asked; default 1, 0 asks for the empty field too),
 * `creatable`, `multiple` (default .ds-combo--multi), `value`, `virtual`
 * (as DS.listbox), `name` (hidden inputs of that name carry the value).
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
  const input = /** @type {HTMLInputElement} */ (element?.querySelector?.('.ds-combo__input'));
  const popup = /** @type {HTMLElement} */ (element?.querySelector?.('.ds-combo__popup'));
  const list = /** @type {HTMLElement} */ (popup?.querySelector('.ds-combo__list'));
  if (!input || !popup || !list) return null;
  const doc = element.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  const select = element.classList.contains('ds-combo--select');
  const multiple = !select && (options.multiple ?? (element.classList.contains('ds-combo--multi') || list.getAttribute('aria-multiselectable') === 'true'));
  const creatable = !select && (options.creatable ?? element.hasAttribute('data-ds-combobox-creatable'));
  const source = typeof options.source === 'function' ? options.source : null;
  const minLength = options.minLength ?? numberOf(element, 'data-ds-combobox-min', 1);
  const toggle = element.querySelector('.ds-combo__toggle');
  const clear = /** @type {HTMLButtonElement|null} */ (element.querySelector('.ds-combo__clear'));
  const name = options.name ?? element.getAttribute('data-ds-combobox-name');

  if (!list.id) list.id = `ds-combo-list-${(sequence += 1)}`;
  if (!input.hasAttribute('aria-controls')) input.setAttribute('aria-controls', list.id);
  if (!select && !input.hasAttribute('aria-autocomplete')) input.setAttribute('aria-autocomplete', 'list');
  if (!select) input.setAttribute('autocomplete', 'off');
  if (multiple) list.setAttribute('aria-multiselectable', 'true');

  // The status line: the system's own part, made when the markup has none (a select-only list counts nothing).
  let status = popup.querySelector('.ds-combo__status');
  if (!status && !select) {
    status = doc.createElement('p');
    status.className = 'ds-combo__status';
    status.setAttribute('role', 'status');
    popup.append(status);
  }

  /* The data: items from the markup or the page, the labels of every value
     ever chosen (a source may not return them again). */
  const markupItems = itemsOf(list);
  /* Without items or a source the engine works on the markup itself, so
     the options keep their content (a progress bar, an icon), ids and groups. */
  let fromMarkup = !options.items && !source;
  let base = options.items ? [...options.items] : markupItems;
  const labels = new Map();
  const remember = (items) => {
    for (const item of items) {
      if (item && typeof item === 'object') labels.set(String(item.value ?? item.label), String(item.label ?? item.value));
      else labels.set(String(item), String(item));
    }
  };
  remember(base);
  const labelOf = (value) => labels.get(value) ?? value;

  let query = '';
  let searching = 0;
  let timer = 0;
  let pending = null;
  /** The query whose results the list holds (a source), so an open asks only for what it lacks. */
  let resultsFor = null;
  let destroyed = false;

  const createItem = {
    value: CREATE,
    label: '',
    className: 'ds-combo__option--create',
    pinned: (text) => creatable && text.trim() !== '' && !hasLabel(text),
  };
  const hasLabel = (text) => {
    const wanted = text.trim().toLowerCase();
    return engineEntries().some((entry) => entry.value !== CREATE && entry.label.toLowerCase() === wanted);
  };

  const withCreate = (items) => (creatable ? [...items, createItem] : items);

  /* The markup's "Create" option: the page's, else one of the system's. */
  const optionTag = list.localName === 'ul' || list.localName === 'ol' ? 'li' : 'div';
  let createEl = fromMarkup && creatable ? list.querySelector('.ds-combo__option--create') : null;
  const madeCreate = fromMarkup && creatable && !createEl;
  if (madeCreate) {
    createEl = doc.createElement(optionTag);
    createEl.className = 'ds-combo__option ds-combo__option--create';
    createEl.setAttribute('role', 'option');
    createEl.setAttribute('aria-selected', 'false');
    createEl.hidden = true;
    const createName = doc.createElement('span');
    createName.className = 'ds-combo__name';
    createEl.append(iconElement(plus, 20, '', doc), createName);
    list.append(createEl);
  }
  if (createEl) createEl.setAttribute('data-value', CREATE);
  const isCreate = (el) => el.classList.contains('ds-combo__option--create');

  const engine = createList(list, {
    ...(fromMarkup ? {} : { items: withCreate(base) }),
    pinned: (el) => (isCreate(el) ? createItem.pinned : false),
    multiple,
    focus: input,
    prefix: 'ds-combo',
    scroller: list,
    wrap: !select,
    follow: false,
    homeEnd: select,
    typeahead: select,
    space: false,
    virtual: options.virtual ?? (element.hasAttribute('data-ds-combobox-virtual') ? element.getAttribute('data-ds-combobox-virtual') !== 'false' : undefined),
    render: (item, nameHtml) => (item?.value === CREATE
      ? `${icon(plus, 20)}<span class="ds-combo__name">${esc(t('createOption', { text: query.trim() }))}</span>`
      : `<span class="ds-combo__name">${nameHtml}</span>${item?.description ? `<span class="ds-combo__description">${esc(item.description)}</span>` : ''}${item?.meta ? `<span class="ds-combo__meta">${esc(item.meta)}</span>` : ''}`),
  });
  const engineEntries = () => engine.entries();

  /** Filters what the list holds by `text`; the markup's "Create" option names it. */
  function filterNow(text) {
    query = text;
    if (fromMarkup && createEl) {
      const nameEl = createEl.querySelector('.ds-combo__name');
      if (nameEl) nameEl.textContent = t('createOption', { text: text.trim() });
    }
    engine.filter(text);
  }
  if (fromMarkup) filterNow('');

  /* The value. */
  let value = multiple ? [] : null;
  const initial = options.value !== undefined ? options.value : element.hasAttribute('data-ds-value') ? (multiple ? parseList(element.getAttribute('data-ds-value')) : element.getAttribute('data-ds-value')) : undefined;
  if (initial !== undefined) value = multiple ? [].concat(initial ?? []).map(String) : initial === null ? null : String(initial);
  else {
    const chosen = markupItems.filter((item) => item.selected).map((item) => item.value);
    value = multiple ? chosen : chosen[0] ?? null;
  }
  engine.set(value);

  const isOpen = () => input.getAttribute('aria-expanded') === 'true';
  const disabled = () => input.disabled || input.getAttribute('aria-disabled') === 'true' || input.readOnly;

  /* Chips of several values, before the field. */
  function renderChips() {
    if (!multiple) return;
    const chips = [...element.querySelectorAll(':scope > .ds-chip[data-ds-combobox-chip]')];
    const wanted = /** @type {string[]} */ (value);
    for (const chip of chips) if (!wanted.includes(chip.getAttribute('data-value'))) chip.remove();
    for (const each of wanted) {
      if (element.querySelector(`:scope > .ds-chip[data-ds-combobox-chip][data-value="${CSS.escape(each)}"]`)) continue;
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = 'ds-chip ds-chip--input';
      chip.setAttribute('data-ds-combobox-chip', '');
      chip.setAttribute('data-value', each);
      chip.tabIndex = -1;
      chip.disabled = input.disabled;
      const body = doc.createElement('span');
      body.className = 'ds-chip__body';
      const label = doc.createElement('span');
      label.className = 'ds-chip__label';
      const sr = doc.createElement('span');
      sr.className = 'ds-sr';
      sr.textContent = `${t('remove')} `;
      label.append(sr, doc.createTextNode(labelOf(each)));
      body.append(label, iconElement(closeGlyph, 18, 'ds-chip__trailing', doc));
      chip.append(body);
      input.before(chip);
    }
  }

  function writeHidden() {
    if (!name) return;
    let holder = element.querySelector(':scope > [data-ds-combobox-values]');
    if (!holder) {
      holder = doc.createElement('span');
      holder.hidden = true;
      holder.setAttribute('data-ds-combobox-values', '');
      element.append(holder);
    }
    holder.replaceChildren(...[].concat(value ?? []).map((each) => {
      const field = doc.createElement('input');
      field.type = 'hidden';
      field.name = name;
      field.value = each;
      return field;
    }));
  }

  function syncClear() {
    if (!clear) return;
    const empty = multiple ? !(/** @type {string[]} */ (value).length) && !input.value : !input.value && value === null;
    clear.hidden = empty || disabled();
  }

  function showValue() {
    if (select) {
      const shown = element.querySelector('.ds-combo__value');
      if (shown) shown.textContent = value === null ? '' : labelOf(/** @type {string} */ (value));
      const metaEl = input.querySelector('.ds-combo__meta');
      if (metaEl) {
        const item = base.find((each) => each && typeof each === 'object' && String(each.value ?? each.label) === value);
        metaEl.textContent = item?.meta ?? '';
      }
    } else if (!multiple) input.value = value === null ? '' : labelOf(/** @type {string} */ (value));
    renderChips();
    writeHidden();
    syncClear();
  }

  function changed(item) {
    emit(element, 'change', { value: multiple ? [...value] : value, item: item ?? null });
  }

  /* The status line, only while the list shows (a hidden one says nothing). */
  function setStatus(text, busy = false) {
    list.setAttribute('aria-busy', String(busy));
    if (!busy) list.removeAttribute('aria-busy');
    if (!status) return;
    const parts = [];
    if (busy) {
      const spinner = doc.createElement('span');
      spinner.className = 'ds-spinner ds-spinner--ink ds-sm';
      spinner.setAttribute('aria-hidden', 'true');
      parts.push(spinner);
    }
    parts.push(doc.createTextNode(text));
    status.replaceChildren(...parts);
  }

  function countText(count) {
    if (!count) return t('noResults');
    return plural(count, { one: () => t('resultsOne', { count }), other: ({ formatted }) => t('resultsOther', { count: formatted }) });
  }

  /** The list part and the status line after a filter or a search. */
  function settle() {
    const found = engine.shown().filter((entry) => entry.value !== CREATE).length;
    list.hidden = engine.shown().length === 0;
    if (searching) return;
    setStatus(source && query.trim().length < minLength ? t('typeToSearch') : countText(found));
  }

  /* Filtering and searching. */
  function run() {
    query = select ? '' : input.value;
    if (!source) {
      filterNow(query);
      settle();
      return;
    }
    clearTimeout(timer);
    pending?.abort();
    if (query.trim().length < minLength) {
      searching = 0;
      resultsFor = null;
      engine.setItems(withCreate([]));
      settle();
      return;
    }
    const wait = options.debounce ?? numberOf(element, 'data-ds-combobox-debounce', motionDuration(element, '--ds-delay-loader'));
    timer = setTimeout(search, wait);
  }

  function search() {
    const asked = query;
    if (!emit(element, 'search', { query: asked }, { cancelable: true })) return;
    const controller = new AbortController();
    pending = controller;
    searching += 1;
    setStatus(t('loading'), true);
    Promise.resolve()
      .then(() => source(asked, { signal: controller.signal }))
      .then((items) => {
        if (controller.signal.aborted || destroyed) return;
        base = [...(items ?? [])];
        remember(base);
        searching = 0;
        resultsFor = asked;
        engine.setItems(withCreate(base), { keep: true, query: asked });
        settle();
      }, (error) => {
        if (controller.signal.aborted || destroyed || error?.name === 'AbortError') return;
        searching = 0;
        resultsFor = null;
        engine.setItems(withCreate([]));
        list.hidden = true;
        setStatus(t('actionFailed'));
      });
  }

  /* Open and close. `all`: every option, whatever the field shows. */
  function openList({ all = false } = {}) {
    if (isOpen() || disabled()) return;
    if (!source) filterNow(select || all ? '' : input.value);
    else if (!select) {
      // Asked once for what the list does not hold yet (minLength 0: the empty field too), at once.
      const wanted = input.value;
      if (wanted.trim().length >= minLength && wanted !== resultsFor && !(searching && wanted === query)) {
        clearTimeout(timer);
        pending?.abort();
        query = wanted;
        search();
      }
    }
    settle();
    openOverlay(popup, { opener: input });
  }

  function closeList() {
    engine.activate(null);
    if (isOpen()) closeOverlay(popup);
  }

  popup.addEventListener('ds:close', () => engine.activate(null), { signal });

  /* Choosing: the engine's ds:change, retold by the combobox. */
  list.addEventListener('ds:change', (/** @type {CustomEvent} */ event) => {
    event.stopPropagation();
    const detail = event.detail;
    // An option of the markup comes as its value: the page gets its item, as with data.
    const item = typeof detail.item === 'string' && fromMarkup ? base.find((each) => each.value === detail.item) ?? detail.item : detail.item;
    if (item === CREATE || (item && typeof item === 'object' && item.value === CREATE)) {
      engine.set(value);
      createFrom(query.trim());
      return;
    }
    if (multiple) {
      value = /** @type {string[]} */ (detail.value).filter((each) => each !== CREATE);
      const label = labelOf(String(item?.value ?? item?.label ?? item));
      announce(t(detail.selected ? 'added' : 'removed', { label }));
      if (input.value) {
        input.value = '';
        run();
      }
      showValue();
      changed(item);
      return;
    }
    value = detail.value;
    showValue();
    closeList();
    if (source) {
      // The field shows the choice now, not a query: nothing to ask, and nothing still waiting.
      clearTimeout(timer);
      pending?.abort();
      searching = 0;
      query = input.value;
      resultsFor = query;
      settle();
    } else if (!select) run();
    changed(item);
  }, { signal });

  function createFrom(text) {
    if (!text) return;
    if (!emit(element, 'create', { text }, { cancelable: true })) return;
    const item = { value: text, label: text };
    base = [...base, item];
    remember([item]);
    if (fromMarkup) {
      // A new option of the markup, before the "Create" one.
      const option = doc.createElement(optionTag);
      option.className = 'ds-combo__option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.setAttribute('data-value', text);
      const nameEl = doc.createElement('span');
      nameEl.className = 'ds-combo__name';
      nameEl.textContent = text;
      option.append(nameEl);
      if (createEl?.parentElement === list) createEl.before(option);
      else list.append(option);
      engine.refresh();
    } else engine.setItems(withCreate(base));
    if (multiple) {
      value = [...value, text];
      announce(t('added', { label: text }));
      input.value = '';
      engine.set(value);
      run();
    } else {
      value = text;
      engine.set(value);
      closeList();
    }
    showValue();
    changed(item);
  }

  function removeValue(each) {
    if (!multiple) return;
    value = value.filter((other) => other !== each);
    engine.set(value);
    announce(t('removed', { label: labelOf(each) }));
    showValue();
    changed(null);
  }

  /* The field. */
  input.addEventListener('input', () => {
    if (select) return;
    if (!multiple && input.value === '' && value !== null) {
      value = null;
      engine.set(null);
      changed(null);
    }
    run();
    syncClear();
    if (!isOpen()) openOverlay(popup, { opener: input });
  }, { signal });

  input.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.isComposing || disabled()) return;
    const k = event.key;
    if (!isOpen()) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || (select && (k === 'Enter' || k === ' '))) {
        event.preventDefault();
        openList();
        if (event.altKey && !select) return;
        const chosen = [].concat(value ?? [])[0];
        if (chosen !== undefined && engine.shown().some((entry) => entry.value === chosen)) engine.activate(chosen);
        else engine.activate(k === 'ArrowUp' ? 'last' : 'first');
        return;
      }
      if (select && (k === 'Home' || k === 'End')) {
        event.preventDefault();
        openList();
        engine.activate(k === 'Home' ? 'first' : 'last');
        return;
      }
      if (select && k.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        openList();
        if (engine.key(event)) event.preventDefault();
        return;
      }
      if (multiple && k === 'Backspace' && !input.value && value.length) {
        event.preventDefault();
        removeValue(value[value.length - 1]);
      }
      return;
    }
    if (select && (k === ' ' || k === 'Enter')) {
      event.preventDefault();
      if (!engine.pick()) closeList();
      return;
    }
    if (k === 'Tab') {
      // A field's Tab chooses nothing; a select-only one takes the active option, as a select does. The focus moves on.
      if (select && engine.active()) engine.pick();
      closeList();
      return;
    }
    if (multiple && k === 'Backspace' && !input.value && value.length) {
      event.preventDefault();
      removeValue(value[value.length - 1]);
      return;
    }
    if (event.altKey && k === 'ArrowUp') {
      event.preventDefault();
      closeList();
      return;
    }
    if (engine.key(event)) event.preventDefault();
  }, { signal });

  input.addEventListener('blur', () => {
    // A press in the list keeps the focus (mousedown is cancelled there).
    closeList();
    if (!multiple && !select && value !== null && input.value !== labelOf(value)) input.value = labelOf(value);
    syncClear();
  }, { signal });

  if (!select) {
    // A press on the field shows what it offers; the keys stay the WAI ones.
    input.addEventListener('click', () => {
      if (!isOpen()) openList();
    }, { signal });
  } else {
    input.addEventListener('click', (/** @type {MouseEvent} */ event) => {
      if (event.detail > 1 || disabled()) return;
      if (isOpen()) closeList();
      else {
        openList();
        if (value !== null) engine.activate(value);
      }
    }, { signal });
  }

  // Presses on the chevron, the clear button and the list keep the focus in the field.
  for (const part of [toggle, clear, popup]) part?.addEventListener('mousedown', (event) => event.preventDefault(), { signal });

  toggle?.addEventListener('click', () => {
    if (disabled()) return;
    input.focus({ preventScroll: true });
    if (isOpen()) closeList();
    else {
      // "Show all": a field that shows the choice shows every option; typed text stays a filter.
      openList({ all: !multiple && value !== null && input.value === labelOf(/** @type {string} */ (value)) });
      const chosen = [].concat(value ?? [])[0];
      if (chosen !== undefined) engine.activate(chosen);
    }
  }, { signal });

  clear?.addEventListener('click', () => {
    const had = multiple ? value.length > 0 : value !== null;
    input.value = '';
    value = multiple ? [] : null;
    engine.set(value);
    run();
    showValue();
    input.focus({ preventScroll: true });
    if (had) changed(null);
  }, { signal });

  if (multiple) {
    element.addEventListener('click', (/** @type {MouseEvent} */ event) => {
      const chip = /** @type {Element} */ (event.target)?.closest?.('.ds-chip[data-ds-combobox-chip]');
      if (!chip || chip.parentElement !== element || disabled()) return;
      removeValue(chip.getAttribute('data-value'));
      input.focus({ preventScroll: true });
    }, { signal });
    // The box looks like one field: a press on an empty part of it goes to the field.
    element.addEventListener('mousedown', (event) => {
      if (event.target !== element) return;
      event.preventDefault();
      input.focus();
    }, { signal });
  }

  showValue();
  settle();

  const controller = {
    element,
    get: () => (multiple ? [...value] : value),
    set(next) {
      value = multiple ? [].concat(next ?? []).map(String) : next === null || next === undefined ? null : String(next);
      engine.set(value);
      showValue();
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === element) fn(event.detail);
      };
      element.addEventListener(`ds:${type}`, listener);
      return () => element.removeEventListener(`ds:${type}`, listener);
    },
    /** New data (items, as DS.listbox); the query kept. */
    setItems(items) {
      fromMarkup = false;
      base = [...items];
      remember(base);
      engine.setItems(withCreate(base));
      run();
    },
    /** Opens the list (DS.overlay). */
    open: openList,
    /** Closes the list (DS.overlay). */
    close: closeList,
    /** The list engine (DS.listbox's controller). */
    list: engine,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      pending?.abort();
      abort.abort();
      engine.destroy();
      if (madeCreate) createEl?.remove();
      controllers.delete(element);
    },
  };
  controllers.set(element, controller);
  return controller;
}

/** A value of data-ds-value with several values: a JSON list, else comma-separated. */
function parseList(text) {
  try {
    const list = JSON.parse(text);
    if (Array.isArray(list)) return list.map(String);
  } catch {
    // Comma-separated.
  }
  return String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

/**
 * Opens a combobox's list: DS.overlay.open() on its popup, the field as
 * the opener.
 * @param {Element} element  the .ds-combo
 * @returns {Promise<void>}
 */
export function open(element) {
  const control = controllers.get(element);
  if (control) {
    control.open();
    return Promise.resolve();
  }
  const popup = element?.querySelector('.ds-combo__popup');
  return popup ? openOverlay(popup, { opener: element.querySelector('.ds-combo__input') }) : Promise.resolve();
}

/**
 * Closes a combobox's list: DS.overlay.close() on its popup.
 * @param {Element} element  the .ds-combo
 * @returns {Promise<void>}
 */
export function close(element) {
  const popup = element?.querySelector('.ds-combo__popup');
  controllers.get(element)?.list.activate(null);
  return popup ? closeOverlay(popup) : Promise.resolve();
}

define('combobox', {
  attribute: 'data-ds-combobox',
  init: (element) => create(element),
});
