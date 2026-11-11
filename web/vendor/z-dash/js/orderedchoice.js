/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The ordered choice (DS.orderedchoice): a multi-select whose order
 * matters. Every option is a row with a grip and a checkbox; the value is
 * the checked ones in the order of the rows.
 *
 *   <ol class="ds-orderedchoice" data-ds-orderedchoice aria-label="Columns">
 *     <li class="ds-orderedchoice__item">
 *       <button class="ds-btn ds-btn--quiet ds-btn--icon ds-grip" type="button" aria-label="Move Name">(grip)</button>
 *       <label class="ds-check"><input type="checkbox" value="name" checked><span>Name</span></label>
 *       <span class="ds-orderedchoice__rank"></span>
 *     </li>
 *   </ol>
 *
 *   const columns = DS.orderedchoice.create(list, { max: 5 });
 *   columns.get();               // ['name', 'status']: checked, in order
 *   columns.order();             // every value, in order
 *   columns.set(['status', 'name']);
 *   columns.on('change', ({ value, order }) => save(value));
 *
 * Moving: the grip drags a row (DS.dnd: pointer, or Space or Enter to lift,
 * the arrows to move, Space to drop, Escape to cancel; announced), and
 * Alt+ArrowUp or Alt+ArrowDown on a row's checkbox or grip moves it one
 * place at once (Alt+Home, Alt+End: to the ends). Checking: the native
 * boxes. Each checked row shows its place (1, 2, ...; "Position 2" for a
 * screen reader through the box's aria-describedby). At `max` checked rows
 * (data-ds-orderedchoice-max) the unchecked boxes are disabled and the
 * status line says "Up to 3 items". ds:change ({ value, order }) after the
 * user changed a box or the order.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { create as createDrag } from './dnd.js';

/** The live controllers. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

let sequence = 0;

/**
 * `order` with `value` first, in its order, the rest after it in theirs:
 * what set() lays out. Values not in `order` are left out.
 * @param {string[]} order
 * @param {string[]} value
 * @returns {string[]}
 */
export function arrange(order, value) {
  const known = new Set(order);
  const first = [...new Set(value)].filter((each) => known.has(each));
  const chosen = new Set(first);
  return [...first, ...order.filter((each) => !chosen.has(each))];
}

/**
 * The places of the checked values: a Map of value to 1, 2, ... in `order`.
 * @param {string[]} order
 * @param {Set<string>|string[]} checked
 * @returns {Map<string, number>}
 */
export function ranks(order, checked) {
  const on = checked instanceof Set ? checked : new Set(checked);
  const out = new Map();
  for (const each of order) if (on.has(each)) out.set(each, out.size + 1);
  return out;
}

/**
 * The controller of an ordered choice, the one [data-ds-orderedchoice]
 * makes; once per list. Options: `max` (the most checked rows;
 * data-ds-orderedchoice-max), `value` (checked, in this order, first).
 * @param {Element} element
 * @param {object} [options]
 * @returns {any}
 */
export function create(element, options = {}) {
  const existing = controllers.get(element);
  if (existing) return existing;
  if (!element?.ownerDocument) return null;
  const doc = element.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  const maxAttr = Number(element.getAttribute('data-ds-orderedchoice-max'));
  const max = options.max ?? (maxAttr > 0 && Number.isFinite(maxAttr) ? maxAttr : Infinity);
  const baseId = element.id || `ds-orderedchoice-${(sequence += 1)}`;
  /** The boxes this module disabled at the maximum (the page's own stay). */
  const heldOff = new WeakSet();
  let destroyed = false;

  const items = () => /** @type {HTMLElement[]} */ ([...element.querySelectorAll(':scope > .ds-orderedchoice__item:not([data-ds-leaving])')]);
  const boxOf = (item) => /** @type {HTMLInputElement|null} */ (item.querySelector('input[type="checkbox"]'));
  const valueOf = (item) => boxOf(item)?.value ?? '';
  const order = () => items().map(valueOf);
  const value = () => items().filter((item) => boxOf(item)?.checked).map(valueOf);
  const nameOf = (item) => (item.querySelector('.ds-check > span')?.textContent ?? valueOf(item)).trim();

  let status = null;
  function say(text) {
    if (!text && !status) return;
    if (!status) {
      status = doc.createElement('p');
      status.className = 'ds-orderedchoice__status';
      status.setAttribute('role', 'status');
      status.id = `${baseId}-status`;
      element.after(status);
    }
    status.textContent = text;
  }

  /** The places, the descriptions and the maximum, from the DOM as it stands. */
  function sync() {
    const places = ranks(order(), value());
    items().forEach((item, index) => {
      const box = boxOf(item);
      let rank = item.querySelector('.ds-orderedchoice__rank');
      if (!rank) {
        rank = doc.createElement('span');
        rank.className = 'ds-orderedchoice__rank';
        item.append(rank);
      }
      if (!rank.id) rank.id = `${baseId}-rank-${index}-${(sequence += 1)}`;
      const place = places.get(valueOf(item));
      if (place) {
        const sr = doc.createElement('span');
        sr.className = 'ds-sr';
        sr.textContent = t('orderPosition', { position: place });
        const shown = doc.createElement('span');
        shown.setAttribute('aria-hidden', 'true');
        shown.textContent = String(place);
        rank.replaceChildren(shown, sr);
      } else rank.replaceChildren();
      if (box) {
        const described = (box.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== rank.id);
        if (place) described.push(rank.id);
        if (described.length) box.setAttribute('aria-describedby', described.join(' '));
        else box.removeAttribute('aria-describedby');
      }
    });
    const full = value().length >= max;
    for (const item of items()) {
      const box = boxOf(item);
      if (!box) continue;
      if (full && !box.checked && !box.disabled) {
        box.disabled = true;
        heldOff.add(box);
      } else if ((!full || box.checked) && heldOff.has(box)) {
        box.disabled = false;
        heldOff.delete(box);
      }
    }
    say(full && Number.isFinite(max) && items().length > max ? t('tagMax', { max }) : '');
  }

  let before = JSON.stringify([order(), value()]);
  function changed() {
    sync();
    const now = JSON.stringify([order(), value()]);
    if (now === before) return;
    before = now;
    emit(element, 'change', { value: value(), order: order() });
  }

  const drag = createDrag(element, {
    items: '.ds-orderedchoice__item',
    label: (item) => nameOf(item),
  });

  // The DOM is in its new order when ds:drop runs, back in the old one if a listener refused it.
  element.addEventListener('ds:drop', () => queueMicrotask(changed), { signal });
  element.addEventListener('ds:drag-cancel', () => queueMicrotask(sync), { signal });

  element.addEventListener('change', (event) => {
    if (!(/** @type {Element} */ (event.target)).matches?.('input[type="checkbox"]')) return;
    changed();
  }, { signal });

  /* Alt with an arrow, Home or End on a row's box or grip: the row moves at once. */
  element.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented || drag.get()) return;
    const item = /** @type {Element} */ (event.target)?.closest?.('.ds-orderedchoice__item');
    if (!item || item.parentElement !== element) return;
    const list = items();
    const at = list.indexOf(/** @type {HTMLElement} */ (item));
    const last = list.length - 1;
    const to = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: last }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    if (to < 0 || to > last || to === at) return;
    const focused = doc.activeElement;
    drag.set({ item, zone: element, index: to });
    if (focused instanceof doc.defaultView.HTMLElement && !item.contains(doc.activeElement)) focused.focus({ preventScroll: true });
  }, { signal });

  if (Array.isArray(options.value)) setValue(options.value);
  sync();
  before = JSON.stringify([order(), value()]);

  /** Lays the rows out as `arrange()` says and checks `next` (no event). */
  function setValue(next) {
    const wanted = [].concat(next ?? []).map(String);
    const byValue = new Map(items().map((item) => [valueOf(item), item]));
    for (const each of arrange(order(), wanted)) element.append(byValue.get(each));
    // Rows without a value of the page's keep their place at the end.
    const on = new Set(wanted);
    for (const item of items()) {
      const box = boxOf(item);
      if (box) box.checked = on.has(valueOf(item));
    }
  }

  const controller = {
    element,
    /** The checked values, in their order. */
    get: value,
    /** Checks `next`, in its order, first; the rest after it (no event). */
    set(next) {
      setValue(next);
      sync();
      before = JSON.stringify([order(), value()]);
    },
    /** Every value, in the order of the rows. */
    order,
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === element) fn(event.detail);
      };
      element.addEventListener(`ds:${type}`, listener);
      return () => element.removeEventListener(`ds:${type}`, listener);
    },
    /** Moves the row of `which` to `index`, as a drop would (announced, ds:change). */
    move(which, index) {
      const item = items().find((each) => valueOf(each) === String(which));
      return item ? drag.set({ item, zone: element, index }) : false;
    },
    /** Reads the rows again (the page added or removed some). */
    refresh: changed,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      drag.destroy();
      status?.remove();
      for (const item of items()) {
        const box = boxOf(item);
        if (box && heldOff.has(box)) box.disabled = false;
      }
      controllers.delete(element);
    },
  };
  controllers.set(element, controller);
  return controller;
}

define('orderedchoice', {
  attribute: 'data-ds-orderedchoice',
  init: (element) => create(element),
});
