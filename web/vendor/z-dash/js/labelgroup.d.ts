/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.labelgroup (src/components/labelgroup/labelgroup.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export interface LabelGroupState {
  /** How many tags in all. */
  total: number;
  /** How many do not fit on the line (the "+N"). */
  hidden: number;
  /** Whether the popup with every tag is open. */
  open: boolean;
}

export interface LabelGroupController {
  get(): LabelGroupState;
  /** Opens (true) or closes the popup; opens only while tags are hidden. */
  set(next: boolean): void;
  on(type: 'change', fn: (detail: LabelGroupState) => void): () => void;
  /** Measures the tags again. */
  update(): void;
  destroy(): void;
}

/** How many tags fit in `room` px beside a `more` px button, `gap` px apart, at most `max`, at least one. */
export declare function visibleCount(widths: number[], room: number, more: number, gap: number, max?: number): number;
/** A label group driven from the page (the .ds-label-group). */
export declare function create(el: Element, options?: { max?: number }): LabelGroupController;
