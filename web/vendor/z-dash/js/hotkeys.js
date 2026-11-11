/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Keyboard shortcuts (3.0): one registry per document, combos that read
 * right on every platform, scopes, and the data of a shortcut sheet.
 *
 *   const save = DS.hotkeys.register('mod+s', store, { description: 'Save', group: 'Editing' });
 *   const board = DS.hotkeys.scope('board');     // its shortcuts count until board.destroy()
 *   DS.hotkeys.format('mod+s').text;             // '⌘S' on Apple systems, 'Ctrl+S' elsewhere
 *   DS.hotkeys.list();                           // the groups a shortcut sheet shows
 *   <button data-ds-hotkey="mod+k" data-ds-hotkey-description="Search">…</button>
 *
 * A combo is modifiers and one key, joined by +: `mod` is Command on Apple
 * systems and Control elsewhere; `ctrl`, `alt` and `shift` are themselves,
 * `meta` the Command or Windows key. A letter or a digit matches by what it
 * types, then by its place on the keyboard where the layout types no Latin
 * letter (another alphabet, Option on a Mac) or the digit needs a modifier
 * (shift+1, a French layout). Other characters are written as typed (`?`,
 * never `shift+/`), whatever Shift it took on this layout.
 *
 * Which registration a key press reaches: the page's own handlers come first
 * (bubble phase; preventDefault() keeps it), a composing IME and a held key
 * get nothing (`repeat: true` takes a held key; a key held on a registration
 * still keeps its default, so the browser's own Ctrl+S never opens). A combo
 * without Control or Command stays out of fields and of widgets that read
 * keys (readsKeys()), where it would type, and off the keys a native control
 * uses itself: Space and Enter on what they press, the arrows, Home, End,
 * PageUp and PageDown on what they move (`fields` changes that). An open
 * overlay masks the registrations behind it, so letters reach a menu's
 * type-ahead and no shortcut acts on the inert page (`within` or `owner` in that layer, or
 * `overlays: true`, still count); a contained dialog masks only inside its
 * container. Escape stays the layer's: over one, it reaches only a `within`
 * inside that layer, a widget that handles its own Escape, which listens on
 * its element so it comes first whatever was added first. A function key
 * types nothing, so it also works from a field. Of what is left the innermost `within`
 * wins, then the scope activated last, then the registration made last; a
 * handler that returns false passes the key on. The one that takes it
 * prevents the default.
 *
 * Scopes: 'global' is always on, below the others; `scope(name)` turns a
 * scope on until its handle is destroyed, and `exclusive: true` masks every
 * scope below it (a full-screen editor).
 *
 * Progressive:
 * - navigator.userAgentData (tells the platform): an engine without it
 *   falls back on navigator.platform.
 */

import { define, runtime, t } from './core.js';
import { disown, own } from './dom.js';
import { layerAt } from './overlay.js';
import { canTakeFocus, readsKeys } from './a11y.js';

/** The scope of a registration that names none; always on, below the others. */
const GLOBAL = 'global';

/**
 * This module's shared state (runtime.state('hotkeys')): per root the
 * registrations, the active scopes, the listeners of list() changes and the
 * one keydown listener, whichever copy made it.
 * @type {{ roots: WeakMap<object, any> }}
 */
const shared = runtime.state('hotkeys', () => ({ roots: new WeakMap() }));

const MODIFIERS = { mod: 'mod', ctrl: 'ctrl', control: 'ctrl', meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta', super: 'meta', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift' };

const KEY_ALIASES = { esc: 'escape', return: 'enter', del: 'delete', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', spacebar: 'space', plus: '+' };

const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/** The keys with a name, by the lower-case key, as aria-keyshortcuts writes them; a name that is none of these, f1 ... or one character is a typo. */
const KEY_NAMES = new Map(['enter', 'escape', 'space', 'tab', 'backspace', 'delete', 'insert', 'home', 'end', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ContextMenu', 'CapsLock', 'NumLock', 'ScrollLock', 'pause', 'PrintScreen', 'help', 'clear', 'BrowserBack', 'BrowserForward', 'BrowserHome', 'BrowserRefresh', 'BrowserSearch', 'MediaPlayPause', 'MediaStop', 'MediaTrackNext', 'MediaTrackPrevious', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute'].map((name) => [name.toLowerCase(), capital(name)]));

/**
 * A combo as data: { key, mod, ctrl, meta, alt, shift }. The key is lower
 * case (`escape`, `arrowup`, `f1`, `k`, `?`), with the aliases `esc`,
 * `return`, `del`, `up`, `down`, `left`, `right`, `spacebar` and `plus`; `+`
 * alone is the plus key. A combo without a key (only modifiers), with an
 * unknown modifier or an unknown key name throws.
 * @param {string} combo
 * @returns {{ key: string, mod: boolean, ctrl: boolean, meta: boolean, alt: boolean, shift: boolean }}
 */
export function parse(combo) {
  const parts = String(combo ?? '').trim().toLowerCase().split('+').map((part) => part.trim());
  let key;
  // 'mod++' and '+': the two empty parts at the end are the plus key.
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') {
    parts.length -= 2;
    key = '+';
  } else key = parts.pop();
  if (!key || Object.hasOwn(MODIFIERS, key)) throw new Error(`DS.hotkeys: no key in the combo "${combo}"`);
  const named = Object.hasOwn(KEY_ALIASES, key) ? KEY_ALIASES[key] : key;
  if ([...named].length > 1 && !KEY_NAMES.has(named) && !/^f\d+$/.test(named)) throw new Error(`DS.hotkeys: unknown key "${key}" in the combo "${combo}"`);
  const spec = { key: named, mod: false, ctrl: false, meta: false, alt: false, shift: false };
  for (const part of parts) {
    if (!Object.hasOwn(MODIFIERS, part)) throw new Error(`DS.hotkeys: unknown modifier "${part}" in the combo "${combo}"`);
    spec[MODIFIERS[part]] = true;
  }
  return spec;
}

/**
 * Whether this is an Apple system, where `mod` means Command.
 * @param {any} [view]
 * @returns {boolean}
 */
export function isApple(view = globalThis) {
  const nav = view?.navigator;
  return /mac|iphone|ipad|ipod/i.test(nav?.userAgentData?.platform || nav?.platform || '');
}

/**
 * Whether a keyboard event is this combo (a string or what parse() gives).
 * Only the combo's modifiers may be held; AltGr types a character, so it
 * counts as neither Control nor Alt.
 * @param {KeyboardEvent} event
 * @param {string|ReturnType<typeof parse>} combo
 * @returns {boolean}
 */
export function matches(event, combo) {
  const spec = typeof combo === 'string' ? parse(combo) : combo;
  const apple = isApple(event.view ?? globalThis);
  const altGr = event.getModifierState?.('AltGraph') === true;
  if ((event.ctrlKey && !altGr) !== (spec.ctrl || (spec.mod && !apple))) return false;
  if (event.metaKey !== (spec.meta || (spec.mod && apple))) return false;
  if ((event.altKey && !altGr) !== spec.alt) return false;
  const pressed = (event.key ?? '').toLowerCase();
  const name = pressed === ' ' ? 'space' : pressed;
  const { key } = spec;
  const letter = /^[a-z]$/.test(key);
  const digit = /^[0-9]$/.test(key);
  // A character other than a letter or a digit is what it types, whatever Shift it took here.
  if (key.length === 1 && !letter && !digit) return name === key && (!spec.shift || event.shiftKey);
  // A digit some layouts type with Shift (a French one).
  if (digit && name === key && (!spec.shift || event.shiftKey)) return true;
  if (event.shiftKey !== spec.shift) return false;
  if (name === key) return true;
  // AltGr typed another character, and an IME holds the key: neither is the key at this place.
  if (altGr || pressed === 'process' || event.keyCode === 229) return false;
  if (letter) return event.code === `Key${key.toUpperCase()}` && !/^[\x20-\x7e]$/.test(event.key ?? '');
  if (digit) return event.code === `Digit${key}` && !/^[a-z0-9]$/i.test(event.key ?? '');
  return false;
}

/** Word keys, by the string that names them (DS.core.t). */
const KEY_STRINGS = { enter: 'keyEnter', escape: 'keyEscape', space: 'keySpace', tab: 'keyTab', backspace: 'keyBackspace', delete: 'keyDelete', home: 'keyHome', end: 'keyEnd', pageup: 'keyPageUp', pagedown: 'keyPageDown' };

const ARROWS = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' };

/** The key as aria-keyshortcuts names it: `K`, `Enter`, `ArrowUp`, `PageDown`, `F1`, `?`; `Plus`, because + is its separator. */
function ariaKey(key) {
  if (key === '+') return capital('plus');
  return KEY_NAMES.get(key) ?? (key.length === 1 ? key.toUpperCase() : capital(key));
}

function keyLabel(key) {
  if (Object.hasOwn(KEY_STRINGS, key)) return t(KEY_STRINGS[key]);
  if (Object.hasOwn(ARROWS, key)) return ARROWS[key];
  return key.length === 1 || /^f\d+$/.test(key) ? key.toUpperCase() : KEY_NAMES.get(key) ?? capital(key);
}

/**
 * A combo for people and for assistive tech on this platform (`apple`
 * overrides it): `keys` one label per key, for a <kbd class="ds-kbd"> each
 * (⌃ ⌥ ⇧ ⌘ on Apple systems, else the strings keyCtrl, keyAlt, keyShift and
 * keyMeta); `text` the one line ('⇧⌘K', 'Ctrl+Shift+K'); `aria` the value
 * of aria-keyshortcuts ('Shift+Meta+K', 'Control+Shift+K').
 * @param {string} combo
 * @param {{ apple?: boolean }} [options]
 * @returns {{ keys: string[], text: string, aria: string }}
 */
export function format(combo, options = {}) {
  const spec = parse(combo);
  const apple = options.apple ?? isApple();
  const ctrl = spec.ctrl || (spec.mod && !apple);
  const meta = spec.meta || (spec.mod && apple);
  const held = [[ctrl, '⌃', 'keyCtrl', 'Control'], [spec.alt, '⌥', 'keyAlt', 'Alt'], [spec.shift, '⇧', 'keyShift', 'Shift'], [meta, '⌘', 'keyMeta', 'Meta']].filter(([on]) => on);
  const keys = [...held.map(([, glyph, string]) => (apple ? glyph : t(string))), keyLabel(spec.key)];
  return {
    keys,
    text: keys.join(apple ? '' : '+'),
    aria: [...held.map(([, , , name]) => name), ariaKey(spec.key)].join('+'),
  };
}

const rootOf = (root) => root ?? globalThis.document;

function stateOf(root) {
  let state = shared.roots.get(root);
  if (!state) {
    state = { entries: [], scopes: [], subscribers: new Set(), listener: null, count: 0 };
    shared.roots.set(root, state);
  }
  return state;
}

/** The active scopes, the one that counts first at the head: down the stack to the first exclusive one, else 'global' last. */
function activeScopes(state) {
  const active = [];
  for (let at = state.scopes.length - 1; at >= 0; at -= 1) {
    const { name, exclusive } = state.scopes[at];
    if (!active.includes(name)) active.push(name);
    if (exclusive) return active;
  }
  if (!active.includes(GLOBAL)) active.push(GLOBAL);
  return active;
}

/** What Space and Enter press by themselves. */
const PRESSED_BY_KEY = 'a[href], area[href], button, summary, input[type="button"], input[type="checkbox"], input[type="color"], input[type="file"], input[type="image"], input[type="radio"], input[type="reset"], input[type="submit"], [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="radio"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="treeitem"]';

/** What the arrows, Home, End, PageUp and PageDown move by themselves (a select and the widgets of readsKeys() are there already). */
const MOVED_BY_KEY = 'input[type="range"], input[type="radio"], input[readonly], textarea[readonly], audio[controls], video[controls], [role="slider"], [role="radiogroup"], [role="tablist"], [role="grid"], [role="toolbar"]';

const MOVING_KEYS = /^(arrow(up|down|left|right)|home|end|pageup|pagedown)$/;

/** Whether `key` (a parsed key name) already means something on `target`: it types there, or the control uses it. */
function reads(target, key) {
  if (readsKeys(target)) return true;
  const uses = key === 'space' || key === 'enter' ? PRESSED_BY_KEY : MOVING_KEYS.test(key) ? MOVED_BY_KEY : null;
  return Boolean(uses && target?.closest?.(uses));
}

/** Whether the entry may take this key press on `target`, for the combo that matched. */
function allowedOn(entry, spec, target) {
  if (entry.fields !== undefined) return entry.fields === true || !reads(target, spec.key);
  return spec.mod || spec.ctrl || spec.meta || /^f\d+$/.test(spec.key) || !reads(target, spec.key);
}

/**
 * Runs the registration a key press belongs to (the file comment has the
 * order). `early`: the one registration asked from its `within` element, for
 * an Escape inside an open layer.
 */
function dispatch(root, state, event, early = null) {
  if (event.defaultPrevented || event.isComposing) return;
  const path = event.composedPath?.() ?? [];
  const target = path[0] ?? event.target;
  const layer = layerAt(target, root.ownerDocument ?? root);
  const active = activeScopes(state);
  const found = [];
  let held = false;
  for (const entry of early ? [early] : state.entries) {
    if (entry.askedBy === event) continue;
    const rank = active.indexOf(entry.scope);
    if (rank < 0) continue;
    const spec = entry.specs.find((each) => matches(event, each));
    if (!spec) continue;
    const depth = entry.within ? path.indexOf(entry.within) : Infinity;
    if (depth < 0) continue;
    const home = entry.owner ?? entry.within;
    if (layer && !entry.overlays && !(home && layer.contains(home))) continue;
    // Escape stays the layer's, but for a `within` inside it (an inline editor); the document's turn comes too late for that.
    const layersEscape = Boolean(layer && spec.key === 'escape');
    if (layersEscape ? !early || depth > path.indexOf(layer) : early) continue;
    if (!allowedOn(entry, spec, target)) continue;
    if (entry.available && !entry.available()) continue;
    if (entry.when && !entry.when(event)) continue;
    // A held key runs nothing, but what the first press took keeps its default (a browser's own Ctrl+S).
    if (event.repeat && !entry.repeat) {
      held ||= !entry.passed;
      continue;
    }
    found.push({ entry, depth, rank });
  }
  // Two entries without `within` give Infinity - Infinity, NaN: falsy, a tie, as it should.
  found.sort((a, b) => a.depth - b.depth || a.rank - b.rank || b.entry.order - a.entry.order);
  for (const { entry } of found) {
    if (early) entry.askedBy = event;
    entry.passed = entry.handler(event) === false;
    if (entry.passed) continue;
    event.preventDefault();
    return;
  }
  if (held) event.preventDefault();
}

/** The keydown listener while there is a registration, and the news for an open sheet. */
function changed(root, state) {
  if (state.entries.length && !state.listener) {
    state.listener = (event) => dispatch(root, state, event);
    root.addEventListener('keydown', state.listener);
  } else if (!state.entries.length && state.listener) {
    root.removeEventListener('keydown', state.listener);
    state.listener = null;
  }
  for (const fn of [...state.subscribers]) fn();
}

/**
 * Registers a shortcut: `combo` (a string, or a list of alternatives) calls
 * `handler(event)`; a handler that returns false passes the key on.
 * `description` (a string, or a function list() asks each time) and `group`
 * (default: the string hotkeysGeneral) are for list(), which leaves out a
 * registration without a description. `scope`
 * (default 'global'). `within`: an element the key press must come from.
 * `owner`: the element this belongs to, when it is no `within`: in an open
 * overlay it still counts. `overlays: true` counts over any overlay. Escape
 * stays the layer's: over one it counts only with a `within` inside that layer.
 * `fields`: true counts in fields too, false never (default: only a combo
 * with Control or Command; plain combos also stay off the keys a native
 * control uses itself). `repeat: true` takes a held key. `when(event)`: false
 * skips it for this press. `available()`: false means it does nothing as the
 * page stands, so it takes no key and list() says it is not active. `root`
 * (default: the document).
 * The last registration of a combo wins while it lives; destroy() brings
 * the one before it back. A bad combo throws here.
 * @param {string|string[]} combo
 * @param {(event: KeyboardEvent) => unknown} handler
 * @param {{ description?: string|null|(() => string|null|undefined), group?: string|null, scope?: string, within?: Element|null, owner?: Element|null, overlays?: boolean, fields?: boolean, repeat?: boolean, when?: (event: KeyboardEvent) => boolean, available?: () => boolean, root?: Document|ShadowRoot|Element|null }} [options]
 * @returns {{ destroy: () => void }}
 */
export function register(combo, handler, options = {}) {
  if (typeof handler !== 'function') throw new TypeError('DS.hotkeys.register: the handler must be a function');
  const combos = (Array.isArray(combo) ? combo : [combo]).map(String);
  if (!combos.length) throw new Error('DS.hotkeys.register: no combo');
  const specs = combos.map(parse);
  const root = rootOf(options.root);
  if (!root?.addEventListener) return { destroy() {} };
  const state = stateOf(root);
  state.count += 1;
  const entry = {
    combos,
    specs,
    handler,
    identity: JSON.stringify(specs),
    order: state.count,
    description: options.description ?? null,
    group: options.group ?? null,
    scope: options.scope ?? GLOBAL,
    within: options.within ?? null,
    owner: options.owner ?? null,
    overlays: options.overlays === true,
    fields: options.fields,
    repeat: options.repeat === true,
    when: options.when ?? null,
    available: options.available ?? null,
    passed: false,
  };
  state.entries.push(entry);
  // On the element itself: an overlay's Escape listens on the document too, and whichever was added first would run first.
  const early = entry.within && specs.some((spec) => spec.key === 'escape') ? (event) => dispatch(root, state, event, entry) : null;
  if (early) entry.within.addEventListener('keydown', early);
  changed(root, state);
  return {
    destroy() {
      const at = state.entries.indexOf(entry);
      if (at < 0) return;
      state.entries.splice(at, 1);
      if (early) entry.within.removeEventListener('keydown', early);
      changed(root, state);
    },
  };
}

/**
 * Turns the scope `name` on until destroy(): its shortcuts count, before
 * those of the scopes turned on earlier. `exclusive: true` masks every scope
 * below it, 'global' too. `root` (default: the document).
 * @param {string} name
 * @param {{ exclusive?: boolean, root?: Document|ShadowRoot|Element|null }} [options]
 * @returns {{ destroy: () => void }}
 */
export function scope(name, options = {}) {
  const root = rootOf(options.root);
  if (!root?.addEventListener) return { destroy() {} };
  const state = stateOf(root);
  const entry = { name: String(name), exclusive: options.exclusive === true };
  state.scopes.push(entry);
  changed(root, state);
  return {
    destroy() {
      const at = state.scopes.indexOf(entry);
      if (at < 0) return;
      state.scopes.splice(at, 1);
      changed(root, state);
    },
  };
}

/**
 * The scopes that count now, the one that counts first at the head.
 * @param {{ root?: Document|ShadowRoot|Element|null }} [options]
 * @returns {string[]}
 */
export function scopes(options = {}) {
  const root = rootOf(options.root);
  return root?.addEventListener ? activeScopes(stateOf(root)) : [GLOBAL];
}

/** Whether a registration's element is on the page at all: a sheet does not list a control that cannot be seen now. */
function shown(element) {
  if (!element) return true;
  if (element.isConnected === false || element.closest?.('[hidden]')) return false;
  return typeof element.checkVisibility !== 'function' || element.checkVisibility({ checkVisibilityCSS: true });
}

const elementOf = (entry) => entry.owner ?? entry.within;

/** Whether the registration can take its key as the page stands, whatever the scopes say. */
const usable = (entry) => shown(elementOf(entry)) && (!entry.available || entry.available());

/** What a registration says on the sheet as the page stands. */
const describe = (entry) => (typeof entry.description === 'function' ? entry.description() : entry.description);

/**
 * The data of a shortcut sheet: the groups in the order they were first
 * registered, each `{ name, items }`, an item `{ description, scope, active,
 * combos: [{ combo, keys, text, aria }] }` (format()). Only registrations
 * with a description, without those a later one with the same combos, scope
 * and `within` replaces, and without those whose `owner` or `within` is not
 * shown (hidden, unseen, in a closed layer). `active`: its scope counts now
 * and `available()` says yes, so a disabled control shows as off.
 * `activeOnly: true` leaves the others out. `apple` overrides the platform.
 * @param {{ root?: Document|ShadowRoot|Element|null, activeOnly?: boolean, apple?: boolean }} [options]
 * @returns {{ name: string, items: { description: string, scope: string, active: boolean, combos: { combo: string, keys: string[], text: string, aria: string }[] }[] }[]}
 */
export function list(options = {}) {
  const root = rootOf(options.root);
  if (!root?.addEventListener) return [];
  const state = stateOf(root);
  const active = activeScopes(state);
  const groups = new Map();
  for (const [at, entry] of state.entries.entries()) {
    const description = describe(entry);
    if (!description) continue;
    if (!shown(elementOf(entry))) continue;
    // Only a later one that can take the key replaces this one (two buttons, one for each breakpoint).
    if (state.entries.slice(at + 1).some((later) => later.scope === entry.scope && later.within === entry.within && later.identity === entry.identity && usable(later))) continue;
    const isActive = active.includes(entry.scope) && (!entry.available || entry.available());
    if (options.activeOnly && !isActive) continue;
    const name = entry.group ?? t('hotkeysGeneral');
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({
      description,
      scope: entry.scope,
      active: isActive,
      combos: entry.combos.map((combo) => ({ combo, ...format(combo, { apple: options.apple }) })),
    });
  }
  return [...groups].map(([name, items]) => ({ name, items }));
}

/**
 * Calls `fn` after a registration or scope change. A control's own state is
 * no change here: call list() again when opening a sheet or after changing
 * it. Returns the unsubscribe.
 * @param {() => void} fn
 * @param {{ root?: Document|ShadowRoot|Element|null }} [options]
 * @returns {() => void}
 */
export function onChange(fn, options = {}) {
  const root = rootOf(options.root);
  if (!root?.addEventListener) return () => {};
  const state = stateOf(root);
  state.subscribers.add(fn);
  return () => {
    state.subscribers.delete(fn);
  };
}

/** What takes focus for a press of its data-ds-hotkey, read-only or not; anything else is pressed. */
const FOCUSED_BY_HOTKEY = 'input:not([type="button"], [type="submit"], [type="reset"], [type="checkbox"], [type="radio"], [type="image"], [type="file"], [type="color"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]';

/*
 * Declarative: a press of the combo presses the button or link, or focuses
 * the field. It counts only while the element could take focus (not
 * disabled, hidden, unseen or inert: canTakeFocus()) and is not
 * aria-disabled, and over an overlay only when it sits in that overlay.
 * aria-keyshortcuts is owned while the system writes it, so a re-render
 * with morphHtml keeps it.
 */
define('hotkey', {
  attribute: 'data-ds-hotkey',
  attributes: ['data-ds-hotkey-description', 'data-ds-hotkey-group', 'data-ds-hotkey-scope'],
  init(el) {
    const combos = (el.getAttribute('data-ds-hotkey') ?? '').split(/\s+/).filter(Boolean);
    if (!combos.length) return undefined;
    const text = () => (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.textContent || '').replace(/\s+/g, ' ').trim();
    const registration = register(combos, () => {
      if (el.matches(FOCUSED_BY_HOTKEY)) {
        /** @type {HTMLElement} */ (el).focus();
        /** @type {HTMLInputElement} */ (el).select?.();
      } else /** @type {HTMLElement} */ (el).click();
    }, {
      description: () => el.getAttribute('data-ds-hotkey-description') || text() || null,
      group: el.getAttribute('data-ds-hotkey-group'),
      scope: el.getAttribute('data-ds-hotkey-scope') ?? undefined,
      owner: el,
      available: () => canTakeFocus(el) && el.getAttribute('aria-disabled') !== 'true',
      root: el.ownerDocument,
    });
    const named = el.hasAttribute('aria-keyshortcuts');
    if (!named) {
      own(el, 'attrs', 'aria-keyshortcuts');
      el.setAttribute('aria-keyshortcuts', combos.map((combo) => format(combo).aria).join(' '));
    }
    return () => {
      registration.destroy();
      if (!named) {
        disown(el, 'attrs', 'aria-keyshortcuts');
        el.removeAttribute('aria-keyshortcuts');
      }
    };
  },
});
