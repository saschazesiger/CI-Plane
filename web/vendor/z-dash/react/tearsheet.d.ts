/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Tearsheet> (react/tearsheet.js), generated from src/components/tearsheet/. */
import type { BehaviourComponent, OverlayProps } from './shared.js';

export type TearsheetVariant = 'narrow';

export interface TearsheetEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:dirty on the root. */
  onDsDirty?: (event: CustomEvent) => void;
  /** ds:step on the root. */
  onDsStep?: (event: CustomEvent) => void;
  /** ds:submit on the root. */
  onDsSubmit?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TearsheetOptions {
}

export declare const Tearsheet: BehaviourComponent<'dialog', TearsheetVariant, TearsheetEvents & TearsheetOptions & OverlayProps, ReturnType<typeof import('../js/tearsheet.js').create>>;
