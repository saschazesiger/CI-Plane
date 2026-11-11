/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.prioritybar (js/prioritybar.js). */

/** A priority action bar's controller: get() the folded actions, update() measures again. */
export interface PriorityBarController {
  element: Element;
  more: Element;
  menu: Element;
  get(): Element[];
  update(): void;
  /** 'change' when the folded set changes: { folded }. Returns the unsubscribe. */
  on(type: 'change', fn: (detail: { folded: Element[] }) => void): () => void;
  destroy(): void;
}

export interface PriorityPlan {
  widths: number[];
  priorities?: number[];
  available: number;
  gap?: number;
  more?: number;
  pinned?: number;
  pinnedCount?: number;
}

/** The indexes of the actions to fold (ascending) so the rest fits. */
export declare function plan(input: PriorityPlan): number[];
/** A priority action bar driven from the page; the controller data-ds-prioritybar makes. */
export declare function create(bar: Element): PriorityBarController;
