/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.question (src/components/question/question.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export type QuestionStateName = 'waiting' | 'answered' | 'skipped';

export interface QuestionAnswer {
  /** The values of the chosen options. */
  values: string[];
  /** Their labels, and the text of one's own answer. */
  labels: string[];
  /** The text of one's own answer ('' without). */
  other: string;
  skipped: boolean;
}

export interface QuestionState {
  state: QuestionStateName;
  values: string[];
  labels: string[];
  other: string;
}

export interface QuestionChanges {
  /** Picks one option (a radio) or exactly this one (checkboxes); null clears. */
  value?: string | null;
  /** Picks exactly these options. */
  values?: string[];
  /** The text of one's own answer. */
  other?: string;
  /** Settles it (after a cancelled ds:answer) or opens it again ('waiting'). */
  state?: QuestionStateName;
}

export interface QuestionController {
  get(): QuestionState;
  set(changes: QuestionChanges): void;
  on(type: 'change', fn: (detail: { state: QuestionStateName }) => void): () => void;
  on(type: 'answer', fn: (detail: QuestionAnswer) => void): () => void;
  destroy(): void;
}

/** The states of a question. */
export declare const QUESTION_STATES: readonly QuestionStateName[];
/** "Answered: A and B", "Skipped", or '' while it waits. */
export declare function answerText(state: QuestionStateName, labels?: string[]): string;
/** The option a digit key picks: 1 to 9 give 0 to 8, anything else -1. */
export declare function optionIndex(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): number;
/** A question card driven from the page. */
export declare function create(form: Element): QuestionController;
