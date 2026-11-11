/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.badge (src/components/badge/badge.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the module's.
 */

export interface BadgeOptions {
  /** The count (default 0). */
  value?: number | string;
  /** The largest figure it shows before the plus (default 99). */
  max?: number;
}

export interface BadgeChange {
  value: number | string;
  text: string;
}

export interface BadgeController {
  get(): number | string;
  set(next: number | string): void;
  on(type: 'change', fn: (detail: BadgeChange) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** The figure of a count: "99+" past the maximum, empty at zero or for no number. */
export declare function format(value: number | string, max?: number): string;
/** A badge driven from the page. */
export declare function create(el: Element, options?: BadgeOptions): BadgeController;
