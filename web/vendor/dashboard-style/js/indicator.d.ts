/**
 * Types of DS.indicator (js/indicator.js). Hand-written; test/build.test.js
 * keeps the declared exports and their parameters equal to the module's.
 */

/** The largest pass of an edge beyond its target, as a share of its travel. */
export declare const OVERSHOOT: number;

export interface IndicatorOptions {
  /** Selector of the active item inside the track. */
  active: string;
  className?: string;
  /** Follow attribute and item changes (default true). */
  observe?: boolean;
  /** view-transition-name ds-indicator-<name> on the pill. */
  name?: string;
  /** Scroll the track so the active item is clear of its edges (default false). */
  reveal?: boolean;
}
export interface IndicatorHandle {
  /** Moves the indicator to the current active item. */
  update(): void;
  destroy(): void;
}
/** One gliding .ds-indicator behind the items of `track`; the live handle again for the same track and options. */
export declare function createIndicator(track: HTMLElement, options: IndicatorOptions): IndicatorHandle;
