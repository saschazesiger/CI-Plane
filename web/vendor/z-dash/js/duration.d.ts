/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.duration (js/duration.js): the duration input. */

export interface DurationOptions {
  /** Text ("1h 30m"), ISO 8601 (PT1H30M) or ms. */
  value?: string | number | null;
  /** A step of the arrow keys, as a duration ("15m"); default a minute. */
  step?: string;
  min?: string;
  max?: string;
  /** What a bare number counts: 'day', 'hour', 'minute' (default), 'second' or their symbols. */
  unit?: string;
  /** The unit the value rounds to when written back: 'day', 'hour', 'minute' or 'second' (default). */
  smallest?: string;
  /** The name of a hidden input that carries the ISO value in a form. */
  name?: string;
  locale?: string;
}

export interface DurationChangeDetail {
  /** ISO 8601, '' while empty or unreadable. */
  value: string;
  ms: number | null;
  text: string;
  valid: boolean;
}

export interface DurationController {
  element: HTMLInputElement;
  get(): string;
  ms(): number | null;
  set(value: string | number | null, options?: { emit?: boolean }): string;
  valid(): boolean;
  update(options?: DurationOptions): void;
  on(type: 'change', fn: (detail: DurationChangeDetail) => void): () => void;
  destroy(): void;
}

/** The ms of a duration as people write it, or null. */
export declare function parse(text: string | number | null | undefined, options?: { unit?: string; locale?: string }): number | null;
/** The ISO 8601 text of a duration in ms ('' for none). */
export declare function iso(ms: number | null | undefined): string;
/** A duration in ms for people, in the locale ('narrow' by default: "1h 30m"). */
export declare function format(ms: number | null | undefined, options?: { style?: 'narrow' | 'short' | 'long'; smallest?: string; locale?: string }): string;
/** The duration input's controller, the one [data-ds-duration] makes. */
export declare function create(element: HTMLInputElement, options?: DurationOptions): DurationController;
