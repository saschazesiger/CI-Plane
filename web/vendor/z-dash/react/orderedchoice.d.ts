/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <OrderedChoice> (react/orderedchoice.js), generated from src/components/orderedchoice/. */
import type { BehaviourComponent } from './shared.js';

export type OrderedChoiceVariant = never;

export interface OrderedChoiceEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface OrderedChoiceOptions {
}

export declare const OrderedChoice: BehaviourComponent<'ol', OrderedChoiceVariant, OrderedChoiceEvents & OrderedChoiceOptions, ReturnType<typeof import('../js/orderedchoice.js').create>>;
