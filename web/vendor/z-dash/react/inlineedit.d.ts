/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <InlineEdit> (react/inlineedit.js), generated from src/components/inlineedit/. */
import type { BehaviourComponent } from './shared.js';

export type InlineEditVariant = never;

export interface InlineEditEvents {
  /** ds:cancel on the root. */
  onDsCancel?: (event: CustomEvent) => void;
  /** ds:edit on the root. */
  onDsEdit?: (event: CustomEvent) => void;
  /** ds:save on the root. */
  onDsSave?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface InlineEditOptions {
}

export declare const InlineEdit: BehaviourComponent<'div', InlineEditVariant, InlineEditEvents & InlineEditOptions, ReturnType<typeof import('../js/inlineedit.js').create>>;
