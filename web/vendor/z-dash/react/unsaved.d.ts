/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <UnsavedGuard> (react/unsaved.js), generated from src/components/unsaved/. */
import type { BehaviourComponent } from './shared.js';

export type UnsavedGuardVariant = 'rows';

export interface UnsavedGuardEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:discard on the root. */
  onDsDiscard?: (event: CustomEvent) => void;
  /** ds:error on the root. */
  onDsError?: (event: CustomEvent) => void;
  /** ds:save on the root. */
  onDsSave?: (event: CustomEvent) => void;
  /** ds:saved on the root. */
  onDsSaved?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface UnsavedGuardOptions {
}

export declare const UnsavedGuard: BehaviourComponent<'form', UnsavedGuardVariant, UnsavedGuardEvents & UnsavedGuardOptions, ReturnType<typeof import('../js/unsaved.js').create>>;
