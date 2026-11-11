/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.sort (js/sort.js). */

export type SortDirection = 'ascending' | 'descending';

export interface SortState {
  field: string | null;
  direction: SortDirection;
}

export interface SortDetail {
  field: string | null;
  direction: SortDirection;
  /** The field's name. */
  label: string;
  /** The direction in the field's words ("A to Z"). */
  words: string;
}

export interface SortController {
  get(): SortState;
  /** Text ("-name") or { field, direction }; sends nothing. */
  set(value: string | { field?: string | null; direction?: SortDirection }): void;
  on(type: 'change' | 'sort', fn: (detail: SortDetail) => void): () => void;
  /** Reads the fields again, after the page changed them. */
  update(): void;
  destroy(): void;
}

/** A sort as text: "name" ascending, "-name" descending; "+name", "name:asc" and "name:desc" too. Empty text: null. */
export declare function parse(text: string | null | undefined): { field: string; direction: SortDirection } | null;
/** A sort as the text parse() reads. */
export declare function stringify(state: { field?: string | null; direction?: string } | null | undefined): string;
/** The controller data-ds-sort makes. */
export declare function create(el: Element): SortController;
