/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.formatted (src/components/formatted/formatted.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export type FormattedKind = 'number' | 'compact' | 'percent' | 'currency' | 'bytes' | 'duration';

export interface FormattedOptions {
  /** What the value is (default 'number'). */
  kind?: FormattedKind;
  /** An ISO 4217 code for 'currency' (default 'USD'). */
  currency?: string;
  /** The most fraction digits. */
  digits?: number | string;
  /** 1024 for binary sizes (KiB) with 'bytes'. */
  base?: number | string;
  /** 'duration': short, long, narrow or clock; 'compact': short or long. */
  style?: string;
  /** A sign on gains too (+4.2%). */
  signed?: boolean;
  /** A locale instead of DS.config()'s. */
  locale?: string;
}

export interface FormattedCreateOptions extends FormattedOptions {
  /** The raw value to start from (default: data-ds-value, else the element's text). */
  value?: number | string;
  /** false: no tooltip with the exact value. */
  tip?: boolean;
}

export interface FormattedState {
  value: number | null;
  text: string;
}

export interface FormattedController {
  get(): FormattedState;
  set(next: number | string | null): void;
  on(type: 'change', fn: (detail: FormattedState) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** The text of a raw value for a kind; '' for what is no number. */
export declare function text(value: number | string | null | undefined, options?: FormattedOptions): string;
/** The exact value for the tip, or '' where the text already is exact. */
export declare function exact(value: number | string | null | undefined, options?: FormattedOptions): string;
/** A formatted value driven from the page. */
export declare function create(el: Element, options?: FormattedCreateOptions): FormattedController;
