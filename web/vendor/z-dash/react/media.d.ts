/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Media> (react/media.js), generated from src/components/media/. */
import type { BehaviourComponent } from './shared.js';

export type MediaVariant = never;

export interface MediaEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface MediaOptions {
}

export declare const Media: BehaviourComponent<'ul', MediaVariant, MediaEvents & MediaOptions, ReturnType<typeof import('../js/media.js').create>>;
