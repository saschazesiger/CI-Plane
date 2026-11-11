/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.expandable (src/components/expandable/expandable.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export interface ExpandableController {
  /** Whether it is open. */
  get(): boolean;
  set(next: boolean): void;
  on(type: 'change', fn: (detail: { open: boolean }) => void): () => void;
  /** Measures again whether the text is longer than its lines. */
  update(): void;
  destroy(): void;
}

/** Whether a text clamped to `lines` hides some of them. */
export declare function overflows(fullHeight: number, lineHeight: number, lines: number): boolean;
/** Expandable text driven from the page. */
export declare function create(el: Element, options?: { open?: boolean }): ExpandableController;
