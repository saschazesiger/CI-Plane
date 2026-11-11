/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <CodeBlock> (react/code.js), generated from src/components/code/. */
import type { BehaviourComponent } from './shared.js';

export type CodeBlockVariant = 'lines';

export interface CodeBlockEvents {
}

/** The options of its documented attributes. */
export interface CodeBlockOptions {
  /** data-ds-code-max (true: present, false or none: absent). */
  dsCodeMax?: string | number | boolean | object | null;
  /** data-ds-code-start (true: present, false or none: absent). */
  dsCodeStart?: string | number | boolean | object | null;
  /** data-ds-code-mark (true: present, false or none: absent). */
  mark?: string | number | boolean | object | null;
}

export declare const CodeBlock: BehaviourComponent<'figure', CodeBlockVariant, CodeBlockEvents & CodeBlockOptions, ReturnType<typeof import('../js/code.js').create>>;
