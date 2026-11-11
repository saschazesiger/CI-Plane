/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.wizard (src/components/wizard/wizard.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export type WizardStatus = '' | 'done' | 'error';

export interface WizardState {
  /** The current step, from 0. */
  index: number;
  count: number;
  /** The current step's label. */
  step: string;
  panel: Element;
  status: WizardStatus[];
}

export interface WizardStepEvent {
  index: number;
  from: number;
  direction: 'forward' | 'back';
  panel: Element;
}

export interface WizardValidateEvent {
  index: number;
  panel: Element;
  /** The fields the browser found invalid (the first of a group). */
  invalid: Element[];
}

export interface WizardController {
  get(): WizardState;
  /** Goes to a step; forward checks every step on the way. Returns whether it got there. */
  set(index: number): boolean;
  go(index: number): boolean;
  next(): boolean;
  back(): boolean;
  /** Checks a step (default the current one) and shows its errors. */
  validate(index?: number): boolean;
  on(type: 'step', fn: (detail: WizardStepEvent) => void): () => void;
  on(type: 'validate', fn: (detail: WizardValidateEvent) => void): () => void;
  destroy(): void;
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** A field's label as a person reads it (data-ds-wizard-label, its label, aria-label, its group's legend). */
export declare function fieldLabel(field: Field): string;
/** A field's value as a person reads it ('' when nothing was given). */
export declare function fieldValue(field: Field, scope?: Element): string;
/** A wizard driven from the page. */
export declare function create(form: HTMLFormElement): WizardController;
