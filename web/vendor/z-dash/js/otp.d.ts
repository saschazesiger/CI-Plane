/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.otp (src/components/otp/otp.js). Hand-written; the build test
 * keeps the declared exports and their parameters equal to the module's.
 */

export type OtpType = 'numeric' | 'alphanumeric';

export interface OtpController {
  /** What the cells hold, in order (empty cells left out). */
  get(): string;
  /** Fills the cells from the start with the cleaned text; the rest empty. */
  set(value: string): void;
  /** Empties every cell and focuses the first. */
  clear(): void;
  /** Focuses the first empty cell, else the last. */
  focus(): void;
  on(type: 'change', fn: (detail: { value: string; complete: boolean }) => void): () => void;
  on(type: 'complete', fn: (detail: { value: string }) => void): () => void;
  /** Reads data-ds-otp-type, data-ds-otp-mask and aria-invalid again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** A text as the cells take it: separators and characters the type does not allow go; cut to `length`. */
export declare function clean(text: string | null | undefined, options?: { type?: OtpType; length?: number }): string;
/** A code field driven from the page. */
export declare function create(el: Element): OtpController;
