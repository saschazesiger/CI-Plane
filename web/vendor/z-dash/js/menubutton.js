/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Menu button (DS.menubutton): a button that opens a menu (DS.menu, through
 * DS.overlay), with a chevron that turns while it is open. A menu of
 * radio items makes it a choice: the button shows the chosen label.
 *
 *   <button class="ds-btn ds-menu-btn" type="button" aria-haspopup="menu" aria-expanded="false"
 *           aria-controls="sort-menu" data-ds-menubutton="#sort-menu">
 *     Sort: <span class="ds-menu-btn__value">Name</span>(chevronDown 16, .ds-chevron .ds-menu-btn__chevron)
 *   </button>
 *   <div class="ds-menu" id="sort-menu" role="menu" aria-label="Sort by" data-ds-menu-checks hidden>
 *     <button class="ds-menu__item" role="menuitemradio" type="button" aria-checked="true" value="name">...</button>
 *   </div>
 *
 *   const sort = DS.menubutton.create(button, { menu, value: 'name' });
 *   sort.get();  sort.set('seen');  sort.on('change', ({ value, item }) => {});
 *   DS.menubutton.open(button);  DS.menubutton.close(button);
 *
 * data-ds-menubutton names the menu (a selector or an id; empty: the
 * button's aria-controls, else the menu right after it). The module fills
 * in what the markup lacks: aria-haspopup="menu", aria-expanded and
 * aria-controls on the button (an id on the menu when it has none), and
 * data-ds-menu-checks on a menu of radio items. Write them in the markup
 * as well: a re-render that patches the button (DS.dom.morphHtml) keeps
 * only what its template has.
 *
 * Keys (the APG menu button): Enter, Space and a click open the menu on
 * its first item and close it again; ArrowDown opens it on the first item,
 * ArrowUp on the last; the menu's own keys, Escape and Tab are DS.menu's
 * (focus goes back to the button). A second click of a double click does
 * nothing. A button that also has data-ds-open leaves opening to the
 * overlay's trigger.
 *
 * A choice: when the menu holds menuitemradio items, the checked one is the
 * value (its value attribute, else data-value, else its label) and
 * .ds-menu-btn__value shows its label. A user's pick sends ds:change
 * ({ value, item }) on the button; set() from the page sends nothing.
 * data-ds-value on the button is the initial value. The menu is looked up
 * again (and its picks listened to) when the one found is gone or was
 * missing: a re-rendered menu keeps the label and ds:change working.
 *
 * ES2022; no progressive feature.
 */
import { define, emit } from './core.js';
import { open as openOverlay, close as closeOverlay } from './menu.js';

const RADIOS = '[role="menuitemradio"]';

/** Menus this module numbered, for an id (one counter per copy is enough: the prefix keeps them apart from the page's). */
let serial = 0;

/** The menu a trigger names: the attribute's selector or id, else aria-controls, else the menu right after it. */
export function menuOf(button, value = button.getAttribute('data-ds-menubutton')) {
  const root = button.getRootNode?.() ?? button.ownerDocument;
  const byId = (id) => (id ? root.getElementById?.(id) ?? button.ownerDocument?.getElementById(id) ?? null : null);
  const named = String(value ?? '').trim();
  if (named) {
    let found = null;
    try {
      found = root.querySelector?.(named) ?? null;
    } catch {
      // No selector: an id.
    }
    return found ?? byId(named.replace(/^#/, ''));
  }
  const controls = byId(button.getAttribute('aria-controls'));
  if (controls) return controls;
  const next = button.nextElementSibling;
  return next?.matches?.('.ds-menu') ? next : null;
}

/** An item's value: its value attribute, else data-value, else its label. */
export function itemValue(item) {
  return item.getAttribute('value') || item.getAttribute('data-value') || labelOf(item);
}

/** The words of an item: its .ds-menu__label, else its text; collapsed. */
function labelOf(item) {
  return (item.querySelector('.ds-menu__label')?.textContent ?? item.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const radiosOf = (menu) => (menu ? [...menu.querySelectorAll(RADIOS)] : []);

/** The trigger's aria and the menu's id: what the markup lacks. */
function prepare(button, menu) {
  if (!button.hasAttribute('aria-haspopup')) button.setAttribute('aria-haspopup', 'menu');
  if (!button.hasAttribute('aria-expanded')) button.setAttribute('aria-expanded', 'false');
  if (!menu) return;
  if (!menu.id) menu.id = `ds-menu-${(serial += 1)}`;
  if (!button.hasAttribute('aria-controls')) button.setAttribute('aria-controls', menu.id);
  if (radiosOf(menu).length && !menu.hasAttribute('data-ds-menu-checks')) menu.setAttribute('data-ds-menu-checks', '');
}

const isOpenFor = (button) => button.getAttribute('aria-expanded') === 'true';

/** A blocked trigger never opens (the action guard stops its clicks; its arrow keys stop here). */
const blocked = (button) => Boolean(button.disabled) || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('aria-busy') === 'true';

function controller(button, options, signal) {
  const listeners = new Set();
  const local = new AbortController();
  signal?.addEventListener('abort', () => local.abort(), { once: true });
  const on = { signal: local.signal };
  let menu = null;
  /** @type {AbortController|null} */
  let watching = null;
  const label = () => options.label ?? button.querySelector('.ds-menu-btn__value');

  const read = () => {
    const checked = radiosOf(menu).find((item) => item.getAttribute('aria-checked') === 'true');
    return checked ? itemValue(checked) : null;
  };
  const show = () => {
    const target = label();
    const checked = radiosOf(menu).find((item) => item.getAttribute('aria-checked') === 'true');
    if (!target || !checked) return;
    const text = labelOf(checked);
    if (target.textContent !== text) target.textContent = text;
  };
  const choose = (value) => {
    const radios = radiosOf(menu);
    const pick = radios.find((item) => itemValue(item) === String(value));
    if (!pick) return;
    for (const item of radios) item.setAttribute('aria-checked', String(item === pick));
    show();
  };
  const toggle = () => {
    if (!menu) return Promise.resolve();
    return isOpenFor(button) ? closeOverlay(menu) : openOverlay(menu, { opener: button });
  };

  button.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    if (event.defaultPrevented || event.detail > 1 || button.hasAttribute('data-ds-open') || blocked(button)) return;
    resolve();
    toggle();
  }, on);
  button.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || button.hasAttribute('data-ds-open')) return;
    if (event.altKey || event.ctrlKey || event.metaKey || blocked(button)) return;
    resolve();
    if (!menu) return;
    event.preventDefault();
    // DS.menu reads this keydown: ArrowUp focuses the last item.
    if (!isOpenFor(button)) openOverlay(menu, { opener: button });
  }, on);
  // A pick in the menu (DS.menu flips the radio and sends ds:change on the menu).
  const picked = (/** @type {CustomEvent} */ event) => {
    const item = event.detail?.item;
    if (!item?.matches?.(RADIOS) || !event.detail.checked) return;
    show();
    const detail = { value: itemValue(item), item };
    emit(button, 'change', detail);
    for (const fn of [...listeners]) fn(detail);
  };
  // The menu, and the pick listener on it: again when the menu named was
  // missing or has been replaced (a re-render).
  const use = (next) => {
    if (next === menu) return;
    watching?.abort();
    watching = null;
    menu = next;
    if (!menu) return;
    prepare(button, menu);
    watching = new AbortController();
    local.signal.addEventListener('abort', () => watching?.abort(), { once: true, signal: watching.signal });
    menu.addEventListener('ds:change', picked, { signal: watching.signal });
  };
  const resolve = () => use(menu?.isConnected ? menu : options.menu?.isConnected ? options.menu : menuOf(button));
  use(options.menu ?? menuOf(button));
  if (!menu) prepare(button, null);

  if (options.value !== undefined && options.value !== null) choose(options.value);
  else show();

  return {
    element: button,
    get menu() { return menu; },
    get() {
      resolve();
      return read();
    },
    set(value) {
      resolve();
      choose(value);
    },
    on(type, fn) {
      if (type !== 'change' || typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    open() {
      resolve();
      return menu && !isOpenFor(button) ? openOverlay(menu, { opener: button }) : Promise.resolve();
    },
    close() {
      resolve();
      return menu && isOpenFor(button) ? closeOverlay(menu) : Promise.resolve();
    },
    update(names) {
      if (names.includes('data-ds-value')) choose(button.getAttribute('data-ds-value'));
    },
    destroy() {
      listeners.clear();
      local.abort();
    },
  };
}

/** The controller of each button set up here or by the attribute. @type {WeakMap<Element, ReturnType<typeof controller>>} */
const controllers = new WeakMap();

/**
 * A menu button driven from the page; the controller data-ds-menubutton
 * makes. `menu`: the menu (else the one the button names); `value`: the
 * start of a choice; `label`: the element that shows the chosen label
 * (default: .ds-menu-btn__value in the button).
 * @param {Element} button
 * @param {{ menu?: Element|null, value?: string|null, label?: Element|null }} [options]
 */
export function create(button, options = {}) {
  controllers.get(button)?.destroy();
  const made = controller(button, options, null);
  controllers.set(button, made);
  return made;
}

/**
 * Opens the menu of a menu button (DS.overlay.open, the button as its opener).
 * @param {Element} button
 * @returns {Promise<void>}
 */
export function open(button) {
  const menu = controllers.get(button)?.menu ?? menuOf(button);
  return menu ? openOverlay(menu, { opener: button }) : Promise.resolve();
}

/**
 * Closes the menu of a menu button (DS.overlay.close).
 * @param {Element} button
 * @returns {Promise<void>}
 */
export function close(button) {
  const menu = controllers.get(button)?.menu ?? menuOf(button);
  return menu ? closeOverlay(menu) : Promise.resolve();
}

define('menubutton', {
  attribute: 'data-ds-menubutton',
  attributes: ['data-ds-value'],
  init(button, ctx) {
    const made = controller(button, { value: button.getAttribute('data-ds-value') }, ctx.signal);
    controllers.set(button, made);
    return made;
  },
});
