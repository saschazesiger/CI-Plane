/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.cite (src/components/cite/cite.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the
 * module's.
 */

export interface CiteChange {
  open: boolean;
}

export interface CiteController {
  /** Whether this marker's card is open. */
  get(): boolean;
  /** true opens the card, pinned; false closes it. */
  set(value: boolean): void;
  on(type: 'change', fn: (detail: CiteChange) => void): () => void;
  destroy(): void;
}

/** The card a marker opens: the element its aria-controls names, or null. */
export declare function cardOf(marker: Element | null | undefined): HTMLElement | null;
/** A citation marker driven from the page. */
export declare function create(marker: Element): CiteController;
