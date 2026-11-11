/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <KeyValueEditor> (react/kveditor.js), generated from src/components/kveditor/. */
import type { BehaviourComponent } from './shared.js';

export type KeyValueEditorVariant = 'code';

export interface KeyValueEditorEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface KeyValueEditorOptions {
}

export declare const KeyValueEditor: BehaviourComponent<'fieldset', KeyValueEditorVariant, KeyValueEditorEvents & KeyValueEditorOptions, ReturnType<typeof import('../js/kveditor.js').create>>;
