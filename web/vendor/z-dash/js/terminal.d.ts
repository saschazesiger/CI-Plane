/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.terminal (src/components/terminal/terminal.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export type TerminalStatus = 'connecting' | 'connected' | 'disconnected';

/** A key of the bar: a name, or a single character sent as it is. */
export type TerminalKey = 'esc' | 'tab' | 'ctrl' | 'alt' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pgup' | 'pgdn' | (string & {});

/** Where the key bar shows: under a coarse pointer only (default), always, or never. */
export type TerminalBar = 'auto' | 'always' | 'off';

export interface TerminalOptions {
  /** Gets the bytes of every key the frame sends (a key of the bar, or a character typed with Ctrl or Alt held). */
  send?: (data: string) => void;
  /** The keys of the bar, in their order (default esc, tab, ctrl, alt, left, up, down, right). */
  keys?: TerminalKey[];
  bar?: TerminalBar;
  status?: TerminalStatus | null;
  /** The text of `.ds-terminal__title`. */
  title?: string;
}

export interface TerminalState {
  status: TerminalStatus | null;
  title: string;
  keys: string[];
  bar: TerminalBar;
  /** Ctrl is held for the next key. */
  ctrl: boolean;
  /** Alt is held for the next key. */
  alt: boolean;
}

export interface TerminalKeyDetail {
  /** The key's name, or the character typed. */
  key: string;
  /** The bytes it sent. */
  data: string;
  ctrl: boolean;
  alt: boolean;
}

export interface TerminalController {
  get(): TerminalState;
  /** Changes the status, title, keys, bar or `send`, or holds and lets go of Ctrl and Alt. */
  set(value: TerminalOptions & { ctrl?: boolean; alt?: boolean }): void;
  /** Presses a key of the bar as a tap would: a modifier toggles, any other key is sent. */
  press(key: TerminalKey): void;
  on(type: 'key', fn: (detail: TerminalKeyDetail) => void): () => void;
  on(type: 'change', fn: (detail: { status: TerminalStatus | null; title: string }) => void): () => void;
  /** Applies the data-ds-terminal-* options whose attributes changed; without `names`, all of them. */
  update(names?: string[]): void;
  destroy(): void;
}

/** The colours of an emulator's theme (xterm.js's ITheme), each an rgb() text. */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** The bytes a key sends to a terminal (xterm's sequences), or null for what cannot be sent. */
export declare function sequence(key: TerminalKey, modifiers?: { ctrl?: boolean; alt?: boolean }): string | null;

/** The theme's colours inside `el`, for an emulator. Empty outside a document. */
export declare function theme(el: Element): TerminalTheme | Record<string, never>;

/** A terminal frame driven from the page; the same controller the attribute path makes. */
export declare function create(el: Element, options?: TerminalOptions): TerminalController;
