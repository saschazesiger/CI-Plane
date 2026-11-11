/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.highlight (src/components/highlight/highlight.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export type HighlightKind = 'keyword' | 'string' | 'number' | 'comment' | 'function' | 'type' | 'property' | 'tag'
  | 'attribute' | 'variable' | 'constant' | 'regex' | 'operator' | 'punctuation' | 'meta' | 'inserted' | 'deleted';

export interface HighlightToken {
  /** One of KINDS, or null for plain text. */
  kind: HighlightKind | null;
  text: string;
}

/** The state a rule's function reads: the last significant token (no comment, no blank). */
export interface HighlightState {
  prev: { kind: string | null; text: string } | null;
  code: string;
  data: Record<string, unknown>;
}

/** A rule's kind: a kind, null for plain, or a function that decides, or splits the match into sub-tokens. */
export type HighlightRuleKind = HighlightKind | null
  | ((text: string, state: HighlightState, index: number, end: number) => HighlightKind | null | Array<[HighlightKind | null, string]>);

export type HighlightRules = Array<[HighlightRuleKind, RegExp]> | ((code: string) => Array<[HighlightKind | null, string]>);

/** The page's own highlighter: markup for the code, or null to leave the language to the system. */
export type ExternalHighlighter = (code: string, language: string) => string | null | undefined;

export interface HighlightOptions {
  /** The code (default: the element's text). */
  code?: string;
  /** The language (default: data-ds-highlight, else a class language-<x>). */
  language?: string;
}

export interface HighlightChange {
  code: string;
  language: string;
}

export interface HighlightController {
  get(): string;
  set(code: string): void;
  on(type: 'change', fn: (detail: HighlightChange) => void): () => void;
  /** Reads the language again (the attribute path calls it). */
  update(): void;
  /** Puts the plain text back. */
  destroy(): void;
}

/** The token kinds, one class .ds-highlight__<kind> each. */
export declare const KINDS: readonly HighlightKind[];
/** Adds or replaces a language. */
export declare function register(name: string, rules: HighlightRules, aliases?: string[]): void;
/** The canonical name of a language or alias, or null. */
export declare function language(name: string | null | undefined): string | null;
/** Every registered language, sorted. */
export declare function languages(): string[];
/** The tokens of the code: every character in order. */
export declare function tokenize(code: string, lang: string): HighlightToken[];
/** Sets the page's own highlighter (null: the system's again). */
export declare function use(highlighter: ExternalHighlighter | null): void;
/** Escaped markup with the token spans. */
export declare function highlight(code: string, lang: string): string;
/** The markup, one string per line; spans close and reopen at each break. */
export declare function lines(code: string, lang: string): string[];
/** Highlights an element's text in place. */
export declare function create(el: Element, options?: HighlightOptions): HighlightController;
