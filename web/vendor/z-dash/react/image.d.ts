/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Image> (react/image.js), generated from src/components/image/. */
import type { BehaviourComponent } from './shared.js';

export type ImageVariant = never;

export interface ImageEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ImageOptions {
}

export declare const Image: BehaviourComponent<'span', ImageVariant, ImageEvents & ImageOptions, ReturnType<typeof import('../js/image.js').create>>;
