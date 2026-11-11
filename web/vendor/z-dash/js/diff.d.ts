/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.diff (src/components/diff/diff.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the module's.
 */

export type DiffKind = 'ctx' | 'add' | 'del';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** The line number on the old side, null for an added line. */
  old: number | null;
  /** The line number on the new side, null for a removed line. */
  new: number | null;
  /** "\ No newline at end of file" followed it. */
  noNewline: boolean;
  /** The changed words ([start, end) in `text`), set by rows(). */
  marks?: Array<[number, number]> | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the second @@ (a function name). */
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  /** The path it is shown by: the new one, else the old one. */
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffGap {
  /** Old-side line numbers of the lines the diff leaves out above a hunk. */
  from: number;
  to: number;
  count: number;
  key: string;
}

export type DiffRow =
  | { type: 'hunk'; hunk: DiffHunk; index: number; gap: DiffGap | null }
  | { type: 'line'; line: DiffLine }
  | { type: 'pair'; left: DiffLine | null; right: DiffLine | null }
  | { type: 'fold'; key: string; count: number; lines: DiffLine[] }
  | { type: 'note' };

export interface DiffRowsOptions {
  view?: 'unified' | 'split';
  /** Unchanged lines kept around a change (default 3); 'all' never folds. */
  context?: number | 'all';
  /** The keys of folds already opened. */
  expanded?: Iterable<string>;
}

export interface DiffWords {
  removed: Array<[number, number]>;
  added: Array<[number, number]>;
}

export type DiffHighlighter = (code: string, language: string) => string;

export interface DiffLoadRequest {
  file: DiffFile;
  path: string;
  /** Old-side line numbers, inclusive. */
  from: number;
  to: number;
}

export interface DiffOptions {
  /** The diff text (default: the text of the .ds-diff__source inside). */
  text?: string;
  /** unified (default), split, or auto (split from --ds-diff-split-min of width). */
  view?: 'unified' | 'split' | 'auto';
  context?: number | 'all';
  /** The language of every file (default: each file's extension). */
  language?: string;
  /** The level of the file headings, 2 to 6 (default 3). */
  heading?: number;
  /** This view's highlighter; false: none. */
  highlight?: DiffHighlighter | false;
  /** The lines the diff leaves out above a hunk, when the page can fetch them. */
  load?: (request: DiffLoadRequest) => string[] | Promise<string[]>;
}

export interface DiffState {
  text: string;
  view: 'unified' | 'split' | 'auto';
  /** The view in force (auto resolved). */
  mode: 'unified' | 'split';
  files: DiffFile[];
}

export interface DiffController {
  get(): DiffState;
  /** New text (a string), or options to change. */
  set(value: string | Partial<Pick<DiffOptions, 'text' | 'view' | 'context' | 'language' | 'highlight' | 'load'>>): void;
  /** Opens every fold. */
  expand(): void;
  on(type: 'change', fn: (detail: { view: string; text: string }) => void): () => void;
  on(type: 'expand', fn: (detail: { file: DiffFile | null; count: number }) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  /** Renders again. */
  refresh(): void;
  destroy(): void;
}

/** Unified diff text as files, hunks and lines. */
export declare function parse(text: string): DiffFile[];
/** The changed words of two versions of a line, or null for a rewrite. */
export declare function words(before: string, after: string): DiffWords | null;
/** The rows a view shows for one file, folds included. */
export declare function rows(file: DiffFile, options?: DiffRowsOptions): DiffRow[];
/** A diff view driven from the page. */
export declare function create(el: Element, options?: DiffOptions): DiffController;
/** Sets the page's highlighter (null: none); returns the one before. */
export declare function highlighter(fn: DiffHighlighter | null): DiffHighlighter | null;
