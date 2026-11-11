/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.shortcuts (js/shortcuts.js): the shortcut sheet. */
import type { HotkeyItem } from './hotkeys.js';

type HotkeyGroup = { name: string; items: HotkeyItem[] };

export interface ShortcutsOptions {
  /** Headings of the scopes: { board: 'Board' }. */
  scopes?: Record<string, string>;
  /** The sheet's own combo (default '?'; 'off': none). data-ds-shortcuts-hotkey wins. */
  hotkey?: string;
}

export interface ShortcutSheet {
  get(): { open: boolean; count: number; filter: string };
  set(next: { scopes?: Record<string, string>; filter?: string }): void;
  on(type: 'filter', fn: (detail: { query: string; count: number }) => void): () => void;
  open(options?: { opener?: Element | null }): Promise<void>;
  close(): Promise<void>;
  refresh(): void;
  destroy(): void;
}

/** The groups of DS.hotkeys.list() by scope, the scope that counts first first, 'global' last. */
export declare function byScope(groups: HotkeyGroup[], order?: string[]): { scope: string; groups: HotkeyGroup[] }[];
/** Renders the shortcut list into `container`; returns how many shortcuts it shows. */
export declare function render(container: Element, options?: { filter?: string; labels?: Record<string, string>; root?: Document | ShadowRoot | Element; apple?: boolean; headingLevel?: number }): number;
/** The sheet of a dialog with a .ds-shortcuts__list; null without it. */
export declare function create(el: Element, options?: ShortcutsOptions): ShortcutSheet | null;
/** Opens the sheet of `el`. */
export declare function open(el: Element, options?: { opener?: Element | null }): Promise<void>;
/** Closes the sheet of `el`. */
export declare function close(el: Element): Promise<void>;
