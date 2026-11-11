/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
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
  /** The active item now, or null. */
  get(): Element | null;
  /** Makes an element or the first match of a selector the active item (it writes the item's state attribute); null clears it. */
  set(value: Element | string | null): void;
  /** Listens for ds:<type> of this track ('change': the active item changed, detail.item); returns the unsubscribe. */
  on(type: string, fn: (event: CustomEvent<{ item: Element | null }>) => void): () => void;
  /** Moves the indicator to the current active item. With names (the core), reads the option attributes again. */
  update(names?: readonly string[]): void;
  destroy(): void;
}
/**
 * One gliding .ds-indicator behind the items of `track`; the live handle again for the same track and options.
 * The same handle as DS.core.get(track, 'indicator') on a track with data-ds-indicator.
 */
export declare function create(track: HTMLElement, options: IndicatorOptions): IndicatorHandle;
