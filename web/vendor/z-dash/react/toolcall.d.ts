/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <ToolCall> (react/toolcall.js), generated from src/components/toolcall/. */
import type { BehaviourComponent } from './shared.js';

export type ToolCallVariant = 'row';

export interface ToolCallEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ToolCallOptions {
  /** data-ds-toolcall-since (true: present, false or none: absent). */
  since?: string | number | boolean | object | null;
  /** data-ds-toolcall-duration (true: present, false or none: absent). */
  duration?: string | number | boolean | object | null;
}

export declare const ToolCall: BehaviourComponent<'details', ToolCallVariant, ToolCallEvents & ToolCallOptions, ReturnType<typeof import('../js/toolcall.js').create>>;
