/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Terminal> (react/terminal.js), generated from src/components/terminal/. */
import type { BehaviourComponent } from './shared.js';

export type TerminalVariant = 'fill';

export interface TerminalEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:key on the root. */
  onDsKey?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TerminalOptions {
  /** data-ds-terminal-keys (true: present, false or none: absent). */
  keys?: string | number | boolean | object | null;
  /** data-ds-terminal-bar (true: present, false or none: absent). */
  bar?: string | number | boolean | object | null;
  /** data-ds-terminal-status (true: present, false or none: absent). */
  status?: string | number | boolean | object | null;
}

export declare const Terminal: BehaviourComponent<'div', TerminalVariant, TerminalEvents & TerminalOptions, ReturnType<typeof import('../js/terminal.js').create>>;
