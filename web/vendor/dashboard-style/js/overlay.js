/**
 * Overlays (D18): the dialog, the side sheet, the modal drawer and the
 * popups (.ds-menu, .ds-combo__popup) open and close through one pair of
 * calls, so focus, inertness, Escape and the scroll lock behave the same
 * everywhere.
 *
 *   DS.overlay.open(dialog, { opener: button });   // a Promise: the entrance settled
 *   DS.overlay.close(dialog);                      // a Promise: hidden again
 *   DS.overlay.close(dialog, { reason: 'confirm' }); // why: the ds-close event says it
 *   DS.overlay.topmost();                          // the top open layer, or null
 *   await DS.overlay.confirm({ title, text });     // a built dialog: true or false
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
 * ds-close ({ detail: { reason } }, bubbling, once), wait for settled(),
 * then hide (div: hidden; native: drop --closing), clear the box's inert
 * and .ds-dialog--nested, unlock the scroll and leave the Escape stack, in
 * one task. Popups return focus to their opener only when it was inside
 * them and the close was not a click outside.
 *
 * Busy: while the page sets data-ds-busy on a dialog, sheet or drawer, the
 * user's close attempts do nothing (Escape, the native cancel, a
 * [data-close] click, the backdrop and the drawer's scrim): one guard at
 * the top of closeFrom(), before the popups inside close, so a refused
 * attempt changes nothing and sends no ds-close. close(el) and the forced
 * closes (removed, breakpoint) still close; menus and lists ignore it.
 *
 * Dismiss guard: a backdrop or scrim click from a pointer closes only when
 * the press began on it, it is the first click (event.detail 1) and
 * --ds-delay-dismiss has passed since the open; a [data-close] click with
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
 * and fires input; the next Escape closes); the stack is shared by
 * every copy of ds.js on the page (sharedOf), so the topmost layer closes
 * whichever copy opened it. A native dialog's cancel
 * event is turned into close(), so its exit plays. Closing a dialog, sheet
 * or the drawer first closes the menus and lists open inside it and hides
 * the tooltip. [data-close] inside an overlay closes it (ignored while
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
 * Promise dialogs: confirm(), alert() and prompt() build a dialog.ds-dialog
 * with DOM APIs inside the opener's .ds-theme, open it through open() and
 * remove it after its exit; the promise resolves with the answer when the
 * close starts. onConfirm runs with busy() on the confirm button and
 * data-ds-busy on the dialog; a rejection keeps it open with an error
 * snackbar (errorText) and focus back on the confirm button.
 *
 * Snackbars (D19): toast(region, content, options) builds or takes a
 * .ds-toast and shows at most TOAST_LIMIT at once; insertions and removals
 * run inside DS.motion.flip(), so the messages on screen glide while one
 * enters or fades out in place. A fourth replaces the oldest message that
 * would close by itself; behind three that stay it waits in a queue. The
 * timer (length-dependent, --ds-time-scale included) pauses while a pointer
 * is over a message, focus is in the region or the tab is hidden. The same
 * string message again restarts the one on screen; a `key` replaces a
 * message in place; an `action` (Undo) adds a text button and keeps the
 * message until it is used or closed; closeToasts() closes by kind or
 * key. Text is announced through two .ds-sr live regions next to the
 * region (announce() speaks through them without a message; the region
 * itself is never live: role and aria-live are taken off it); a focused
 * message that leaves hands focus to the next close button, else to where
 * focus came from, never to <body>. Messages that stay keep room at the end
 * of their layer (data-toast-reserve on the view, a hosting sheet's body
 * or dialog). An open dialog or side sheet takes the
 * regions of its theme in (with a sheet they glide to its panel's edge and
 * above its foot on the sheet's timing), so messages stay above its scrim,
 * usable and announced; the div trap and the modal drawer never make them
 * inert. Closing, they glide back while still inside it (above its leaving
 * scrim and panel in every engine) and go back to the page once it
 * settled. On the page they rise above a shown save bar and, on phones,
 * the open modal drawer's foot (--ds-toast-lift, gliding on both axes).
 *
 * Tooltips (D17, WCAG 1.4.13): tooltips(root) serves every [data-tip]
 * trigger in root with one tooltip per call: shown after
 * --ds-delay-tooltip on hover (mouse and pen) and at once on keyboard
 * focus, at once again within --ds-delay-tooltip-skip of the last hide
 * (warm-up; a visible one swaps text and place in place; anchored, its
 * data-placement is read again two frames later), hoverable during
 * the --ds-delay-tooltip-hide grace, hidden by Escape (only then is the key
 * the tooltip's, unless an open layer lies over its trigger: then the same
 * Escape also closes that layer), by any pointerdown and by open(); the
 * opener of an open layer shows no tip. A tip that repeats the
 * trigger's visible text shows only while that text is cut off. On touch a
 * tap shows the tip of an image or a blocked control, a long press the
 * others. A trigger that leaves the document takes its tooltip with it.
 * Like the snackbar regions, it is never made inert by the div trap or the
 * modal drawer, so a trigger inside one shows a hoverable tooltip that is
 * heard.
 *
 * Save bar: savebar(element) shows and hides a view's .ds-savebar
 * (.ds-presence), keeps the view's end and its focused element clear of
 * it and lifts the snackbars above it.
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
 * ES2022 (Safari 16.4); a module may import from an earlier module (the
 * build bundles it into dist/ds.js as DS.overlay); newer APIs only behind
 * feature detection, named under Progressive:.
 *
 * Progressive:
 * - scrollbar-gutter (CSS.supports; keeps the room of a removed page
 *   scrollbar): without it the body gets the same room as padding-right.
 * - showPopover and CSS anchor positioning (anchorName and position-area,
 *   both detected, anchor-size() too for a combobox list; the tooltip, a
 *   menu and a combobox list go into the top layer as popover="manual",
 *   anchored to their trigger): without them the script places them
 *   (--ds-tooltip-x/-y, --ds-menu-x/-y in the terms of the box they are
 *   fixed to, the list's upward flip).
 * - moveBefore (a snackbar region that moves into a dialog or side sheet
 *   keeps its running motion and focus): without it insertBefore, focus
 *   put back, the entrances already marked played (.ds-toast--shown).
 * - startViewTransition (through DS.motion.transition(), for `container:
 *   true`, only with .ds-theme on <html>): without it the usual entrance.
 * - focus({ focusVisible: false }) (an overlay opened or closed with the
 *   pointer, or after the last input was a press, shows no keyboard ring
 *   in WebKit, which marks what showModal(), close() and a script's
 *   focus() focus as :focus-visible): without it that ring stays as WebKit
 *   draws it.
 */
import { busy, flip, motionDuration, originFrom, settled, transition } from './motion.js';
import { scrollEdges, watchScrolled } from './dom.js';
import { alertCircle, checkCircle, close as closeGlyph, iconElement, info } from './icons.js';

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
const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]';

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
 * @returns {{ order: Array<{ element: Element, open: () => boolean, opener?: () => Element|null, escape: (event: Event) => void }>, lock: { count: number, saved: { gutter: string, padding: string } | null }, seq: number, tipRoots: WeakMap<Element, { destroy: () => void }> }}
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

function sharedOf(doc) {
  const record = doc[SHARED] ?? (doc[SHARED] = {});
  record.order ??= [];
  record.lock ??= { count: 0, saved: null };
  record.seq ??= 0;
  record.tipRoots ??= new WeakMap();
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
      if (containedDialog(element) && !inside(containerOf(element), event)) return;
      // preventDefault() also keeps a native dialog from its own cancel.
      event.preventDefault();
      closeFrom(element, 'escape');
    },
  });
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

/** Documents with the Escape and pointer listeners. */
const listening = new WeakSet();

/** Elements with their [data-close] (and scrim, cancel) listeners. */
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

/** Whether focus() would land on the node (enabled, rendered, not inert or hidden). */
function canFocus(node) {
  if (!node || node.isConnected === false || typeof node.focus !== 'function') return false;
  if (node.disabled || node.closest?.('[inert], [hidden]')) return false;
  return typeof node.getClientRects !== 'function' || node.getClientRects().length > 0;
}

/** The first tabbable element inside `root`. */
function firstFocusable(root) {
  for (const node of root.querySelectorAll(FOCUSABLE)) {
    if (node.getAttribute('tabindex') === '-1') continue;
    if (canFocus(node)) return node;
  }
  return null;
}

/** The items of a menu that take focus (aria-disabled ones too: their name is read). */
function menuItems(menu) {
  return [...menu.querySelectorAll('.ds-menu__item')].filter(canFocus);
}

const enabled = (item) => item.getAttribute('aria-disabled') !== 'true';

/** The first enabled item of a menu. */
function firstItem(menu) {
  return menuItems(menu).find(enabled) ?? null;
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
  let opener = state.opener;
  for (let depth = 0; opener && depth < 4; depth += 1) {
    if (canFocus(opener) && !element.contains(opener)) return opener;
    const host = [...stack, ...hostsOf(opener)].find((node) => node !== element && node.contains(opener));
    opener = host ? overlays.get(host)?.opener ?? null : null;
  }
  const outside = (node) => canFocus(node) && !element.contains(node);
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
    // Opened from an ArrowUp keydown (the trigger's handler is running):
    // the last item, as in a native menu.
    const event = /** @type {any} */ (viewOf(element)).event;
    const last = event?.type === 'keydown' && event.key === 'ArrowUp';
    (last ? menuItems(element).filter(enabled).at(-1) : firstItem(element))?.focus({ preventScroll: true });
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
  for (let node = element; node && node !== stop && node !== body;) {
    const parent = node.parentNode;
    if (!parent || parent.nodeType === 9) break;
    for (const sibling of /** @type {ParentNode} */ (parent).children) {
      if (sibling === node || sibling.matches('.ds-scrim, .ds-toasts') || announcerNodes.has(sibling) || tooltipNodes.has(sibling)) continue;
      if (sibling.inert && !managedInert.has(sibling)) continue;
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
    if (!closingBoxes.has(node)) node.inert = false;
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
      order[i].escape(event);
      return;
    }
  });
  doc.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Tab' || event.isComposing || event.defaultPrevented) return;
    const top = topOpen();
    if (!top || overlays.get(top)?.kind !== 'menu' || !top.contains(activeIn(top))) return;
    // Tab moves on from the trigger, as if the menu had not been there.
    const opener = overlays.get(top)?.opener;
    if (canFocus(opener)) opener.focus({ preventScroll: true });
    closeFrom(top, 'tab');
  }, true);
  doc.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
    pruneDetached();
    for (const element of [...stack].reverse()) {
      const state = overlays.get(element);
      if (state?.kind !== 'menu' || state.phase !== 'open') continue;
      if (inside(element, event) || inside(state.opener, event)) continue;
      closeFrom(element, 'outside');
    }
  }, true);
  // A menu the script placed follows its trigger through scrolling and
  // resizing, within one frame (an anchored one follows by itself).
  const view = doc.defaultView ?? globalThis;
  let frame = 0;
  const follow = (/** @type {Event} */ event) => {
    // A menu's own scroll moves nothing it is placed by, and placing it
    // again (its cap lifted to measure) would clamp that scroll.
    if (event?.type === 'scroll' && /** @type {Element} */ (event.target)?.closest?.('.ds-menu')) return;
    if (frame || !stack.some((element) => overlays.get(element)?.kind === 'menu')) return;
    const run = () => {
      frame = 0;
      for (const element of stack) {
        const state = overlays.get(element);
        if (state?.kind === 'menu' && state.phase !== 'closed' && !element.hasAttribute('data-anchored')) placeMenu(element, state.opener);
      }
    };
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(run) : 0;
    if (!frame) run();
  };
  doc.addEventListener('scroll', follow, { capture: true, passive: true });
  view.addEventListener?.('resize', follow);
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

/** [data-close] clicks, the drawer's scrim and a native dialog's cancel. */
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
    const closer = target.closest?.('[data-close]');
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
  if (state.kind === 'menu') wireMenu(element);
  if (state.kind === 'dialog') wireDialogList(element);
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
 * An action sheet's list (.ds-dialog__list): ArrowUp, ArrowDown, Home and
 * End move focus among its .ds-menu__item rows (wrapping), as in a menu.
 */
function wireDialogList(dialog) {
  dialog.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const list = /** @type {Element} */ (event.target)?.closest?.('.ds-dialog__list');
    if (!list || !dialog.contains(list)) return;
    const next = arrowTarget([...list.querySelectorAll('.ds-menu__item')].filter(canFocus), event);
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
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

/**
 * A menu's own keys and items: ArrowUp, ArrowDown, Home and End move focus
 * (wrapping); an item's click closes the menu once its handlers ran (a
 * task later, so a handler further up the tree still sees it open).
 */
function wireMenu(menu) {
  // Type-ahead: the letters typed within --ds-delay-tooltip of each other.
  let typed = '';
  let typedAt = 0;
  menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const items = menuItems(menu);
    const next = arrowTarget(items, event);
    if (next) {
      typed = '';
      event.preventDefault();
      next.focus();
      return;
    }
    // A printable key; a space only within a word (alone it activates the item).
    if (event.key.length !== 1 || (event.key === ' ' && !typed)) return;
    const now = clock();
    if (now - typedAt > motionDuration(menu, '--ds-delay-tooltip')) typed = '';
    typedAt = now;
    typed += event.key.toLowerCase();
    const match = typeAhead(items, /** @type {Element} */ (event.target)?.closest?.('.ds-menu__item'), typed);
    if (!match) return;
    event.preventDefault();
    match.focus();
  });
  menu.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const item = /** @type {Element} */ (event.target)?.closest?.('.ds-menu__item');
    if (!item || !menu.contains(item) || !enabled(item) || /** @type {any} */ (item).disabled) return;
    const state = overlays.get(menu);
    if (state?.phase !== 'open') return;
    const gen = state.gen;
    setTimeout(() => {
      if (state.gen === gen && state.phase === 'open') closeFrom(menu, 'item');
    });
  });
}

/**
 * The item the typed letters lead to: the next one after `current`
 * (wrapping) whose label starts with them; one letter typed again and
 * again cycles through the items with that letter.
 */
function typeAhead(items, current, typed) {
  const label = (item) => (item.querySelector('.ds-menu__label') ?? item).textContent.replace(/\s+/g, ' ').trim().toLowerCase();
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
 * The anchor-names this module wrote, per element, with a count of users:
 * a tooltip and a popup on one trigger (an icon button with a tooltip that
 * opens a menu) share one name, which goes only once neither uses it.
 * @type {WeakMap<Element, { name: string, count: number }>}
 */
const anchorClaims = new WeakMap();

/**
 * The anchor-name to point at `element`: one this module wrote (counted),
 * the page's own (never touched; `mine` false), or a new one written
 * inline (--ds-anchor-<n>, numbered per page across every copy of ds.js).
 * @returns {{ name: string, mine: boolean }}
 */
function claimAnchor(element, view) {
  const held = anchorClaims.get(element);
  if (held) {
    held.count += 1;
    return { name: held.name, mine: true };
  }
  const css = view.getComputedStyle(element).getPropertyValue('anchor-name').trim();
  if (css && css !== 'none') return { name: css.split(',')[0].trim(), mine: false };
  const name = `--ds-anchor-${sharedOf(element.ownerDocument).seq += 1}`;
  /** @type {HTMLElement} */ (element).style.setProperty('anchor-name', name);
  own(element, 'props', 'anchor-name');
  anchorClaims.set(element, { name, count: 1 });
  return { name, mine: true };
}

/** Lets go of a name claimAnchor() gave; the last user removes it. */
function releaseAnchor(element) {
  const held = element ? anchorClaims.get(element) : null;
  if (!held) return;
  held.count -= 1;
  if (held.count > 0) return;
  anchorClaims.delete(element);
  /** @type {HTMLElement} */ (element).style.removeProperty('anchor-name');
  disown(element, 'props', 'anchor-name');
}

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
 * The side of a popup `height` tall at `rect`: below when it fits there,
 * else the side with more room, and the room on that side (a popup taller
 * than it scrolls inside it instead of covering its trigger). `top` and
 * `bottom` bound the room; `near` is the gap to the trigger, `far` the one
 * kept from the bound.
 */
function sideFor(height, rect, near, far, top, bottom) {
  const below = bottom - far - rect.bottom - near;
  const above = rect.top - near - top - far;
  const up = height > below && above > below;
  return { up, room: Math.max(0, up ? above : below) };
}

/** Caps a popup placed by the script to `room` (none when it fits). */
function fitTo(element, height, room) {
  const style = /** @type {HTMLElement} */ (element).style;
  if (height > room) style.setProperty('max-height', `${round(room)}px`);
  else style.removeProperty('max-height');
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
    element.setAttribute('popover', 'manual');
    element.setAttribute('data-anchored', '');
    releaseAnchor(state.anchor);
    state.anchor = null;
    const { name, mine } = claimAnchor(anchor, view);
    if (mine) state.anchor = /** @type {HTMLElement} */ (anchor);
    const style = /** @type {HTMLElement} */ (element).style;
    style.setProperty('position-anchor', name);
    try {
      /** @type {HTMLElement} */ (element).showPopover();
    } catch {
      // Already open: it stays.
    }
    // The side from its full height (the CSS cap lifted to measure it);
    // the engine then fits it to the room on that side.
    style.setProperty('max-height', 'none');
    const height = /** @type {HTMLElement} */ (element).offsetHeight;
    style.removeProperty('max-height');
    const doc = element.ownerDocument;
    const gap = pxOf(element, '--ds-space-1', 4);
    const { up } = sideFor(height, anchor.getBoundingClientRect(), gap, gap, 0, doc.documentElement.clientHeight || view.innerHeight);
    if (up) element.setAttribute('data-placement', 'top');
    else element.removeAttribute('data-placement');
  } else if (state.kind === 'menu') placeMenu(element, anchor);
  else placeList(element, anchor);
  return anchor;
}

/**
 * A menu by the script: below the trigger from its start edge, towards the
 * start edge (the trigger's end) when it would leave the viewport, above
 * the trigger when it does not fit below and there is more room above,
 * never taller than the room on its side; 8px (--ds-space-2) from the
 * viewport edges.
 */
/** The fixed probe beside each script-placed popup, kept while it is placed (fixedOrigin()). */
const probes = new WeakMap();

/**
 * Where (0,0) of a fixed box's containing block sits in the viewport: the
 * viewport's origin, unless a host ancestor (an embedded widget's) has a
 * transform, filter, perspective, will-change or contain: layout/paint and
 * so becomes the box that fixed layers fill. A fixed probe beside
 * `element` tells, whatever transform the element itself has now, read
 * afresh on every call (a transformed host may scroll with the page). The
 * probe stays beside the popup until it is no longer placed (dropProbe()),
 * so following a scroll or a resize adds no DOM mutation per frame for the
 * page's observers; data-ds-keep keeps morphs and indicator tracks off it.
 */
function fixedOrigin(element) {
  const parent = element.parentNode;
  if (!parent) return { left: 0, top: 0 };
  let probe = probes.get(element);
  if (!probe) {
    probe = element.ownerDocument.createElement('div');
    probe.setAttribute('data-ds-keep', '');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;margin:0;border:0;padding:0;transform:none;translate:none;scale:none;rotate:none;animation:none;transition:none;visibility:hidden;pointer-events:none';
    probes.set(element, probe);
  }
  // Re-inserted only when the popup moved (adopted into a dialog, re-rendered).
  if (probe.parentNode !== parent || probe.nextSibling !== element) parent.insertBefore(probe, element);
  const { left, top } = probe.getBoundingClientRect();
  return { left, top };
}

/** Takes the probe of fixedOrigin() out once the popup is no longer placed by the script. */
function dropProbe(element) {
  probes.get(element)?.remove();
  probes.delete(element);
}

function placeMenu(menu, anchor) {
  if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
  const doc = menu.ownerDocument;
  const view = viewOf(menu);
  const rect = anchor.getBoundingClientRect();
  const gap = pxOf(menu, '--ds-space-1', 4);
  const edge = pxOf(menu, '--ds-space-2', 8);
  const style = /** @type {HTMLElement} */ (menu).style;
  style.removeProperty('max-height');
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const viewWidth = doc.documentElement.clientWidth || view.innerWidth;
  const viewHeight = doc.documentElement.clientHeight || view.innerHeight;
  const rtl = view.getComputedStyle?.(anchor).direction === 'rtl';
  const start = rtl ? rect.right - width : rect.left;
  const flipped = rtl ? rect.left : rect.right - width;
  const fits = (x) => x >= edge && x + width <= viewWidth - edge;
  let x = fits(start) || !fits(flipped) ? start : flipped;
  x = Math.max(edge, Math.min(viewWidth - width - edge, x));
  const { up, room } = sideFor(height, rect, gap, edge, 0, viewHeight);
  fitTo(menu, height, room);
  const y = up ? rect.top - gap - Math.min(height, room) : rect.bottom + gap;
  // Viewport coordinates, written in those of the box the menu is fixed to.
  const origin = fixedOrigin(menu);
  style.setProperty('--ds-menu-x', `${round(x - origin.left)}px`);
  style.setProperty('--ds-menu-y', `${round(y - origin.top)}px`);
  if (up) menu.setAttribute('data-placement', 'top');
  else menu.removeAttribute('data-placement');
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
  const view = viewOf(list);
  const doc = list.ownerDocument;
  const rect = anchor.getBoundingClientRect();
  const gap = pxOf(list, '--ds-space-1', 4);
  /** @type {HTMLElement} */ (list).style.removeProperty('max-height');
  const height = list.offsetHeight;
  let top = 0;
  let bottom = doc.documentElement.clientHeight || view.innerHeight;
  for (let node = list.parentElement; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    if (view.getComputedStyle?.(node).overflowY === 'visible') continue;
    const box = node.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  const { up, room } = sideFor(height, rect, gap, gap, top, bottom);
  fitTo(list, height, room);
  if (up) list.setAttribute('data-placement', 'top');
  else list.removeAttribute('data-placement');
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
  if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
  else query.addListener?.(onChange);
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
  if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
  else query.addListener?.(onChange);
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
    if (kind === 'dialog' || kind === 'sheet') releaseToasts(element);
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
    viewOf(element).console?.warn('Dashboard-Style: DS.overlay.open() on an element outside .ds-theme. Overlays must sit inside the .ds-theme element, or they get neither the tokens nor the motion.');
  }
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
    hostToasts(element, 'enter');
  } else {
    if (/** @type {HTMLElement} */ (element).hidden) /** @type {HTMLElement} */ (element).hidden = false;
    for (const name of ['ds-dialog--hidden', 'ds-sheet--hidden']) {
      if (element.classList.contains(name)) {
        element.classList.remove(name);
        state.hiddenClass = name;
      }
    }
    // The snackbars come in before the page turns inert, so they never are.
    if (kind === 'dialog' || kind === 'sheet') hostToasts(element, 'enter');
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
  return entrance;
}

/**
 * Closes an overlay that open() showed, in the documented order: the trap
 * goes and focus is on the opener at once, the box or panel turns inert,
 * data-state="closed" plays the exit, and once it settled the overlay is
 * hidden and leaves the lock and the Escape stack. A second call during
 * the exit returns the same promise; an open() meanwhile takes it back.
 * `reason` (default 'api') is what the ds-close event says; it also closes
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

/* ── Promise dialogs ────────────────────────────────── */

/** What a failed onConfirm says by default (never the raw error message). */
const CONFIRM_ERROR = 'That did not work. Try again.';

/** What a required prompt field left empty says by default. */
const REQUIRED_TEXT = 'Enter a value.';

/**
 * Asks with a built dialog: Cancel and a confirm button. `destructive`
 * makes it an alertdialog whose first focus is Cancel; the confirm label
 * names the consequence (there are no red buttons). `onConfirm` (async)
 * runs with busy() on the confirm button and data-ds-busy on the dialog: a
 * rejection keeps it open, shows `errorText` as an error snackbar above it
 * (in the theme's .ds-toasts region, made when the page has none, inside
 * the open dialog) and focuses the confirm button again.
 * Resolves true when it closed through the confirm button, else false.
 * @param {{ title?: string, text?: string, confirmLabel?: string, cancelLabel?: string, destructive?: boolean,
 *   opener?: Element|null, onConfirm?: () => unknown, errorText?: string }} [options]
 * @returns {Promise<boolean>}
 */
export function confirm(options = {}) {
  return /** @type {Promise<boolean>} */ (ask('confirm', options));
}

/**
 * Tells something with a built alertdialog and one button (`closeLabel`,
 * default "OK"); resolves once it closes.
 * @param {{ title?: string, text?: string, closeLabel?: string, opener?: Element|null }} [options]
 * @returns {Promise<void>}
 */
export function alert(options = {}) {
  return /** @type {Promise<void>} */ (ask('alert', options));
}

/**
 * Asks for one value with a built dialog: a field (`label`, `value`;
 * `input` sets its type, autocomplete, inputmode, required, spellcheck,
 * autocapitalize, autocorrect and enterkeyhint), Cancel and a confirm
 * button; Enter in the field confirms. A required field left
 * empty stays open with the field error `requiredText` (default "Enter a
 * value."; aria-invalid, a .ds-field__hint--error linked by
 * aria-describedby, announced assertively) until the next input.
 * `onConfirm(value)` runs as in confirm(). Resolves the value when it
 * closed through the confirm button, else null.
 * @param {{ title?: string, text?: string, label?: string, value?: string, confirmLabel?: string,
 *   cancelLabel?: string, opener?: Element|null, onConfirm?: (value: string) => unknown, errorText?: string,
 *   requiredText?: string,
 *   input?: { type?: string, autocomplete?: string, inputmode?: string, required?: boolean,
 *     spellcheck?: boolean, autocapitalize?: string, autocorrect?: string, enterkeyhint?: string } }} [options]
 * @returns {Promise<string|null>}
 */
export function prompt(options = {}) {
  return /** @type {Promise<string|null>} */ (ask('prompt', options));
}

/** The answer of a promise dialog that closed without its confirm button. */
const declined = (kind) => (kind === 'confirm' ? false : kind === 'prompt' ? null : undefined);

/**
 * Builds, opens and answers a promise dialog (confirm(), alert(),
 * prompt()): native <dialog> markup inside the opener's .ds-theme (else
 * the first one), DOM APIs only (no HTML strings, CSP-safe), removed once
 * its exit settled.
 */
function ask(kind, options) {
  const opener = options.opener ?? null;
  const doc = opener?.ownerDocument ?? globalThis.document;
  if (!doc?.createElement || !doc.body) return Promise.resolve(declined(kind));
  const theme = opener?.closest?.('.ds-theme') ?? activeIn(doc.body)?.closest?.('.ds-theme') ?? doc.querySelector('.ds-theme');
  const home = !theme || theme === doc.documentElement ? doc.body : theme;
  const id = `ds-ask-${sharedOf(doc).seq += 1}`;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  };
  const native = typeof make('dialog').showModal === 'function';
  const dialog = make(native ? 'dialog' : 'div', 'ds-dialog');
  const box = make('div', 'ds-dialog__box');
  // The modal semantics: a native dialog has them; the div markup's box takes the role.
  const labelled = native ? dialog : box;
  const role = kind === 'alert' || options.destructive ? 'alertdialog' : 'dialog';
  if (native) {
    if (role === 'alertdialog') dialog.setAttribute('role', role);
  } else {
    dialog.hidden = true;
    box.setAttribute('role', role);
    box.setAttribute('aria-modal', 'true');
  }
  const backdrop = make('div', 'ds-dialog__backdrop');
  backdrop.setAttribute('data-close', '');
  const title = make('h2', 'ds-dialog__title', options.title ?? '');
  title.id = `${id}-title`;
  labelled.setAttribute('aria-labelledby', title.id);
  box.append(title);
  if (options.text) {
    const text = make('p', 'ds-dialog__text', options.text);
    text.id = `${id}-text`;
    labelled.setAttribute('aria-describedby', text.id);
    box.append(text);
  }
  /** @type {HTMLInputElement|null} */
  let field = null;
  if (kind === 'prompt') {
    const wrap = make('div', 'ds-field');
    const label = make('label', 'ds-field__label', options.label ?? '');
    field = /** @type {HTMLInputElement} */ (make('input', 'ds-input'));
    field.id = `${id}-field`;
    label.htmlFor = field.id;
    const input = options.input ?? {};
    field.type = input.type ?? 'text';
    if (input.autocomplete) field.setAttribute('autocomplete', input.autocomplete);
    if (input.inputmode) field.setAttribute('inputmode', input.inputmode);
    if (input.required) field.required = true;
    // Typing hints for a path or a code: written only when given, so the browser's defaults stay otherwise.
    if (typeof input.spellcheck === 'boolean') field.setAttribute('spellcheck', String(input.spellcheck));
    for (const name of ['autocapitalize', 'autocorrect', 'enterkeyhint']) {
      if (input[name]) field.setAttribute(name, input[name]);
    }
    field.value = options.value ?? '';
    field.setAttribute('autofocus', '');
    wrap.append(label, field);
    box.append(wrap);
  }
  const actions = make('div', 'ds-dialog__actions');
  const button = (className, text) => {
    const node = /** @type {HTMLButtonElement} */ (make('button', className, text));
    node.type = 'button';
    return node;
  };
  /** @type {HTMLButtonElement|null} */
  let cancel = null;
  let confirmButton;
  if (kind === 'alert') {
    confirmButton = button('ds-btn ds-btn--primary', options.closeLabel ?? 'OK');
    confirmButton.setAttribute('data-close', '');
    confirmButton.setAttribute('autofocus', '');
    actions.append(confirmButton);
  } else {
    cancel = button('ds-btn ds-btn--text', options.cancelLabel ?? 'Cancel');
    cancel.setAttribute('data-close', '');
    // The faces of busy(): the label, and the spinner with it while onConfirm runs.
    const label = options.confirmLabel ?? 'Confirm';
    confirmButton = button('ds-btn ds-btn--primary');
    const faces = make('span', 'ds-btn__faces');
    const rest = make('span', 'ds-btn__face', label);
    const working = make('span', 'ds-btn__face ds-btn__face--busy');
    working.setAttribute('aria-hidden', 'true');
    working.append(make('span', 'ds-spinner ds-spinner--sm'), doc.createTextNode(label));
    faces.append(rest, working);
    confirmButton.append(faces);
    // The safe choice first in a destructive question; else the answer, or the field.
    if (options.destructive) cancel.setAttribute('autofocus', '');
    else if (!field) confirmButton.setAttribute('autofocus', '');
    actions.append(cancel, confirmButton);
  }
  box.append(actions);
  dialog.append(backdrop, box);

  return new Promise((resolve) => {
    dialog.addEventListener('ds-close', (event) => {
      if (event.target !== dialog) return;
      const reason = /** @type {CustomEvent} */ (event).detail?.reason;
      resolve(reason === 'confirm' ? (kind === 'confirm' ? true : kind === 'prompt' ? field?.value ?? '' : undefined) : declined(kind));
      // Gone once its exit settled (unless it opened again meanwhile).
      Promise.resolve(overlays.get(dialog)?.closing).then(() => {
        if (overlays.get(dialog)?.phase !== 'open') dialog.remove();
      });
    });
    if (kind === 'alert') {
      home.append(dialog);
      open(dialog, { opener });
      return;
    }
    // A required field left empty: the documented field error (an
    // aria-invalid field described by a .ds-field__hint--error with its
    // icon, so never colour alone), said at once since focus is already
    // there and the description is only read on the next focus.
    /** @type {HTMLElement|null} */
    let hint = null;
    const invalid = (/** @type {HTMLInputElement} */ input) => {
      const text = String(options.requiredText ?? REQUIRED_TEXT);
      if (!hint) {
        hint = make('small', 'ds-field__hint ds-field__hint--error');
        hint.id = `${id}-error`;
        hint.append(iconElement(alertCircle, 16, undefined, doc), doc.createTextNode(text));
        input.parentElement?.append(hint);
      }
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', hint.id);
      input.focus();
      announce(text, { assertive: true, region: regionOfTheme(doc, theme, home) });
    };
    // Typing takes the error away at once (the documented instant removal).
    const valid = () => {
      if (!field) return;
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
      hint?.remove();
      hint = null;
    };
    const attempt = async () => {
      if (dialog.hasAttribute('data-ds-busy') || overlays.get(dialog)?.phase !== 'open') return;
      if (field?.required && !field.value.trim()) {
        invalid(field);
        return;
      }
      valid();
      if (typeof options.onConfirm !== 'function') {
        close(dialog, { reason: 'confirm' });
        return;
      }
      // Busy: the dialog refuses the user's closes, Cancel says it is blocked, the value stays.
      dialog.setAttribute('data-ds-busy', '');
      cancel?.setAttribute('aria-disabled', 'true');
      if (field) field.readOnly = true;
      const settle = () => {
        dialog.removeAttribute('data-ds-busy');
        cancel?.removeAttribute('aria-disabled');
        if (field) field.readOnly = false;
      };
      try {
        await busy(confirmButton, () => options.onConfirm(field?.value ?? undefined), { done: false });
      } catch {
        settle();
        if (!dialog.isConnected) return;
        // Above the dialog: the theme's region (made when the page has
        // none) moves into it on first use.
        const region = regionOfTheme(doc, theme, home);
        if (region) toast(region, options.errorText ?? CONFIRM_ERROR, { kind: 'error' });
        confirmButton.focus({ preventScroll: true });
        return;
      }
      settle();
      close(dialog, { reason: 'confirm' });
    };
    confirmButton.addEventListener('click', (/** @type {MouseEvent} */ event) => {
      if (event.detail > 1) return;
      attempt();
    });
    field?.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      attempt();
    });
    field?.addEventListener('input', valid);
    home.append(dialog);
    open(dialog, { opener });
  });
}

/** Tells the page why an overlay closed (once per close, after its state turned closed). */
function announceClose(element, reason) {
  const view = viewOf(element);
  if (typeof view.CustomEvent !== 'function') return;
  element.dispatchEvent(new view.CustomEvent('ds-close', { bubbles: true, detail: { reason } }));
}

/**
 * close() by its cause, which steers focus and the busy guard: 'api' (a
 * call), 'close' ([data-close]), 'backdrop' (the backdrop or the drawer's
 * scrim), 'escape', 'native' (the native dialog closed itself), 'parent'
 * (the overlay around it closes), 'item' (a menu item ran), 'tab' (a menu;
 * focus is on the trigger already) or 'outside' (a pointerdown outside a
 * menu: focus stays where the pointer puts it). `reason` is what ds-close
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
  if (kind === 'dialog' || kind === 'sheet') hostToasts(element, 'exit');

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
    if (kind === 'dialog' || kind === 'sheet') hostToasts(element, 'settle');
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

const round = (value) => Math.round(value * 100) / 100;

/** Text as compared: whitespace collapsed, trimmed, lower case. */
const normalText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** A monotonic clock in ms. */
const clock = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());

/** A length token as computed on the element, in px (`fallback` outside a theme). */
function pxOf(element, token, fallback) {
  const value = parseFloat(viewOf(element).getComputedStyle?.(element).getPropertyValue(token) ?? '');
  return Number.isFinite(value) ? value : fallback;
}

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

/* ── Snackbars ──────────────────────────────────────── */

/** Each character past TOAST_FREE_CHARS adds this much reading time (ms), up to TOAST_MAX_MS. */
const TOAST_CHAR_MS = 50;

/** A message this long or shorter takes TOAST_MS. */
const TOAST_FREE_CHARS = 40;

/** The phone width of toast.css: the region spans the width, and the open modal drawer covers its foot. */
const PHONE_QUERY = '(max-width: 600px)';

/**
 * What toast() returns for a message.
 * @typedef {{ el: HTMLElement|null, close: () => Promise<void>, closed: Promise<void> }} ToastHandle
 */

/**
 * One message. `key`: a later toast() with the same key replaces it (an
 * explicit key) or restarts it (the implicit `restart:` key of a string
 * message without an action); `reserve`: it stays and keeps room in its
 * layer; `onAction`: the onClick of its action button, until used.
 * @typedef {{ el: HTMLElement, region: Element, kind: string, key: string|null, stays: boolean, reserve: boolean,
 *   assertive: boolean, text: string, timeout: number, remaining: number, timer: any, started: number,
 *   phase: 'queued'|'shown'|'leaving'|'gone', done: () => void, closed: Promise<void>,
 *   onAction: ((event: Event, handle: ToastHandle) => void)|null, handle: ToastHandle }} Toast
 */

/**
 * One region: the messages on screen (oldest first) and waiting, why its
 * timers pause, where focus came from, its announcers, the scroller or
 * dialog that keeps room for its messages that stay (`reserved`, watched by
 * `observer` while held) and whether it owns its --ds-toast-lift.
 * @typedef {{ shown: Toast[], queue: Toast[], pointer: boolean, focus: boolean, origin: Element|null,
 *   polite: HTMLElement|null, assertive: HTMLElement|null, pending: Map<HTMLElement, string[]>,
 *   reserved: HTMLElement|null, observer: ResizeObserver|null, lifted: boolean }} ToastRegion
 * @type {WeakMap<Element, ToastRegion>}
 */
const toastRegions = new WeakMap();

/** The message of each .ds-toast that toast() shows. @type {WeakMap<Element, Toast>} */
const toastEntries = new WeakMap();

/** Regions with a pointer over a message (cleared by a pointerover anywhere else). */
const pointedRegions = /** @type {Set<Element>} */ (new Set());

/** Documents with the pointer watcher of pointedRegions. */
const pointerWatched = new WeakSet();

/**
 * Per document: the regions its one visibilitychange listener pauses and
 * resumes, held weakly, so a region the page dropped is not kept alive.
 * @type {WeakMap<Document, Set<WeakRef<Element>>>}
 */
const visibilityRegions = new WeakMap();

/**
 * Per .ds-app, the regions its one data-drawer-open observer lifts, held
 * weakly like visibilityRegions.
 * @type {WeakMap<Element, Set<WeakRef<Element>>>}
 */
const drawerRegions = new WeakMap();

/** The live regions announcers() made: inertOutside() leaves them alone, like the snackbar regions. */
const announcerNodes = new WeakSet();

/**
 * The tooltips tooltips() made: inertOutside() leaves them alone too, so
 * the one a trigger inside a div dialog, side sheet or the modal drawer
 * shows takes the pointer (the hoverable grace) and is heard.
 */
const tooltipNodes = new WeakSet();

/**
 * Regions that open dialogs and side sheets took in: the places each one
 * left, the latest last ({ host, parent, next, left: the inline
 * --ds-toast-left, at: the computed left in px there, leaving: the host's
 * exit runs and the region glides back inside it }).
 * @type {WeakMap<Element, Array<{ host: Element, parent: Node, next: Node|null, left: string, at: number, leaving: boolean }>>}
 */
const toastHomes = new WeakMap();

/**
 * The regions that have a toastHomes entry right now, so a close finds
 * them even when they left the document meanwhile; each with the nodes
 * that keepAway() marked (the region and its announcers).
 * @type {Map<Element, Node[]>}
 */
const hostedRegions = new Map();

/** The latest follow glide of each region (a later one supersedes it). @type {WeakMap<Element, number>} */
const followRuns = new WeakMap();

/**
 * The save bars on screen (savebar()): each lifts the snackbar regions of
 * its theme above itself (`lift(region)`, in px).
 * @type {Set<{ element: HTMLElement, lift: (region: Element) => number }>}
 */
const shownSavebars = new Set();

function regionState(region) {
  let state = toastRegions.get(region);
  if (!state) {
    state = {
      shown: [], queue: [], pointer: false, focus: false, origin: null,
      polite: null, assertive: null, pending: new Map(),
      reserved: null, observer: null, lifted: false,
    };
    toastRegions.set(region, state);
    // The markup removed in 2.0 (role="status" aria-live="polite" on the
    // region): the announcers speak, so a live region would read every
    // message twice. Taken off once and owned, so a re-render of the
    // page's markup (DS.dom.morphHtml) does not put it back.
    for (const name of ['role', 'aria-live']) {
      if (!region.hasAttribute(name)) continue;
      region.removeAttribute(name);
      own(region, 'attrs', name);
    }
    wireRegion(region, state);
    hostLate(region);
  }
  return state;
}

/**
 * A region first used while a dialog or side sheet of its theme is open
 * (made by toastRegion() then, or rendered by the page after the open)
 * goes into each such overlay on the stack, oldest first, as if it had
 * been there at open(): else it would stay under the modal, inert, and
 * its announcers unheard. One inside a nested .ds-theme stays, as in
 * hostToasts().
 */
function hostLate(region) {
  const theme = region.closest?.('.ds-theme') ?? null;
  for (const host of [...stack]) {
    const state = overlays.get(host);
    if (state?.phase !== 'open' || (state.kind !== 'dialog' && state.kind !== 'sheet')) continue;
    const hostTheme = host.closest('.ds-theme');
    if (hostTheme && hostTheme !== theme) continue;
    followInto(region, host);
  }
}

/** The .ds-app of a region's theme (the region sits right after it). */
function appOf(region) {
  const scope = region.closest?.('.ds-theme') ?? region.ownerDocument;
  return /** @type {HTMLElement|null} */ (scope?.querySelector?.('.ds-app') ?? null);
}

const paused = (region, state) => state.pointer || state.focus || Boolean(region.ownerDocument.hidden);

/** Starts (or resumes) a message's timer with the time it has left. */
function arm(entry, region, state) {
  if (entry.stays || entry.phase !== 'shown' || entry.timer || paused(region, state)) return;
  entry.started = clock();
  entry.timer = setTimeout(() => {
    entry.timer = 0;
    closeToast(entry);
  }, Math.max(0, entry.remaining));
}

/** Stops a message's timer and keeps the time it has left. */
function disarm(entry) {
  if (!entry.timer) return;
  clearTimeout(entry.timer);
  entry.timer = 0;
  entry.remaining -= clock() - entry.started;
}

function pauseToasts(state) {
  for (const entry of state.shown) disarm(entry);
}

function resumeToasts(region, state) {
  for (const entry of state.shown) arm(entry, region, state);
}

function unpoint(region, state) {
  pointedRegions.delete(region);
  if (!state.pointer) return;
  state.pointer = false;
  resumeToasts(region, state);
}

/**
 * The pauses (pointer, focus, a hidden tab), the close and action buttons,
 * the origin of focus and the open modal drawer (its foot lifts the
 * messages on phones), once per region. The region itself takes no
 * pointer (pointer-events: none), its messages do, and their events
 * bubble here.
 */
function wireRegion(region, state) {
  const doc = region.ownerDocument;
  region.addEventListener('pointerover', (/** @type {PointerEvent} */ event) => {
    if (state.pointer || region.contains(/** @type {Node} */ (event.relatedTarget))) return;
    state.pointer = true;
    pointedRegions.add(region);
    pauseToasts(state);
  });
  region.addEventListener('pointerout', (/** @type {PointerEvent} */ event) => {
    if (region.contains(/** @type {Node} */ (event.relatedTarget))) return;
    unpoint(region, state);
  });
  region.addEventListener('focusin', (/** @type {FocusEvent} */ event) => {
    const from = /** @type {Element|null} */ (event.relatedTarget);
    if (!state.focus && from && !region.contains(from)) state.origin = from;
    state.focus = true;
    pauseToasts(state);
  });
  region.addEventListener('focusout', (/** @type {FocusEvent} */ event) => {
    if (region.contains(/** @type {Node} */ (event.relatedTarget))) return;
    state.focus = false;
    resumeToasts(region, state);
  });
  region.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const target = /** @type {Element} */ (event.target);
    const button = target.closest?.('.ds-toast__close, .ds-toast__action');
    const entry = button && region.contains(button) ? toastEntries.get(button.closest('.ds-toast')) : null;
    if (!entry || entry.phase !== 'shown') return;
    if (button.classList.contains('ds-toast__close')) {
      closeToast(entry);
      return;
    }
    const run = entry.onAction;
    if (!run) return;
    // Once: a double click never undoes twice.
    entry.onAction = null;
    closeToast(entry);
    try {
      run(event, entry.handle);
    } catch (error) {
      report(region, error);
    }
  });
  const regions = visibilityOf(doc);
  for (const ref of [...regions]) if (!ref.deref()) regions.delete(ref);
  regions.add(new WeakRef(region));
  watchPointer(doc);
  const app = appOf(region);
  const lifted = app ? drawerOf(app) : null;
  if (lifted) {
    for (const ref of [...lifted]) if (!ref.deref()) lifted.delete(ref);
    lifted.add(new WeakRef(region));
  }
}

/**
 * The regions that the modal drawer of `app` lifts while it opens and
 * closes (its foot on phones): one MutationObserver per .ds-app. A
 * function of its own, like visibilityOf(): an observer made inside
 * wireRegion() would keep its region alive as long as the .ds-app, also
 * after the page replaced the region. Null without MutationObserver.
 * @returns {Set<WeakRef<Element>>|null}
 */
function drawerOf(app) {
  let watched = drawerRegions.get(app);
  if (watched) return watched;
  const Observer = viewOf(app).MutationObserver;
  if (typeof Observer !== 'function') return null;
  const regions = /** @type {Set<WeakRef<Element>>} */ (new Set());
  drawerRegions.set(app, regions);
  new Observer(() => {
    for (const ref of [...regions]) {
      const region = ref.deref();
      const state = region && toastRegions.get(region);
      if (!state) regions.delete(ref);
      else if (region.isConnected && state.shown.length) liftRegion(region);
    }
  }).observe(app, { attributes: true, attributeFilter: ['data-drawer-open'] });
  return regions;
}

/**
 * A message that leaves from under a still pointer sends no pointerout to
 * the region; the next pointerover elsewhere tells. A function of its own,
 * like visibilityOf(): made inside wireRegion(), the listener would keep
 * the first region alive.
 */
function watchPointer(doc) {
  if (pointerWatched.has(doc)) return;
  pointerWatched.add(doc);
  doc.addEventListener('pointerover', (/** @type {PointerEvent} */ event) => {
    for (const pointed of [...pointedRegions]) {
      if (!inside(pointed, event)) unpoint(pointed, toastRegions.get(pointed));
    }
  }, true);
}

/**
 * The regions of `doc` that its one visibilitychange listener pauses and
 * resumes. A function of its own: a listener made inside wireRegion()
 * would share that call's scope and keep its region alive.
 * @returns {Set<WeakRef<Element>>}
 */
function visibilityOf(doc) {
  let watched = visibilityRegions.get(doc);
  if (watched) return watched;
  const regions = /** @type {Set<WeakRef<Element>>} */ (new Set());
  visibilityRegions.set(doc, regions);
  doc.addEventListener('visibilitychange', () => {
    for (const ref of [...regions]) {
      const region = ref.deref();
      const state = region && toastRegions.get(region);
      if (!state) regions.delete(ref);
      else if (doc.hidden) pauseToasts(state);
      else resumeToasts(region, state);
    }
  });
  return regions;
}

/** The documented close button of a message; its label is its tooltip too. */
function closeButton(doc, label) {
  const button = doc.createElement('button');
  button.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-toast__close';
  button.type = 'button';
  button.setAttribute('aria-label', label || 'Close');
  button.setAttribute('data-tip', label || 'Close');
  button.append(iconElement(closeGlyph, 20, undefined, doc));
  return button;
}

/** The documented message for a string: icon, text, the action and, when it stays, a close button. */
function buildToast(doc, text, kind, closable, closeLabel, actionLabel) {
  const el = doc.createElement('div');
  el.className = kind === 'error' || kind === 'info' ? `ds-toast ds-toast--${kind}` : 'ds-toast';
  el.append(iconElement(kind === 'error' ? alertCircle : kind === 'info' ? info : checkCircle, 20, undefined, doc));
  const span = doc.createElement('span');
  span.className = 'ds-toast__text';
  span.textContent = text;
  el.append(span);
  if (actionLabel) {
    const action = doc.createElement('button');
    action.className = 'ds-btn ds-btn--text ds-btn--sm ds-toast__action';
    action.type = 'button';
    action.textContent = actionLabel;
    el.append(action);
  }
  if (closable) el.append(closeButton(doc, closeLabel));
  return el;
}

/** The two announcers next to the region (created once, moved with it). */
function announcers(region, state) {
  // An announcer a re-render patched into a page element is no announcer
  // any more: a new one takes its place, and the page keeps its element.
  const live = (key) => {
    const node = state[key];
    return Boolean(node?.isConnected) && node.classList.contains('ds-sr') && node.getAttribute('aria-live') === key;
  };
  if (live('polite') && live('assertive')) return;
  const doc = region.ownerDocument;
  for (const key of /** @type {const} */ (['polite', 'assertive'])) {
    if (live(key)) continue;
    if (state[key]) announcerNodes.delete(state[key]);
    const node = doc.createElement('div');
    node.className = 'ds-sr';
    node.setAttribute('aria-live', key);
    node.setAttribute('aria-atomic', 'true');
    // A runtime node, like a ripple: DS.dom.morphHtml of the region's
    // parent never matches, patches or removes it.
    node.setAttribute('data-ds-keep', '');
    announcerNodes.add(node);
    state[key] = node;
  }
  region.after(/** @type {HTMLElement} */ (state.polite), /** @type {HTMLElement} */ (state.assertive));
}

/**
 * Says a text through the region's announcer: cleared now, written on the
 * next frame, so the same text again is announced again. Texts of one
 * frame are read together.
 * @param {{ text: string, assertive: boolean }} entry
 */
function speak(region, state, entry) {
  if (!entry.text) return;
  announcers(region, state);
  const node = /** @type {HTMLElement} */ (entry.assertive ? state.assertive : state.polite);
  const texts = state.pending.get(node);
  if (texts) {
    texts.push(entry.text);
    return;
  }
  state.pending.set(node, [entry.text]);
  node.textContent = '';
  nextFrame(region.ownerDocument, () => {
    node.textContent = (state.pending.get(node) ?? []).join('\n');
    state.pending.delete(node);
  });
}

/** How long a message stays (ms): longer texts get more time, capped; --ds-time-scale stretches it. */
function toastTimeout(region, text, options) {
  const given = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : 0;
  const base = given || Math.min(TOAST_MAX_MS, TOAST_MS + TOAST_CHAR_MS * Math.max(0, text.length - TOAST_FREE_CHARS));
  return base * timeScaleOf(region);
}

/**
 * The page's snackbar region: the .ds-toasts in the theme of the first
 * .ds-app (else the first in the document). Without one it creates
 * <div class="ds-toasts"></div> right after the .ds-app (else as the last
 * child of the .ds-theme, else of <body>; a theme on <html> puts it at the
 * end of <body>, never after it). toast(null, ...), announce() and
 * savebar() use it.
 * @param {Document} [doc]
 * @returns {HTMLElement|null}
 */
export function toastRegion(doc = globalThis.document) {
  if (!doc?.querySelector) return null;
  const app = doc.querySelector('.ds-app');
  const theme = app?.closest('.ds-theme') ?? null;
  const found = (theme && ownOf(theme, '.ds-toasts')) ?? doc.querySelector('.ds-toasts');
  if (found) return /** @type {HTMLElement} */ (found);
  return newRegion(doc, app, doc.querySelector('.ds-theme') ?? doc.body);
}

/** The first `selector` match inside `theme` that is its own (not inside a nested .ds-theme, an embedded widget's). */
function ownOf(theme, selector) {
  return [...theme.querySelectorAll(selector)].find((node) => node.closest('.ds-theme') === theme) ?? null;
}

/**
 * A new empty .ds-toasts right after `app` (else the last child of
 * `parent`, <body> for a theme on <html>, as ask() places its dialog);
 * null when it is not in the document.
 */
function newRegion(doc, app, parent) {
  const region = doc.createElement('div');
  region.className = 'ds-toasts';
  if (app) app.after(region);
  else (parent === doc.documentElement && doc.body ? doc.body : parent)?.append(region);
  return region.isConnected ? region : null;
}

/**
 * The snackbar region of a built dialog's theme (`home` is where the
 * dialog went: the theme, or <body> for a theme on <html>): its own
 * region, else a new one after its .ds-app, which regionState() then
 * moves into the open dialog.
 */
function regionOfTheme(doc, theme, home) {
  if (!theme) return toastRegion(doc);
  return /** @type {HTMLElement|null} */ (ownOf(theme, '.ds-toasts')) ?? newRegion(doc, ownOf(theme, '.ds-app'), home);
}

/**
 * Says `text` to screen readers through the announcers of a snackbar
 * region (`region`, default toastRegion()), without showing a message:
 * polite, or assertive with `assertive: true`. The same text twice is
 * spoken twice; empty text does nothing. While a dialog or side sheet is
 * open the region (and its announcers) sit inside it, so the text is heard
 * there.
 * @param {string} text
 * @param {{ assertive?: boolean, region?: Element|null }} [options]
 */
export function announce(text, options = {}) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return;
  const region = options.region ?? toastRegion();
  if (!region?.ownerDocument) return;
  speak(region, regionState(region), { text: value, assertive: options.assertive === true });
}

/**
 * Shows a snackbar in `region` (a .ds-toasts element inside the
 * .ds-theme; null: toastRegion()). `content` is a .ds-toast element or a
 * string, from which it builds the documented message: the checkCircle
 * icon (alertCircle for kind 'error', info for 'info'), the text, the
 * `action` button and, for a message that stays, a close button (an
 * element message that stays without one gets it too). At most TOAST_LIMIT
 * show at once: a further one replaces the oldest that would close by
 * itself, or waits until one closes. Errors, `persistent` messages and
 * messages with an action, another button or a link never close by
 * themselves; the others close after `timeout` ms (default 4000ms plus
 * 50ms per character past 40, at most 10000ms; all stretched by
 * --ds-time-scale), paused while a pointer is over a message, focus is in
 * the region or the tab is hidden.
 *
 * The same message again (a string without action, same kind, same
 * `persistent`, same text) restarts the one on screen (its timer, its
 * announcement) and returns its handle; `restart: false` stacks it. A
 * message with the `key` of one on screen or waiting replaces it in place
 * (the old one's `closed` resolves). Messages that stay keep room in the
 * view, a hosting sheet's body or dialog (data-toast-reserve and
 * --ds-toast-reserve), unless `reserve: false`.
 * @param {Element|null} region
 * @param {Element|string} content
 * @param {{ kind?: 'success'|'error'|'info', persistent?: boolean, timeout?: number, closeLabel?: string,
 *   action?: { label: string, onClick?: (event: Event, handle: ToastHandle) => void },
 *   key?: string, restart?: boolean, reserve?: boolean }} [options]
 * @returns {ToastHandle}
 *   close() takes it away (a waiting one leaves the queue); closed resolves once it is gone
 */
export function toast(region, content, options = {}) {
  const target = region ?? (content == null ? null : toastRegion());
  const doc = target?.ownerDocument;
  if (!doc || content == null) return { el: null, close: () => Promise.resolve(), closed: Promise.resolve() };
  const state = regionState(target);
  const given = typeof content === 'object' && /** @type {Element} */ (content).nodeType === 1;
  const element = /** @type {HTMLElement} */ (given ? content : null);
  const kind = options.kind ?? (element?.classList.contains('ds-toast--error') ? 'error' : element?.classList.contains('ds-toast--info') ? 'info' : 'success');
  const label = !given && options.action ? String(options.action.label ?? '').trim() : '';
  const persistent = options.persistent === true || kind === 'error' || Boolean(label);
  const el = element ?? buildToast(doc, String(content), kind, persistent, options.closeLabel, label);
  // A message with an action waits for it (WCAG 2.2.1).
  const action = [...el.querySelectorAll('button, a[href]')].some((node) => !node.classList.contains('ds-toast__close'));
  // A message that stays can always be closed.
  if (given && persistent && !action && !el.querySelector('.ds-toast__close')) el.append(closeButton(doc, options.closeLabel));
  const text = ((el.querySelector('.ds-toast__text') ?? el).textContent ?? '').replace(/\s+/g, ' ').trim();
  // The announcers speak; a live message would be read twice.
  if (/^(alert|status)$/.test(el.getAttribute('role') ?? '')) el.removeAttribute('role');
  el.removeAttribute('aria-live');
  const explicit = options.key != null && options.key !== '';
  const key = explicit ? String(options.key) : !given && !label && options.restart !== false ? `restart:${kind}:${persistent}:${normalText(text)}` : null;
  const match = key ? [...state.shown, ...state.queue].find((other) => other.key === key && (other.phase === 'shown' || other.phase === 'queued')) : null;
  if (match && (!explicit || match.el === el)) {
    // The same message again: nothing moves, it starts over (or keeps its place in the queue).
    if (match.phase === 'shown') restartToast(match, target, state);
    return match.handle;
  }
  const timeout = toastTimeout(target, text, options);
  let done = () => {};
  const closed = new Promise((resolve) => {
    done = () => resolve(undefined);
  });
  const stays = persistent || action || !Number.isFinite(timeout);
  /** @type {Toast} */
  const entry = {
    el, region: target, kind, key, stays, reserve: stays && options.reserve !== false, assertive: kind === 'error', text,
    timeout, remaining: timeout, timer: 0, started: 0, phase: 'queued', done, closed,
    onAction: label && typeof options.action?.onClick === 'function' ? options.action.onClick : null,
    handle: /** @type {ToastHandle} */ (/** @type {unknown} */ (null)),
  };
  entry.handle = { el, close: () => closeToast(entry), closed };
  toastEntries.set(el, entry);
  if (match) replaceToast(target, state, match, entry);
  else {
    state.queue.push(entry);
    updateToasts(target, state, []);
  }
  return entry.handle;
}

/**
 * Closes every message of `region` (default toastRegion()) on screen or
 * waiting that matches `kind` and `key` (both optional: no filter closes
 * all), as one change of the stack. Resolves once they are gone.
 * @param {Element|null} [region]
 * @param {{ kind?: 'success'|'error'|'info', key?: string }} [filter]
 * @returns {Promise<void>}
 */
export function closeToasts(region, filter = {}) {
  const target = region ?? toastRegion();
  const state = target ? toastRegions.get(target) : null;
  if (!state) return Promise.resolve();
  const matches = (entry) => (filter.kind == null || entry.kind === filter.kind) && (filter.key == null || entry.key === String(filter.key));
  const queued = state.queue.filter(matches);
  const shown = state.shown.filter((entry) => entry.phase === 'shown' && matches(entry));
  for (const entry of queued) {
    state.queue.splice(state.queue.indexOf(entry), 1);
    finishToast(entry);
  }
  if (shown.length) updateToasts(target, state, shown);
  return Promise.all([...queued, ...shown].map((entry) => entry.closed)).then(() => undefined);
}

/** Takes a message away: a waiting one leaves the queue, a shown one leaves the stack. */
function closeToast(entry) {
  const state = toastRegions.get(entry.region);
  if (!state) return entry.closed;
  if (entry.phase === 'queued') {
    state.queue.splice(state.queue.indexOf(entry), 1);
    finishToast(entry);
  } else if (entry.phase === 'shown') updateToasts(entry.region, state, [entry]);
  return entry.closed;
}

function finishToast(entry) {
  if (entry.phase === 'gone') return;
  entry.phase = 'gone';
  disarm(entry);
  toastEntries.delete(entry.el);
  entry.done();
}

/** The same message on screen again: its timer starts over and its text is said again; nothing moves. */
function restartToast(entry, region, state) {
  disarm(entry);
  entry.remaining = entry.timeout;
  arm(entry, region, state);
  speak(region, state, entry);
}

/**
 * A message with the key of `old` takes its place: in the queue, its
 * slot; on screen, inside one flip() the old one fades out where it is and
 * the new one enters in its slot. Focus inside the old one moves to the
 * new one's close button.
 */
function replaceToast(region, state, old, entry) {
  if (old.phase === 'queued') {
    state.queue.splice(state.queue.indexOf(old), 1, entry);
    finishToast(old);
    return;
  }
  const focused = old.el.contains(activeIn(old.el));
  disarm(old);
  old.phase = 'leaving';
  state.shown.splice(state.shown.indexOf(old), 1, entry);
  entry.phase = 'shown';
  const moved = flip(region, (hooks) => {
    region.insertBefore(entry.el, old.el.parentNode === region ? old.el : null);
    const leaving = hooks.onRemove(old.el);
    if (leaving) leaving.then(() => finishToast(old));
    else {
      old.el.remove();
      finishToast(old);
    }
  });
  if (focused) {
    const button = entry.el.querySelector('.ds-toast__close');
    if (canFocus(button)) /** @type {HTMLElement} */ (button).focus({ preventScroll: true });
    else releaseToastFocus(old, region, state, state.shown.filter((other) => other !== entry));
  }
  shownNow(region, state, [entry], moved);
}

/**
 * Moves focus off a message that leaves: to the close button of the next
 * message that stays (else the one before), else to where focus came from
 * into the region, else to the view (tabindex="-1"). Never <body>.
 */
function releaseToastFocus(entry, region, state, staying) {
  const doc = region.ownerDocument;
  if (!entry.el.contains(activeIn(entry.el))) return;
  const others = staying.filter((other) => other.el.parentNode === region);
  const after = others.filter((other) => entry.el.compareDocumentPosition(other.el) & 4);
  const before = others.filter((other) => !after.includes(other)).reverse();
  const buttons = [...after, ...before].map((other) => other.el.querySelector('.ds-toast__close'));
  const origin = state.origin && !region.contains(state.origin) ? state.origin : null;
  const view = region.closest('[tabindex="-1"]') ?? doc.querySelector(LANDMARK);
  const target = [...buttons, origin, view].find((node) => canFocus(node) && !entry.el.contains(node));
  target?.focus({ preventScroll: true });
}

/**
 * Brings the stack in line: `closing` leaves, waiting messages fill free
 * places or replace the oldest message that would close by itself. One
 * flip() for all of it, so the messages that stay glide to their places
 * while the new ones enter and the old ones fade out in place.
 */
function updateToasts(region, state, closing) {
  const next = state.shown.filter((entry) => !closing.includes(entry));
  const added = [];
  while (state.queue.length) {
    if (next.length >= TOAST_LIMIT) {
      const oldest = next.findIndex((entry) => !entry.stays);
      if (oldest < 0) break;
      next.splice(oldest, 1);
    }
    const entry = /** @type {Toast} */ (state.queue.shift());
    next.push(entry);
    added.push(entry);
  }
  const removed = state.shown.filter((entry) => !next.includes(entry));
  const entering = added.filter((entry) => next.includes(entry));
  // Replaced before it ever showed (several entered at once): gone at once.
  for (const entry of added) if (!next.includes(entry)) finishToast(entry);
  if (!removed.length && !entering.length) return;
  for (const entry of removed) {
    disarm(entry);
    entry.phase = 'leaving';
  }
  // The first message of an empty stack enters where the region rests now
  // (above a sheet's foot, the drawer's foot, a save bar): set at once.
  if (!state.shown.length && entering.length) writeLift(region, liftOf(region));
  state.shown = next;
  for (const entry of removed) releaseToastFocus(entry, region, state, next.filter((other) => !entering.includes(other)));
  const moved = flip(region, (hooks) => {
    for (const entry of removed) {
      const leaving = hooks.onRemove(entry.el);
      if (leaving) leaving.then(() => finishToast(entry));
      else {
        entry.el.remove();
        finishToast(entry);
      }
    }
    for (const entry of entering) {
      entry.phase = 'shown';
      region.append(entry.el);
    }
  });
  shownNow(region, state, entering, moved);
}

/**
 * After a change of the stack: the new messages are said and timed, their
 * entrance is marked played, and once it all settled the room for the
 * messages that stay is measured again.
 */
function shownNow(region, state, entering, moved) {
  const landed = entering.map((entry) => {
    speak(region, state, entry);
    arm(entry, region, state);
    // Played once: a later move of the region (a side sheet) does not replay it.
    const played = settled(entry.el);
    played.then(() => {
      if (entry.phase !== 'shown') return;
      // For good: a re-render never replays the entrance.
      own(entry.el, 'classes', 'ds-toast--shown');
      entry.el.classList.add('ds-toast--shown');
    });
    return played;
  });
  Promise.all([moved, ...landed]).then(() => reserveRoom(region, state));
}

/* ── Room for messages that stay, and the lift ───────── */

/** The open dialog or side sheet a region shows in (not one that is leaving), else null: the page. */
function hostOf(region) {
  const homes = toastHomes.get(region);
  const last = homes?.[homes.length - 1];
  return last && !last.leaving ? last.host : null;
}

/**
 * Where a region keeps room for messages that stay: a hosting dialog, a
 * hosting sheet's body, else the .ds-view of its app. A layer the page
 * marked data-ds-toast-room="off" keeps none (a fixed view that must not
 * shrink); the others still do. Read at every measure, so a toggle
 * applies on the next change of the stack.
 */
function reserveTarget(region) {
  const host = hostOf(region);
  const node = /** @type {HTMLElement|null} */ (host
    ? (host.matches('.ds-dialog') ? host : host.querySelector('.ds-sheet__body'))
    : appOf(region)?.querySelector('.ds-view') ?? null);
  return node?.getAttribute('data-ds-toast-room') === 'off' ? null : node;
}

/** Gives the room back: the attribute and the property toast() wrote go. */
function releaseReserve(state) {
  state.observer?.disconnect();
  state.observer = null;
  const node = state.reserved;
  if (!node) return;
  state.reserved = null;
  node.removeAttribute('data-toast-reserve');
  node.style.removeProperty('--ds-toast-reserve');
  disown(node, 'attrs', 'data-toast-reserve');
  disown(node, 'props', '--ds-toast-reserve');
}

/**
 * While messages that stay show, the scroller of their layer keeps room
 * for them at its end: data-toast-reserve and --ds-toast-reserve = how far
 * the highest of them reaches into it, rounded up. In a hosting dialog the
 * box makes room only while it would overlap the stack: the stack, its
 * distance from the bottom edge and --ds-space-3 (the box re-centres). A
 * focused element (or where focus came from) under the stack scrolls
 * clear. Measured after every change of the stack settled, after the
 * region moved and when the region resizes (one ResizeObserver, while
 * held).
 */
function reserveRoom(region, state) {
  const staying = state.shown.filter((entry) => entry.phase === 'shown' && entry.reserve && entry.el.parentNode === region);
  const node = staying.length && region.isConnected ? reserveTarget(region) : null;
  if (state.reserved && state.reserved !== node) releaseReserve(state);
  if (!node) return;
  const top = Math.min(...staying.map((entry) => entry.el.getBoundingClientRect().top));
  let room = 0;
  if (node.matches('.ds-dialog')) {
    const box = node.querySelector('.ds-dialog__box') ?? node;
    const applied = state.reserved === node ? parseFloat(node.style.getPropertyValue('--ds-toast-reserve')) || 0 : 0;
    // Where the box would rest without the room: it re-centres by half of it.
    if (box.getBoundingClientRect().bottom + applied / 2 <= top) {
      releaseReserve(state);
      return;
    }
    const doc = region.ownerDocument;
    room = (doc.documentElement.clientHeight || viewOf(region).innerHeight) - top + pxOf(region, '--ds-space-3', 12);
  } else room = node.getBoundingClientRect().bottom - top;
  if (state.reserved !== node) {
    own(node, 'attrs', 'data-toast-reserve');
    own(node, 'props', '--ds-toast-reserve');
    state.reserved = node;
  }
  node.setAttribute('data-toast-reserve', '');
  node.style.setProperty('--ds-toast-reserve', `${Math.ceil(Math.max(0, room))}px`);
  const Observer = viewOf(region).ResizeObserver;
  if (!state.observer && typeof Observer === 'function') {
    let first = true;
    state.observer = new Observer(() => {
      // The first call only reports the size it starts with.
      if (first) first = false;
      else reserveRoom(region, state);
    });
    state.observer.observe(region);
  }
  if (node.matches('.ds-dialog')) return;
  for (const el of new Set([activeIn(node), state.origin])) {
    if (!el || el === node || !node.contains(el) || typeof el.scrollIntoView !== 'function') continue;
    if (el.getBoundingClientRect().bottom > top) el.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * How far a region rises above its resting bottom (px): above a hosting
 * side sheet's foot; on the page above the open modal drawer's foot on
 * phones and above a shown save bar of its theme.
 */
function liftOf(region) {
  const gap = pxOf(region, '--ds-space-2', 8);
  const above = (node) => (node && node.offsetHeight > 0 ? node.offsetHeight + gap : 0);
  const host = hostOf(region);
  if (host) return host.matches('.ds-sheet') ? above(host.querySelector('.ds-sheet__foot')) : 0;
  let lift = 0;
  const app = appOf(region);
  if (app?.hasAttribute('data-drawer-open') && viewOf(region).matchMedia?.(PHONE_QUERY).matches) lift = above(app.querySelector('.ds-drawer .ds-drawer__foot'));
  const theme = region.closest('.ds-theme');
  for (const bar of shownSavebars) if (bar.element.closest('.ds-theme') === theme) lift = Math.max(lift, bar.lift(region));
  return lift;
}

/** Writes (or removes) a region's --ds-toast-lift, owned while set. */
function writeLift(region, px) {
  const state = regionState(region);
  const style = /** @type {HTMLElement} */ (region).style;
  if (px > 0.5) {
    style.setProperty('--ds-toast-lift', `${round(px)}px`);
    if (!state.lifted) own(region, 'props', '--ds-toast-lift');
    state.lifted = true;
  } else {
    style.removeProperty('--ds-toast-lift');
    if (state.lifted) disown(region, 'props', '--ds-toast-lift');
    state.lifted = false;
  }
}

/** The lift of a region on the page changed (a save bar, the drawer): its messages glide there. */
function liftRegion(region) {
  const next = liftOf(region);
  const now = parseFloat(/** @type {HTMLElement} */ (region).style.getPropertyValue('--ds-toast-lift')) || 0;
  if (Math.abs(next - now) < 0.5) return;
  const state = regionState(region);
  glideRegion(region, next > now ? 'enter' : 'exit', () => writeLift(region, next)).then(() => reserveRoom(region, state));
}

/* ── Snackbars inside an open dialog or side sheet ───── */

/** Moves the region (and its announcers) before `before` in `parent`; focus inside stays. */
function moveRegion(region, parent, before) {
  const state = toastRegions.get(region);
  const active = activeIn(region);
  const refocus = active && region.contains(active) ? active : null;
  const nodes = [region, state?.polite, state?.assertive].filter((node) => node && node.parentNode === region.parentNode);
  const anchor = before && before.parentNode === parent ? before : null;
  for (const node of nodes) {
    if (typeof parent.moveBefore === 'function') {
      try {
        parent.moveBefore(node, anchor);
        continue;
      } catch {
        // Not movable here (another document, a disconnected parent): insert.
      }
    }
    parent.insertBefore(node, anchor);
  }
  if (refocus && activeIn(refocus) !== refocus && canFocus(refocus)) refocus.focus({ preventScroll: true });
}

/**
 * Applies `move` (a DOM move, a new --ds-toast-left or --ds-toast-lift)
 * and lets the messages glide from where they are on screen to the new
 * place on both axes, through the region's own translate transition
 * (--ds-toast-shift and --ds-toast-shift-y: set, flushed, cleared) with the
 * timing of data-follow. A region without messages just moves, without
 * measuring; one whose place does not change by half a pixel on either
 * axis (phones, a dialog) moves without a glide. Resolves once the glide
 * ended.
 * @returns {Promise<void>}
 */
function glideRegion(region, direction, move) {
  const style = /** @type {HTMLElement} */ (region).style;
  const run = (followRuns.get(region) ?? 0) + 1;
  followRuns.set(region, run);
  // Nothing on screen to glide: it just moves, without a measurement or a
  // style flush, so opening a div-trap overlay does not lay the page out
  // once more before its inert changes invalidate it again.
  if (![...region.children].some((child) => child.matches('.ds-toast:not([data-ds-leaving])'))) {
    style.removeProperty('--ds-toast-shift');
    style.removeProperty('--ds-toast-shift-y');
    move();
    region.removeAttribute('data-follow');
    return Promise.resolve();
  }
  const transition = style.transition;
  const from = region.getBoundingClientRect();
  style.transition = 'none';
  style.removeProperty('--ds-toast-shift');
  style.removeProperty('--ds-toast-shift-y');
  move();
  const to = region.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.bottom - to.bottom;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
    flushStyle(region);
    style.transition = transition;
    region.removeAttribute('data-follow');
    return Promise.resolve();
  }
  style.setProperty('--ds-toast-shift', `${round(dx)}px`);
  style.setProperty('--ds-toast-shift-y', `${round(dy)}px`);
  flushStyle(region);
  region.setAttribute('data-follow', direction);
  style.transition = transition;
  style.removeProperty('--ds-toast-shift');
  style.removeProperty('--ds-toast-shift-y');
  return settled(region, { transitions: true }).then(() => {
    if (followRuns.get(region) === run) region.removeAttribute('data-follow');
  });
}

/**
 * An opening dialog or side sheet takes in every .ds-toasts region of its
 * theme (with their announcers; not one inside a nested .ds-theme, an
 * embedded widget's), so a message shown meanwhile is above its
 * scrim and usable: in the top layer of a native one, outside the inert
 * page of the div trap. In a sheet --ds-toast-left becomes the panel's
 * resting left edge plus --ds-space-6 and --ds-toast-lift the height of
 * its foot, and the messages glide there; in a dialog the region keeps its
 * place. Closing ('exit'), each region glides back to its old place while
 * it stays inside: Chromium keeps a closing native dialog in the top
 * layer, so a region already on the page would fall under its leaving
 * scrim and panel. Once the exit settled ('settle'), it goes back to where
 * it was, with its --ds-toast-left; an open() during the exit glides it
 * back to the panel. Overlays over each other nest.
 * @param {Element} host
 * @param {'enter'|'exit'|'settle'} step
 */
function hostToasts(host, step) {
  const doc = host.ownerDocument;
  const theme = host.closest('.ds-theme');
  const scope = !theme || theme === doc.documentElement ? doc : theme;
  // Only the regions of its own theme: one inside a nested .ds-theme (an
  // embedded widget's) stays in its widget, under the modal like the rest of it.
  const regions = new Set([...scope.querySelectorAll('.ds-toasts')].filter((region) => !theme || region.closest('.ds-theme') === theme));
  // A hosted region is found even if it left the document meanwhile.
  if (step !== 'enter') for (const region of hostedRegions.keys()) regions.add(region);
  for (const region of regions) {
    if (step === 'enter') followInto(region, host);
    else if (step === 'exit') followOut(region, host);
    else giveRegionBack(region, host);
  }
}

/** Where a region rests inside `host`, in px: a sheet's panel edge (its layout box, whatever its translate is now) plus --ds-space-6; NaN for a dialog. */
function hostedLeft(region, host) {
  const panel = host.matches('.ds-sheet') ? host.querySelector('.ds-sheet__panel') : null;
  if (!panel) return NaN;
  return host.getBoundingClientRect().left + host.clientLeft + /** @type {HTMLElement} */ (panel).offsetLeft + pxOf(region, '--ds-space-6', 24);
}

/** After a move of the region: the room for its messages that stay follows it to the new layer. */
function roomAfter(region, glide) {
  const state = toastRegions.get(region);
  if (!state) return;
  reserveRoom(region, state);
  glide.then(() => reserveRoom(region, state));
}

function followInto(region, host) {
  const homes = toastHomes.get(region) ?? [];
  const own = homes.find((home) => home.host === host);
  if (own) {
    // Reopened during its exit: the region is still inside, gliding back.
    if (own.leaving) {
      own.leaving = false;
      const left = hostedLeft(region, host);
      roomAfter(region, glideRegion(region, 'enter', () => {
        if (Number.isFinite(left)) /** @type {HTMLElement} */ (region).style.setProperty('--ds-toast-left', `${round(left)}px`);
        writeLift(region, liftOf(region));
      }));
    }
    return;
  }
  if (host.contains(region)) return;
  if (host.matches('.ds-sheet') && !host.querySelector('.ds-sheet__panel')) return;
  const state = toastRegions.get(region);
  let next = region.nextSibling;
  while (next && (next === state?.polite || next === state?.assertive)) next = next.nextSibling;
  // Where the region stands: a dialog keeps it (its rule beside the drawer
  // would no longer match inside), and closing glides back to it.
  const at = parseFloat(viewOf(region).getComputedStyle?.(region).left ?? '');
  homes.push({ host, parent: /** @type {Node} */ (region.parentNode), next, left: /** @type {HTMLElement} */ (region).style.getPropertyValue('--ds-toast-left'), at, leaving: false });
  toastHomes.set(region, homes);
  // Away from home, the region and its announcers carry data-ds-keep: a
  // re-render of the open dialog (or of the view holding it) keeps them.
  if (!hostedRegions.has(region)) {
    hostedRegions.set(region, [region, state?.polite, state?.assertive].filter((node) => node && node.parentNode === region.parentNode && keepAway(node)));
  }
  const sheetLeft = hostedLeft(region, host);
  const left = Number.isFinite(sheetLeft) ? sheetLeft : at;
  roomAfter(region, glideRegion(region, 'enter', () => {
    moveRegion(region, host, null);
    if (Number.isFinite(left)) /** @type {HTMLElement} */ (region).style.setProperty('--ds-toast-left', `${round(left)}px`);
    // Above the sheet's foot (none in a dialog), measured now that it is in.
    if (state) writeLift(region, liftOf(region));
  }));
}

/** A later overlay took the region from the one at `index`: its home becomes the later one's. */
function passHome(homes, index) {
  const home = homes[index];
  Object.assign(homes[index + 1], { parent: home.parent, next: home.next, left: home.left, at: home.at });
  homes.splice(index, 1);
}

function followOut(region, host) {
  const homes = toastHomes.get(region);
  const index = homes ? homes.findIndex((home) => home.host === host) : -1;
  if (!homes || index < 0) return;
  // The region sits in a later overlay, which took it from this one: it
  // goes back to where this one took it from (and glides there now if
  // that overlay is leaving too).
  if (index < homes.length - 1) {
    passHome(homes, index);
    if (homes[homes.length - 1].leaving) glideHome(region, homes[homes.length - 1]);
    return;
  }
  homes[index].leaving = true;
  glideHome(region, homes[index]);
}

/** Glides the region, still inside its host, to the left and the lift it has at `home`. */
function glideHome(region, home) {
  const lift = toastRegions.has(region) ? liftOf(region) : 0;
  roomAfter(region, glideRegion(region, 'exit', () => {
    if (Number.isFinite(home.at)) /** @type {HTMLElement} */ (region).style.setProperty('--ds-toast-left', `${round(home.at)}px`);
    if (toastRegions.has(region)) writeLift(region, lift);
  }));
}

/**
 * The regions a removed dialog or sheet took in go back to their place at
 * once (nothing to glide from: the host is gone).
 */
function releaseToasts(host) {
  const doc = host.ownerDocument;
  for (const region of new Set([...host.querySelectorAll('.ds-toasts'), ...doc.querySelectorAll('.ds-toasts')])) {
    const homes = toastHomes.get(region);
    const index = homes ? homes.findIndex((home) => home.host === host) : -1;
    if (index < 0) continue;
    if (index < homes.length - 1) {
      passHome(homes, index);
      continue;
    }
    homes[index].leaving = true;
    giveRegionBack(region, host, false);
  }
}

function giveRegionBack(region, host, glide = true) {
  const homes = toastHomes.get(region);
  const index = homes ? homes.findIndex((home) => home.host === host && home.leaving) : -1;
  if (!homes || index < 0) return;
  // An overlay opened during the exit took the region from this one.
  if (index < homes.length - 1) return passHome(homes, index);
  const home = homes[index];
  homes.pop();
  if (!homes.length) {
    toastHomes.delete(region);
    for (const node of hostedRegions.get(region) ?? []) keepHome(node, true);
    hostedRegions.delete(region);
  }
  const parent = home.parent.isConnected ? home.parent : host.parentNode;
  if (!parent) return;
  const move = () => {
    moveRegion(region, parent, home.next);
    const style = /** @type {HTMLElement} */ (region).style;
    if (home.left) style.setProperty('--ds-toast-left', home.left);
    else style.removeProperty('--ds-toast-left');
    if (toastRegions.has(region)) writeLift(region, liftOf(region));
  };
  // It already stands at its place: nothing moves, unless that place
  // changed meanwhile (a resize past the drawer's breakpoint), then it
  // glides. The room it kept in the dialog or sheet goes with it.
  roomAfter(region, glide ? glideRegion(region, 'exit', move) : (move(), Promise.resolve()));
}
/* ── Tooltips ───────────────────────────────────────── */

let tooltipWarned = false;

/** Top layer and CSS anchor positioning, both needed for the anchored path. */
function supportsAnchoring(view) {
  const proto = view.HTMLElement?.prototype ?? {};
  return typeof proto.showPopover === 'function' && typeof view.CSS?.supports === 'function'
    && view.CSS.supports('position-area: block-end') && 'anchorName' in view.document.documentElement.style;
}

/** A close enough accessible name: aria-labelledby, aria-label, else the text. */
function accessibleName(node) {
  const doc = node.ownerDocument;
  const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  if (ids.length) return ids.map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
  return node.getAttribute('aria-label') ?? node.textContent ?? '';
}

/** A tap on touch moves at most this far (px, a distance) between pointerdown and pointerup. */
const TAP_SLOP_PX = 10;

/** How many descendants of a trigger the cut-off check measures, at most. */
const CUT_DESCENDANTS = 24;

/** How many ancestors with the trigger's text the cut-off check measures (a td around a link), at most. */
const CUT_ANCESTORS = 3;

/**
 * The text a trigger shows, normalised like normalText(): its text nodes
 * that render (their parent has client rects), skipping .ds-sr,
 * [aria-hidden="true"], svg, and any element whose border box is at most
 * 1×1px (the .ds-sr declarations without the class: a collapsed adaptive
 * button's label, a rail's drawer label).
 */
function visibleText(trigger) {
  const doc = trigger.ownerDocument;
  const verdicts = new Map();
  const hidden = (element) => {
    for (let at = element; at && at !== trigger.parentElement; at = at.parentElement) {
      if (verdicts.has(at)) return verdicts.get(at);
      const box = at.getBoundingClientRect?.();
      const gone = at.matches('.ds-sr, [aria-hidden="true"], svg, svg *') || !at.getClientRects?.().length || (box && box.width <= 1 && box.height <= 1);
      if (gone) {
        verdicts.set(at, true);
        return true;
      }
      if (at === trigger) break;
    }
    verdicts.set(element, false);
    return false;
  };
  const walker = doc.createTreeWalker(trigger, 4);
  const parts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent && node.nodeValue?.trim() && !hidden(parent)) parts.push(node.nodeValue);
  }
  return normalText(parts.join(' '));
}

/** Whether a box clips its content: overflow other than visible and more content than room. */
function clips(element) {
  const style = viewOf(element).getComputedStyle?.(element);
  if (!style || (style.overflowX === 'visible' && style.overflowY === 'visible')) return false;
  return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
}

/**
 * Whether the tooltip of `trigger` is wanted now. A tip that differs from
 * the text the trigger shows always is (an icon button, a label hidden on
 * phones, a collapsed rail); a tip that repeats it only while that text is
 * cut off: the trigger, one of its first descendants or one of the
 * ancestors that hold just its text (a td around a link) clips it.
 * @returns {'adds'|'cut'|null} why it shows (a cut-off text is never a description), or null: not now
 */
function tipWanted(trigger) {
  const tip = normalText(trigger.getAttribute('data-tip'));
  if (!tip) return null;
  const text = visibleText(trigger);
  if (text !== tip) return 'adds';
  if (clips(trigger)) return 'cut';
  const descendants = trigger.querySelectorAll('*');
  for (let index = 0; index < descendants.length && index < CUT_DESCENDANTS; index += 1) if (clips(descendants[index])) return 'cut';
  let at = trigger.parentElement;
  for (let step = 0; at && step < CUT_ANCESTORS && normalText(at.textContent) === text; step += 1, at = at.parentElement) {
    if (clips(at)) return 'cut';
  }
  return null;
}

function focusVisible(node) {
  try {
    return node.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Tooltips for every [data-tip] trigger inside `root` (the attribute holds
 * the text), through one set of delegated listeners and one
 * <div class="ds-tooltip" role="tooltip"> that it creates inside the
 * .ds-theme around `root` (warns once if there is none). A mouse or pen
 * that rests on a trigger shows it after --ds-delay-tooltip; keyboard
 * focus (:focus-visible) shows it at once. On touch a tap on an image
 * ([role="img"]) or a blocked control ([aria-disabled="true"]) shows it at
 * once and a second tap hides it; a long press of --ds-delay-tooltip on any
 * other trigger but a link shows it and swallows the click and the context
 * menu that follow; it stays until the next pointerdown, a scroll or
 * Escape (no timeout: WCAG 1.4.13).
 * A tip that repeats the text the trigger shows shows only while that
 * text is cut off (tipWanted()), and never describes it.
 * While one shows, or within --ds-delay-tooltip-skip of the last hide, the
 * next trigger shows at once: a visible tooltip swaps text and place in
 * place, a hidden one only fades in (data-warm). It hides after the
 * --ds-delay-tooltip-hide grace, which the pointer may use to move onto
 * it; at once on Escape (the key is then the tooltip's: the dialog under
 * it stays open), on any pointerdown, on DS.overlay.open(), when its
 * trigger scrolls out of view, and when its trigger leaves the document
 * (a MutationObserver on the root, connected only while it shows). While
 * shown, the trigger is described by it (aria-describedby), unless its
 * accessible name says the same.
 * Placement: below the trigger, above it without room; with popover and
 * anchor positioning in the top layer, else by --ds-tooltip-x/-y. A second
 * call on the same root returns the first handle (also one of another
 * copy of ds.js), and a trigger inside nested roots (a host page's
 * document and an embedded widget's root) is served by the innermost one.
 * An open shadow root works as a root too (the tooltip goes into the
 * .ds-theme inside it).
 * @param {Document|Element|ShadowRoot} [root]
 * @returns {{ destroy: () => void }}
 */
export function tooltips(root = globalThis.document) {
  const doc = root?.nodeType === 9 ? /** @type {Document} */ (root) : root?.ownerDocument;
  if (!doc) return { destroy() {} };
  const view = doc.defaultView ?? globalThis;
  // A shadow root stays itself: its listeners see the real targets (the
  // document sees the host), and its theme is the .ds-theme inside it,
  // where ds.css applies.
  const shadow = root.nodeType === 11;
  const rootElement = root.nodeType === 9 ? doc.documentElement : /** @type {Element} */ (root);
  // One controller per root (whichever copy of ds.js made it): a second call returns the first.
  const roots = sharedOf(doc).tipRoots;
  const existing = roots.get(rootElement);
  if (existing) return existing;
  watchModality(doc);
  const theme = shadow ? /** @type {ShadowRoot} */ (root).querySelector('.ds-theme')
    : rootElement.closest('.ds-theme') ?? (root.nodeType === 9 ? doc.querySelector('.ds-theme') : null);
  if (!theme && !tooltipWarned) {
    tooltipWarned = true;
    view.console?.warn('Dashboard-Style: DS.overlay.tooltips() on a root outside .ds-theme. The tooltip must sit inside the .ds-theme element, or it gets neither the tokens nor the motion.');
  }
  const anchored = supportsAnchoring(view);
  const home = !theme || theme === doc.documentElement ? doc.body : theme;

  const tip = doc.createElement('div');
  tip.className = 'ds-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.id = `ds-tooltip-${sharedOf(doc).seq += 1}`;
  tip.hidden = true;
  tip.setAttribute('data-state', 'closed');
  if (anchored) {
    tip.setAttribute('popover', 'manual');
    tip.setAttribute('data-anchored', '');
  }
  tooltipNodes.add(tip);
  // A runtime node: a re-render of the theme (DS.dom.morphHtml) keeps it.
  tip.setAttribute('data-ds-keep', '');
  home.append(tip);

  /** @type {'hidden'|'open'|'closing'} */
  let phase = 'hidden';
  let trigger = /** @type {Element|null} */ (null);
  let hovering = false;
  let focusing = false;
  let showTimer = /** @type {any} */ (0);
  let hideTimer = /** @type {any} */ (0);
  let lastHide = -Infinity;
  let run = 0;
  let frame = 0;
  let ownAnchor = /** @type {HTMLElement|null} */ (null);
  let described = /** @type {Element|null} */ (null);
  // Touch: the press under way, whether the tooltip on screen came from
  // touch, and the listener that swallows what a long press ends in.
  let press = /** @type {{ trigger: Element, id: number, x: number, y: number, timer: any } | null} */ (null);
  let touchShown = false;
  let swallow = /** @type {((event: Event) => void) | null} */ (null);
  // The trigger leaving the document hides the tooltip at once (connected while it shows).
  const Observer = view.MutationObserver;
  const watcher = typeof Observer === 'function' ? new Observer(() => {
    if (phase !== 'hidden' && trigger && !trigger.isConnected) hideNow();
  }) : null;
  let watching = false;

  const time = (token) => motionDuration(tip.isConnected ? tip : shadow ? theme ?? /** @type {ShadowRoot} */ (root).host : rootElement, token);
  const contains = (node) => (root.nodeType === 9 ? doc.contains(node) : rootElement.contains(node));

  /** Where the tooltip lives for a trigger: its overlay (in the top layer, never inert), else the theme. */
  function hostFor(node) {
    return node.closest('dialog[open], .ds-dialog:not(.ds-dialog--contained), .ds-sheet') ?? home;
  }

  /** Points the tooltip at `next`, through a name shared with a popup anchored there (claimAnchor). */
  function anchorTo(next) {
    if (!anchored || (ownAnchor && ownAnchor === next)) return;
    unanchor();
    const { name, mine } = claimAnchor(next, view);
    if (mine) ownAnchor = /** @type {HTMLElement} */ (next);
    tip.style.setProperty('position-anchor', name);
  }

  function unanchor() {
    releaseAnchor(ownAnchor);
    ownAnchor = null;
  }

  /** Marks the side the engine put an anchored tooltip on; true when that changed. */
  function readSide(next) {
    const box = tip.getBoundingClientRect();
    const top = box.bottom <= next.getBoundingClientRect().top + 1;
    if (top === tip.hasAttribute('data-placement')) return false;
    if (top) tip.setAttribute('data-placement', 'top');
    else tip.removeAttribute('data-placement');
    return true;
  }

  /** Below the trigger, centred and clamped to the viewport; above it when there is no room below. */
  function place(next) {
    if (anchored) {
      // The engine places it; its side sets the origin. Chromium lays a
      // swap out with what it took from the previous anchor at the last
      // rendering (the scroll offset of a box around it: from a trigger in
      // a scrolled box it read "top" for a tooltip that then sits below),
      // so the side read now is a guess, read again once two frames have
      // rendered; the origin follows a corrected side.
      readSide(next);
      const mine = run;
      nextFrame(doc, () => nextFrame(doc, () => {
        if (mine !== run || phase !== 'open' || trigger !== next || !tip.isConnected) return;
        if (readSide(next)) originFrom(next, tip);
      }));
      return;
    }
    const rect = next.getBoundingClientRect();
    const gap = pxOf(tip, '--ds-space-2', 8);
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const viewWidth = doc.documentElement.clientWidth || view.innerWidth;
    const viewHeight = doc.documentElement.clientHeight || view.innerHeight;
    const x = Math.max(gap, Math.min(viewWidth - width - gap, rect.left + rect.width / 2 - width / 2));
    let y = rect.bottom + gap;
    const above = y + height > viewHeight - gap && rect.top - gap - height >= gap;
    if (above) y = rect.top - gap - height;
    const origin = fixedOrigin(tip);
    tip.style.setProperty('--ds-tooltip-x', `${round(x - origin.left)}px`);
    tip.style.setProperty('--ds-tooltip-y', `${round(y - origin.top)}px`);
    if (above) tip.setAttribute('data-placement', 'top');
    else tip.removeAttribute('data-placement');
  }

  function describe(next, why) {
    undescribe();
    // A cut-off text read again adds nothing.
    if (why === 'cut' || normalText(tip.textContent) === normalText(accessibleName(next))) return;
    const ids = (next.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (!ids.includes(tip.id)) next.setAttribute('aria-describedby', [...ids, tip.id].join(' '));
    own(next, 'attrs', 'aria-describedby');
    described = next;
  }

  function undescribe() {
    if (!described) return;
    const ids = (described.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== tip.id);
    if (ids.length) described.setAttribute('aria-describedby', ids.join(' '));
    else described.removeAttribute('aria-describedby');
    disown(described, 'attrs', 'aria-describedby');
    described = null;
  }

  function cancelTimers() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = 0;
    hideTimer = 0;
  }

  /** Shows the tooltip of `next` now (if it is wanted now): in place when one is visible, else from its closed state. */
  function show(next, touch = false) {
    cancelTimers();
    const text = next.getAttribute('data-tip') ?? '';
    // The opener of an open menu (or dialog) shows no tip: it would cover
    // the layer or take the Escape that closes it.
    const why = next.isConnected && !opensOpenLayer(next) ? tipWanted(next) : null;
    if (!text.trim() || !why) return;
    touchShown = touch;
    if (watcher && !watching) {
      watcher.observe(shadow ? /** @type {ShadowRoot} */ (root) : rootElement, { childList: true, subtree: true });
      watching = true;
    }
    const host = hostFor(next);
    const visible = phase !== 'hidden' && tip.parentNode === host;
    const warm = !visible && clock() - lastHide < time('--ds-delay-tooltip-skip');
    run += 1;
    trigger = next;
    focusing = next === activeIn(next) && focusVisible(next);
    tip.textContent = text;
    if (visible) {
      // A swap (or a hide taken back): text and place change where it is,
      // and a fade still under way turns back from its current opacity.
      anchorTo(next);
      place(next);
      originFrom(next, tip);
      tip.setAttribute('data-state', 'open');
    } else {
      if (tip.parentNode !== host) {
        try {
          if (anchored && tip.matches(':popover-open')) tip.hidePopover();
        } catch {
          // Not open after all.
        }
        host.append(tip);
      }
      // The closed state at rest size (data-warm), so its place and the
      // origin at the anchor side are measured true.
      tip.setAttribute('data-state', 'closed');
      tip.setAttribute('data-warm', '');
      tip.hidden = false;
      anchorTo(next);
      if (anchored) {
        try {
          tip.showPopover();
        } catch {
          // Already open (a fade that just ended): it stays.
        }
      }
      place(next);
      originFrom(next, tip);
      if (!warm) {
        // Cold: from --ds-scale-tooltip at the anchor, without a transition to it.
        tip.style.transition = 'none';
        tip.removeAttribute('data-warm');
        flushStyle(tip);
        tip.style.removeProperty('transition');
      } else flushStyle(tip);
      tip.setAttribute('data-state', 'open');
    }
    phase = 'open';
    describe(next, why);
  }

  function unwatch() {
    if (!watching) return;
    watcher?.disconnect();
    watching = false;
  }

  /** The end of an exit: hidden, out of the top layer, unanchored. */
  function rest() {
    phase = 'hidden';
    trigger = null;
    touchShown = false;
    try {
      if (anchored && tip.matches(':popover-open')) tip.hidePopover();
    } catch {
      // Not open.
    }
    tip.hidden = true;
    unanchor();
    dropProbe(tip);
  }

  /** Starts the exit: a quick fade; once it settled the tooltip is hidden. */
  function hide() {
    cancelTimers();
    if (phase !== 'open') return;
    phase = 'closing';
    lastHide = clock();
    undescribe();
    unwatch();
    const mine = ++run;
    tip.setAttribute('data-state', 'closed');
    settled(tip, { transitions: true }).then(() => {
      if (mine !== run || phase !== 'closing') return;
      rest();
    });
  }

  /**
   * Its trigger left the document: hidden at once, without the fade (an
   * anchor that is gone would put it in a corner of the viewport, or leave
   * it at the old place).
   */
  function hideNow() {
    cancelTimers();
    if (phase === 'hidden') return;
    if (phase === 'open') lastHide = clock();
    undescribe();
    unwatch();
    run += 1;
    hovering = false;
    focusing = false;
    tip.style.transition = 'none';
    tip.setAttribute('data-state', 'closed');
    flushStyle(tip);
    tip.style.removeProperty('transition');
    rest();
  }

  /** Hides after the grace, unless the pointer or keyboard focus still holds it. */
  function hideLater() {
    clearTimeout(showTimer);
    showTimer = 0;
    if (hovering || focusing || phase !== 'open' || hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      if (!hovering && !focusing) hide();
    }, time('--ds-delay-tooltip-hide'));
  }

  /** The trigger of `node` that this controller serves: inside nested roots, the innermost one serves it. */
  const triggerOf = (node) => {
    const found = /** @type {Element|null} */ (node?.closest?.('[data-tip]') ?? null);
    if (!found || !contains(found)) return null;
    for (let at = /** @type {Element|null} */ (found); at; at = at.parentElement) {
      if (roots.has(at)) return at === rootElement ? found : null;
    }
    return found;
  };

  function onPointerOver(/** @type {PointerEvent} */ event) {
    if (event.pointerType === 'touch') return;
    const next = triggerOf(event.target);
    if (!next || next.contains(/** @type {Node} */ (event.relatedTarget))) return;
    // A tip that repeats a text that fits is not wanted: the pointer rests on nothing.
    if (!tipWanted(next)) return;
    hovering = true;
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (phase === 'open' && trigger === next) return;
    if (phase !== 'hidden' || clock() - lastHide < time('--ds-delay-tooltip-skip')) {
      show(next);
      return;
    }
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = 0;
      show(next);
    }, time('--ds-delay-tooltip'));
  }

  function onPointerOut(/** @type {PointerEvent} */ event) {
    if (event.pointerType === 'touch') return;
    const from = triggerOf(event.target);
    const to = /** @type {Node} */ (event.relatedTarget);
    if (!from || from.contains(to) || tip.contains(to)) return;
    hovering = false;
    hideLater();
  }

  function onTipOver(/** @type {PointerEvent} */ event) {
    if (event.pointerType === 'touch' || phase !== 'open') return;
    // Hoverable: the pointer crossed onto the tooltip within the grace.
    hovering = true;
    clearTimeout(hideTimer);
    hideTimer = 0;
  }

  function onTipOut(/** @type {PointerEvent} */ event) {
    if (event.pointerType === 'touch') return;
    const to = /** @type {Node} */ (event.relatedTarget);
    if (tip.contains(to) || trigger?.contains(to)) return;
    hovering = false;
    hideLater();
  }

  function onFocusIn(/** @type {FocusEvent} */ event) {
    const next = triggerOf(event.target);
    if (!next || !focusVisible(next) || !tipWanted(next)) return;
    hovering = false;
    show(next);
  }

  function onFocusOut(/** @type {FocusEvent} */ event) {
    const from = triggerOf(event.target);
    if (!from || from !== trigger || from.contains(/** @type {Node} */ (event.relatedTarget))) return;
    focusing = false;
    // A focusin on another trigger right after takes over in place.
    hideLater();
  }

  function onKeyDown(/** @type {KeyboardEvent} */ event) {
    if (event.key !== 'Escape' || event.defaultPrevented || !escape()) return;
    event.preventDefault();
    event.stopPropagation();
  }

  /** The element a pointer event began on, also inside an open shadow root. */
  const origin = (/** @type {Event} */ event) => /** @type {Element} */ (event.composedPath?.()[0] ?? event.target);

  /** On touch a tap shows the tip of an image or a blocked control; the others need a long press. */
  const tapShows = (node) => node.matches('[role="img"], [aria-disabled="true"]');

  function cancelPress() {
    if (press) clearTimeout(press.timer);
    press = null;
  }

  function unswallow() {
    if (!swallow) return;
    doc.removeEventListener('click', swallow, true);
    doc.removeEventListener('contextmenu', swallow, true);
    swallow = null;
  }

  /** A long press showed a tooltip: the click (and a context menu) it would end in never happen. */
  function swallowNext() {
    unswallow();
    swallow = (/** @type {Event} */ event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'click') unswallow();
    };
    doc.addEventListener('click', swallow, true);
    doc.addEventListener('contextmenu', swallow, true);
  }

  function onPointerDown(/** @type {PointerEvent} */ event) {
    clearTimeout(showTimer);
    showTimer = 0;
    unswallow();
    cancelPress();
    const next = event.pointerType === 'touch' ? triggerOf(origin(event)) : null;
    // The second tap on a trigger whose tip touch showed only hides it.
    const hidesOwn = Boolean(next) && phase === 'open' && touchShown && trigger === next;
    hide();
    if (!next || hidesOwn) return;
    press = { trigger: next, id: event.pointerId, x: event.clientX, y: event.clientY, timer: 0 };
    if (tapShows(next) || next.matches('a[href]')) return;
    // A long press: shown once the press held --ds-delay-tooltip (a link keeps its own long press).
    press.timer = setTimeout(() => {
      if (!press || press.trigger !== next) return;
      press = null;
      show(next, true);
      if (phase === 'open' && trigger === next) swallowNext();
    }, time('--ds-delay-tooltip'));
  }

  function onPointerMove(/** @type {PointerEvent} */ event) {
    if (!press || event.pointerId !== press.id) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX) cancelPress();
  }

  function onPointerUp(/** @type {PointerEvent} */ event) {
    if (!press || event.pointerId !== press.id) return;
    const next = press.trigger;
    const near = Math.hypot(event.clientX - press.x, event.clientY - press.y) <= TAP_SLOP_PX;
    cancelPress();
    if (near && tapShows(next) && triggerOf(origin(event)) === next) show(next, true);
  }

  function onScroll() {
    // A tip that touch showed goes with any scroll.
    if (phase === 'open' && touchShown) {
      hide();
      return;
    }
    if (phase !== 'open' || frame) return;
    const update = () => {
      frame = 0;
      if (phase !== 'open' || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const gone = !trigger.isConnected || rect.bottom <= 0 || rect.right <= 0 || rect.top >= view.innerHeight || rect.left >= view.innerWidth;
      if (gone) hide();
      else if (!anchored) place(trigger);
    };
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(update) : 0;
    if (!frame) update();
  }

  /**
   * Escape: hides a visible tooltip and reports whether the key was its.
   * It is not when an open layer lies over the trigger (a menu over its
   * opener's tip): the tooltip hides and the same Escape closes the layer.
   */
  function escape() {
    if (phase !== 'open') return false;
    const under = Boolean(trigger?.isConnected && layerOver(trigger));
    hovering = false;
    focusing = false;
    hide();
    return !under;
  }

  const controller = {
    hide() {
      clearTimeout(showTimer);
      showTimer = 0;
      hide();
    },
    escape,
  };
  tooltipControllers.add(controller);

  const target = /** @type {EventTarget} */ (root);
  target.addEventListener('pointerover', onPointerOver);
  target.addEventListener('pointerout', onPointerOut);
  target.addEventListener('focusin', onFocusIn);
  target.addEventListener('focusout', onFocusOut);
  tip.addEventListener('pointerover', onTipOver);
  tip.addEventListener('pointerout', onTipOut);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  doc.addEventListener('pointerup', onPointerUp, true);
  doc.addEventListener('pointercancel', cancelPress, true);
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  view.addEventListener('resize', onScroll);

  const handle = {
    destroy() {
      if (roots.get(rootElement) === handle) roots.delete(rootElement);
      tooltipControllers.delete(controller);
      cancelTimers();
      if (frame && typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(frame);
      target.removeEventListener('pointerover', onPointerOver);
      target.removeEventListener('pointerout', onPointerOut);
      target.removeEventListener('focusin', onFocusIn);
      target.removeEventListener('focusout', onFocusOut);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('pointermove', onPointerMove, { capture: true });
      doc.removeEventListener('pointerup', onPointerUp, true);
      doc.removeEventListener('pointercancel', cancelPress, true);
      doc.removeEventListener('scroll', onScroll, { capture: true });
      view.removeEventListener('resize', onScroll);
      cancelPress();
      unswallow();
      unwatch();
      undescribe();
      unanchor();
      dropProbe(tip);
      run += 1;
      phase = 'hidden';
      tip.remove();
    },
  };
  roots.set(rootElement, handle);
  return handle;
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
    view.console?.warn('Dashboard-Style: DS.overlay.savebar() outside .ds-view. The bar shows and hides, but no view keeps room for it or scrolls focus clear of it.');
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
    return [...scope.querySelectorAll('.ds-toasts')].filter((region) => (!theme || region.closest('.ds-theme') === theme) && !toastHomes.has(region));
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
    for (const region of regions()) liftRegion(region);
    const Observer = view.ResizeObserver;
    if (!observer && typeof Observer === 'function') {
      observer = new Observer(() => {
        if (!shown || bar.offsetHeight === height) return;
        measure();
        for (const region of regions()) liftRegion(region);
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
    for (const region of regions()) liftRegion(region);
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
      if (shownSavebars.delete(entry)) for (const region of regions()) liftRegion(region);
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
