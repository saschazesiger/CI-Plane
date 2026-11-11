/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Lightbox> (react/lightbox.js), generated from src/components/lightbox/. */
import type { BehaviourComponent } from './shared.js';

export type LightboxVariant = never;

export interface LightboxEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:close on the root. */
  onDsClose?: (event: CustomEvent) => void;
  /** ds:open on the root. */
  onDsOpen?: (event: CustomEvent) => void;
  /** ds:zoom on the root. */
  onDsZoom?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface LightboxOptions {
}

export declare const Lightbox: BehaviourComponent<'ul', LightboxVariant, LightboxEvents & LightboxOptions, ReturnType<typeof import('../js/lightbox.js').create>>;
