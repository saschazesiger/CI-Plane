/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <AiLabel> (react/ailabel.js), generated from src/components/ailabel/. */
import type { BehaviourComponent } from './shared.js';

export type AiLabelVariant = 'icon' | 'outlined' | 'plain';

export interface AiLabelEvents {
  /** ds:toggle on the root. */
  onDsToggle?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface AiLabelOptions {
}

export declare const AiLabel: BehaviourComponent<'button', AiLabelVariant, AiLabelEvents & AiLabelOptions, ReturnType<typeof import('../js/ailabel.js').create>>;
