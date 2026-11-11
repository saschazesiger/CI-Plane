/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.orderedchoice (js/orderedchoice.js). */

export interface OrderedchoiceOptions {
  /** The most checked rows (default data-ds-orderedchoice-max, else no limit). */
  max?: number;
  /** Checked, in this order, first; the rest after it. */
  value?: string[];
}

export interface OrderedchoiceController {
  readonly element: Element;
  get(): string[];
  set(value: string[]): void;
  order(): string[];
  on(type: 'change', fn: (detail: { value: string[], order: string[] }) => void): () => void;
  move(which: string, index: number): boolean;
  refresh(): void;
  destroy(): void;
}

/** `order` with `value` first, in its order, the rest after it. */
export declare function arrange(order: string[], value: string[]): string[];
/** The places of the checked values: value to 1, 2, ... in `order`. */
export declare function ranks(order: string[], checked: Set<string> | string[]): Map<string, number>;
/** The controller of an ordered choice, the one [data-ds-orderedchoice] makes. */
export declare function create(element: Element, options?: OrderedchoiceOptions): OrderedchoiceController | null;
