/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.listbox (js/listbox.js). */

/** An item of a data list: a string, or an object. */
export type ListboxItem = string | {
  value?: string | number;
  label?: string;
  description?: string;
  meta?: string;
  group?: string;
  disabled?: boolean;
  [key: string]: unknown;
};

/** What the listbox knows of one option. */
export interface ListboxEntry {
  index: number;
  value: string;
  label: string;
  description: string;
  meta: string;
  group: string;
  disabled: boolean;
  item: ListboxItem | null;
  el: Element | null;
}

export interface ListboxOptions {
  /** Data to render; without it the options are the markup's. */
  items?: ListboxItem[];
  /** Several values (default: aria-multiselectable on the element). */
  multiple?: boolean;
  /** The first value (default data-ds-value, else the options marked aria-selected). */
  value?: string | string[] | null;
  /** The element that keeps the focus and aria-activedescendant (default the listbox). */
  focus?: Element;
  /** One choice follows the active option (default on for a standalone listbox). */
  follow?: boolean;
  /** true, false, or the number of items from which a data list is windowed (default VIRTUAL_FROM). */
  virtual?: boolean | number;
  /** What scrolls (default the listbox). */
  scroller?: Element;
  /** The class block of the parts (default 'ds-listbox'). */
  prefix?: string;
  /** Render the check mark (default on for ds-listbox). */
  check?: boolean;
  /** Home and End move the active option (default on for a standalone listbox; a field keeps them). */
  homeEnd?: boolean;
  /** Letters jump to a name (default on for a standalone listbox). */
  typeahead?: boolean;
  /** Space chooses (default on for a standalone listbox). */
  space?: boolean;
  /** The arrows go round (default off). */
  wrap?: boolean;
  /** The inner markup of a data option; `name` is its label with the matched letters marked. */
  render?: (item: ListboxItem, name: string) => string;
  /** Hidden inputs of this name carry the value in a form. */
  name?: string;
  /** A markup option that comes last whatever the query (true), or while `(query, matches)` says so (a "Create" option). */
  pinned?: (option: Element) => boolean | ((query: string, matches: number) => boolean);
}

export interface ListboxChange {
  value: string | string[] | null;
  item: ListboxItem | string | null;
  selected: boolean;
}

export interface ListboxController {
  readonly element: Element;
  get(): string | string[] | null;
  set(value: string | string[] | null): void;
  on(type: 'change', fn: (detail: ListboxChange) => void): () => void;
  setItems(items: ListboxItem[], how?: { keep?: boolean, query?: string }): number;
  filter(text: string, how?: { keep?: boolean }): number;
  shown(): ListboxEntry[];
  entries(): ListboxEntry[];
  active(): ListboxEntry | null;
  activate(which: string | 'first' | 'last' | null): void;
  move(step: number): ListboxEntry | null;
  pick(value?: string): boolean;
  key(event: KeyboardEvent): boolean;
  refresh(): void;
  destroy(): void;
}

/** A data list longer than this is windowed unless `virtual: false`. */
export declare const VIRTUAL_FROM: number;
/** How well `query` matches `text`, or null. */
export declare function fuzzy(query: string, text: string): { score: number, ranges: Array<[number, number]> } | null;
/** The items that match `query`, best first. */
export declare function filter<T>(items: T[], query: string, options?: { label?: (item: T) => string, limit?: number }): Array<{ item: T, index: number, score: number, ranges: Array<[number, number]> }>;
/** `text` as markup with the ranges marked, escaped. */
export declare function highlight(text: string, ranges: Array<[number, number]>, className?: string): string;
/** The controller of a listbox, the one [data-ds-listbox] makes. */
export declare function create(element: Element, options?: ListboxOptions): ListboxController;
