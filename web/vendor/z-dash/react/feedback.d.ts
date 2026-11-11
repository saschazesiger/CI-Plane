/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Feedback> (react/feedback.js), generated from src/components/feedback/. */
import type { BehaviourComponent } from './shared.js';

export type FeedbackVariant = never;

export interface FeedbackEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:feedback on the root. */
  onDsFeedback?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface FeedbackOptions {
}

export declare const Feedback: BehaviourComponent<'div', FeedbackVariant, FeedbackEvents & FeedbackOptions, ReturnType<typeof import('../js/feedback.js').create>>;
