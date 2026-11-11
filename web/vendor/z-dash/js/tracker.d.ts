/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.tracker (src/components/tracker/tracker.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export type TrackerState = 'success' | 'info' | 'warning' | 'error' | 'empty';

export interface TrackerCell {
  state: TrackerState;
  /** The cell's name and tooltip: its date and its state in words. */
  label: string;
}

export interface TrackerCounts {
  success: number;
  info: number;
  warning: number;
  error: number;
  empty: number;
  total: number;
}

export interface TrackerController {
  get(): { cells: TrackerCell[]; counts: TrackerCounts };
  /** Renders the cells from data, reusing the existing ones in order. */
  set(list: TrackerCell[]): void;
  on(type: 'change', fn: (detail: { cells: TrackerCell[]; counts: TrackerCounts }) => void): () => void;
  /** Names the cells again and puts the tab stop back. */
  update(): void;
  destroy(): void;
}

/** How many cells of each state, and in all. */
export declare function counts(cells: Iterable<string | { state?: string }>): TrackerCounts;
/** A status row driven from the page (the .ds-tracker__cells row). */
export declare function create(el: Element): TrackerController;
