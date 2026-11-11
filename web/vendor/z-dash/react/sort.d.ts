/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Sort> (react/sort.js), generated from src/components/sort/. */
import type { BehaviourComponent } from './shared.js';

export type SortVariant = 'menu';

export interface SortEvents {
  /** ds:sort on the root. */
  onDsSort?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface SortOptions {
}

export declare const Sort: BehaviourComponent<'div', SortVariant, SortEvents & SortOptions, ReturnType<typeof import('../js/sort.js').create>>;
