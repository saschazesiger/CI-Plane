/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.taginput (js/taginput.js). */

export interface TaginputRules {
  /** A repeat (case aside) is refused (default true). */
  unique?: boolean;
  /** The most tags. */
  max?: number;
  /** The whole tag must match (a RegExp, or its source). */
  pattern?: RegExp | string | null;
  /** false or a message refuses the tag. */
  validate?: (text: string, value: string[]) => boolean | string | void;
}

export interface TaginputOptions extends TaginputRules {
  /** The first tags (default data-ds-value: a JSON list or comma-separated). */
  value?: string[];
  /** The characters that end a tag (default [',']). */
  separators?: string[];
  /** Leaving the field adds what is typed (default true). */
  addOnBlur?: boolean;
  /** Hidden inputs of this name carry the value in a form. */
  name?: string;
}

export interface TaginputChange {
  value: string[];
  added: string[];
  removed: string[];
}

export interface TaginputController {
  readonly element: Element;
  get(): string[];
  set(value: string[]): void;
  on(type: 'change', fn: (detail: TaginputChange) => void): () => void;
  on(type: 'add', fn: (detail: { text: string }) => void): () => void;
  add(text: string | string[]): string;
  remove(tag: string): void;
  destroy(): void;
}

/** The tags of a typed or pasted text: split, trimmed, the empty ones gone. */
export declare function split(text: string, separators?: string[]): string[];
/** Whether `text` may join `value`, and why not. */
export declare function check(text: string, value: string[], options?: TaginputRules): { ok: boolean, reason?: 'empty' | 'duplicate' | 'invalid' | 'max', message?: string };
/** The controller of a tag input, the one [data-ds-taginput] makes. */
export declare function create(element: Element, options?: TaginputOptions): TaginputController | null;
