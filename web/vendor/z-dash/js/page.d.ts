/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.page (src/components/page/page.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the
 * module's.
 */

export interface PageHeadOptions {
  /** A .ds-page-head--sticky head condenses once the reader has scrolled (default true). */
  condense?: boolean;
}

export interface PageHeadController {
  /** Whether the head is condensed. */
  get(): boolean;
  /** Condenses or unfolds a sticky head until the next scroll decides again. */
  set(value: boolean): void;
  on(type: 'change', fn: (detail: { condensed: boolean }) => void): () => void;
  /** Lays the actions out again, measures the head's place and what folds, and reads the scroll. */
  refresh(): void;
  destroy(): void;
}

/** Which actions fold into the More menu in a row of `room` px (indices, sorted); none when all fit. */
export declare function fold(widths: number[], options: { room: number; gap?: number; more?: number; order?: number[] }): number[];
/** A page head driven from the page. */
export declare function create(el: HTMLElement, options?: PageHeadOptions): PageHeadController;
