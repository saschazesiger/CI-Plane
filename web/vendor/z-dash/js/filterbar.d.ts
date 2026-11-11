/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.filterbar (js/filterbar.js). */

/** Name to a list of strings; a range is [min, max] ('' for an open end). */
export type Filters = Record<string, string[]>;

export interface FilterDetail {
  filters: Filters;
  /** The filter that changed (null: Clear all). */
  name: string | null;
  reason: 'input' | 'change' | 'remove' | 'clear';
}

export interface AppliedFilter {
  /** "status=online", a range "storage=256..1024". */
  key: string;
  name: string;
  value: string | string[];
  /** The filter's name ("Status"). */
  label: string;
  /** The value in words ("Online", "256 to 1,024"). */
  text: string;
  /** What the chip says ("Status: Online"). */
  chip: string;
}

export interface FilterbarController {
  get(): Filters;
  /** The controls follow; sends nothing. */
  set(filters: Record<string, string | string[]>): void;
  /** One applied filter by its key, or every filter but the search text. */
  clear(key?: string | null): void;
  /** The result count, in the bar and on the sheet's results button. */
  count(value: number, forms?: Record<string, string | ((values: { count: number; formatted: string }) => string)>): void;
  /** Folds the bar and opens its sheet. */
  fold(): void;
  on(type: 'change', fn: (detail: FilterDetail) => void): () => void;
  update(): void;
  destroy(): void;
}

export interface FiltersEngine {
  get(): Filters;
  set(filters: Record<string, string | string[]>): void;
  on(type: 'change', fn: (detail: FilterDetail) => void): () => void;
  clear(key?: string | null): void;
  paint(): AppliedFilter[];
  /** The result count in `count` and on the `results` buttons; announced after a change by the user, once changes pause. */
  count(value: number, forms?: Record<string, string | ((values: { count: number; formatted: string }) => string)>): void;
  /** Listens for chips and Clear all on a root outside the element (a chips row beside the list), until `signal` aborts. */
  watch(root: Element, signal?: AbortSignal | null): void;
  destroy(): void;
}

/** The filters the named controls inside `root` hold. */
export declare function read(root: Element | Document): Filters;
/** Sets the named controls inside `root` (a name left out is emptied); sends nothing. Returns the controls that changed. */
export declare function write(root: Element | Document, filters: Record<string, string | string[]>): Element[];
/** The applied filters of the named controls inside `root`, one entry per chip. */
export declare function applied(root: Element | Document): AppliedFilter[];
/** Opens `sheet` with `part` moved into its body; moves it back once the sheet has closed. */
export declare function fold(part: Element, sheet: Element, options?: { opener?: Element | null; into?: Element | null; back?: () => void }): Promise<void>;
/** The controller data-ds-filterbar makes. */
export declare function create(el: Element, options?: { sheet?: string | Element | null }): FilterbarController;
/** The engine of the chips and Clear all on any container (DS.facets builds on it). */
export declare function filters(el: Element, options: { chips?: string; clear?: string; applied?: string; count?: string; results?: string; home?: string; fallback?: () => Element | null; extra?: () => Element[]; paint?: (list: AppliedFilter[]) => void }, signal?: AbortSignal | null): FiltersEngine;
