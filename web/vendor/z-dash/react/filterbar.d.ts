/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <FilterBar> (react/filterbar.js), generated from src/components/filterbar/. */
import type { BehaviourComponent } from './shared.js';

export type FilterBarVariant = never;

export interface FilterBarEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:filter on the root. */
  onDsFilter?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface FilterBarOptions {
  /** data-ds-filterbar-sheet (true: present, false or none: absent). */
  sheet?: string | number | boolean | object | null;
}

export declare const FilterBar: BehaviourComponent<'div', FilterBarVariant, FilterBarEvents & FilterBarOptions, ReturnType<typeof import('../js/filterbar.js').create>>;
