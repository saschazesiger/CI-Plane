/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <ChoiceList> (react/choices.js), generated from src/components/choices/. */
import type { BehaviourComponent } from './shared.js';

export type ChoiceListVariant = 'columns' | 'scroll';

export interface ChoiceListEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ChoiceListOptions {
}

export declare const ChoiceList: BehaviourComponent<'div', ChoiceListVariant, ChoiceListEvents & ChoiceListOptions, ReturnType<typeof import('../js/choices.js').create>>;
