/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Accessibility helpers (3.0): the focus and speech tools a behaviour
 * needs, in one module, so no component writes its own.
 *
 *   const hold = DS.a11y.trap(panel);             // Tab stays inside; hold.destroy() returns focus
 *   DS.a11y.roving(toolbar, { items: 'button', activate: false }); // one tab stop, arrow keys (DS.dom.roving)
 *   DS.a11y.typeahead(list);                      // typing a label moves focus to its item
 *   DS.a11y.announce('Saved');                    // spoken, not shown (DS.overlay.announce)
 *   const still = DS.a11y.inert(others);          // inert until still.destroy() (DS.overlay.holdInert)
 *
 * trap() is for a region that is no overlay (a tour step, a full-screen
 * editor): it keeps the Tab key inside and pulls stray focus back. It does
 * not make the page inert (inert() does) and takes no scroll lock: a dialog,
 * a sheet or the modal drawer goes through DS.overlay.open(), which is their
 * trap. Traps stack per document (the last one holds; destroying it wakes the
 * one below), and a trap rests while an overlay over its region is open, so
 * a dialog opened from a trapped region keeps its focus; a contained dialog
 * elsewhere lies only over its container, and keeps only the focus inside it.
 * A region that stops rendering lets go until it shows again, one the page
 * removed lets go for good (like destroy(), at the next Tab or focus change).
 * Snackbars stay usable above a trap, as above every modal.
 *
 * roving(), announce() and inert() are the functions of DS.dom and DS.overlay
 * under this name, so what a behaviour needs for its keys is one import. The
 * focusable list, the canFocus() test and the type-ahead matcher are
 * DS.overlay's, the test for a field that takes text is DS.dom's.
 *
 * Every timing comes from the computed tokens (motionDuration): type-ahead
 * joins the letters typed within --ds-delay-tooltip of each other.
 */

import { runtime } from './core.js';
import { motionDuration } from './motion.js';
import { roving as rovingOf, typesText } from './dom.js';
import { announce as announceOf, canFocus, FOCUSABLE, holdInert, layerAt, typeAhead } from './overlay.js';

/**
 * This module's shared state (runtime.state('a11y')): per document the
 * stack of traps, per container its handle. Every copy of the module uses
 * the same stack, so the last trap holds, whichever copy made it.
 * @type {{ stacks: WeakMap<Document, any[]>, traps: WeakMap<Element, { destroy: () => void }> }}
 */
const shared = runtime.state('a11y', () => ({ stacks: new WeakMap(), traps: new WeakMap() }));

const isRadio = (node) => node.tagName === 'INPUT' && node.type === 'radio' && Boolean(node.name);

/**
 * Whether focus can land on the node as the page stands: canFocus(), and not
 * in a disabled fieldset, nor unseen through `visibility` or
 * `content-visibility` of itself or an ancestor (a closed details, a closed
 * panel). canFocus() alone answers yes to those, and focus() then does nothing.
 * @param {any} node
 * @returns {boolean}
 */
export function canTakeFocus(node) {
  if (!canFocus(node) || node.matches?.(':disabled')) return false;
  return typeof node.checkVisibility !== 'function' || node.checkVisibility({ checkVisibilityCSS: true });
}

/**
 * The elements inside `root` that the Tab key stops at, in DOM order:
 * canTakeFocus(), without a negative tabindex; a named radio group counts once (its checked radio, else the
 * first), as the engines do. A positive tabindex keeps its DOM place here:
 * the system never writes one.
 * @param {Element|null|undefined} root
 * @returns {HTMLElement[]}
 */
export function tabbables(root) {
  if (!root?.querySelectorAll) return [];
  const candidates = [...root.querySelectorAll(FOCUSABLE)].filter((node) => Number(node.getAttribute('tabindex')) >= 0 && canTakeFocus(node));
  const groups = new Map();
  for (const node of candidates) {
    if (!isRadio(node)) continue;
    if (!groups.has(node.name) || node.checked) groups.set(node.name, node);
  }
  return candidates.filter((node) => !isRadio(node) || groups.get(node.name) === node);
}

/** The roles of the widgets that read plain keys themselves (type-ahead, typing). */
const KEY_WIDGETS = '[role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], [role="listbox"], [role="menu"], [role="menubar"], [role="tree"], [role="treegrid"]';

/**
 * Whether plain keys typed on `node` already mean something: a field that
 * takes text, a select, or a widget with type-ahead. A read-only field and
 * a checkbox type nothing, so a letter has nothing to do there. This is about
 * typing: Space on a checkbox still means something (DS.hotkeys keeps a
 * shortcut off the keys a native control uses itself).
 * @param {Element|null|undefined} node
 * @returns {boolean}
 */
export function readsKeys(node) {
  if (!node?.closest) return false;
  return typesText(node) || node.tagName === 'SELECT' || Boolean(node.closest(KEY_WIDGETS));
}

/** The element that has focus, through open shadow roots: the document only knows their host. */
function deepActive(doc) {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/**
 * The tabbable after `node` (`backwards`: before it) in document order,
 * wrapping: where Tab goes from a node that is no stop itself.
 */
function aroundNode(list, node, backwards) {
  if (backwards) return [...list].reverse().find((each) => node.compareDocumentPosition(each) & node.DOCUMENT_POSITION_PRECEDING) ?? list[list.length - 1];
  return list.find((each) => node.compareDocumentPosition(each) & node.DOCUMENT_POSITION_FOLLOWING) ?? list[0];
}

/** Whether a trap can hold: its region, or something in it, can take focus. One that stopped rendering lets go until it shows again. */
const holds = (item) => canTakeFocus(item.container) || tabbables(item.container).length > 0;

/** Lets go of the regions the page removed without destroy() (a re-render, a route change), as an overlay does: Tab works, and the trap below wakes. */
function pruneRemoved(stack) {
  for (const item of [...stack]) if (!item.container.isConnected) item.destroy();
}

/**
 * Keeps the Tab key inside `container` until destroy(), and pulls focus
 * that lands outside back to where it was inside. It moves focus in at once:
 * `initial` (an element or a selector), else [autofocus], else the first
 * tabbable, else the container itself; `initial: false`, or focus already
 * inside without an `initial`, leaves it. destroy() gives focus back to
 * `returnFocus` (default: what had it before; false: nowhere) when focus is
 * still inside or nowhere. Once per container (a second call returns the
 * same handle). A region that stops rendering lets go until it shows again;
 * one the page removed lets go for good.
 * @param {Element|null|undefined} container
 * @param {{ initial?: Element|string|false, returnFocus?: Element|false }} [options]
 * @returns {{ destroy: () => void }}
 */
export function trap(container, options = {}) {
  const doc = container?.ownerDocument;
  if (!doc) return { destroy() {} };
  const existing = shared.traps.get(container);
  if (existing) return existing;
  // In a shadow root the document only knows the host: ask the root the container lives in.
  const scope = container.getRootNode?.() ?? doc;
  const activeNow = () => scope.activeElement ?? null;
  const before = deepActive(doc);
  const addedTabindex = !container.hasAttribute('tabindex');
  const stack = shared.stacks.get(doc) ?? [];
  shared.stacks.set(doc, stack);
  const entry = { last: null, container, destroy: () => handle.destroy() };
  stack.push(entry);

  const focusBox = () => {
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    /** @type {HTMLElement} */ (container).focus();
  };
  /** Whether an open layer the region does not sit in rules at `node`. */
  const under = (node) => {
    const layer = node ? layerAt(node, doc) : null;
    return Boolean(layer && !layer.contains(container));
  };
  /**
   * Not the top trap that can hold, an overlay over the region, or focus at
   * `node` in a layer elsewhere (a contained dialog): everything stays as it is.
   */
  const resting = (node) => [...stack].reverse().find(holds) !== entry || under(container) || under(node);
  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Tab') return;
    pruneRemoved(stack);
    if (event.defaultPrevented || resting(deepActive(doc))) return;
    const active = activeNow();
    // A snackbar's buttons are usable above the trap: Tab walks them, and from the end of the region comes back in.
    const toasts = active?.closest?.('.ds-toasts');
    if (toasts) {
      const own = tabbables(toasts);
      if (active !== own[event.shiftKey ? 0 : own.length - 1]) return;
    }
    const list = tabbables(container);
    const first = list[0];
    const last = list[list.length - 1];
    let next = null;
    if (!first) next = container;
    else if (!active || !container.contains(active)) next = event.shiftKey ? last : first;
    // Inside, but no stop (the region itself, a tabindex -1 box): the engine could leave from there.
    else if (!list.includes(active)) next = aroundNode(list, active, event.shiftKey);
    else if (event.shiftKey && active === first) next = last;
    else if (!event.shiftKey && active === last) next = first;
    if (!next) return;
    event.preventDefault();
    if (next === container) focusBox();
    else next.focus();
  };
  const onFocus = (/** @type {FocusEvent} */ event) => {
    pruneRemoved(stack);
    const path = event.composedPath?.() ?? [event.target];
    if (path.includes(container)) {
      entry.last = path[0];
      return;
    }
    if (resting(path[0]) || path.some((node) => node.matches?.('.ds-toasts'))) return;
    const back = canTakeFocus(entry.last) && container.contains(entry.last) ? entry.last : tabbables(container)[0];
    if (back) back.focus();
    else focusBox();
  };
  // Capture: a page handler that stops the event must not open the trap.
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('focusin', onFocus, true);

  const active = activeNow();
  if (options.initial !== false && (options.initial !== undefined || !active || !container.contains(active))) {
    const wanted = typeof options.initial === 'string' ? container.querySelector(options.initial)
      : options.initial ?? container.querySelector('[autofocus]');
    const target = canTakeFocus(wanted) ? wanted : tabbables(container)[0];
    // No preventScroll, here or below: unlike an overlay the region may sit in the page's flow, and focus must be seen.
    if (target) /** @type {HTMLElement} */ (target).focus();
    else focusBox();
  } else if (active && container.contains(active)) entry.last = active;

  const handle = {
    destroy() {
      if (shared.traps.get(container) !== handle) return;
      shared.traps.delete(container);
      stack.splice(stack.indexOf(entry), 1);
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('focusin', onFocus, true);
      const now = doc.activeElement;
      const lost = !now || now === doc.body || container.contains(activeNow());
      if (addedTabindex) container.removeAttribute('tabindex');
      const home = options.returnFocus === undefined ? before : options.returnFocus;
      if (home && lost && canTakeFocus(home)) /** @type {HTMLElement} */ (home).focus();
    },
  };
  shared.traps.set(container, handle);
  return handle;
}

/**
 * DS.dom.roving() under this module's name: one tab stop for a set of
 * items, the arrow keys, Home and End between them. The same function, so
 * a container has one roving focus whichever name set it up.
 * @param {Element|null|undefined} container
 * @param {{ items?: string, orientation?: 'horizontal'|'vertical'|'both', wrap?: boolean, activate?: 'focus'|'manual'|false, onActivate?: (item: Element) => void }} [options]
 * @returns {{ destroy: () => void }}
 */
export function roving(container, options = {}) {
  return rovingOf(container, options);
}

/** The items typeahead() moves through by default. */
const TYPEAHEAD_ITEMS = '[role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="treeitem"], [role="tab"], [role="radio"]';

/** What an item is called for type-ahead: its aria-label, else its text; collapsed, lower case. */
const labelOf = (item) => (item.getAttribute?.('aria-label') || item.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The item the typed letters lead to: the next one after `current`
 * (wrapping) whose label starts with them; one letter typed again and again
 * cycles through the items with that letter. A longer search may stay on
 * the current item. `label(item)` gives the lower-case label (default: its
 * aria-label, else its text). `typed` is lower case. The matcher of the menus
 * (DS.overlay) with this module's label.
 * @param {Element[]} items
 * @param {Element|null|undefined} current
 * @param {string} typed
 * @param {(item: Element) => string} [label]
 * @returns {Element|null}
 */
export function typeaheadMatch(items, current, typed, label = labelOf) {
  return typeAhead(items, current, typed, label);
}

/** Live typeahead() handles. @type {WeakMap<Element, { destroy: () => void }>} */
const typeaheads = new WeakMap();

/**
 * Typing a label moves focus to its item: the letters typed within
 * --ds-delay-tooltip of each other are one search, a navigation key starts
 * a new one, a space counts only within a word (alone it activates the
 * item), and a field inside the container keeps its letters. `items`: a
 * selector or a function (default: every option, menu item, tree item, tab
 * and radio); disabled and hidden items are skipped, aria-disabled ones are
 * reached (their name is read). `label(item)`: see typeaheadMatch().
 * `onMatch(item)` replaces item.focus(). The search goes on from the item
 * that holds focus, else the one the container's aria-activedescendant names
 * (the pattern `onMatch` is for), else `current()`. Delegated on the
 * container, so it survives a re-render; once per container (a second call
 * returns the same handle). Works next to roving(): focus moved here moves
 * the tab stop.
 * @param {Element|null|undefined} container
 * @param {{ items?: string|(() => Element[]), label?: (item: Element) => string, onMatch?: (item: Element) => void, current?: () => Element|null|undefined }} [options]
 * @returns {{ destroy: () => void }}
 */
export function typeahead(container, options = {}) {
  if (!container?.addEventListener) return { destroy() {} };
  const existing = typeaheads.get(container);
  if (existing) return existing;
  const selector = options.items ?? TYPEAHEAD_ITEMS;
  const items = () => (typeof selector === 'function' ? [...selector()] : [...container.querySelectorAll(selector)]).filter(canTakeFocus);
  const currentOf = (list, target) => {
    const holding = list.find((item) => item === target || item.contains(target));
    if (holding) return holding;
    const named = container.getAttribute?.('aria-activedescendant');
    return (named ? container.getRootNode().getElementById?.(named) : null) ?? options.current?.();
  };
  let typed = '';
  let typedAt = 0;
  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const target = /** @type {Element} */ (event.target);
    if (typesText(target) || target?.tagName === 'SELECT') return;
    const key = event.key ?? '';
    if (key.length !== 1) {
      if (/^(arrow|home|end|page)/i.test(key)) typed = '';
      return;
    }
    if (event.timeStamp - typedAt > motionDuration(container, '--ds-delay-tooltip')) typed = '';
    if (key === ' ' && !typed) return;
    typedAt = event.timeStamp;
    typed += key.toLowerCase();
    const list = items();
    const match = typeaheadMatch(list, currentOf(list, target), typed, options.label);
    if (!match) return;
    event.preventDefault();
    if (typeof options.onMatch === 'function') options.onMatch(match);
    else /** @type {HTMLElement} */ (match).focus();
  };
  container.addEventListener('keydown', onKey);
  const handle = {
    destroy() {
      if (typeaheads.get(container) !== handle) return;
      typeaheads.delete(container);
      container.removeEventListener('keydown', onKey);
    },
  };
  typeaheads.set(container, handle);
  return handle;
}

/**
 * DS.overlay.announce() under this module's name: says `text` to screen
 * readers without showing anything: polite, or assertive with `assertive:
 * true`. The same text twice is spoken twice; empty text does nothing; a
 * newer text with the same `key` replaces the one not read yet.
 * @param {string} text
 * @param {{ assertive?: boolean, region?: Element|null, key?: string }} [options]
 */
export function announce(text, options = {}) {
  announceOf(text, options);
}

/**
 * Makes `elements` (one element or a list) inert until destroy(), for a modal
 * region that is no overlay: trap() holds the keyboard, this the pointer and a
 * screen reader's cursor. DS.overlay.holdInert() under this module's name:
 * counted per element, and it composes with the overlays' own inert in any
 * order. Leave out what must stay usable (the snackbar region, what holds the
 * region); an overlay opened inside a held element is inert with it.
 * @param {Element|Iterable<Element>|null|undefined} elements
 * @returns {{ destroy: () => void }}
 */
export function inert(elements) {
  if (!elements) return holdInert([]);
  // By nodeType: a form and a select are iterable too.
  return holdInert(elements.nodeType ? [elements] : elements);
}
