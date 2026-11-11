/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.choices (js/choices.js). */

export interface ChoicesOptions {
  /** The checked values to start with (default the markup's `checked`). */
  value?: string[];
  /** Write the count into .ds-choices__count (default true). */
  count?: boolean;
}

export interface ChoicesController {
  readonly element: Element;
  get(): string[];
  set(value: string[]): void;
  on(type: 'change', fn: (detail: { value: string[] }) => void): () => void;
  filter(text: string): number;
  refresh(): void;
  destroy(): void;
}

/** The state of a "select all" box over these boxes; blocked ones do not count. */
export declare function summary(boxes: Array<{ checked: boolean, disabled?: boolean }>): 'all' | 'none' | 'some';
/** The controller of a choice list, the one [data-ds-choices] makes. */
export declare function create(element: Element, options?: ChoicesOptions): ChoicesController | null;
