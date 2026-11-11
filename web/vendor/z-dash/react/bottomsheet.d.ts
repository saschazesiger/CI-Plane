/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <BottomSheet> (react/bottomsheet.js), generated from src/components/bottomsheet/. */
import type { BehaviourComponent, OverlayProps } from './shared.js';

export type BottomSheetVariant = never;

export interface BottomSheetEvents {
  /** ds:detent on the root. */
  onDsDetent?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface BottomSheetOptions {
  /** data-ds-bottomsheet-detents (true: present, false or none: absent). */
  detents?: string | number | boolean | object | null;
}

export declare const BottomSheet: BehaviourComponent<'dialog', BottomSheetVariant, BottomSheetEvents & BottomSheetOptions & OverlayProps, ReturnType<typeof import('../js/bottomsheet.js').create>>;
