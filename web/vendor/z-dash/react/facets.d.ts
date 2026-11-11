/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Facets> (react/facets.js), generated from src/components/facets/. */
import type { BehaviourComponent } from './shared.js';

export type FacetsVariant = never;

export interface FacetsEvents {
  /** ds:filter on the root. */
  onDsFilter?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface FacetsOptions {
  /** data-ds-facets-sheet (true: present, false or none: absent). */
  sheet?: string | number | boolean | object | null;
  /** data-ds-facets-zero (true: present, false or none: absent). */
  zero?: string | number | boolean | object | null;
}

export declare const Facets: BehaviourComponent<'section', FacetsVariant, FacetsEvents & FacetsOptions, ReturnType<typeof import('../js/facets.js').create>>;
