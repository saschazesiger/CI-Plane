/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Truncate> (react/truncate.js), generated from src/components/truncate/. */
import type { BehaviourComponent } from './shared.js';

export type TruncateVariant = 'lines';

export interface TruncateEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes, and its content. */
export interface TruncateOptions {
  /** The text the behaviour renders; string children give it too. */
  text?: string;
  children?: string | number;
}

export declare const Truncate: BehaviourComponent<'span', TruncateVariant, TruncateEvents & TruncateOptions, ReturnType<typeof import('../js/truncate.js').create>>;
