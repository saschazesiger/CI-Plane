/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.media (src/components/media/media.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the module's.
 */

export interface MediaChange {
  /** The keys of the selected cards, in grid order. */
  selected: string[];
}

export interface MediaController {
  /** The keys of the selected cards (data-ds-key, else the checkbox's value, else the index). */
  get(): string[];
  /** Selects exactly these keys. */
  set(keys: Iterable<string>): void;
  selectAll(): void;
  clear(): void;
  on(type: 'change', fn: (detail: MediaChange) => void): () => void;
  destroy(): void;
}

/** The items from `from` to `to` in the order of `items`, both included. */
export declare function between<T>(items: T[], from: T, to: T): T[];
/** A media grid driven from the page: one tab stop, the keys, the selection. */
export declare function create(el: Element): MediaController;
