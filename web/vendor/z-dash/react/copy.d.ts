/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <CopyButton> (react/copy.js), generated from src/components/copy/. */
import type { BehaviourComponent } from './shared.js';

export type CopyButtonVariant = 'adaptive' | 'block' | 'disc' | 'disclosure' | 'elevated' | 'filled' | 'ghost' | 'icon' | 'outlined' | 'quiet' | 'text' | 'tonal';

export interface CopyButtonEvents {
  /** ds:copy on the root. */
  onDsCopy?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface CopyButtonOptions {
}

export declare const CopyButton: BehaviourComponent<'button', CopyButtonVariant, CopyButtonEvents & CopyButtonOptions, ReturnType<typeof import('../js/copy.js').create>>;
