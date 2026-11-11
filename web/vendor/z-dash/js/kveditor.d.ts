/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.kveditor (src/components/kveditor/kveditor.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export interface KeyValueRow {
  key: string;
  value: string;
  /** A secret value: masked until revealed. */
  secret?: boolean;
}

export type KeyValueInput = Record<string, string> | Array<KeyValueRow | [string, string]> | string;

export interface KeyValueOptions {
  /** The start value: an object, rows, JSON or KEY=value text (default data-ds-value). */
  value?: KeyValueInput;
  /** A hidden input of this name carries the value for a plain form. */
  name?: string;
  /** What the hidden input holds: JSON of the object (default) or KEY=value lines. */
  format?: 'json' | 'env';
  /** Keys whose values are secret: a RegExp or its source (case-insensitive). */
  secret?: RegExp | string;
}

export interface KeyValueChange {
  rows: KeyValueRow[];
  value: Record<string, string>;
  /** The keys that come more than once. */
  duplicates: string[];
}

export interface KeyValueController {
  get(): KeyValueRow[];
  set(value: KeyValueInput): void;
  /** Adds a row (at `index`, default the end) and returns it. */
  add(row?: Partial<KeyValueRow>, index?: number): HTMLLIElement;
  remove(index: number): Promise<void>;
  toObject(): Record<string, string>;
  toText(): string;
  on(type: 'change', fn: (detail: KeyValueChange) => void): () => void;
  destroy(): void;
}

/** KEY=value lines as rows (comments, export and quotes read as dotenv does). */
export declare function parse(text: string): { key: string; value: string }[];
/** Rows as KEY=value lines, quoting values that need it. */
export declare function stringify(rows: Iterable<{ key: string; value: string }>): string;
/** The keys that come more than once, with the indices of their rows. */
export declare function duplicates(rows: Iterable<{ key: string }>): Map<string, number[]>;
/** Rows as an object: the last row of a key wins. */
export declare function toObject(rows: Iterable<{ key: string; value: string }>): Record<string, string>;
/** A key-value editor driven from the page. */
export declare function create(el: Element, options?: KeyValueOptions): KeyValueController;
