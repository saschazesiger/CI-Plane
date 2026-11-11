/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.number (src/components/number/number.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export interface NumberOptions {
  /** The smallest value (none by default). */
  min?: number;
  /** The largest value (none by default). */
  max?: number;
  /** ArrowUp, ArrowDown and the steppers (default 1); typed values are rounded to a step given here or in the markup. */
  step?: number;
  /** PageUp and PageDown (default ten steps). */
  page?: number;
  /** Fraction digits shown (default the step's, or the currency's). */
  decimals?: number;
  /** An ISO 4217 code: the symbol fills the group's prefix or suffix where the locale writes it. */
  currency?: string;
  /** An Intl unit (gigabyte, kilogram, percent ...), else shown as written in the suffix. */
  unit?: string;
  /** false: no thousands separators. */
  grouping?: boolean;
  /** Default: DS.core.config().locale. */
  locale?: string;
}

export interface NumberChange {
  /** The value, or null when the field is empty. */
  value: number | null;
  /** The text the field shows. */
  text: string;
}

export interface NumberController {
  get(): number | null;
  /** A number, null (empty) or a text in the locale. */
  set(next: number | string | null): void;
  /** Steps `count` steps (default 1; negative steps down). */
  step(count?: number): void;
  on(type: 'change', fn: (detail: NumberChange) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** The group and decimal separators and the ten digits of a locale. */
export declare function symbols(locale?: string): { group: string; decimal: string; digits: string[] };
/** A number typed in the locale; null for empty text, NaN for text that is no number. */
export declare function parse(text: string | null | undefined, options?: { locale?: string }): number | null;
/** A number as the field writes it, in the locale; '' for null and NaN. */
export declare function format(value: number | null | undefined, options?: { locale?: string; decimals?: number; grouping?: boolean }): string;
/** A value kept within min and max and rounded to the step. */
export declare function clamp(value: number, options?: { min?: number | null; max?: number | null; step?: number | null; decimals?: number }): number;
/** A number input driven from the page. */
export declare function create(el: Element, options?: NumberOptions): NumberController;
