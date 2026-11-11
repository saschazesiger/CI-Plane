/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.virtual (js/virtual.js). Hand-written; test/build.test.js keeps
 * the declared exports and their parameters equal to the module's.
 */

/** A row's height until it was measured: a number, or a function of the index. */
export type Estimate = number | ((index: number) => number);

export interface SizeModel {
  readonly count: number;
  /** A row's height: measured, else estimated. */
  size(index: number): number;
  /** Sets the measured height of a row; returns the difference. */
  set(index: number, height: number): number;
  /** Whether set() has measured this row. */
  measured(index: number): boolean;
  /** The sum of the heights before `index`. */
  offset(index: number): number;
  total(): number;
  /** The row that holds `offset`. */
  indexAt(offset: number): number;
  /** A new length: rows that stay keep their heights. */
  resize(count: number): void;
  /** A better estimate: every row not measured yet takes it. */
  estimate(estimate: Estimate): void;
  /** Forgets what was measured. */
  forget(): void;
}

export interface VirtualOptions {
  /** The markup of one row: one root element, with its data-ds-key. */
  render: (index: number) => string;
  /** How many rows (default 0). */
  count?: number;
  /** A row's height until measured (default: the first row measured). */
  estimate?: Estimate;
  /** Rows rendered beyond each end of the viewport (default 4). */
  overscan?: number;
  /** The element that holds the rows (default: the first tbody, list, listbox, rowgroup or grid in the scroller, else the scroller). */
  content?: Element;
  /** One tab stop with arrow, Home, End and page keys (default true). */
  keyboard?: boolean;
  /** The row that holds the tab stop at the start (default 0). */
  active?: number;
  /** What ARIA reports when `count` is not the whole set; -1: unknown. */
  total?: number;
  /** Rows above these in a table or grid (default the rows of its thead). */
  rowOffset?: number;
  /** The columns a spacer row spans (default those of the header row). */
  columns?: number;
}

export interface VirtualState {
  /** The first row of the window. */
  start: number;
  /** One past the last row of the window. */
  end: number;
  count: number;
  active: number;
}

export interface VirtualController {
  get(): VirtualState;
  /** Changes the count, the reported total or the active row; `forget`: the data is new, forget measured heights. */
  set(value: { count?: number; total?: number | null; active?: number; forget?: boolean }): void;
  /** ds:range ({ start, end, count }) or ds:active ({ index, element }); returns the unsubscribe. */
  on(type: 'range' | 'active', fn: (detail: any) => void): () => void;
  /** Renders one row again; without an index, all of them. */
  refresh(index?: number): void;
  /** Brings a row into view and returns its element. */
  scrollTo(index: number, options?: { align?: 'auto' | 'start' | 'center' | 'end' }): Element | null;
  /** Makes a row the active one, brings it into view and focuses it. */
  focus(index: number): Element | null;
  /** The element of a row, if rendered. */
  row(index: number): Element | null;
  /** The index of a row or of anything in one, else -1. */
  indexOf(node: Node | null): number;
  destroy(): void;
}

/** The height of `count` rows and the offsets they add up to, in log(count). */
export declare function sizes(count?: number, estimate?: Estimate): SizeModel;
/** Windows the rows of `scroller`; once per scroller. */
export declare function create(scroller: Element | null | undefined, options?: VirtualOptions): VirtualController;
