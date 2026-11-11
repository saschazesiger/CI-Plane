/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.command (js/command.js): the command palette. */

/** One command. `children` makes it a page: a list, or a function of the query that returns one. */
export interface Command {
  id?: string;
  label: string;
  group?: string;
  keywords?: string[] | string;
  description?: string;
  /** A glyph of DS.icons. */
  icon?: string;
  /** A combo of DS.hotkeys, or a list: shown as keys and registered while the palette lives. */
  shortcut?: string | string[];
  href?: string;
  run?: (command: Command, palette: CommandPalette) => void;
  disabled?: boolean;
  keepOpen?: boolean;
  /** One character typed first enters this page. */
  prefix?: string;
  placeholder?: string;
  children?: Command[] | ((query: string, context: { signal: AbortSignal }) => Command[] | Promise<Command[]>);
  [key: string]: unknown;
}

/** Results from elsewhere (a search on the server): asked as the query changes, the older call aborted. */
export interface CommandProvider {
  group?: string;
  search: (query: string, context: { signal: AbortSignal; page: Command | null }) => Command[] | Promise<Command[]>;
  /** How many characters before it is asked (default 1). */
  minLength?: number;
}

export interface CommandOptions {
  commands?: Command[];
  providers?: CommandProvider[];
  /** How many recent commands lead an empty field (default 5; 0: none). */
  recent?: number;
  /** The opening combo (default 'mod+k'; 'off': none). data-ds-command-hotkey wins. */
  hotkey?: string;
  /** false: the commands' combos are not registered with DS.hotkeys. */
  shortcuts?: boolean;
}

export interface CommandState {
  open: boolean;
  query: string;
  page: string | null;
  active: string | null;
}

export interface CommandPalette {
  get(): CommandState;
  set(next: { commands?: Command[]; providers?: CommandProvider[]; query?: string } | Command[]): void;
  on(type: 'select' | 'query', fn: (detail: { command?: Command; query: string; page?: Command | null }) => void): () => void;
  open(options?: { opener?: Element | null; query?: string; page?: string }): Promise<void>;
  close(): Promise<void>;
  back(): boolean;
  run(id: string): void;
  refresh(): void;
  destroy(): void;
}

/** How well `query` matches `text`: a score and the matched ranges, or null. */
export declare function fuzzy(query: string, text: string): { score: number; ranges: [number, number][] } | null;
/** The commands that match `query`, best first. */
export declare function rank<C extends { label: string; keywords?: string[] }>(commands: C[], query: string): { command: C; score: number; ranges: [number, number][] }[];
/** The palette of a .ds-dialog.ds-command; null without its field. */
export declare function create(el: Element, options?: CommandOptions): CommandPalette | null;
/** Opens the palette of `el`. */
export declare function open(el: Element, options?: { opener?: Element | null; query?: string; page?: string }): Promise<void>;
/** Closes the palette of `el`. */
export declare function close(el: Element): Promise<void>;
