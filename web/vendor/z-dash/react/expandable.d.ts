/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Expandable> (react/expandable.js), generated from src/components/expandable/. */
import type { BehaviourComponent } from './shared.js';

export type ExpandableVariant = never;

export interface ExpandableEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ExpandableOptions {
}

export declare const Expandable: BehaviourComponent<'div', ExpandableVariant, ExpandableEvents & ExpandableOptions, ReturnType<typeof import('../js/expandable.js').create>>;
