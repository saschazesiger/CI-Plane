/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.hits (src/components/hits/hits.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export interface HitsState {
  query: string;
  /** How many marks. */
  count: number;
}

export interface HitsController {
  get(): HitsState;
  set(next: string): void;
  on(type: 'change', fn: (detail: HitsState) => void): () => void;
  /** Reads the attributes again and marks anew. */
  update(): void;
  destroy(): void;
}

/** Where the terms of `query` occur in `text`: [start, end) pairs, touching hits joined. */
export declare function ranges(text: string, query: string, options?: { mode?: 'words' | 'phrase' }): [number, number][];
/** Marks driven from the page. */
export declare function create(el: Element, options?: { query?: string; mode?: 'words' | 'phrase' }): HitsController;
