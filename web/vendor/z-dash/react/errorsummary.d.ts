/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <ErrorSummary> (react/errorsummary.js), generated from src/components/errorsummary/. */
import type { BehaviourComponent } from './shared.js';

export type ErrorSummaryVariant = 'inline' | 'plain' | 'section';

export interface ErrorSummaryEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:invalid on the root. */
  onDsInvalid?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ErrorSummaryOptions {
}

export declare const ErrorSummary: BehaviourComponent<'div', ErrorSummaryVariant, ErrorSummaryEvents & ErrorSummaryOptions, ReturnType<typeof import('../js/errorsummary.js').create>>;
