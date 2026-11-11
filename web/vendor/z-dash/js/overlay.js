/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Overlays (D18): the dialog, the side sheet, the modal drawer and the
 * popups (.ds-menu, .ds-combo__popup) open and close through one pair of
 * calls, so focus, inertness, Escape and the scroll lock behave the same
 * everywhere.
 *
 *   DS.overlay.open(dialog, { opener: button });   // a Promise: the entrance settled
 *   DS.overlay.close(dialog);                      // a Promise: hidden again
 *   DS.overlay.close(dialog, { reason: 'confirm' }); // why: the ds:close event says it
 *   DS.overlay.topmost();                          // the top open layer, or null
 *   await DS.overlay.confirm({ title, text });     // a built dialog: true or false (components/dialog/dialog.js)
 *
 * Kinds, recognised by class: a native <dialog class="ds-dialog | ds-sheet">
 * (showModal() is the focus trap and makes the page inert), the div
 * markup .ds-dialog / .ds-sheet (the siblings of the overlay and of each
 * of its ancestors up to <body> turn inert, .ds-scrim excepted), the modal
 * drawer .ds-drawer (only while (max-width: 900px) matches; wider, open()
 * resolves at once) and the popups .ds-menu and .ds-combo__popup (no
 * trap, no lock). Any other element is opened like a popup.
 *
 * Motion is state-driven: open() sets data-state="closed", flushes style,
 * writes the origin (originFrom(opener, box) for dialogs and popups) and
 * sets data-state="open"; close() sets data-state="closed". The CSS
 * transitions keyed on data-state therefore reverse from the current value
 * when a close is taken back (D21). The drawer keeps its own attribute,
 * data-drawer-open on .ds-app.
 *
 * Every element has one state with a generation: a later open() or
 * close() supersedes an earlier call, whose promise then resolves without
 * acting. A second close() during an exit returns the same promise; open()
 * on an open overlay does nothing.
 *
 * Close order (the same for dialog, sheet and modal drawer): release the
 * trap (native: dialog.close() at once plus .ds-dialog--closing /
 * .ds-sheet--closing, which keeps it displayed and stacked outside the top
 * layer; div: restore the inert it set), focus the opener at once (gone:
 * returnTo(), the opener's id twin, the nearest tabindex="-1" ancestor or
 * landmark, never <body>), make only the box or panel inert (the backdrop
 * keeps swallowing clicks, and a mousedown on it or the drawer's scrim is
 * prevented, so focus stays on the opener), set data-state="closed", send
 * ds:close ({ detail: { reason } }, bubbling, once), wait for settled(),
 * then hide (div: hidden; native: drop --closing), clear the box's inert
 * and .ds-dialog--nested, unlock the scroll and leave the Escape stack, in
 * one task. Popups return focus to their opener only when it was inside
 * them and the close was not a click outside.
 *
 * Busy: while the page sets data-ds-busy on a dialog, sheet or drawer, the
 * user's close attempts do nothing (Escape, the native cancel, a
 * [data-ds-close] click, the backdrop and the drawer's scrim): one guard at
 * the top of closeFrom(), before the popups inside close, so a refused
 * attempt changes nothing and sends no ds:close. close(el) and the forced
 * closes (removed, breakpoint) still close; menus and lists ignore it.
 *
 * Dismiss guard: a backdrop or scrim click from a pointer closes only when
 * the press began on it, it is the first click (event.detail 1) and
 * --ds-delay-dismiss has passed since the open; a [data-ds-close] click with
 * detail > 1 never closes. click(), Enter and Space (detail 0) close at
 * once.
 *
 * Container transform (opt-in): open(el, { opener, container: true }) on
 * a dialog or side sheet runs the open inside DS.motion.transition() with
 * type 'container', so the opener (a card, a row) grows into the box or
 * panel on the spring over --ds-dur-long while the scrim fades with the
 * root's crossfade; the overlay skips its own entrance for that open (the
 * live image would grow twice), and the page frame and the sheet's body
 * keep no view-transition-name meanwhile (named, they would paint above
 * the scrim or apart from the panel). The page is frozen while it runs, so
 * it is never the default. close() keeps its own exit. Without View
 * Transitions, or without .ds-theme on <html>, it is the usual entrance
 * from the opener; an opener that its scroller clips (a group would paint
 * its hidden part over the top bar) gets that entrance inside a short
 * fade-through.
 *
 * Escape stack: one keydown listener on the document (bubble phase, so a
 * widget inside the overlay that handles Escape itself and calls
 * preventDefault() keeps it open) closes the topmost overlay that is not
 * already closing, unless a tooltip took the key or the key came from a
 * filled input[type="search"] inside that overlay (it clears the search
 * and fires input; the next Escape closes), or the layer is non-modal
 * (a .ds-dialog__box--modeless, a docked sheet panel) and the key came
 * from a page field outside it (escapeReaches(): the layer under it may
 * take the key instead); the stack is shared by
 * every copy of ds.js on the page (sharedOf), so the topmost layer closes
 * whichever copy opened it. A native dialog's cancel
 * event is turned into close(), so its exit plays. Closing a dialog, sheet
 * or the drawer first closes the menus and lists open inside it and hides
 * the tooltip. [data-ds-close] inside an overlay closes it (ignored while
 * closing); the scrim closes the modal drawer; a menu also closes on Tab
 * (focus goes back to its trigger and Tab moves on from there) and on a
 * pointerdown outside the menu and its trigger.
 *
 * Popups (D17): a menu or a combobox list is placed before it enters, at
 * rest size, then grows from its trigger (originFrom(): the origin and the
 * clip edge). Where popover and CSS anchor positioning exist it opens as
 * popover="manual" in the top layer, anchored to its trigger (a combobox
 * list to its field, as wide as the field), so no scrolling box clips it;
 * elsewhere a menu is placed by --ds-menu-x/-y (below the trigger from its
 * start edge, towards the start edge without room, following scroll and
 * resize) and a combobox list stays absolute under its field. A popup
 * opens below when it fits, else on the side with more room
 * (data-placement="top" above; for the list, the viewport narrowed by
 * clipping boxes), never taller than that room (anchored: the CSS cap of
 * its position-area; else an inline max-height), so it never covers its
 * trigger. While it is open, DS.dom.scrollEdges() watches the block axis
 * of what scrolls (the menu, the combobox's list), so a cut edge fades
 * where scroll timelines are missing too. Over an open native dialog or
 * sheet (showModal() makes the rest inert, top-layer popovers too) a
 * menu, popup, dialog or sheet (div
 * or native) moves inside it while it shows and back once closed; a native
 * one so that its exit, outside the top layer at once, stays above the
 * sheet's panel and its scrim keeps catching clicks. A menu focuses
 * its first enabled item (the last one when an ArrowUp keydown opened it),
 * moves focus with ArrowUp, ArrowDown, Home and End (wrapping), to the next
 * item whose label starts with the typed letters (type-ahead; the letters
 * reset after --ds-delay-tooltip) and closes a task after an item's click,
 * once the item's handlers ran. The items of a dialog's .ds-dialog__list
 * (an action sheet) take the same arrow keys.
 *
 * Scroll lock: reference-counted per document (lockScroll(doc) /
 * unlockScroll(doc), default the global one; modal kinds lock their own
 * document, a contained dialog none). body.ds-no-scroll (needs .ds-base)
 * toggles only on 0 <-> 1.
 * When the lock really removes a classic scrollbar of the page, its room
 * is kept: scrollbar-gutter: stable on <html>, else a padding-right on
 * <body>; in the app frame, where .ds-view scrolls, nothing is reserved.
 *
 * Inert follows the stack: each div trap (and the drawer) records what
 * it took, and an element is inert while a trap holds it and no overlay
 * above that trap sits inside it. So overlays opened over each other (a
 * dialog from a div sheet or from the modal drawer) take input, and
 * closing in any order restores exactly what was taken. A contained dialog
 * (.ds-dialog--contained) traps only inside its positioned container: the
 * page around it (a host page around an embedded widget) stays usable.
 *
 * An overlay that the page removes from the document while it is open or
 * closing (a route change, a re-render) is closed at once, without motion:
 * a MutationObserver, connected while the stack holds anything, notices
 * the removal, and its lock, inert, aria-expanded and Escape entry go;
 * focus is not moved. One that left only with the native host it was moved
 * into goes back to its place, and the drawer's frame (kept from open())
 * loses data-drawer-open also when only the drawer was replaced.
 *
 * Escape and a contained dialog: the key is the dialog's only when pressed
 * inside its container; elsewhere in a host page it stays the host's.
 *
 * Runtime state: from open() until its close settled, the state this
 * module writes (data-state, the dropped `hidden`, popover, data-anchored,
 * data-placement, the --closing, --nested and --hidden classes,
 * --ds-menu-x/-y, max-height, position-anchor, aria-expanded on the
 * opener, anchor-name on the anchor, the `inert` of what a trap took, a
 * tooltip's aria-describedby; for snackbars data-toast-reserve and
 * --ds-toast-reserve where toast() keeps room, --ds-toast-lift and the
 * role and aria-live it took off a region; for a save bar its hidden and
 * inert, data-ds-savebar, data-ds-savebar-rest and --ds-savebar-height on
 * the view) is owned (Symbol.for('ds.owned'), see
 * motion.js), so a live re-render with DS.dom.morphHtml keeps it.
 *
 * Openers: open(el, { opener }) without an opener takes the focused
 * element, or, with focus on <body> (Safari does not focus a clicked
 * button), the focusable control the current event came from. A dialog or
 * sheet keeps aria-expanded on its opener in step only when the opener
 * already carries the attribute (opt-in by markup). open(drawer) focuses
 * the drawer's [aria-current="page"] item when it has one.
 *
 * Save bar: savebar(element) shows and hides a view's .ds-savebar
 * (.ds-presence), keeps the view's end and its focused element clear of
 * it and lifts the snackbars above it.
 *
 * Split (3.0): this file is the shared core, what every overlay needs: the
 * stack, focus and its return, Escape order, dismiss, the scroll lock, the
 * inert trap, the exit contract, the modal drawer (which has no folder of its
 * own yet) and the save bar. What only one component needs lives in its
 * folder and registers itself here through internals.use(): the keys of a
 * menu (components/menu/menu.js), the promise dialogs, the action sheet's
 * keys and the form dialog (components/dialog/dialog.js), the snackbars
 * (components/toast/toast.js) and the tooltips
 * (components/tooltip/tooltip.js). DS.overlay keeps its whole API:
 * confirm(), toast(), tooltips() and the others below call the module that
 * registered, and throw a message naming the file when it is not loaded
 * (ds.js always has them; a bundle has them when the page uses them, by
 * "exportRequires" of overlay.requires.json; ES modules import the file).
 * A menu or dialog opened without its module still opens, but has lost its
 * keys and more: open() warns once, with the same message.
 * Placement is js/position.js. `internals` is what those modules read; it is
 * no API and may change in any release.
 *
 * Triggers: [data-ds-open="<selector or id>"] opens that overlay on a click
 * (with the trigger as its opener; again, or a menu's ArrowDown and ArrowUp,
 * as a menu button does), [data-ds-close="<selector or id>"] closes it from
 * outside and leaves the overlay around it open, [data-ds-close] without a
 * value inside an overlay closes that one: one delegated listener per root
 * of DS.init().
 *
 * Events: ds:open ({ opener }) once the entrance started and ds:close
 * ({ reason }) as soon as a close started. Both bubble.
 *
 * The constants are fallbacks only (outside a .ds-theme or without a
 * DOM): JS timing comes from the computed tokens through motionDuration(),
 * which includes --ds-time-scale. Nothing touches the DOM at import; the
 * one thing import does is listen to the drawer breakpoint (matchMedia),
 * so every .ds-app > .ds-drawer of the page crosses 900px in place from
 * load on, also one DS.overlay never opened.
 *
 * Listeners that outlive an element (the drawer breakpoint per window,
 * the tab's visibility per document) are one per window or document and
 * hold the drawers and snackbar regions through WeakRef (ES2021), so a
 * frame the page re-renders is not kept alive.
 *
 * ES2022; a module may import from an earlier module (the
 * build bundles it into dist/ds.js as DS.overlay); newer APIs only behind
 * feature detection, named under Progressive:.
 *
 * Progressive:
 * - scrollbar-gutter (CSS.supports; keeps the room of a removed page
 *   scrollbar): without it the body gets the same room as padding-right.
 * - CSS anchor positioning (js/position.js detects anchorName and
 *   position-area, this file anchor-size() too for a combobox list; a menu
 *   and a combobox list go into the top layer as popover="manual", anchored
 *   to their trigger): without them the script places them (--ds-menu-x/-y
 *   in the terms of the box they are fixed to, the list's upward flip).
 * - startViewTransition (through DS.motion.transition(), for `container:
 *   true`, only with .ds-theme on <html>): without it the usual entrance.
 * - focus({ focusVisible: false }) (an overlay opened or closed with the
 *   pointer, or after the last input was a press, shows no keyboard ring
 *   in WebKit, which marks what showModal(), close() and a script's
 *   focus() focus as :focus-visible): without it that ring stays as WebKit
 *   draws it.
 */
import { define, emit, runtime } from './core.js';
import { motionDuration, originFrom, settled, transition } from './motion.js';
import { scrollEdges, watchScrolled } from './dom.js';
import { anchorPopup, clippedBounds, dropProbe, place, pxOf, releaseAnchor, round, supportsAnchoring } from './position.js';

/** How long a snackbar stays (ms) before its length adds time; --ds-time-scale stretches it. */
export const TOAST_MS = 4000;

/** The longest a snackbar stays on its own (ms), however long its text. */
export const TOAST_MAX_MS = 10000;

/** At most this many snackbars show at once (D19). */
export const TOAST_LIMIT = 3;

/** --ds-delay-tooltip outside a theme: the wait before a tooltip shows. */
export const TOOLTIP_DELAY_MS = 500;

/** --ds-delay-tooltip-skip outside a theme: within this of the last hide the next tooltip shows at once. */
export const TOOLTIP_SKIP_MS = 300;

/** --ds-delay-tooltip-hide outside a theme: the grace before a tooltip hides (it is hoverable). */
export const TOOLTIP_HIDE_MS = 100;

/** --ds-delay-dismiss outside a theme: a backdrop or scrim click this soon after the open does not close. */
export const DISMISS_DELAY_MS = 300;

/* ── State ──────────────────────────────────────────── */

/** The modal drawer exists only at this width and below: the media query of shell.css (tested). */
export const DRAWER_QUERY = '(max-width: 900px)';

/** Tabbable candidates; canFocus() filters them. */
export const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]';

/** The landmarks focus falls back to when an opener is gone (leave()'s rule). */
const LANDMARK = '.ds-view[tabindex="-1"], main[tabindex="-1"], [role="main"][tabindex="-1"]';

/** Kinds that trap focus, lock the scroll and count as "another modal" for --nested. */
const MODAL = new Set(['dialog', 'sheet', 'drawer']);

/**
 * One state per overlay element. `anchor`: the element a popup gave an
 * anchor-name (removed again on close). `home`: where an overlay that
 * moved into an open native modal came from (put back on close).
 * `openerId` and `openerRoot`: the opener's id and its document or shadow
 * root, so focus finds the twin of an opener a re-render replaced;
 * `returnTo`: the page's own fallback. `shownAt`: when it opened, and
 * `pressed`: where the last press inside it (or on the drawer's scrim)
 * began (the dismiss guard). `cancelled`: a native cancel the engine
 * would not let us prevent (Android Back), so the close that follows is an
 * Escape.
 * @typedef {{ gen: number, phase: 'closed'|'open'|'closing', kind: string, opener: Element|null,
 *   expander: Element|null, inerted: Element[], locked: boolean, lockedDoc: Document|null, hiddenClass: string,
 *   opening: Promise<void>|null, closing: Promise<void>|null, anchor: HTMLElement|null,
 *   home: { parent: Node, next: Node|null }|null, container: object|null,
 *   claims: Array<[Element, string, string]>, openerId: string, openerRoot: any,
 *   returnTo: (() => Element|null|undefined)|null, shownAt: number, pressed: Node|null, cancelled: boolean }} OverlayState
 * @type {WeakMap<Element, OverlayState>}
 */
const overlays = new WeakMap();

/** Open overlays (and those still closing), the topmost last. */
const stack = /** @type {Element[]} */ ([]);

/**
 * What every copy of ds.js on a page shares per document (a host page and
 * an embedded widget may each load their own, of another version), under
 * a symbol of the global registry like the owned record:
 * - `order`: the open overlays of every copy, the topmost last, each with
 *   its copy's `open()` and `escape(event)`, so Escape closes the topmost
 *   layer whichever copy opened it, and (2.1.1) `opener()`, so no copy
 *   shows a tooltip for the opener of an open layer;
 * - `lock`: the scroll lock's count and the inline styles it replaced;
 * - `seq`: the counter of anchor names and tooltip ids, so two copies
 *   never write the same one;
 * - `tipRoots`: the roots tooltips() serves, root element to handle.
 * Copies before 1.6.1 keep their own.
 * @returns {{ order: Array<{ element: Element, open: () => boolean, opener?: () => Element|null, escape: (event: Event) => boolean|undefined }>, lock: { count: number, saved: { gutter: string, padding: string } | null }, seq: number, tipRoots: WeakMap<Element, { destroy: () => void }> }}
 */
/**
 * The focused element as seen from `node`'s tree: inside a shadow root its
 * own activeElement (document.activeElement is the shadow host there, so a
 * widget in a shadow root would never see its own focus), else the
 * document's.
 * @param {any} node
 * @returns {any}
 */
function activeIn(node) {
  const root = node?.getRootNode?.();
  return (root?.nodeType === 11 ? root.activeElement : null) ?? node?.ownerDocument?.activeElement ?? null;
}

/**
 * Whether `event` started inside `node`: a test along the composed path.
 * It covers `node` inside an open shadow root (a listener on the document
 * sees the target retargeted to the shadow host, so a contained dialog in
 * a shadow root would take every Escape for one pressed outside its
 * container) and a press inside a web component in `node` (an icon
 * element with its own shadow root: contains() stops at the shadow
 * boundary of the innermost target, so that press would count as one
 * outside a menu). A closed shadow root ends the path at its host, which
 * is still on it.
 * @param {Node|null|undefined} node
 * @param {Event} event
 * @returns {boolean}
 */
function inside(node, event) {
  if (!node) return false;
  const path = event.composedPath?.();
  return path?.length ? path.includes(node) : node.contains(/** @type {Node} */ (event.target));
}

const SHARED = Symbol.for('ds.overlay');

/** The record of each document, in the page's runtime (DS.core.runtime). @type {WeakMap<Document, any>} */
const sharedRecords = runtime.state('overlay', () => new WeakMap());

function sharedOf(doc) {
  let record = sharedRecords.get(doc);
  if (!record) {
    // A copy before 3.0 keeps the record on the document: adopt it, and leave it there for such copies.
    record = doc[SHARED] ?? {};
    sharedRecords.set(doc, record);
    doc[SHARED] = record;
  }
  record.order ??= [];
  record.lock ??= { count: 0, saved: null };
  record.seq ??= 0;
  record.tipRoots ??= new WeakMap();
  record.inertHolds ??= new WeakMap();
  return record;
}

/** Puts `element` on top of its document's shared order (see sharedOf). */
function enterOrder(element) {
  const order = sharedOf(element.ownerDocument).order;
  leaveOrder(element);
  order.push({
    element,
    open: () => element.isConnected && overlays.get(element)?.phase === 'open',
    opener: () => overlays.get(element)?.opener ?? null,
    escape(event) {
      // A contained dialog owns Escape only inside its container: the host
      // page around an embedded widget keeps the key (its own dialogs, its
      // search fields), also with focus on <body>.
      if (containedDialog(element) && !inside(containerOf(element), event)) return undefined;
      // A non-modal layer leaves the key to the page field that has focus.
      if (!escapeReaches(element, event)) return false;
      // preventDefault() also keeps a native dialog from its own cancel.
      event.preventDefault();
      closeFrom(element, 'escape');
      return true;
    },
  });
}

/** The non-modal layers: the page around them stays usable. */
const NON_MODAL = '.ds-dialog__box--modeless, .ds-sheet__panel--push, .ds-sheet__panel--inspector';

/**
 * Whether Escape is the layer's: always for a modal one; for a non-modal
 * layer (WAI-ARIA APG) only from inside it, from its opener or with focus
 * nowhere (<body>), and for a docked panel also from the content of its
 * .ds-sheet__layout (an inspector's list keeps the focus). Escape in an
 * unrelated page field stays that field's.
 */
function escapeReaches(element, event) {
  if (!element.matches?.(NON_MODAL)) return true;
  const target = /** @type {any} */ (event.composedPath?.()[0] ?? event.target);
  const doc = element.ownerDocument;
  if (!target || target === doc || target === doc.body || target === doc.documentElement) return true;
  const docked = element.matches('.ds-sheet__panel--push, .ds-sheet__panel--inspector') ? element.closest('.ds-sheet__layout') : null;
  return inside(docked ?? element, event) || inside(overlays.get(element)?.opener ?? null, event);
}

function leaveOrder(element) {
  const order = element.ownerDocument?.[SHARED]?.order;
  const index = order ? order.findIndex((entry) => entry.element === element) : -1;
  if (index >= 0) order.splice(index, 1);
}

/**
 * The elements the div trap and the drawer made inert, for whichever
 * overlays took them (each overlay records its own in `inerted`).
 * syncInert() derives their inert from the stack, so overlays over each
 * other compose and closing in any order restores exactly what was taken.
 */
const managedInert = /** @type {Set<Element>} */ (new Set());

/**
 * Tooltip controllers (tooltips()): open() hides them through hide(), and
 * the Escape stack asks escape() first, which returns true when it hid a
 * visible tooltip (the key is then the tooltip's).
 * @type {Set<{ hide: () => void, escape: () => boolean }>}
 */
const tooltipControllers = new Set();

/**
 * Nodes inertOutside() leaves alone, like the snackbar regions: the live
 * regions a snackbar region made (they stay heard) and the tooltips (the one
 * a trigger inside a div dialog, side sheet or the modal drawer shows takes
 * the pointer through the hoverable grace, and is heard).
 */
const neverInert = new WeakSet();

/**
 * The save bars on screen (savebar()): each lifts the snackbar regions of
 * its theme above itself (`lift(region)`, in px).
 * @type {Set<{ element: HTMLElement, lift: (region: Element) => number }>}
 */
const shownSavebars = new Set();

/**
 * The behaviours that registered (internals.use): the modules of the
 * component folders this core calls, each once. A page without one has no
 * such component: its calls below are optional, and the DS.overlay function
 * it backs says which file is missing.
 * @type {{ menu?: any, dialog?: any, toast?: any, tooltip?: any }}
 */
const parts = {};

/** The same behaviours of the whole page, so js/overlay.js next to a ds.js or a bundle finds the ones they hold. */
const pageParts = runtime.state('overlay-parts', () => ({}));

/** The module behind a DS.overlay function that lives in a component's folder. */
function partFor(name, fn) {
  const found = parts[name] ?? pageParts[name];
  if (found) return found;
  throw new Error(`Z-Dash: DS.overlay.${fn}() needs the ${name} module: import js/${name}.js next to js/overlay.js, or keep ${name} in the bundle.`);
}

/** The kinds open() warned about, once each. */
const partsWarned = new Set();

/**
 * An open() that would silently lose behaviour: a menu's keys, focus and
 * close on an item, a dialog's action sheet keys and form. A throw would
 * break a page that only needs the overlay to show.
 */
function warnMissingPart(element, kind) {
  if (parts[kind] || partsWarned.has(kind)) return;
  partsWarned.add(kind);
  viewOf(element).console?.warn(`Z-Dash: DS.overlay.open() on a ${kind} needs the ${kind} module: import js/${kind}.js next to js/overlay.js, or keep ${kind} in the bundle.`);
}

/** Documents with the Escape and pointer listeners. */
const listening = new WeakSet();

/** Elements with their [data-ds-close] (and scrim, cancel) listeners. */
const wired = new WeakSet();

/** Drawers with their media-change listener. */
const watchedDrawers = new WeakSet();

let warned = false;

/**
 * The runtime state a DS helper owns on an element right now, which
 * DS.dom.morphHtml keeps (present or absent) until the helper lets go:
 * the record of motion.js under the same symbol of the global registry
 * ({ attrs, classes, props }, each a Map of name to a count of owners).
 * These two helpers are motion.js's own, repeated here.
 */
const OWNED = Symbol.for('ds.owned');

/** `kind`: 'attrs', 'classes' or 'props' (a style property, kebab-case). */
function own(element, kind, name) {
  if (!element || typeof element !== 'object') return;
  const record = element[OWNED] ?? (element[OWNED] = { attrs: new Map(), classes: new Map(), props: new Map() });
  record[kind].set(name, (record[kind].get(name) ?? 0) + 1);
}

function disown(element, kind, name) {
  const map = element?.[OWNED]?.[kind];
  const count = map?.get(name) ?? 0;
  if (count > 1) map.set(name, count - 1);
  else map?.delete(name);
}

/** What an overlay owns on itself from open() until its close settled. */
const PANEL_STATE = {
  attrs: ['data-state', 'hidden', 'open', 'popover', 'data-anchored', 'data-placement'],
  classes: ['ds-dialog--closing', 'ds-sheet--closing', 'ds-dialog--nested', 'ds-dialog--hidden', 'ds-sheet--hidden'],
  props: ['--ds-menu-x', '--ds-menu-y', 'max-height', 'position-anchor'],
};

/** Owns `names` of `kind` on `node` for the overlay of `state`, until releaseClaims(). */
function claim(state, node, kind, names) {
  if (!node) return;
  for (const name of names) {
    own(node, kind, name);
    state.claims.push([node, kind, name]);
  }
}

function releaseClaims(state) {
  for (const [node, kind, name] of state.claims) disown(node, kind, name);
  state.claims = [];
}

function stateOf(element) {
  let state = overlays.get(element);
  if (!state) {
    state = { gen: 0, phase: 'closed', kind: kindOf(element), opener: null, expander: null, inerted: [], locked: false, lockedDoc: null, hiddenClass: '', opening: null, closing: null, anchor: null, home: null, app: null, container: null, claims: [], openerId: '', openerRoot: null, returnTo: null, shownAt: 0, pressed: null, cancelled: false, edges: null };
    overlays.set(element, state);
  }
  return state;
}

/** @returns {'dialog'|'sheet'|'drawer'|'menu'|'combo'|'popup'} */
function kindOf(element) {
  if (element.matches('.ds-drawer')) return 'drawer';
  if (element.matches('.ds-dialog')) return 'dialog';
  if (element.matches('.ds-sheet')) return 'sheet';
  if (element.matches('.ds-menu')) return 'menu';
  if (element.matches('.ds-combo__popup')) return 'combo';
  return 'popup';
}

/** The part that moves and holds the content: the dialog's box, the sheet's panel, else the element. */
function boxOf(element, kind) {
  if (kind === 'dialog') return element.querySelector('.ds-dialog__box') ?? element;
  if (kind === 'sheet') return element.querySelector('.ds-sheet__panel') ?? element;
  return element;
}

const isNative = (element) => element.tagName === 'DIALOG' && typeof element.showModal === 'function';

const viewOf = (element) => element.ownerDocument?.defaultView ?? globalThis;

/** A style flush: the closed state is computed before the open one is set. */
function flushStyle(element) {
  const view = viewOf(element);
  if (typeof view.getComputedStyle === 'function') void view.getComputedStyle(element).opacity;
}

/* ── Focus ──────────────────────────────────────────── */

/**
 * Whether focus() would land on the node (enabled, rendered, not inert or hidden).
 * @param {any} node
 * @returns {boolean}
 */
export function canFocus(node) {
  if (!node || node.isConnected === false || typeof node.focus !== 'function') return false;
  if (node.disabled || node.closest?.('[inert], [hidden]')) return false;
  return typeof node.getClientRects !== 'function' || node.getClientRects().length > 0;
}

/**
 * The first tabbable element inside `root`, a focusable separator (a
 * sheet's resize handle, the first child of its panel) passed over: the
 * first focus belongs to the content, not to a handle that only resizes.
 */
function firstFocusable(root) {
  for (const node of root.querySelectorAll(FOCUSABLE)) {
    if (node.getAttribute('tabindex') === '-1' || node.getAttribute('role') === 'separator') continue;
    if (canFocus(node)) return node;
  }
  return null;
}

/**
 * Where focus goes when `element` closes: its opener, or, when that is
 * gone or hidden inside another closed overlay, that overlay's opener;
 * else what the page's returnTo() gives (a focusable element outside the
 * overlay; an error is reported and passed over), the element that now
 * holds the opener's id (a re-render replaced the opener), the nearest
 * tabindex="-1" ancestor or landmark. Never <body>.
 */
function returnTarget(element, state) {
  // An opener that is rendered but not focusable (a span that only places
  // a popup) would drop the focus to <body>: it counts as gone.
  const takes = (node) => canFocus(node) && (typeof node.matches !== 'function' || node.matches(FOCUSABLE));
  let opener = state.opener;
  for (let depth = 0; opener && depth < 4; depth += 1) {
    if (takes(opener) && !element.contains(opener)) return opener;
    const host = [...stack, ...hostsOf(opener)].find((node) => node !== element && node.contains(opener));
    opener = host ? overlays.get(host)?.opener ?? null : null;
  }
  const outside = (node) => takes(node) && !element.contains(node);
  if (typeof state.returnTo === 'function') {
    try {
      const target = state.returnTo();
      if (outside(target)) return target;
    } catch (error) {
      report(element, error);
    }
  }
  const twin = state.openerId ? state.openerRoot?.getElementById?.(state.openerId) : null;
  if (twin && twin !== state.opener && outside(twin)) return twin;
  const doc = element.ownerDocument;
  const near = element.parentElement?.closest('[tabindex="-1"]');
  return [near, doc.querySelector(LANDMARK)].find(outside) ?? null;
}

/**
 * Reports an error of a page callback (returnTo, a toast action, a save
 * bar's focusTarget) to the window's error handling, without stopping
 * what DS is doing (reportError where it exists).
 */
function report(element, error) {
  const view = viewOf(element);
  if (typeof view.reportError === 'function') view.reportError(error);
  else view.console?.error(error);
}

/**
 * The opener when open() got none: the focused element outside the
 * overlay, or, with focus on <body> (Safari does not focus a clicked
 * button), the focusable control the current event came from.
 */
function defaultOpener(element) {
  const doc = element.ownerDocument;
  const active = activeIn(element);
  if (active && active !== doc.body && !element.contains(active)) return active;
  if (active && active !== doc.body) return null;
  const event = /** @type {any} */ (viewOf(element)).event;
  const origin = event?.composedPath?.()[0] ?? event?.target;
  const control = origin?.closest?.(OPENER_CONTROL);
  return control && canFocus(control) && !element.contains(control) ? control : null;
}

/** Controls that open overlays: the targets of defaultOpener(). */
const OPENER_CONTROL = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';

/** The overlay elements around a node that DS.overlay has seen (closed ones included). */
function hostsOf(node) {
  const hosts = [];
  for (let el = node?.parentElement; el; el = el.parentElement) if (overlays.has(el)) hosts.push(el);
  return hosts;
}

/** Controls that always show the keyboard ring when focused, by pointer or by key. */
const TEXT_ENTRY = 'input:not([type="button"], [type="submit"], [type="reset"], [type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="image"]), textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Keys that alone never ask for the keyboard ring (as in the engines' own :focus-visible). */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/**
 * The last input of a document, shared under a symbol of the global
 * registry with js/ripple.js (attach() installs the same listeners) and
 * every other copy of ds.js on the page: { last } is 'pointer' (a press of
 * a mouse, pen or finger), 'key' (a key other than a modifier) or '' before
 * either. Only known once something of DS listens: DS.ripple.attach(), the
 * first open() or tooltips().
 */
const INPUT = Symbol.for('ds.input');

/**
 * Remembers the last input modality of `doc` (capture listeners, passive
 * for the pointer), for a focus that moves outside any input event: an
 * overlay opened once another one's exit settled, after a fetch or a
 * timer. Once per document, whichever module or copy comes first.
 */
function watchModality(doc) {
  if (typeof doc?.addEventListener !== 'function' || doc[INPUT]) return;
  const record = (doc[INPUT] = { last: '' });
  // mousedown too: a tap that only WebKit's compatibility mouse events report (an automated tap on iOS).
  for (const type of ['pointerdown', 'mousedown']) doc.addEventListener(type, () => { record.last = 'pointer'; }, { capture: true, passive: true });
  doc.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (!MODIFIER_KEYS.has(event.key)) record.last = 'key';
  }, true);
}

/**
 * Runs what moves focus for an overlay (showModal() or close() of a native
 * dialog, focusing into a layer, giving focus back) without the keyboard
 * ring a pointer never asked for: WebKit marks the element these focus
 * (the autofocus target, a first item, the opener) as :focus-visible even
 * after a mouse click or a tap, and the focus() that follows is a no-op on
 * an element that has focus already. Pointer-caused: inside a pointer,
 * mouse or touch event (a click from Enter or Space has detail 0), or,
 * inside no input event at all (a dialog opened when an action sheet's
 * exit settled, after a fetch), when the document's last input was a
 * press (watchModality()); and only when the previous focus showed no
 * ring. A key press (Escape, Enter) keeps the engine's own choice.
 * Text-entry controls are left alone: they match :focus-visible in every
 * engine whatever the input modality, so there is nothing to correct, and
 * a blur would run the page's blur handlers (validate on blur, a combobox
 * that closes) on open.
 */
function keepFocusVisibility(element, run) {
  const before = activeIn(element);
  const body = element.ownerDocument.body;
  const was = Boolean(before) && before !== body && before.matches(':focus-visible');
  const event = /** @type {any} */ (viewOf(element)).event;
  const type = event?.type ?? '';
  const key = /^key/.test(type) || (type === 'click' && event.detail === 0);
  const press = !key && /^(pointer|mouse|touch|click$)/.test(type);
  const pointer = press || (!key && element.ownerDocument[INPUT]?.last === 'pointer');
  run();
  const now = activeIn(element);
  if (was || !pointer || !now || now === before || now === body || now.matches(TEXT_ENTRY) || !now.matches(':focus-visible')) return;
  now.blur();
  now.focus({ preventScroll: true, focusVisible: false });
}

function focusInto(element, state, box) {
  const autofocus = element.querySelector('[autofocus]');
  if (canFocus(autofocus)) {
    autofocus.focus({ preventScroll: true });
    return;
  }
  if (state.kind === 'combo') return;
  if (state.kind === 'menu') {
    parts.menu?.focusInto(element);
    return;
  }
  if (state.kind === 'drawer') {
    // The page the user is on, so the list reads from there.
    const current = element.querySelector('[aria-current="page"]');
    if (canFocus(current)) {
      current.focus({ preventScroll: true });
      return;
    }
  }
  if (state.kind === 'drawer' && element.hasAttribute('tabindex')) {
    element.focus({ preventScroll: true });
    return;
  }
  if (state.kind === 'popup') return;
  const target = firstFocusable(box);
  if (target) target.focus({ preventScroll: true });
  else {
    // Nothing to focus: the box itself takes it, so focus is inside the trap.
    if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
    box.focus({ preventScroll: true });
  }
}

/* ── Inert outside (the div trap) ───────────────────── */

/**
 * The siblings of `element` and of each of its ancestors up to <body>
 * (or up to `stop`, a contained dialog's container) that its trap takes:
 * all but .ds-scrim, the snackbar regions and their announcers (they stay
 * above every modal: usable and heard), the tooltips (a trigger inside the
 * overlay shows one that must stay hoverable and heard), and what is inert
 * already without us. syncInert() applies them. The walk crosses a shadow
 * root through its host (a top-level child of a shadow root has no
 * parentElement), so the div dialog, sheet or modal drawer of a widget in
 * a shadow root makes the host page inert too, as showModal() does.
 */
function inertOutside(element, stop = element.ownerDocument.body) {
  const taken = [];
  const body = element.ownerDocument.body;
  const holds = sharedOf(element.ownerDocument).inertHolds;
  for (let node = element; node && node !== stop && node !== body;) {
    const parent = node.parentNode;
    if (!parent || parent.nodeType === 9) break;
    for (const sibling of /** @type {ParentNode} */ (parent).children) {
      if (sibling === node || sibling.matches('.ds-scrim, .ds-toasts') || neverInert.has(sibling)) continue;
      if (sibling.inert && !managedInert.has(sibling) && !holds.has(sibling)) continue;
      taken.push(sibling);
    }
    node = parent.nodeType === 11 ? /** @type {ShadowRoot} */ (parent).host : /** @type {Element} */ (parent);
  }
  return taken;
}

/** Whether `node` holds `other`, also across shadow roots (through their hosts). */
function composedContains(node, other) {
  for (let at = other; at; at = at.parentNode ?? /** @type {any} */ (at).host ?? null) {
    if (at === node) return true;
  }
  return false;
}

/**
 * Nodes the page added next to an open div trap, or next to an ancestor of
 * it (a host script's banner appended to <body>, a re-rendered section),
 * join that trap: Tab never reaches them while it is open.
 * @param {Node[]} targets  the parents that gained children
 */
function refreshTraps(targets) {
  let grew = false;
  for (const element of stack) {
    const state = overlays.get(element);
    // Only div traps hold a list; a native modal is inert-free by the top layer.
    if (!state?.inerted.length || state.phase !== 'open' || !element.isConnected) continue;
    if (!targets.some((target) => composedContains(target, element))) continue;
    const stop = containedDialog(element) ? containerOf(element) : undefined;
    const known = new Set(state.inerted);
    for (const node of inertOutside(element, stop)) {
      if (known.has(node)) continue;
      state.inerted.push(node);
      grew = true;
    }
  }
  if (grew) syncInert();
}

/**
 * Sets inert from the stack: an element a trap took is inert unless it
 * holds an overlay above that trap (opened later, still open or closing).
 * So a dialog opened from a div sheet or from the modal drawer, which the
 * lower trap took as a sibling, takes input, and its scrim keeps
 * swallowing clicks through its exit; the lower overlay stays inert under
 * it. The box of a closing overlay keeps its inert.
 */
function syncInert() {
  const wanted = new Set();
  stack.forEach((element, index) => {
    const above = stack.slice(index + 1);
    for (const node of overlays.get(element)?.inerted ?? []) {
      // A host-page node the trap took may hold a later overlay inside a shadow root.
      if (node.isConnected && !above.some((other) => composedContains(node, other))) wanted.add(node);
    }
  });
  const closingBoxes = new Set(stack.filter((element) => overlays.get(element)?.phase === 'closing')
    .map((element) => boxOf(element, overlays.get(element)?.kind ?? '')));
  for (const node of [...managedInert]) {
    if (wanted.has(node)) continue;
    managedInert.delete(node);
    disown(node, 'attrs', 'inert');
    if (!closingBoxes.has(node) && !sharedOf(node.ownerDocument).inertHolds.has(node)) node.inert = false;
  }
  for (const node of wanted) {
    // A re-render of a region the trap took (DS.dom.morphHtml) keeps it inert.
    if (!managedInert.has(node)) own(node, 'attrs', 'inert');
    managedInert.add(node);
    node.inert = true;
  }
}

/** A dialog that covers its positioned container instead of the window (an embedded panel). */
const containedDialog = (element) => element.matches('.ds-dialog--contained');

/**
 * The box a contained dialog covers: its nearest positioned ancestor
 * (dialog.css places it absolute), else the .ds-theme around it, else
 * <body>. Its trap stops there.
 */
function containerOf(element) {
  const doc = element.ownerDocument;
  const view = viewOf(element);
  for (let node = element.parentElement; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    if ((view.getComputedStyle?.(node).position ?? 'static') !== 'static') return node;
  }
  return element.closest('.ds-theme') ?? doc.body;
}

function restoreInert(state) {
  state.inerted = [];
  syncInert();
}

/**
 * Makes the elements inert until destroy(), for a modal region that is no
 * overlay (DS.a11y.inert()). Counted per element and known to syncInert(), so
 * holds and overlay traps compose in any order: the element stays inert until
 * the last of them lets go, and what the page made inert itself stays inert.
 * A re-render with morphHtml keeps it.
 * @param {Iterable<Element>} elements
 * @returns {{ destroy: () => void }}
 */
export function holdInert(elements) {
  const nodes = [...new Set(elements)].filter((node) => node?.ownerDocument);
  for (const node of nodes) {
    const holds = sharedOf(node.ownerDocument).inertHolds;
    const held = holds.get(node);
    if (held) {
      held.count += 1;
      continue;
    }
    holds.set(node, { count: 1, pageOwn: node.inert === true && !managedInert.has(node) });
    own(node, 'attrs', 'inert');
    node.inert = true;
  }
  let done = false;
  return {
    destroy() {
      if (done) return;
      done = true;
      for (const node of nodes) {
        const holds = sharedOf(node.ownerDocument).inertHolds;
        const held = holds.get(node);
        held.count -= 1;
        if (held.count) continue;
        holds.delete(node);
        disown(node, 'attrs', 'inert');
        if (!held.pageOwn && !managedInert.has(node)) node.inert = false;
      }
    },
  };
}

/* ── Scroll lock ────────────────────────────────────── */

function supportsGutter(view) {
  return typeof view.CSS?.supports === 'function' && view.CSS.supports('scrollbar-gutter: stable');
}

/**
 * Locks the scroll of `doc` (default: the global document; the overlays
 * lock their own): the first call adds body.ds-no-scroll; later calls only
 * count. When the lock removes a classic page scrollbar, its room stays
 * (scrollbar-gutter: stable on <html>, else padding-right on <body>), so
 * the page does not shift sideways.
 * @param {Document} [doc]
 */
export function lockScroll(doc = globalThis.document) {
  if (!doc?.body) return;
  // Shared by every copy of ds.js on the page (sharedOf).
  const lock = sharedOf(doc).lock;
  lock.count += 1;
  if (lock.count !== 1) return;
  const root = doc.documentElement;
  const body = doc.body;
  const view = doc.defaultView ?? globalThis;
  const before = (view.innerWidth || 0) - (root.clientWidth || 0);
  lock.saved = { gutter: root.style.scrollbarGutter ?? '', padding: body.style.paddingRight ?? '' };
  body.classList.add('ds-no-scroll');
  // Only a scrollbar that the lock really removed leaves a gap to fill.
  const gap = before - ((view.innerWidth || 0) - (root.clientWidth || 0));
  if (!(before > 0) || !(gap > 0)) return;
  if (supportsGutter(view)) root.style.scrollbarGutter = 'stable';
  else {
    const padding = parseFloat(view.getComputedStyle?.(body).paddingRight ?? '') || 0;
    body.style.paddingRight = `${padding + gap}px`;
  }
}

/**
 * Releases one lockScroll() of `doc` (default: the global document); the
 * last one removes the class and restores the inline styles. Never below 0.
 * @param {Document} [doc]
 */
export function unlockScroll(doc = globalThis.document) {
  const lock = doc?.body ? doc[SHARED]?.lock : null;
  if (!lock || lock.count === 0) return;
  lock.count -= 1;
  if (lock.count) return;
  doc.body.classList.remove('ds-no-scroll');
  if (lock.saved) {
    doc.documentElement.style.scrollbarGutter = lock.saved.gutter;
    doc.body.style.paddingRight = lock.saved.padding;
  }
  lock.saved = null;
}

/* ── Listeners ──────────────────────────────────────── */

/** The topmost overlay that is not already closing. */
function topOpen() {
  pruneDetached();
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (overlays.get(stack[i])?.phase === 'open') return stack[i];
  }
  return null;
}

function listen(doc) {
  if (listening.has(doc)) return;
  listening.add(doc);
  watchModality(doc);
  // Escape in the bubble phase: a widget inside the overlay that handles
  // the key itself (an inline edit, a picker) runs first and keeps the
  // overlay open with preventDefault(), as with a plain <dialog>. A
  // visible tooltip takes the key earlier, in its own capture listener.
  doc.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    for (const tip of tooltipControllers) {
      if (!tip.escape()) continue;
      // The key was the tooltip's: the overlay under it stays open.
      event.preventDefault();
      return;
    }
    pruneDetached();
    // The topmost open overlay of any copy of ds.js on the page: the first
    // copy's listener closes it through that copy (a copy whose own top is
    // lower never closes it instead), and the later ones see the key taken.
    const order = doc[SHARED]?.order ?? [];
    for (let i = order.length - 1; i >= 0; i -= 1) {
      if (!order[i].open()) continue;
      // A filled search in that layer takes the first Escape: it clears.
      if (clearSearch(order[i].element, event)) return;
      // false: a non-modal layer left the key to the page; the layer under it may take it.
      if (order[i].escape(event) === false) continue;
      return;
    }
  });
  doc.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
    pruneDetached();
    for (const element of [...stack].reverse()) {
      const state = overlays.get(element);
      if (state?.kind !== 'menu' || state.phase !== 'open') continue;
      if (inside(element, event) || inside(state.opener, event)) continue;
      closeFrom(element, 'outside');
    }
  }, true);
}

/**
 * Escape in a filled input[type="search"] inside `layer`: the value goes,
 * an input event tells the page's filter, the key is taken and the layer
 * stays. An empty search lets the key through.
 */
function clearSearch(layer, event) {
  const target = /** @type {any} */ (event.composedPath?.()[0] ?? event.target);
  if (!target || target.localName !== 'input' || target.type !== 'search' || !target.value) return false;
  if (!composedContains(layer, target) || target.readOnly || target.disabled) return false;
  event.preventDefault();
  target.value = '';
  const view = viewOf(target);
  target.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  return true;
}

/** What closes the overlay around it: the attribute without a value (one with a value closes only the overlay it names). */
const CLOSERS = '[data-ds-close=""]';

/** Close causes that the user started: refused while the overlay is busy (data-ds-busy). */
const USER_CLOSE = new Set(['escape', 'backdrop', 'close']);

/**
 * Whether a pointer click on a backdrop or scrim may close: the first
 * click of a press that began on it, --ds-delay-dismiss after the open.
 * click(), Enter and Space (detail 0) always may.
 */
function dismissable(element, state, part, event) {
  if (event.detail === 0) return true;
  if (event.detail > 1 || !state.pressed || !composedContains(part, state.pressed)) return false;
  return clock() - state.shownAt >= motionDuration(element, '--ds-delay-dismiss');
}

/** [data-ds-close] clicks, the drawer's scrim and a native dialog's cancel. */
function wire(element, state) {
  if (wired.has(element)) return;
  wired.add(element);
  // A press on the backdrop or scrim would move focus: neither is
  // focusable, so the second press of the double click that opened the
  // overlay would take focus off the field it just focused (to the dialog
  // or <body>), and one during the exit off the opener. Its default is the
  // focus change (the click still comes), so focus stays put; during the
  // exit that holds for a press anywhere on the overlay.
  const holdFocus = (/** @type {MouseEvent} */ event) => {
    const phase = overlays.get(element)?.phase;
    if (!phase || phase === 'closed') return;
    const target = /** @type {Element} */ (event.target);
    if (phase === 'closing' || target.closest?.('.ds-dialog__backdrop, .ds-sheet__backdrop, .ds-scrim')) event.preventDefault();
  };
  element.addEventListener('mousedown', holdFocus, true);
  // Where a press began: a drag from the box that ends on the backdrop
  // is no click on the backdrop (the dismiss guard).
  const pressAt = (/** @type {PointerEvent} */ event) => {
    const own = overlays.get(element);
    if (own) own.pressed = /** @type {Node} */ (event.composedPath?.()[0] ?? event.target);
  };
  element.addEventListener('pointerdown', pressAt, true);
  element.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const target = /** @type {Element} */ (event.target);
    const closer = target.closest?.(CLOSERS);
    if (!closer || !element.contains(closer)) return;
    // A closer inside a nested overlay belongs to that one.
    if (hostsOf(closer)[0] !== element && closer !== element) return;
    const own = overlays.get(element);
    if (own?.phase !== 'open') return;
    // The second click of a double click never closes (it may be the
    // opener's second click, landing on the dialog that just opened).
    if (event.detail > 1) return;
    const backdrop = closer.matches('.ds-dialog__backdrop, .ds-sheet__backdrop');
    if (backdrop && !dismissable(element, own, closer, event)) return;
    closeFrom(element, backdrop ? 'backdrop' : 'close');
  });
  if (state.kind === 'menu') parts.menu?.wire(element);
  if (state.kind === 'dialog') parts.dialog?.wire(element);
  if (state.kind === 'drawer') {
    const scrim = element.parentElement?.querySelector(':scope > .ds-scrim');
    scrim?.addEventListener('click', (/** @type {MouseEvent} */ event) => {
      const own = overlays.get(element);
      if (own?.phase === 'open' && dismissable(element, own, scrim, event)) closeFrom(element, 'backdrop');
    });
    scrim?.addEventListener('mousedown', holdFocus, true);
    scrim?.addEventListener('pointerdown', pressAt, true);
  }
  if (isNative(element)) {
    element.addEventListener('cancel', (event) => {
      // Escape or another close request: play the exit instead of vanishing.
      // A request the engine does not let us refuse (Android Back without
      // a user activation) closes anyway: the close that follows is an Escape.
      const own = overlays.get(element);
      if (own && !event.cancelable) own.cancelled = true;
      event.preventDefault();
      if (own?.phase === 'open') closeFrom(element, 'escape');
    });
    // Closed natively (a <form method="dialog">, dialog.close() of the
    // page, a cancel the engine forced): the state follows, and the exit
    // still plays. The event of close() itself arrives later, when the
    // dialog may be open again.
    element.addEventListener('close', () => {
      const own = overlays.get(element);
      if (own?.phase !== 'open' || element.open) return;
      const reason = own.cancelled ? 'escape' : 'api';
      own.cancelled = false;
      closeFrom(element, 'native', reason);
    });
  }
}

/**
 * data-scrolled on the box or panel while a dialog or sheet body is
 * scrolled (the head's or body's hairline): DS.dom.watchScrolled() on
 * every .ds-dialog__body and .ds-sheet__body of this overlay (not of one
 * nested in it), once per body (a page's own call keeps its handle). On a
 * later open, update() puts back a sentinel that a re-render took away.
 */
function watchBodies(element) {
  for (const body of element.querySelectorAll?.('.ds-dialog__body, .ds-sheet__body') ?? []) {
    if (body.closest('.ds-dialog, .ds-sheet') !== element) continue;
    const handle = watchScrolled(body);
    if (!body.querySelector(':scope > [data-ds-sentinel]')) handle.update();
  }
}

/** The item ArrowUp, ArrowDown, Home or End moves to among `items` (wrapping), or null for another key. */
function arrowTarget(items, event) {
  if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return null;
  const current = items.indexOf(/** @type {Element} */ (event.target)?.closest?.('.ds-menu__item'));
  if (event.key === 'Home') return items[0];
  if (event.key === 'End') return items.at(-1);
  if (event.key === 'ArrowDown') return items[(current + 1) % items.length];
  return items[current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length];
}

/** What a menu item is called for type-ahead: its label part, else its text; collapsed, lower case. */
const menuItemLabel = (item) => (item.querySelector('.ds-menu__label') ?? item).textContent.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The item the typed letters lead to: the next one after `current`
 * (wrapping) whose label starts with them; one letter typed again and
 * again cycles through the items with that letter. `label(item)` gives the
 * lower-case label (default: a menu item's). The one matcher: menu.js and
 * DS.a11y.typeahead() both use it.
 * @param {Element[]} items
 * @param {Element|null|undefined} current
 * @param {string} typed
 * @param {(item: Element) => string} [label]
 * @returns {Element|null}
 */
export function typeAhead(items, current, typed, label = menuItemLabel) {
  const repeated = typed.length > 1 && [...typed].every((char) => char === typed[0]);
  const start = items.indexOf(current);
  // A new search starts after the current item; a longer one may stay on it.
  const from = typed.length === 1 || repeated ? start + 1 : Math.max(0, start);
  for (const text of repeated ? [typed, typed[0]] : [typed]) {
    for (let step = 0; step < items.length; step += 1) {
      const item = items[(from + step) % items.length];
      if (label(item).startsWith(text)) return item;
    }
  }
  return null;
}

/* ── Popups: placement ──────────────────────────────── */

/**
 * Top layer and CSS anchor positioning for a popup: popover, anchor-name
 * and position-area; the combobox list also needs anchor-size() for its
 * width.
 */
function popupAnchoring(view, kind) {
  if (!supportsAnchoring(view)) return false;
  return kind !== 'combo' || view.CSS.supports('width: anchor-size(width)');
}

/** The element a popup is placed at: the combobox's field, else its opener. */
function popupAnchorOf(element, state) {
  const anchor = state.kind === 'combo' ? element.closest('.ds-combo') ?? state.opener : state.opener;
  return anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor : null;
}

/**
 * Places a popup that is about to enter (laid out at rest size): anchored
 * in the top layer where the engine can (popover="manual", data-anchored,
 * an anchor-name on the anchor unless it has one), else by the script (a
 * menu by --ds-menu-x/-y; the combobox list stays absolute and flips
 * above). Either way it opens below its anchor when it fits there, else on
 * the side with more room, and never taller than that room (anchored: the
 * CSS caps it to its position-area; the script writes max-height), so it
 * never covers its trigger. data-placement="top" marks a popup above its
 * anchor. Returns the anchor.
 */
function placePopup(element, state) {
  const anchor = popupAnchorOf(element, state);
  if (!anchor) return null;
  const view = viewOf(element);
  if (popupAnchoring(view, state.kind)) {
    releaseAnchor(state.anchor);
    state.anchor = null;
    const mine = anchorPopup(/** @type {HTMLElement} */ (element), anchor, { nextName: () => nextAnchorName(element.ownerDocument), offset: pxOf(element, '--ds-space-1', 4) });
    if (mine) state.anchor = /** @type {HTMLElement} */ (anchor);
  } else if (state.kind === 'menu') placeMenu(element, anchor);
  else placeList(element, anchor);
  return anchor;
}

/** The next anchor-name of a document, numbered across every copy of ds.js. */
function nextAnchorName(doc) {
  return `--ds-anchor-${sharedOf(doc).seq += 1}`;
}

/**
 * A menu by the script: below the trigger from its start edge, towards the
 * start edge (the trigger's end) when it would leave the viewport, above
 * the trigger when it does not fit below and there is more room above,
 * never taller than the room on its side; 8px (--ds-space-2) from the
 * viewport edges.
 */
function placeMenu(menu, anchor) {
  place(menu, anchor, { offset: pxOf(menu, '--ds-space-1', 4), padding: pxOf(menu, '--ds-space-2', 8), crossFlip: true, x: '--ds-menu-x', y: '--ds-menu-y' });
}

/**
 * The combobox list by the script: under its field; above it when it does
 * not fit below and there is more room above; never taller than the room
 * on its side, so it never covers the field. The room is the viewport's,
 * narrowed by every box around the field that clips its overflow (a
 * dialog's box, a sheet's body), since the absolute list cannot leave
 * them.
 */
function placeList(list, anchor) {
  const gap = pxOf(list, '--ds-space-1', 4);
  place(list, anchor, { offset: gap, padding: gap, shift: false, bounds: clippedBounds(list) });
}

/** Undoes placePopup() once a popup is hidden: out of the top layer, its anchor-name gone. */
function releasePopup(element, state) {
  dropProbe(element);
  if (element.hasAttribute('popover')) {
    try {
      if (element.matches(':popover-open')) /** @type {HTMLElement} */ (element).hidePopover();
    } catch {
      // Not open.
    }
    element.removeAttribute('popover');
  }
  element.removeAttribute('data-anchored');
  element.removeAttribute('data-placement');
  /** @type {HTMLElement} */ (element).style.removeProperty('position-anchor');
  /** @type {HTMLElement} */ (element).style.removeProperty('max-height');
  releaseAnchor(state.anchor);
  state.anchor = null;
  unwatchEdges(state);
}

/**
 * The cut edges of a menu or a combobox list: DS.dom.scrollEdges() on the
 * block axis of what scrolls (the menu, the list inside the popup) writes
 * data-ds-overflow-start / -end (the fallback of the scroll-driven fades)
 * and --ds-scrollbar-width (the strip the list's mask leaves opaque).
 * Watched from the open until the popup is hidden, then let go, so a list
 * the page replaces is not kept; a watch the page started itself is left
 * alone. A reopen measures again (the content may have changed).
 */
function watchEdges(element, state) {
  const scroller = state.kind === 'combo' ? element.querySelector('.ds-combo__list') ?? element : element;
  if (state.edges?.scroller === scroller) {
    state.edges.handle.update();
    return;
  }
  unwatchEdges(state);
  if (scroller.hasAttribute('data-ds-edges')) return;
  state.edges = { scroller, handle: scrollEdges(scroller, { axis: 'block' }) };
}

function unwatchEdges(state) {
  state.edges?.handle.destroy();
  state.edges = null;
}

/* ── Over a native modal ────────────────────────────── */

/**
 * The topmost open native dialog or sheet, unless it holds `element`
 * already. showModal() makes everything outside it inert, top-layer
 * popovers included, so an overlay opened over it must sit inside it.
 */
function nativeHostFor(element) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const other = stack[i];
    const state = overlays.get(other);
    if (other === element || state?.phase !== 'open' || !MODAL.has(state.kind) || !isNative(other) || !other.open) continue;
    return other.contains(element) ? null : other;
  }
  return null;
}

/**
 * A menu, popup, dialog or sheet (div or native) opened while a native
 * modal is open moves into it (still hidden or closed, so nothing shows
 * the move) and goes back once its close settled. It stays fixed to the
 * viewport there: the native element has no transform, and its overflow
 * does not clip fixed boxes. A native one needs it for its exit: its
 * close() at once makes the one under it the top modal again, which
 * would make the closing dialog inert (clicks on its scrim would reach
 * the sheet under it) and draw it under that top-layer sheet; inside it,
 * the closing dialog stays above the sheet's panel and keeps catching
 * clicks. A combobox list stays with its field, the drawer in its frame.
 */
function adopt(element, state) {
  if (state.home || !['menu', 'popup', 'dialog', 'sheet'].includes(state.kind)) return;
  // Moving an open <dialog> would close it: one the page opened itself stays.
  if (isNative(element) && element.open) return;
  const host = nativeHostFor(element);
  if (!host || !element.parentNode) return;
  state.home = { parent: element.parentNode, next: element.nextSibling, host, kept: keepAway(element) };
  host.append(element);
}

/**
 * Marks a node DS moves away from home with data-ds-keep, so a re-render of
 * the open dialog it sits in (DS.dom.morphHtml) never removes it; returns
 * whether DS set it (a page's own data-ds-keep stays).
 */
function keepAway(node) {
  if (!node || node.hasAttribute('data-ds-keep')) return false;
  node.setAttribute('data-ds-keep', '');
  return true;
}

/** Takes the data-ds-keep that keepAway() set off again. */
function keepHome(node, kept) {
  if (kept) node?.removeAttribute('data-ds-keep');
}

/** Puts an adopted overlay back where it was (it is hidden by then). */
function giveBack(element, state) {
  const home = state.home;
  state.home = null;
  if (home) keepHome(element, home.kept);
  if (!home || element.parentNode === home.parent) return;
  home.parent.insertBefore(element, home.next && home.next.parentNode === home.parent ? home.next : null);
}

/* ── Modal drawer ───────────────────────────────────── */

function drawerQuery(drawer) {
  const view = viewOf(drawer);
  return typeof view.matchMedia === 'function' ? view.matchMedia(DRAWER_QUERY) : null;
}

/** The latest crossing of each drawer (a later one keeps the class on). @type {WeakMap<Element, number>} */
const drawerCrossings = new WeakMap();

/**
 * Crossing 900px changes the drawer in place: .ds-drawer--instant for two
 * frames (no slide, no scrim fade), and a wider window closes a stale open
 * state at once.
 */
function crossDrawer(drawer, query) {
  const view = viewOf(drawer);
  const run = (drawerCrossings.get(drawer) ?? 0) + 1;
  drawerCrossings.set(drawer, run);
  const frame = (callback) => (typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(callback) : setTimeout(callback));
  drawer.classList.add('ds-drawer--instant');
  if (!query.matches) {
    const state = overlays.get(drawer);
    if (state && state.phase !== 'closed') closeNow(drawer, state);
  }
  frame(() => frame(() => {
    if (drawerCrossings.get(drawer) === run) drawer.classList.remove('ds-drawer--instant');
  }));
}

/**
 * Per window: its drawer query and the drawers watched in it, held weakly,
 * so a drawer the page dropped (a re-rendered frame) is not kept alive.
 * @type {WeakMap<object, { query: MediaQueryList, drawers: Set<WeakRef<Element>> }>}
 */
const drawerWatches = new WeakMap();

/**
 * A drawer's breakpoint listener (in its own window: a drawer in an iframe
 * too), from its first open() or close(): one listener per window crosses
 * every drawer watched there that is in the document. A drawer out of the
 * document is not crossed; its next open() reads the query again.
 */
function watchDrawer(drawer, query) {
  if (!query || watchedDrawers.has(drawer)) return;
  watchedDrawers.add(drawer);
  const drawers = drawerWatchOf(viewOf(drawer), query);
  for (const ref of [...drawers]) if (!ref.deref()) drawers.delete(ref);
  drawers.add(new WeakRef(drawer));
}

/**
 * The drawers of `view` that its one breakpoint listener crosses. A
 * function of its own: a listener made inside watchDrawer() would share
 * that call's scope and could keep its drawer alive.
 * @returns {Set<WeakRef<Element>>}
 */
function drawerWatchOf(view, query) {
  const known = drawerWatches.get(view);
  if (known) return known.drawers;
  const watch = { query, drawers: /** @type {Set<WeakRef<Element>>} */ (new Set()) };
  drawerWatches.set(view, watch);
  const onChange = () => {
    for (const ref of [...watch.drawers]) {
      const drawer = ref.deref();
      if (!drawer) watch.drawers.delete(ref);
      else if (drawer.isConnected) crossDrawer(drawer, watch.query);
    }
  };
  query.addEventListener?.('change', onChange);
  return watch.drawers;
}

/*
 * From load on, every drawer of the page frame crosses 900px in place,
 * also one DS.overlay never opened or closed (a page that drives the
 * drawer through DS.overlay needs no breakpoint snippet). A drawer with a
 * listener of its own (watchDrawer) is left to it, so none crosses twice.
 * Without a DOM (node) nothing happens.
 */
if (typeof globalThis.matchMedia === 'function' && typeof globalThis.document?.querySelectorAll === 'function') {
  const query = globalThis.matchMedia(DRAWER_QUERY);
  const onChange = () => {
    for (const drawer of globalThis.document.querySelectorAll('.ds-app > .ds-drawer')) {
      if (!watchedDrawers.has(drawer)) crossDrawer(drawer, query);
    }
  };
  query.addEventListener?.('change', onChange);
}

/** Closes the drawer without motion (the window widened): every bit of state goes at once. */
function closeNow(drawer, state) {
  const wasOpen = state.phase === 'open';
  state.gen += 1;
  state.closing = null;
  state.opening = null;
  state.phase = 'closed';
  (state.app ?? drawer.closest('.ds-app'))?.removeAttribute('data-drawer-open');
  state.expander?.setAttribute('aria-expanded', 'false');
  restoreInert(state);
  drawer.inert = false;
  finishClose(drawer, state);
  if (wasOpen) announceClose(drawer, 'breakpoint');
}

/* ── Open and close ─────────────────────────────────── */

/** Leaves the stack and the lock and lets go of its runtime state; shared by every end of a close. */
function finishClose(element, state) {
  const index = stack.indexOf(element);
  if (index >= 0) stack.splice(index, 1);
  leaveOrder(element);
  // What this overlay lifted from a lower trap is inert again.
  syncInert();
  if (state.locked) {
    state.locked = false;
    unlockScroll(state.lockedDoc ?? undefined);
    state.lockedDoc = null;
  }
  releaseClaims(state);
  state.app = null;
  unwatchRemovals(element.ownerDocument);
}

/* ── Overlays the page removed ──────────────────────── */

/** Per document: the observer that notices a removed overlay, connected while the stack holds anything. */
const removals = new WeakMap();

function watchRemovals(doc) {
  let watch = removals.get(doc);
  if (!watch) {
    const view = doc.defaultView ?? globalThis;
    if (typeof view.MutationObserver !== 'function') return;
    // A callback runs as a microtask: an overlay the code moved (adopt(),
    // a keyed morph) is in the document again by then.
    watch = { observer: new view.MutationObserver(pruneDetached), on: false };
    removals.set(doc, watch);
  }
  if (watch.on || !doc.documentElement) return;
  watch.on = true;
  watch.observer.observe(doc.documentElement, { childList: true, subtree: true });
}

function unwatchRemovals(doc) {
  const watch = removals.get(doc);
  if (!watch?.on || stack.some((element) => element.ownerDocument === doc)) return;
  watch.on = false;
  watch.observer.disconnect();
}

/**
 * dropDetached() when an overlay on the stack left the document; nodes the
 * page added beside an open div trap join it (refreshTraps()).
 * @param {MutationRecord[]} [records]
 */
function pruneDetached(records) {
  if (stack.some((element) => !element.isConnected)) dropDetached();
  const grown = records?.filter((record) => record.addedNodes.length).map((record) => record.target) ?? [];
  if (grown.length) refreshTraps(grown);
}

/**
 * An overlay the page removed while it was open or closing: closed at
 * once, without motion. Its lock, the inert of its trap, aria-expanded,
 * its runtime state and its Escape entry go, the snackbar regions it took
 * in go back to their place; focus is not moved. One that left only with
 * the native host adopt() moved it into goes back to its place too (DS
 * made the move, the page removed only the host), so it opens again. The
 * topmost first: giving back an outer overlay must not reconnect an inner
 * adopted one before it was handled.
 */
function dropDetached() {
  for (const element of stack.filter((item) => !item.isConnected).reverse()) {
    if (element.isConnected) continue;
    const state = overlays.get(element);
    if (!state) {
      stack.splice(stack.indexOf(element), 1);
      leaveOrder(element);
      continue;
    }
    const kind = state.kind;
    // A closing one told the page already, as the close started.
    const wasOpen = state.phase === 'open';
    dropProbe(element);
    // A pending exit's settled() callback no longer acts.
    state.gen += 1;
    state.phase = 'closed';
    state.closing = null;
    state.opening = null;
    state.container = null;
    const home = state.home;
    state.home = null;
    state.inerted = [];
    state.expander?.setAttribute('aria-expanded', 'false');
    // The frame the drawer opened in: a replaced drawer is outside it now.
    if (kind === 'drawer') (state.app ?? element.closest('.ds-app'))?.removeAttribute('data-drawer-open');
    else {
      if (isNative(element) && element.open) element.close();
      element.classList.remove('ds-dialog--closing', 'ds-sheet--closing');
      if (!isNative(element)) {
        if (state.hiddenClass) element.classList.add(state.hiddenClass);
        else /** @type {HTMLElement} */ (element).hidden = true;
      }
      if (kind === 'menu' || kind === 'combo') releasePopup(element, state);
      element.removeAttribute('data-state');
    }
    if (kind === 'dialog' || kind === 'sheet') parts.toast?.release(element);
    boxOf(element, kind).inert = false;
    element.classList.remove('ds-dialog--nested');
    // Carried out inside the host DS moved it into: back home, hidden.
    if (home && home.host?.contains(element) && home.parent.isConnected) {
      state.home = home;
      giveBack(element, state);
    } else if (home) keepHome(element, home.kept);
    finishClose(element, state);
    if (wasOpen) announceClose(element, 'removed');
  }
}

/**
 * Opens an overlay: a dialog or side sheet (native <dialog> or div
 * markup), the modal drawer, or a popup (.ds-menu, .ds-combo__popup).
 * `opener` (default: the focused element) gets focus back on close; a
 * popup's opener (and the drawer's menu button) carries aria-expanded.
 * Focus moves at once to [autofocus], else the first focusable element
 * (a menu: its first enabled item; a combobox keeps focus in its input;
 * the drawer: itself). A close in progress is taken back from where its
 * motion is. Resolves when the entrance has settled. A dialog's or
 * sheet's .ds-dialog__body / .ds-sheet__body is watched on its first open
 * (DS.dom.watchScrolled(): data-scrolled on the box or panel), so the
 * page needs no recipe for the scrolled hairline.
 *
 * `container: true` (a closed dialog or side sheet, with View Transitions
 * and .ds-theme on <html>): the opener grows into the box or panel as a
 * container transform (DS.motion.transition()); the open, focus included,
 * runs a frame later inside the transition's update, and the promise
 * resolves once the transform finished. The page is frozen meanwhile
 * (--ds-dur-long; a press skips the motion), so use it only where the overlay is the opener's own
 * detail. Ignored elsewhere: the usual entrance.
 * @param {Element} element
 * @param {{ opener?: Element|null, container?: boolean }} [options]
 * @returns {Promise<void>}
 */
export function open(element, options = {}) {
  if (!element?.isConnected) return Promise.resolve();
  if (options.container) {
    const transform = containerOpen(element, options);
    if (transform) return transform;
  }
  return show(element, options, false);
}

/** The parts that keep no view-transition-name during a container open (see containerOpen). */
const UNNAMED_IN_CONTAINER = '.ds-view, .ds-panel, .ds-drawer';

/**
 * open() as a container transform, or null where it cannot run: only a
 * closed dialog or sheet, an opener on the page, View Transitions and
 * .ds-theme on <html> (the conditions of DS.motion.transition()'s View
 * Transition path). The page frame (shell.css names it while data-ds-vt
 * is set) and the overlay's sheet body keep no name meanwhile: every group
 * paints above the root, where the scrim is, and a body named apart would
 * not grow with its panel.
 */
function containerOpen(element, options) {
  const doc = element.ownerDocument;
  const state = stateOf(element);
  if (state.kind !== 'dialog' && state.kind !== 'sheet') return null;
  if (state.phase !== 'closed' || state.container) return state.container?.done ?? null;
  const viewTransitions = typeof doc.startViewTransition === 'function' && doc.documentElement.classList.contains('ds-theme');
  if (!viewTransitions) return null;
  const opener = options.opener ?? defaultOpener(element);
  if (!opener?.isConnected || typeof opener.getBoundingClientRect !== 'function') return null;

  const lifted = new Map();
  for (const part of [...doc.querySelectorAll(UNNAMED_IN_CONTAINER), ...element.querySelectorAll('.ds-sheet__body')]) {
    lifted.set(part, part.style.getPropertyValue('view-transition-name'));
    part.style.setProperty('view-transition-name', 'none');
  }
  const restore = () => {
    for (const [part, before] of lifted) {
      if (part.style.getPropertyValue('view-transition-name') !== 'none') continue;
      if (before) part.style.setProperty('view-transition-name', before);
      else part.style.removeProperty('view-transition-name');
    }
  };

  const pending = { done: /** @type {Promise<void>|null} */ (null) };
  state.container = pending;
  let entrance = Promise.resolve();
  const update = () => {
    // A close() (or a plain open()) before the snapshot took over.
    const current = state.container === pending;
    if (current) state.container = null;
    if (!current || !element.isConnected) return null;
    // Inside the View Transition data-ds-vt is "container"; were it
    // refused, the update runs bare, and an opener that its scroller clips
    // (a row of a wide table, a card partly scrolled under the top bar)
    // made it a fade-through: the overlay plays its usual entrance.
    const transform = doc.documentElement.getAttribute('data-ds-vt') === 'container';
    entrance = show(element, { ...options, opener }, transform);
    return transform ? boxOf(element, state.kind) : null;
  };
  pending.done = transition(update, { type: 'container', from: opener }).then(
    () => { restore(); return entrance; },
    (error) => { restore(); throw error; },
  );
  return pending.done;
}

/** Keeps what finds the opener again: its id and root (for a twin after a re-render) and the page's returnTo. */
function remember(state, options) {
  const opener = state.opener;
  state.openerId = typeof opener?.id === 'string' ? opener.id : '';
  state.openerRoot = state.openerId ? opener.getRootNode?.() ?? opener.ownerDocument : null;
  state.returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
}

/**
 * The open itself. `transform`: the container transform plays the motion,
 * so the overlay takes its open state at once (shown straight into
 * data-state="open": nothing to transition from).
 */
function show(element, options, transform) {
  const doc = element.ownerDocument;
  const state = stateOf(element);
  state.container = null;
  const kind = state.kind;
  const box = boxOf(element, kind);
  const app = kind === 'drawer' ? element.closest('.ds-app') : null;
  if (kind === 'drawer') {
    const query = drawerQuery(element);
    watchDrawer(element, query);
    if (query && !query.matches) return Promise.resolve();
  }
  if (!warned && !element.closest('.ds-theme')) {
    warned = true;
    viewOf(element).console?.warn('Z-Dash: DS.overlay.open() on an element outside .ds-theme. Overlays must sit inside the .ds-theme element, or they get neither the tokens nor the motion.');
  }
  if (kind === 'menu' || kind === 'dialog') warnMissingPart(element, kind);
  for (const tip of tooltipControllers) tip.hide();
  if (state.phase === 'open') return state.opening ?? Promise.resolve();
  pruneDetached();
  listen(doc);
  wire(element, state);
  if (kind === 'dialog' || kind === 'sheet') watchBodies(element);
  let reopening = state.phase === 'closing';
  // Reopened mid-exit from another trigger (one menu for every row): the
  // placement, origin, aria-expanded and claims belong to the previous
  // trigger, so it opens afresh from the new one.
  if (reopening && (kind === 'menu' || kind === 'combo' || kind === 'popup') && options.opener && options.opener !== state.opener) {
    if (kind !== 'popup') releasePopup(element, state);
    reopening = false;
  }
  const gen = ++state.gen;
  state.closing = null;
  state.phase = 'open';

  if (!reopening) {
    const focused = defaultOpener(element);
    const menuButton = app?.querySelector('.ds-topbar__menu') ?? null;
    state.opener = options.opener ?? (kind === 'drawer' ? menuButton ?? focused : focused);
    // A dialog's or sheet's opener says expanded only when its markup asks for it.
    const expands = Boolean(state.opener?.hasAttribute?.('aria-expanded'));
    state.expander = kind === 'drawer' ? menuButton ?? state.opener : MODAL.has(kind) ? (expands ? state.opener : null) : state.opener;
    remember(state, options);
    // Until its close settled, a live re-render (DS.dom.morphHtml) keeps
    // what this module writes on the overlay, its box, opener and frame.
    releaseClaims(state);
    for (const key of /** @type {const} */ (['attrs', 'classes', 'props'])) claim(state, element, key, PANEL_STATE[key]);
    claim(state, box, 'attrs', ['inert']);
    claim(state, state.expander, 'attrs', ['aria-expanded']);
    claim(state, app, 'attrs', ['data-drawer-open']);
    // Kept: a drawer the page replaced is no longer inside its frame.
    state.app = app;
  } else if (options.opener) {
    state.opener = options.opener;
    remember(state, options);
  }
  state.shownAt = clock();
  state.pressed = null;

  // A contained dialog covers its container in a panel (an embedded
  // widget): it traps only there and takes no scroll lock.
  const contained = kind === 'dialog' && containedDialog(element);
  // The stack: a reopened overlay moves to the top again.
  const index = stack.indexOf(element);
  if (index >= 0) stack.splice(index, 1);
  if (MODAL.has(kind)) {
    if (!state.locked && !contained) {
      state.locked = true;
      state.lockedDoc = doc;
      lockScroll(doc);
    }
    if (kind === 'dialog') {
      const nested = !contained && stack.some((other) => MODAL.has(overlays.get(other)?.kind ?? '') && overlays.get(other)?.phase === 'open' && !containedDialog(other));
      element.classList.toggle('ds-dialog--nested', nested);
    }
  }
  stack.push(element);
  enterOrder(element);
  watchRemovals(doc);
  // Over a native modal, it goes inside it, or it would be inert.
  if (!reopening) adopt(element, state);

  // The closed state first, so a native dialog shown by showModal() never
  // matches the hand-driven rules (their @starting-style) on the way.
  if (kind !== 'drawer' && !reopening) element.setAttribute('data-state', transform ? 'open' : 'closed');

  // Show it and take the page away.
  if (kind === 'drawer') {
    app?.setAttribute('data-drawer-open', '');
    element.inert = false;
    if (!state.inerted.length) state.inerted = inertOutside(element);
  } else if (isNative(element) && MODAL.has(kind)) {
    element.classList.remove('ds-dialog--closing', 'ds-sheet--closing');
    if (!element.open) keepFocusVisibility(element, () => element.showModal());
    // The snackbars of the theme come in: into the top layer with it.
    parts.toast?.host(element, 'enter');
  } else {
    if (/** @type {HTMLElement} */ (element).hidden) /** @type {HTMLElement} */ (element).hidden = false;
    for (const name of ['ds-dialog--hidden', 'ds-sheet--hidden']) {
      if (element.classList.contains(name)) {
        element.classList.remove(name);
        state.hiddenClass = name;
      }
    }
    // The snackbars come in before the page turns inert, so they never are.
    if (kind === 'dialog' || kind === 'sheet') parts.toast?.host(element, 'enter');
    if (MODAL.has(kind) && !state.inerted.length) state.inerted = inertOutside(element, contained ? containerOf(element) : undefined);
  }
  // A lower trap may have taken this overlay (or a box around it) as a
  // sibling: the stack lifts that, since this one is above it now.
  syncInert();
  box.inert = false;

  // Closed -> flush -> open: the entrance runs on transitions in every engine.
  if (kind !== 'drawer') {
    if (reopening) {
      element.setAttribute('data-state', 'open');
      if (kind === 'menu' || kind === 'combo') watchEdges(element, state);
    } else if (kind === 'menu' || kind === 'combo') {
      // A popup is placed and measured at rest size (the closed state's
      // scale would shrink its box), then takes its closed state without a
      // transition, and grows from the trigger.
      element.setAttribute('data-state', 'closed');
      const style = /** @type {HTMLElement} */ (element).style;
      style.setProperty('transition', 'none');
      style.setProperty('scale', 'none');
      const anchor = placePopup(element, state);
      const trigger = state.opener && typeof state.opener.getBoundingClientRect === 'function' ? state.opener : anchor;
      if (trigger) originFrom(trigger, element);
      style.removeProperty('scale');
      flushStyle(element);
      style.removeProperty('transition');
      element.setAttribute('data-state', 'open');
      watchEdges(element, state);
    } else if (!transform) {
      element.setAttribute('data-state', 'closed');
      flushStyle(box);
      if ((kind !== 'sheet') && state.opener && typeof state.opener.getBoundingClientRect === 'function') originFrom(state.opener, box);
      element.setAttribute('data-state', 'open');
    }
  }

  keepFocusVisibility(element, () => focusInto(element, state, box));
  state.expander?.setAttribute('aria-expanded', 'true');

  const entrance = settled(box, { transitions: true }).then(() => {
    if (state.gen === gen) state.opening = null;
  });
  state.opening = entrance;
  if (typeof viewOf(element).CustomEvent === 'function') emit(element, 'open', { opener: state.opener ?? null });
  return entrance;
}

/**
 * Closes an overlay that open() showed, in the documented order: the trap
 * goes and focus is on the opener at once, the box or panel turns inert,
 * data-state="closed" plays the exit, and once it settled the overlay is
 * hidden and leaves the lock and the Escape stack. A second call during
 * the exit returns the same promise; an open() meanwhile takes it back.
 * `reason` (default 'api') is what the ds:close event says; it also closes
 * a busy overlay (data-ds-busy refuses only the user's attempts).
 * @param {Element} element
 * @param {{ reason?: string }} [options]
 * @returns {Promise<void>}
 */
export function close(element, options = {}) {
  if (!element) return Promise.resolve();
  // A container open still waiting for its snapshot does not open.
  const pending = overlays.get(element);
  if (pending?.container) pending.container = null;
  if (element.matches('.ds-drawer')) watchDrawer(element, drawerQuery(element));
  return closeFrom(element, 'api', typeof options.reason === 'string' && options.reason ? options.reason : 'api');
}

/**
 * The topmost open layer of the page (`doc`): a dialog, side sheet, the
 * modal drawer, a menu, a combobox list or a contained dialog, whichever
 * copy of ds.js (1.6.1 and later) opened it; null when none is open or
 * without a DOM. A layer that is closing no longer counts.
 * @param {Document} [doc]
 * @returns {Element|null}
 */
export function topmost(doc = globalThis.document) {
  if (!doc) return null;
  pruneDetached();
  const order = doc[SHARED]?.order ?? [];
  for (let i = order.length - 1; i >= 0; i -= 1) if (order[i].open()) return order[i].element;
  return null;
}

/**
 * The open layer over `node`: the topmost open overlay of its page when
 * `node` lies outside it (a menu over the button that opened it), else
 * null. A contained dialog lies only over its container. A tooltip whose
 * trigger is under such a layer leaves Escape to the layer.
 * @param {Element} node
 * @returns {Element|null}
 */
function layerOver(node) {
  const top = topmost(node.ownerDocument);
  if (!top || composedContains(top, node)) return null;
  if (containedDialog(top) && !composedContains(containerOf(top), node)) return null;
  return top;
}

/**
 * The open layer that rules where `node` is: the topmost open overlay, past
 * any contained dialog `node` lies outside the container of (the page around
 * it stays live, so a modal below one still counts). `node` may sit inside
 * the layer it gets. Null when none rules there, or without a DOM.
 * @param {Node|null|undefined} node
 * @param {Document} [doc]
 * @returns {Element|null}
 */
export function layerAt(node, doc = node?.ownerDocument ?? globalThis.document) {
  if (!doc) return null;
  pruneDetached();
  const order = doc[SHARED]?.order ?? [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const { element } = order[i];
    if (!order[i].open()) continue;
    if (containedDialog(element) && !composedContains(containerOf(element), node)) continue;
    return element;
  }
  return null;
}

/**
 * Whether `node` opened a layer that is open now (a menu button while its
 * menu shows), in any copy of ds.js that records openers (2.1.1 and
 * later): its tooltip would sit over or beside that layer and take its
 * Escape, so it does not show.
 * @param {Element} node
 * @returns {boolean}
 */
function opensOpenLayer(node) {
  pruneDetached();
  const order = node.ownerDocument?.[SHARED]?.order ?? [];
  return order.some((entry) => entry.open() && entry.opener?.() === node);
}

/** Tells the page why an overlay closed (once per close, after its state turned closed). */
function announceClose(element, reason) {
  emit(element, 'close', { reason });
}

/**
 * close() by its cause, which steers focus and the busy guard: 'api' (a
 * call), 'close' ([data-ds-close]), 'backdrop' (the backdrop or the drawer's
 * scrim), 'escape', 'native' (the native dialog closed itself), 'parent'
 * (the overlay around it closes), 'item' (a menu item ran), 'tab' (a menu;
 * focus is on the trigger already) or 'outside' (a pointerdown outside a
 * menu: focus stays where the pointer puts it). `reason` is what ds:close
 * tells (by default the cause).
 */
function closeFrom(element, cause, reason = cause) {
  const state = overlays.get(element);
  if (!state || state.phase === 'closed') return Promise.resolve();
  if (state.phase === 'closing') return state.closing ?? Promise.resolve();
  // Removed from the document by the page: closed at once.
  if (!element.isConnected) {
    dropDetached();
    return Promise.resolve();
  }
  const kind = state.kind;
  // Busy (data-ds-busy, set by the page while its action runs): the user's
  // attempts change nothing, not even the popups inside.
  if (MODAL.has(kind) && USER_CLOSE.has(cause) && element.hasAttribute('data-ds-busy')) return Promise.resolve();
  const box = boxOf(element, kind);
  const doc = element.ownerDocument;
  if (MODAL.has(kind)) {
    // What floats over it goes with it: a tooltip, and a menu or list
    // opened inside it (or from a trigger inside it), the topmost first,
    // so none stays open, marked expanded or on the Escape stack.
    for (const tip of tooltipControllers) tip.hide();
    for (const other of [...stack].reverse()) {
      const inner = overlays.get(other);
      if (other === element || inner?.phase !== 'open') continue;
      if (element.contains(other) || (!MODAL.has(inner.kind) && element.contains(inner.opener))) closeFrom(other, 'parent');
    }
  }
  const gen = ++state.gen;
  state.phase = 'closing';
  state.opening = null;
  const active = activeIn(element);
  const focusInside = Boolean(active) && (element.contains(active) || active === doc.body);

  // 1. Release the trap.
  if (kind === 'drawer') (state.app ?? element.closest('.ds-app'))?.removeAttribute('data-drawer-open');
  if (isNative(element) && MODAL.has(kind)) {
    element.classList.add(kind === 'sheet' ? 'ds-sheet--closing' : 'ds-dialog--closing');
    if (element.open) keepFocusVisibility(element, () => element.close());
  }
  restoreInert(state);

  // 2. Focus back on the opener at once.
  state.expander?.setAttribute('aria-expanded', 'false');
  const returns = MODAL.has(kind) ? focusInside : cause !== 'outside' && element.contains(activeIn(element));
  if (returns) keepFocusVisibility(element, () => returnTarget(element, state)?.focus({ preventScroll: true }));
  // The snackbars glide back to their place (from a sheet, with the
  // leaving panel) and stay inside it, above its scrim, until it settled.
  if (kind === 'dialog' || kind === 'sheet') parts.toast?.host(element, 'exit');

  // 3. Only the box or panel stops taking input; the backdrop swallows clicks.
  box.inert = true;

  // 4. The exit.
  if (kind !== 'drawer') element.setAttribute('data-state', 'closed');

  // 5., 6. Hide once it settled, all in one task.
  const exit = settled(box, { transitions: true }).then(() => {
    if (state.gen !== gen) return;
    state.phase = 'closed';
    state.closing = null;
    // Back to the page before it hides; they already stand at their place.
    if (kind === 'dialog' || kind === 'sheet') parts.toast?.host(element, 'settle');
    if (kind !== 'drawer') {
      if (isNative(element) && MODAL.has(kind)) {
        // display: none is computed while data-state still holds; the
        // hand-driven rules (no data-state) would step display late and
        // keep the finished dialog on screen, catching clicks, for one
        // more exit time.
        element.classList.remove('ds-dialog--closing', 'ds-sheet--closing');
        flushStyle(element);
      } else if (state.hiddenClass) element.classList.add(state.hiddenClass);
      else /** @type {HTMLElement} */ (element).hidden = true;
      if (kind === 'menu' || kind === 'combo') releasePopup(element, state);
      element.removeAttribute('data-state');
    }
    box.inert = false;
    element.classList.remove('ds-dialog--nested');
    giveBack(element, state);
    finishClose(element, state);
  });
  state.closing = exit;
  // Why it closed, once, as soon as the close started (a listener sees
  // focus back on the opener and the overlay closing).
  announceClose(element, reason);
  return exit;
}

/* ── Shared helpers of snackbars and tooltips ───────── */

/** Text as compared: whitespace collapsed, trimmed, lower case. */
const normalText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** A monotonic clock in ms. */
const clock = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());

/** --ds-time-scale on the element (10 at ?speed=0.1); 1 outside a theme. */
function timeScaleOf(element) {
  if (!element?.closest?.('.ds-theme')) return 1;
  const value = parseFloat(viewOf(element).getComputedStyle?.(element).getPropertyValue('--ds-time-scale') ?? '');
  return value > 0 ? value : 1;
}

/** Runs `callback` on the next frame, or in the next task where frames do not run (a hidden tab). */
function nextFrame(doc, callback) {
  const view = doc.defaultView ?? globalThis;
  if (doc.hidden || typeof view.requestAnimationFrame !== 'function') setTimeout(callback);
  else view.requestAnimationFrame(callback);
}

/* ── Save bar ───────────────────────────────────────── */

/** The controller of each save bar element. @type {WeakMap<Element, object>} */
const savebars = new WeakMap();

let savebarWarned = false;

/**
 * The save bar of a view: unsaved edits, saved or discarded together.
 * `element` is the .ds-savebar (or its .ds-savebar__bar, a .ds-presence
 * with `hidden`); one controller per element, a second call returns it.
 *
 * show() drops `hidden` (the .ds-presence entrance plays), measures the
 * bar into --ds-savebar-height and sets data-ds-savebar on the .ds-view
 * (its scroll padding and the content's end keep clear of the bar), lifts
 * every snackbar region of its theme that no open overlay hosts above it
 * (--ds-toast-lift, the messages glide), and scrolls the view so the
 * focused element is not covered (WCAG 2.4.11). hide() moves focus inside
 * the bar to `focusTarget()` (else the view), makes the bar inert while it
 * leaves, sets `hidden`, takes the lift back and, when the view was at its
 * end, keeps its room (data-ds-savebar-rest) until the page scrolls away
 * from the end, so nothing jumps. update(fn) runs `fn` at once, or after
 * the exit while the bar is leaving (a text that changes only once it is
 * gone). A ResizeObserver measures again while it shows. What it writes is
 * owned (Symbol.for('ds.owned')), so a re-render keeps it. Outside a
 * .ds-view it warns once and only shows and hides.
 * @param {Element} element
 * @param {{ focusTarget?: () => Element|null|undefined }} [options]
 * @returns {{ element: Element, show: () => void, hide: () => void, update: (fn: () => void) => void, readonly shown: boolean, destroy: () => void }}
 */
export function savebar(element, options = {}) {
  const existing = savebars.get(element);
  if (existing) return existing;
  const doc = element.ownerDocument;
  const view = viewOf(element);
  const bar = /** @type {HTMLElement} */ (element.matches('.ds-savebar__bar') ? element : element.querySelector('.ds-savebar__bar') ?? element);
  const wrapper = /** @type {HTMLElement|null} */ (bar.closest('.ds-savebar'));
  const scroller = /** @type {HTMLElement|null} */ ((wrapper ?? bar).closest('.ds-view'));
  if (!scroller && !savebarWarned) {
    savebarWarned = true;
    view.console?.warn('Z-Dash: DS.overlay.savebar() outside .ds-view. The bar shows and hides, but no view keeps room for it or scrolls focus clear of it.');
  }
  let shown = false;
  let gen = 0;
  let height = 0;
  let leaving = /** @type {Promise<void>|null} */ (null);
  const pending = /** @type {Array<() => void>} */ ([]);
  let observer = /** @type {ResizeObserver|null} */ (null);
  let resting = false;
  let restRoom = 0;
  const gap = () => pxOf(bar, '--ds-space-2', 8);
  const offset = () => parseFloat(view.getComputedStyle?.(bar).bottom ?? '') || 0;

  /** Where the bar's top edge rests, in viewport px (its entrance scale aside). */
  const barTop = () => (wrapper ? wrapper.getBoundingClientRect().bottom - offset() : bar.getBoundingClientRect().bottom) - height;

  const entry = {
    element: bar,
    /** How far `region` rises to sit --ds-space-2 above the bar. */
    lift(region) {
      const style = view.getComputedStyle?.(region);
      if (!style) return 0;
      const lifted = parseFloat(/** @type {HTMLElement} */ (region).style.getPropertyValue('--ds-toast-lift')) || 0;
      const floor = (doc.documentElement.clientHeight || view.innerHeight) - ((parseFloat(style.bottom) || 0) - lifted) - (parseFloat(style.marginBottom) || 0);
      const top = barTop();
      // A bar that ends above the stack (a view that does not reach the
      // bottom edge) is not in its way.
      if (top + height <= floor - /** @type {HTMLElement} */ (region).offsetHeight) return 0;
      return Math.max(0, floor - (top - gap()));
    },
  };

  for (const name of ['hidden', 'inert']) own(bar, 'attrs', name);
  if (scroller) {
    for (const name of ['data-ds-savebar', 'data-ds-savebar-rest']) own(scroller, 'attrs', name);
    own(scroller, 'props', '--ds-savebar-height');
  }

  /** The snackbar regions of the bar's theme that sit on the page (no open overlay hosts them). */
  function regions() {
    const theme = bar.closest('.ds-theme');
    const scope = theme ?? doc;
    return [...scope.querySelectorAll('.ds-toasts')].filter((region) => (!theme || region.closest('.ds-theme') === theme) && !parts.toast?.hosted(region));
  }

  function measure() {
    height = bar.offsetHeight;
    scroller?.style.setProperty('--ds-savebar-height', `${round(height)}px`);
  }

  function flush() {
    while (pending.length) {
      const fn = /** @type {() => void} */ (pending.shift());
      try {
        fn();
      } catch (error) {
        report(bar, error);
      }
    }
  }

  function onScroll() {
    if (!scroller || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop >= restRoom) stopRest();
  }

  /** Hidden at the end of the page: the room stays until the page scrolls away from the end. */
  function startRest() {
    if (!scroller) return;
    restRoom = height + offset() + gap();
    resting = true;
    scroller.setAttribute('data-ds-savebar-rest', '');
    scroller.addEventListener('scroll', onScroll, { passive: true });
  }

  function stopRest() {
    if (!resting || !scroller) return;
    resting = false;
    scroller.removeEventListener('scroll', onScroll);
    scroller.removeAttribute('data-ds-savebar-rest');
    if (!shown) scroller.style.removeProperty('--ds-savebar-height');
  }

  /** The focused element of the view, if the bar covers it, scrolls clear (scroll-padding-bottom does the rest). */
  function keepClear() {
    const active = scroller ? activeIn(scroller) : null;
    if (!active || active === scroller || !scroller?.contains(active) || bar.contains(active) || typeof active.scrollIntoView !== 'function') return;
    if (active.getBoundingClientRect().bottom > barTop() - gap()) active.scrollIntoView({ block: 'nearest' });
  }

  function show() {
    if (shown) return;
    shown = true;
    gen += 1;
    // A hide taken back: its exit turns back, and what waited for it runs now.
    leaving = null;
    flush();
    stopRest();
    bar.inert = false;
    bar.hidden = false;
    measure();
    scroller?.setAttribute('data-ds-savebar', '');
    shownSavebars.add(entry);
    for (const region of regions()) parts.toast?.lift(region);
    const Observer = view.ResizeObserver;
    if (!observer && typeof Observer === 'function') {
      observer = new Observer(() => {
        if (!shown || bar.offsetHeight === height) return;
        measure();
        for (const region of regions()) parts.toast?.lift(region);
      });
      observer.observe(bar);
    }
    keepClear();
  }

  function hide() {
    if (!shown) return;
    shown = false;
    const mine = ++gen;
    if (bar.contains(activeIn(bar))) {
      // A page callback that throws is reported; the bar still hides.
      let target = null;
      try {
        target = options.focusTarget?.() ?? null;
      } catch (error) {
        report(bar, error);
      }
      const fallback = scroller ?? doc.querySelector(LANDMARK);
      const next = [target, fallback].find((node) => canFocus(node) && !bar.contains(node));
      next?.focus({ preventScroll: true });
    }
    const atEnd = Boolean(scroller) && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
    observer?.disconnect();
    observer = null;
    bar.inert = true;
    bar.hidden = true;
    shownSavebars.delete(entry);
    for (const region of regions()) parts.toast?.lift(region);
    if (scroller) {
      scroller.removeAttribute('data-ds-savebar');
      if (atEnd) startRest();
      else scroller.style.removeProperty('--ds-savebar-height');
    }
    leaving = settled(bar, { transitions: true }).then(() => {
      if (mine !== gen) return;
      leaving = null;
      bar.inert = false;
      flush();
    });
  }

  const handle = {
    element,
    show,
    hide,
    /** @param {() => void} fn */
    update(fn) {
      if (typeof fn !== 'function') return;
      if (leaving) pending.push(fn);
      else fn();
    },
    get shown() {
      return shown;
    },
    destroy() {
      gen += 1;
      observer?.disconnect();
      observer = null;
      leaving = null;
      pending.length = 0;
      stopRest();
      if (shownSavebars.delete(entry)) for (const region of regions()) parts.toast?.lift(region);
      bar.inert = false;
      for (const name of ['hidden', 'inert']) disown(bar, 'attrs', name);
      if (scroller) {
        scroller.removeAttribute('data-ds-savebar');
        scroller.style.removeProperty('--ds-savebar-height');
        for (const name of ['data-ds-savebar', 'data-ds-savebar-rest']) disown(scroller, 'attrs', name);
        disown(scroller, 'props', '--ds-savebar-height');
      }
      savebars.delete(element);
    },
  };
  savebars.set(element, handle);
  // A bar that shows from the start is shown: the view keeps its room.
  if (!bar.hidden) {
    bar.hidden = true;
    show();
  }
  return handle;
}

/* ── The functions of DS.overlay in the component folders ── */

/**
 * Asks with a built dialog (components/dialog/dialog.js).
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
export function confirm(options = {}) {
  return partFor('dialog', 'confirm').confirm(options);
}

/**
 * Tells something with a built alertdialog (components/dialog/dialog.js).
 * @param {object} [options]
 * @returns {Promise<void>}
 */
export function alert(options = {}) {
  return partFor('dialog', 'alert').alert(options);
}

/**
 * Asks for one value with a built dialog (components/dialog/dialog.js).
 * @param {object} [options]
 * @returns {Promise<string|null>}
 */
export function prompt(options = {}) {
  return partFor('dialog', 'prompt').prompt(options);
}

/**
 * The page's snackbar region (components/toast/toast.js).
 * @param {Document} [doc]
 * @returns {HTMLElement|null}
 */
export function toastRegion(doc = globalThis.document) {
  return partFor('toast', 'toastRegion').toastRegion(doc);
}

/**
 * Says a text to screen readers without a message (components/toast/toast.js).
 * @param {string} text
 * @param {{ assertive?: boolean, region?: Element|null }} [options]
 */
export function announce(text, options = {}) {
  return partFor('toast', 'announce').announce(text, options);
}

/**
 * Shows a snackbar (components/toast/toast.js).
 * @param {Element|null} region
 * @param {Element|string} content
 * @param {object} [options]
 * @returns {{ el: HTMLElement|null, close: () => Promise<void>, closed: Promise<void> }}
 */
export function toast(region, content, options = {}) {
  return partFor('toast', 'toast').toast(region, content, options);
}

/**
 * Closes snackbars by kind or key (components/toast/toast.js).
 * @param {Element|null} [region]
 * @param {{ kind?: 'success'|'error'|'info', key?: string }} [filter]
 * @returns {Promise<void>}
 */
export function closeToasts(region, filter = {}) {
  return partFor('toast', 'closeToasts').closeToasts(region, filter);
}

/**
 * Tooltips for every [data-tip] inside `root` (components/tooltip/tooltip.js).
 * @param {Document|Element|ShadowRoot} [root]
 * @returns {{ destroy: () => void }}
 */
export function tooltips(root = globalThis.document) {
  return partFor('tooltip', 'tooltips').tooltips(root);
}

/* ── Triggers and controllers ───────────────────────── */

/** The overlay a trigger's value names: a selector, or an id without its #. */
function targetOf(trigger, value) {
  const scope = trigger.getRootNode?.() ?? trigger.ownerDocument;
  let found = null;
  try {
    found = scope.querySelector(value);
  } catch {
    // No selector: an id.
  }
  return found ?? scope.getElementById?.(value) ?? null;
}

/**
 * Whether `element` is open through this core, and not on its way out.
 * @param {Element} element
 * @returns {boolean}
 */
function isOpen(element) {
  return overlays.get(element)?.phase === 'open';
}

/*
 * [data-ds-open] and [data-ds-close] (see the header): one delegated
 * listener per root of DS.core.init(). A button that opens a menu also opens
 * it from its arrow keys, and closes it from a click; the second click of a
 * double click toggles nothing.
 */
define('triggers', {
  global(root) {
    const onClick = (/** @type {MouseEvent} */ event) => {
      if (event.defaultPrevented || event.detail > 1) return;
      const trigger = /** @type {Element} */ (event.target)?.closest?.('[data-ds-open], [data-ds-close]');
      if (!trigger) return;
      const opens = trigger.getAttribute('data-ds-open');
      if (opens) {
        const target = targetOf(trigger, opens);
        if (!target) return;
        if (isOpen(target) && overlays.get(target)?.opener === trigger) closeFrom(target, 'close');
        else open(target, { opener: trigger });
        return;
      }
      const closes = trigger.getAttribute('data-ds-close');
      const target = closes ? targetOf(trigger, closes) : null;
      if (target && isOpen(target)) closeFrom(target, 'close');
    };
    const onKeyDown = (/** @type {KeyboardEvent} */ event) => {
      if (event.defaultPrevented || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
      const trigger = /** @type {Element} */ (event.target)?.closest?.('[data-ds-open]');
      const target = trigger ? targetOf(trigger, trigger.getAttribute('data-ds-open') ?? '') : null;
      if (!target?.matches('.ds-menu') || isOpen(target)) return;
      event.preventDefault();
      open(target, { opener: trigger });
    };
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyDown);
    return () => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown);
    };
  },
});

/**
 * The controller of a dialog, side sheet or menu: get() says whether it is
 * open, set(true|false, options) opens or closes it, on('open'|'close', fn)
 * hears its ds: events and returns the unsubscribe.
 * @param {Element} element
 * @returns {{ element: Element, get: () => boolean, set: (value: boolean, options?: object) => Promise<void>, on: (type: string, fn: (event: Event) => void) => () => void, destroy: () => void }}
 */
function controllerOf(element) {
  const listeners = /** @type {Array<() => void>} */ ([]);
  return {
    element,
    get: () => isOpen(element),
    set: (value, options) => (value ? open(element, options) : close(element, options)),
    on(type, fn) {
      const name = `ds:${type}`;
      element.addEventListener(name, fn);
      const off = () => element.removeEventListener(name, fn);
      listeners.push(off);
      return off;
    },
    destroy() {
      for (const off of listeners.splice(0)) off();
    },
  };
}

/**
 * What the modules of the component folders read: no API, may change in any
 * release (see the header). use(name, part) registers one, once per copy of
 * this module.
 */
export const internals = Object.freeze({
  overlays,
  stack,
  tooltipControllers,
  neverInert,
  shownSavebars,
  LANDMARK,
  activeIn,
  inside,
  sharedOf,
  own,
  disown,
  viewOf,
  flushStyle,
  canFocus,
  report,
  watchModality,
  composedContains,
  keepAway,
  keepHome,
  closeFrom,
  layerOver,
  opensOpenLayer,
  arrowTarget,
  topOpen,
  nextAnchorName,
  placeMenu,
  isOpen,
  controllerOf,
  clock,
  normalText,
  timeScaleOf,
  nextFrame,
  part: (name) => parts[name] ?? null,
  use(name, part) {
    parts[name] ??= part;
    pageParts[name] ??= part;
  },
});
