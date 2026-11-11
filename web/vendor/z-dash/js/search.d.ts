/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.search (src/components/search/search.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export interface SearchDetail {
  value: string;
  /** 'enter': Enter in the filled field; 'recent': a recent search was taken. */
  source: 'enter' | 'recent';
}

export interface SearchController {
  get(): { value: string; count: number | null; recent: string[] };
  /** A value (sends an input event) and the result count (null empties it; spoken once typing pauses). */
  set(next?: { value?: string; count?: number | null }): void;
  /** Keeps a search at the head of the recent ones (data-ds-search-recent). */
  remember(value: string): void;
  /** Forgets every recent search. */
  forget(): void;
  on(type: 'search', fn: (detail: SearchDetail) => void): () => void;
  /** Reads the markup again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** The recent searches after one more: at the head, an earlier copy gone, at most `max` (default 5). */
export declare function remember(list: string[] | null | undefined, value: string | null | undefined, options?: { max?: number }): string[];
/** A search field driven from the page. */
export declare function create(el: Element): SearchController;
