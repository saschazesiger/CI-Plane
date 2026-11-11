/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <LevelMeter> (react/levelmeter.js), generated from src/components/levelmeter/. */
import type { BehaviourComponent } from './shared.js';

export type LevelMeterVariant = 'segmented' | 'vertical';

export interface LevelMeterEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface LevelMeterOptions {
}

export declare const LevelMeter: BehaviourComponent<'div', LevelMeterVariant, LevelMeterEvents & LevelMeterOptions, ReturnType<typeof import('../js/levelmeter.js').create>>;
