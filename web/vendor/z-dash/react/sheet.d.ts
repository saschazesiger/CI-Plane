/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Sheet> (react/sheet.js), generated from src/components/sheet/. */
import type { BehaviourComponent, OverlayProps } from './shared.js';

export type SheetVariant = never;

export interface SheetEvents {
  /** ds:close on the root. */
  onDsClose?: (event: CustomEvent) => void;
  /** ds:resize on the root. */
  onDsResize?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface SheetOptions {
}

export declare const Sheet: BehaviourComponent<'dialog', SheetVariant, SheetEvents & SheetOptions & OverlayProps, ReturnType<typeof import('../js/sheet.js').create>>;
