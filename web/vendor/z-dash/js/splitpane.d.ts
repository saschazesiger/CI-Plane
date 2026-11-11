/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.splitpane (src/components/splitpane/splitpane.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export interface SplitpaneOptions {
  /** The key the sizes are remembered under (DS.store, namespace 'splitpane'); none: not remembered. */
  store?: string;
  /** The px a key moves a divider (default 16; with Shift four times that). */
  step?: number;
  /** The width in px under which the panes stack (data-state="stacked"); none: never. */
  stack?: number;
}

export interface SplitpaneState {
  /** The size of each pane in px, null for the pane that fills, 0 for a collapsed one. */
  sizes: (number | null)[];
  /** Whether each pane is collapsed. */
  collapsed: boolean[];
}

export interface SplitpaneValue {
  /** Per pane: px, a CSS length as text ('30%', '20rem' as computed px), or null to leave it. */
  sizes?: (number | string | null | undefined)[];
  /** Per pane: collapse (a pane marked data-ds-splitpane-collapsible) or restore it. */
  collapsed?: (boolean | null | undefined)[];
}

export interface SplitpaneChange extends SplitpaneState {
  /** The pane that changed (-1 after reset()). */
  index: number;
}

export interface SplitpaneController {
  get(): SplitpaneState;
  /** Sizes (px or CSS text) and collapsed panes; a bare array sets the sizes. */
  set(value?: SplitpaneValue | (number | string | null | undefined)[]): void;
  /** Collapses a pane, by index or id (the pane that fills never collapses). */
  collapse(ref: number | string): void;
  /** Restores a collapsed pane to its last open size. */
  expand(ref: number | string): void;
  toggle(ref: number | string): void;
  /** Back to the markup's sizes, nothing collapsed, the remembered sizes forgotten. */
  reset(): void;
  on(type: 'change', fn: (detail: SplitpaneChange) => void): () => void;
  /** The attribute path: re-reads the option attributes named (step, stack, store) without a new controller. */
  update(names?: string[]): void;
  /** Stops it and takes back what it wrote: no pane stays collapsed or inert, the dividers keep the markup's attributes. */
  destroy(): void;
}

/** A computed length in px: px, a percentage of `total`, or calc(<a>% ± <b>px); null for anything else. */
export declare function toPixels(text: string | null | undefined, total: number): number | null;

/** The size of a pane after a key or a drag, or null for a key that does nothing. */
export declare function nextSize(
  state: { size: number; min: number; max: number; collapsed?: boolean; collapsible?: boolean; step?: number },
  input: { key?: string; shift?: boolean; sign?: number; axis?: 'x' | 'y'; to?: number },
): { size: number; collapsed: boolean } | null;

/** A split pane driven from the page. */
export declare function create(el: Element, options?: SplitpaneOptions): SplitpaneController;
