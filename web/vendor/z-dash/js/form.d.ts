/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.form (src/components/form/form.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the
 * module's.
 */

export interface FieldCount {
  /** The value's length in UTF-16 code units, as maxlength counts. */
  length: number;
  /** The limit, or null without one. */
  max: number | null;
  /** What is left before the limit (negative past a soft one), or null without one. */
  remaining: number | null;
  over: boolean;
}

export interface CounterController {
  get(): FieldCount;
  /** Sets the field's value and counts it again. */
  set(value: string): void;
  on(type: 'change', fn: (detail: FieldCount) => void): () => void;
  /** Counts again (after a value set by script, a new limit). */
  update(): void;
  destroy(): void;
}

/** The length of a value against a limit. */
export declare function count(value: string | null | undefined, max: number | null | undefined): FieldCount;
/** A character counter driven from the page. */
export declare function counter(el: Element): CounterController;
