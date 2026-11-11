/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <LoadingOverlay> (react/loadingoverlay.js), generated from src/components/loadingoverlay/. */
import type { BehaviourComponent } from './shared.js';

export type LoadingOverlayVariant = 'opaque';

export interface LoadingOverlayEvents {
  /** ds:cancel on the root. */
  onDsCancel?: (event: CustomEvent) => void;
  /** ds:hide on the root. */
  onDsHide?: (event: CustomEvent) => void;
  /** ds:show on the root. */
  onDsShow?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface LoadingOverlayOptions {
}

export declare const LoadingOverlay: BehaviourComponent<'div', LoadingOverlayVariant, LoadingOverlayEvents & LoadingOverlayOptions, ReturnType<typeof import('../js/loadingoverlay.js').create>>;
