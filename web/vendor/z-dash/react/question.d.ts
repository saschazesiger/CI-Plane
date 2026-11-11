/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <QuestionCard> (react/question.js), generated from src/components/question/. */
import type { BehaviourComponent } from './shared.js';

export type QuestionCardVariant = never;

export interface QuestionCardEvents {
  /** ds:answer on the root. */
  onDsAnswer?: (event: CustomEvent) => void;
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface QuestionCardOptions {
}

export declare const QuestionCard: BehaviourComponent<'form', QuestionCardVariant, QuestionCardEvents & QuestionCardOptions, ReturnType<typeof import('../js/question.js').create>>;
