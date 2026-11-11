/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The select panel (DS.selectpanel): a button that opens a popover with a
 * filter, a list of options to check and an apply foot (labels, assignees,
 * filters), on the list engine of DS.listbox.
 *
 *   <div class="ds-selectpanel" data-ds-selectpanel>
 *     <button class="ds-btn ds-btn--outlined ds-selectpanel__trigger" type="button">Labels <span class="ds-selectpanel__summary"></span></button>
 *     <div class="ds-selectpanel__panel" role="dialog" aria-label="Labels" hidden>
 *       <div class="ds-selectpanel__head"><input class="ds-input ds-selectpanel__search" type="search" aria-label="Filter labels"></div>
 *       <div class="ds-listbox ds-listbox--plain ds-selectpanel__list" role="listbox" aria-multiselectable="true" aria-label="Labels"> options </div>
 *       <p class="ds-selectpanel__status" role="status"></p>
 *       <div class="ds-selectpanel__foot"><button data-ds-selectpanel-clear>Clear</button><button data-ds-selectpanel-apply>Apply</button></div>
 *     </div>
 *   </div>
 *
 *   const labels = DS.selectpanel.create(el, { items });
 *   labels.get();  labels.set(['bug']);  labels.on('change', ({ value }) => ...);
 *
 * The button opens and closes the panel (DS.overlay: data-state, Escape,
 * focus back to the button). The focus goes to the filter, which keeps it
 * while ArrowDown, ArrowUp, PageDown and PageUp move the active option
 * (aria-activedescendant), Enter checks or unchecks it, and Ctrl+Enter
 * (Cmd+Enter) applies; without a filter the list is the tab stop with the
 * keys of a listbox. Nothing changes until Apply (data-ds-selectpanel-apply):
 * Escape, a press outside and the focus leaving the panel discard the
 * pending choice. Without an Apply button every change applies at once; one
 * value (no aria-multiselectable) applies and closes on the choice.
 * data-ds-selectpanel-clear unchecks everything (pending). The filter
 * matches with DS.listbox.fuzzy and marks the letters; the status line says
 * "No results". The button's .ds-selectpanel__summary says what is chosen:
 * one or two names, else "3 selected", or "All selected".
 *
 * Events on the .ds-selectpanel: ds:change ({ value }) when the choice was
 * applied; ds:open and ds:close come from DS.overlay on the panel.
 *
 * Progressive:
 * - anchor positioning and the top layer (DS.position anchorPopup()),
 *   feature-detected: elsewhere DS.position place() writes the side and the
 *   cap of the absolute panel.
 */
import { define, emit, t } from './core.js';
import { open as openOverlay, close as closeOverlay } from './overlay.js';
import { place, clippedBounds, supportsAnchoring, anchorPopup, releaseAnchor, pxOf } from './position.js';
import { list as formatList } from './format.js';
import { announce } from './a11y.js';
import { create as createList } from './listbox.js';

/** The live controllers. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

let sequence = 0;

/**
 * The summary of a choice for the button: '' for none, the names of one or
 * two (a list in the locale), else "3 selected", or "All selected" when
 * every option of `total` is chosen.
 * @param {string[]} names
 * @param {number} total
 * @returns {string}
 */
export function summarize(names, total) {
  if (!names.length) return '';
  if (total > 2 && names.length >= total) return t('allSelected');
  if (names.length <= 2) return formatList(names);
  return t('selectedCount', { count: names.length });
}

/**
 * The controller of a select panel, the one [data-ds-selectpanel] makes;
 * once per element. Options: `items` (data, as DS.listbox; default the
 * markup's options), `value` (default data-ds-value, else the options marked
 * aria-selected), `virtual` (as DS.listbox), `name` (hidden inputs of that
 * name carry the applied value in a form).
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
  const trigger = /** @type {HTMLElement|null} */ (element?.querySelector?.('.ds-selectpanel__trigger'));
  const panel = /** @type {HTMLElement|null} */ (element?.querySelector?.('.ds-selectpanel__panel'));
  const listEl = /** @type {HTMLElement|null} */ (panel?.querySelector('.ds-selectpanel__list'));
  if (!trigger || !panel || !listEl) return null;
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  const abort = new AbortController();
  const signal = abort.signal;
  const search = /** @type {HTMLInputElement|null} */ (panel.querySelector('.ds-selectpanel__search'));
  const apply = panel.querySelector('[data-ds-selectpanel-apply]');
  const clear = panel.querySelector('[data-ds-selectpanel-clear]');
  const summaryEl = trigger.querySelector('.ds-selectpanel__summary');
  const multiple = options.multiple ?? listEl.getAttribute('aria-multiselectable') === 'true';
  const instant = !apply || !multiple;
  const name = options.name ?? element.getAttribute('data-ds-selectpanel-name');
  let destroyed = false;
  let anchored = false;

  if (!panel.id) panel.id = `ds-selectpanel-${(sequence += 1)}`;
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', panel.id);
  if (!trigger.hasAttribute('aria-expanded')) trigger.setAttribute('aria-expanded', 'false');
  if (search) {
    search.setAttribute('autocomplete', 'off');
    search.setAttribute('aria-controls', listEl.id || (listEl.id = `${panel.id}-list`));
  }

  let status = panel.querySelector('.ds-selectpanel__status');
  if (!status) {
    status = doc.createElement('p');
    status.className = 'ds-selectpanel__status';
    status.setAttribute('role', 'status');
    listEl.after(status);
  }

  const engine = createList(listEl, {
    items: options.items,
    multiple,
    focus: search ?? listEl,
    follow: false,
    homeEnd: !search,
    typeahead: !search,
    space: !search,
    virtual: options.virtual ?? (element.hasAttribute('data-ds-selectpanel-virtual') ? element.getAttribute('data-ds-selectpanel-virtual') !== 'false' : undefined),
    value: options.value !== undefined ? options.value : element.hasAttribute('data-ds-value') ? parseValue(element.getAttribute('data-ds-value'), multiple) : undefined,
  });

  /** The applied value; the engine holds the pending one while the panel is open. */
  let applied = engine.get();
  const asList = (value) => [].concat(value ?? []);
  const labelOf = (value) => engine.entries().find((entry) => entry.value === value)?.label ?? value;
  const isOpen = () => trigger.getAttribute('aria-expanded') === 'true' && panel.getAttribute('data-state') === 'open';

  function writeSummary() {
    if (summaryEl) summaryEl.textContent = summarize(asList(applied).map(labelOf), engine.entries().filter((entry) => !entry.disabled).length);
    if (!name) return;
    let holder = element.querySelector(':scope > [data-ds-selectpanel-values]');
    if (!holder) {
      holder = doc.createElement('span');
      holder.hidden = true;
      holder.setAttribute('data-ds-selectpanel-values', '');
      element.append(holder);
    }
    holder.replaceChildren(...asList(applied).map((each) => {
      const field = doc.createElement('input');
      field.type = 'hidden';
      field.name = name;
      field.value = each;
      return field;
    }));
  }

  function settleStatus() {
    status.textContent = engine.shown().length ? '' : t('noResults');
  }

  /* Placement: the top layer where it can, else the side and the cap under the button. */
  function placePanel() {
    const offset = pxOf(panel, '--ds-space-1', 4);
    if (supportsAnchoring(view)) {
      anchored = anchorPopup(panel, trigger, { nextName: () => `--ds-selectpanel-${(sequence += 1)}`, offset });
      return;
    }
    place(panel, trigger, { offset, padding: offset, shift: false, bounds: clippedBounds(panel) });
  }

  function unplace() {
    if (panel.hasAttribute('popover')) {
      try {
        if (panel.matches(':popover-open')) panel.hidePopover();
      } catch {
        // Not open.
      }
      panel.removeAttribute('popover');
    }
    panel.removeAttribute('data-anchored');
    panel.removeAttribute('data-placement');
    panel.style.removeProperty('position-anchor');
    panel.style.removeProperty('max-height');
    if (anchored) releaseAnchor(trigger);
    anchored = false;
  }

  /* Open and close. */
  function openPanel() {
    if (isOpen() || trigger.matches(':disabled, [aria-disabled="true"]')) return Promise.resolve();
    engine.set(applied);
    if (search) search.value = '';
    engine.filter('');
    settleStatus();
    // Shown and placed before DS.overlay plays the entrance from the button.
    panel.hidden = false;
    panel.setAttribute('data-state', 'closed');
    placePanel();
    const opened = openOverlay(panel, { opener: trigger });
    const first = asList(applied)[0];
    if (first !== undefined) engine.activate(first);
    (search ?? listEl).focus({ preventScroll: true });
    return opened;
  }

  /** Closes; `commit` applies the pending choice first (else it is dropped). */
  function closePanel(commit = false) {
    if (commit) commitPending();
    else engine.set(applied);
    engine.activate(null);
    return closeOverlay(panel);
  }

  function commitPending() {
    const pending = engine.get();
    if (JSON.stringify(asList(pending)) === JSON.stringify(asList(applied))) return;
    applied = pending;
    writeSummary();
    emit(element, 'change', { value: multiple ? [...asList(applied)] : applied });
  }

  // However it closed (Escape, close(), a removal), the panel leaves the top layer once hidden.
  panel.addEventListener('ds:close', () => {
    engine.set(applied);
    engine.activate(null);
    closeOverlay(panel).then(() => {
      if (panel.hidden) unplace();
    });
  }, { signal });

  // A press on the button closes an open panel itself (an engine that does not focus buttons blurs the panel first).
  let pressing = false;
  trigger.addEventListener('pointerdown', () => {
    pressing = isOpen();
  }, { signal });
  trigger.addEventListener('click', () => {
    const wasOpen = pressing || panel.getAttribute('data-state') === 'open';
    pressing = false;
    if (wasOpen) closePanel();
    else openPanel();
  }, { signal });

  trigger.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !isOpen()) {
      event.preventDefault();
      openPanel();
    }
  }, { signal });

  /* The choice: pending until Apply, else applied at once. */
  listEl.addEventListener('ds:change', (event) => {
    event.stopPropagation();
    if (!instant) return;
    commitPending();
    if (!multiple) closePanel();
  }, { signal });

  apply?.addEventListener('click', () => {
    closePanel(true);
    announce(summarize(asList(applied).map(labelOf), engine.entries().filter((entry) => !entry.disabled).length) || t('selectedCount', { count: 0 }));
  }, { signal });

  clear?.addEventListener('click', () => {
    engine.set(multiple ? [] : null);
    if (instant) commitPending();
    (search ?? listEl).focus({ preventScroll: true });
  }, { signal });

  if (search) {
    search.addEventListener('input', () => {
      engine.filter(search.value);
      engine.activate('first');
      settleStatus();
    }, { signal });
    search.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (apply) /** @type {HTMLElement} */ (apply).click();
        else closePanel(true);
        return;
      }
      if (event.key === 'Enter' && !engine.active()) {
        // Nothing active: the first option that shows.
        engine.activate('first');
      }
      if (engine.key(event)) event.preventDefault();
    }, { signal });
  } else {
    listEl.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        closePanel(true);
      }
    }, { signal });
  }

  // The focus leaving the panel (a press outside, Tab away) discards; back to the button is the button's.
  panel.addEventListener('focusout', (/** @type {FocusEvent} */ event) => {
    const to = /** @type {Node|null} */ (event.relatedTarget);
    if (!isOpen() || (to && (panel.contains(to) || to === trigger))) return;
    // A press on a part of the panel that takes no focus moves it nowhere for a moment.
    view.requestAnimationFrame(() => {
      if (!isOpen() || pressing || panel.contains(doc.activeElement) || doc.activeElement === trigger) return;
      closePanel();
    });
  }, { signal });
  // A press on a part of the panel that takes no focus keeps the focus where it is.
  panel.addEventListener('mousedown', (event) => {
    const target = /** @type {Element} */ (event.target);
    if (!target.closest?.('input, button, a, [tabindex]')) event.preventDefault();
  }, { signal });

  writeSummary();

  const controller = {
    element,
    /** The applied value: a list with several, else one value or null. */
    get: () => (multiple ? [...asList(applied)] : applied),
    /** Sets the applied value from the page (no event). */
    set(next) {
      engine.set(next);
      applied = engine.get();
      writeSummary();
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === element) fn(event.detail);
      };
      element.addEventListener(`ds:${type}`, listener);
      return () => element.removeEventListener(`ds:${type}`, listener);
    },
    /** New data (as DS.listbox); the applied value kept. */
    setItems(items) {
      engine.setItems(items);
      engine.set(isOpen() ? engine.get() : applied);
      writeSummary();
      settleStatus();
    },
    /** Opens the panel (DS.overlay). */
    open: openPanel,
    /** Closes it; `commit` applies the pending choice first. */
    close: closePanel,
    /** The list engine (DS.listbox's controller). */
    list: engine,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      engine.destroy();
      unplace();
      controllers.delete(element);
    },
  };
  controllers.set(element, controller);
  return controller;
}

/** A value of data-ds-value: a JSON list or comma-separated with several, else the text. */
function parseValue(text, multiple) {
  if (!multiple) return text;
  try {
    const list = JSON.parse(text);
    if (Array.isArray(list)) return list.map(String);
  } catch {
    // Comma-separated.
  }
  return String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

/**
 * Opens a select panel (DS.overlay.open() on its panel, the button as the opener).
 * @param {Element} element  the .ds-selectpanel
 * @returns {Promise<void>}
 */
export function open(element) {
  return create(element)?.open() ?? Promise.resolve();
}

/**
 * Closes a select panel; `commit: true` applies the pending choice first.
 * @param {Element} element  the .ds-selectpanel
 * @param {{ commit?: boolean }} [options]
 * @returns {Promise<void>}
 */
export function close(element, options = {}) {
  return create(element)?.close(Boolean(options.commit)) ?? Promise.resolve();
}

define('selectpanel', {
  attribute: 'data-ds-selectpanel',
  init: (element) => create(element),
});
