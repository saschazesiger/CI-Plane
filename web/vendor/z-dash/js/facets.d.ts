/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.facets (js/facets.js). */
import type { Filters, FilterDetail } from './filterbar.js';

export interface FacetOption {
  label: string;
  checked?: boolean;
  /** null: no count. */
  count?: number | null;
}

export interface FacetsController {
  get(): Filters;
  /** The controls follow (an option disabled for its count of 0 too); sends nothing. */
  set(filters: Record<string, string | string[]>): void;
  /** One applied filter by its key, or every filter; silent. */
  clear(key?: string | null): void;
  /** The counts of the options, by filter name and value: { status: { online: 24 } }. */
  counts(map: Record<string, Record<string, number>>): void;
  /** The result count, in .ds-facets__count and on the sheet's results button. */
  count(value: number, forms?: Record<string, string | ((values: { count: number; formatted: string }) => string)>): void;
  /** Opens the panel in its sheet (the toggle's action). */
  open(): Promise<void>;
  on(type: 'change', fn: (detail: FilterDetail) => void): () => void;
  /** Reads the options and the facets again (rows added or removed). */
  update(): void;
  destroy(): void;
}

/** Text folded for matching: lower case, without accents and repeated spaces. */
export declare function foldText(text: string | null | undefined): string;
/** Which options of a facet show, by its search, limit, "Show all" and counts. */
export declare function visible(
  options: FacetOption[],
  state?: { query?: string; limit?: number | null; expanded?: boolean; zero?: string },
): { shown: boolean[]; matches: number; total: number; more: boolean };
/** The controller data-ds-facets makes. */
export declare function create(el: Element, options?: { sheet?: string | Element | null; zero?: 'disable' | 'hide' | 'show' }): FacetsController;
