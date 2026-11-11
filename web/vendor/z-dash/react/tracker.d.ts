/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Tracker> (react/tracker.js), generated from src/components/tracker/. */
import type { BehaviourComponent } from './shared.js';

export type TrackerVariant = never;

export interface TrackerEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TrackerOptions {
}

export declare const Tracker: BehaviourComponent<'div', TrackerVariant, TrackerEvents & TrackerOptions, ReturnType<typeof import('../js/tracker.js').create>>;
