/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Steps> (react/steps.js), generated from src/components/steps/. */
import type { BehaviourComponent } from './shared.js';

export type StepsVariant = 'bar' | 'path' | 'vertical';

export interface StepsEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface StepsOptions {
}

export declare const Steps: BehaviourComponent<'ol', StepsVariant, StepsEvents & StepsOptions, ReturnType<typeof import('../js/steps.js').create>>;
