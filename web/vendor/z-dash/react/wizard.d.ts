/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Wizard> (react/wizard.js), generated from src/components/wizard/. */
import type { BehaviourComponent } from './shared.js';

export type WizardVariant = never;

export interface WizardEvents {
  /** ds:step on the root. */
  onDsStep?: (event: CustomEvent) => void;
  /** ds:validate on the root. */
  onDsValidate?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface WizardOptions {
}

export declare const Wizard: BehaviourComponent<'form', WizardVariant, WizardEvents & WizardOptions, ReturnType<typeof import('../js/wizard.js').create>>;
