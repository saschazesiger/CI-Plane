/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <TagInput> (react/taginput.js), generated from src/components/taginput/. */
import type { BehaviourComponent } from './shared.js';

export type TagInputVariant = 'full';

export interface TagInputEvents {
  /** ds:add on the root. */
  onDsAdd?: (event: CustomEvent) => void;
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TagInputOptions {
}

export declare const TagInput: BehaviourComponent<'div', TagInputVariant, TagInputEvents & TagInputOptions, ReturnType<typeof import('../js/taginput.js').create>>;
