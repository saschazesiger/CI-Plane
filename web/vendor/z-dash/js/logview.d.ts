/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.logview (src/components/logview/logview.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type AnsiColour = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white';

/** One run of a text with ANSI escapes: its text and its style. */
export interface AnsiRun {
  text: string;
  fg: AnsiColour | null;
  bg: AnsiColour | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

/** One line of a log as data (parse()). */
export interface LogLine {
  /** The stamp at its start as written, or null. */
  time: string | null;
  level: LogLevel | null;
  /** The message: without the stamp, the level word and the ANSI escapes. */
  text: string;
  /** The ANSI runs of the message. */
  segments: AnsiRun[];
}

/** A line given to append() or `lines`: text, or its parts. */
export type LogInput = string | { text?: string; message?: string; level?: string; time?: string | number | Date };

export interface LogviewOptions {
  /** Text (lines split at line breaks) or a list of lines; default the .ds-logview__source inside. */
  lines?: string | LogInput[];
  /** Keep the end in view while lines arrive, with the "Latest" pill (default true). */
  follow?: boolean;
  /** Lines wrap (default false). */
  wrap?: boolean;
  /** The timestamp column: the time of day (default), the stamp as written, or none. */
  time?: 'time' | 'full' | 'off';
  /** Lines kept; the oldest go first (default 100000; 0: no limit). */
  limit?: number;
  /** The tool bar (default true). */
  tools?: boolean;
  /** A DS.store namespace that remembers wrap and timestamps. */
  store?: string | null;
}

export interface LogviewState {
  /** Lines kept. */
  count: number;
  /** Lines the filters let through. */
  shown: number;
  /** The search, in lower case. */
  query: string;
  /** The levels that show. */
  levels: LogLevel[];
  /** Only the lines with a match show. */
  only: boolean;
  wrap: boolean;
  time: 'time' | 'full' | 'off';
  /** The line numbers selected. */
  selected: number[];
  /** Every line kept, as plain text. */
  lines: string[];
}

export interface LogviewChange {
  /** Replaces every line. */
  text?: string | LogInput[];
  query?: string;
  only?: boolean;
  levels?: LogLevel[];
  wrap?: boolean;
  time?: 'time' | 'full' | 'off' | boolean;
  limit?: number;
  /** The line numbers to select. */
  selected?: number[];
}

export interface LogviewController {
  get(): LogviewState;
  /** A change, or new text for every line. */
  set(value: LogviewChange | string | LogInput[]): void;
  /** Adds lines at the end (batched to a frame). */
  append(value: string | LogInput[]): void;
  /** Drops every line. */
  clear(): void;
  /** Copies the selected lines that show, else the active one; resolves with the text. */
  copy(): Promise<string>;
  /** Goes to the next or previous search match. */
  find(direction?: 'next' | 'previous'): void;
  /** Goes back to the end and follows it. */
  latest(): void;
  on(type: 'change', fn: (detail: { query: string; levels: LogLevel[]; wrap: boolean; time: string; shown: number; count: number }) => void): () => void;
  on(type: 'select', fn: (detail: { lines: number[] }) => void): () => void;
  on(type: 'copy', fn: (detail: { text: string; count: number }) => void): () => void;
  /** Applies the data-ds-logview-* options (and aria-label) whose attributes changed; without `names`, all of them. */
  update(names?: string[]): void;
  destroy(): void;
}

/** The runs of a text with ANSI escapes. */
export declare function ansi(text: string): AnsiRun[];

/** One line of a log as data. */
export declare function parse(line: string): LogLine;

/** A log viewer driven from the page; the same controller the attribute path makes. */
export declare function create(el: Element, options?: LogviewOptions): LogviewController;
