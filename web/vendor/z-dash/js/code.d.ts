/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.code (src/components/code/code.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the module's.
 */

export interface CodeOptions {
  /** Replaces the first block's text. */
  code?: string;
}

export interface CodeLinesOptions {
  /** A language of DS.highlight (or one the page's highlighter knows); empty: plain. */
  language?: string;
  /** The number of the first line (default 1). */
  start?: number;
  /** The line numbers (as shown) to mark. */
  marks?: Set<number>;
}

export interface CodeEvents {
  change: { code: string; index: number };
  select: { index: number; panel: HTMLElement };
  expand: { expanded: boolean };
  wrap: { wrap: boolean };
}

export interface CodeController {
  /** The source of the block shown. */
  get(): string;
  /** Replaces the source of the block shown and renders it. */
  set(code: string): void;
  on<K extends keyof CodeEvents>(type: K, fn: (detail: CodeEvents[K]) => void): () => void;
  /** Shows the block at `index` (a tab). */
  select(index: number): void;
  /** Unfolds (true) or folds (false) a block longer than data-ds-code-max. */
  expand(open?: boolean): void;
  /** Wraps long lines (true) or scrolls them (false). */
  wrap(on?: boolean): void;
  /** Reads the blocks' attributes again and renders. */
  refresh(): void;
  /** The attribute path calls it when an option attribute changes. */
  update(): void;
  destroy(): void;
}

/** The line numbers a mark list names ("2,4-6"). */
export declare function parseLines(text: string | null | undefined): Set<number>;
/** The markup of the lines of a source, one .ds-code__line each. */
export declare function linesHtml(source: string, options?: CodeLinesOptions): string;
/** A code block driven from the page. */
export declare function create(el: Element, options?: CodeOptions): CodeController;
