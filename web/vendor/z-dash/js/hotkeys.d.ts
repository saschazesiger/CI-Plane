/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.hotkeys (js/hotkeys.js). Hand-written; test/build.test.js
 * keeps the declared exports and their parameters equal to the module's.
 */

/** A combo as data. */
export interface HotkeyCombo {
  /** Lower case: `k`, `?`, `escape`, `arrowup`, `f1`. */
  key: string;
  /** Command on Apple systems, Control elsewhere. */
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}
/** A combo for people and for assistive tech. */
export interface HotkeyLabel {
  /** One label per key, for a <kbd class="ds-kbd"> each. */
  keys: string[];
  /** The one line: '⇧⌘K', 'Ctrl+Shift+K'. */
  text: string;
  /** The value of aria-keyshortcuts: 'Shift+Meta+K', 'Control+Shift+K'. */
  aria: string;
}
/** Where a registry lives; default: the document. */
export type HotkeyRoot = Document | ShadowRoot | Element | null;

export interface HotkeyOptions {
  /** What it does, for list(): a string, or a function list() asks each time; without one it stays off the sheet. */
  description?: string | null | (() => string | null | undefined);
  /** The group of list(). Default: the string hotkeysGeneral. */
  group?: string | null;
  /** Default: 'global'. */
  scope?: string;
  /** An element the key press must come from. */
  within?: Element | null;
  /** The element this belongs to, when it is no `within`: in an open overlay it still counts. */
  owner?: Element | null;
  /** Counts over any open overlay. */
  overlays?: boolean;
  /** True counts in fields and on the keys a native control uses itself, false never. Default: only a combo with Control or Command. */
  fields?: boolean;
  /** Takes a held key. */
  repeat?: boolean;
  /** False skips it for this press. */
  when?: (event: KeyboardEvent) => boolean;
  /** False: it does nothing as the page stands, takes no key, and list() says it is not active. */
  available?: () => boolean;
  root?: HotkeyRoot;
}
/** One shortcut of the sheet. */
export interface HotkeyItem {
  description: string;
  scope: string;
  /** Its scope counts now and available() says yes. */
  active: boolean;
  combos: (HotkeyLabel & { combo: string })[];
}

/** A combo as data; a combo without a key, with an unknown modifier or an unknown key name throws. */
export declare function parse(combo: string): HotkeyCombo;
/** Whether this is an Apple system, where `mod` means Command. */
export declare function isApple(view?: any): boolean;
/** Whether a keyboard event is this combo. */
export declare function matches(event: KeyboardEvent, combo: string | HotkeyCombo): boolean;
/** A combo for people and for assistive tech on this platform (`apple` overrides it). */
export declare function format(combo: string, options?: { apple?: boolean }): HotkeyLabel;
/** Registers a shortcut; a handler that returns false passes the key on. */
export declare function register(combo: string | string[], handler: (event: KeyboardEvent) => unknown, options?: HotkeyOptions): { destroy(): void };
/** Turns the scope `name` on until destroy(). */
export declare function scope(name: string, options?: { exclusive?: boolean; root?: HotkeyRoot }): { destroy(): void };
/** The scopes that count now, the one that counts first at the head. */
export declare function scopes(options?: { root?: HotkeyRoot }): string[];
/** The data of a shortcut sheet. */
export declare function list(options?: { root?: HotkeyRoot; activeOnly?: boolean; apple?: boolean }): { name: string; items: HotkeyItem[] }[];
/** Calls `fn` after a registration or scope change; returns the unsubscribe. */
export declare function onChange(fn: () => void, options?: { root?: HotkeyRoot }): () => void;
