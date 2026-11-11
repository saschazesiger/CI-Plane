/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <ObjectPage> (react/object.js), generated from src/components/object/. */
import type { BehaviourComponent } from './shared.js';

export type ObjectPageVariant = never;

export interface ObjectPageEvents {
  /** ds:cancel on the root. */
  onDsCancel?: (event: CustomEvent) => void;
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:edit on the root. */
  onDsEdit?: (event: CustomEvent) => void;
  /** ds:save on the root. */
  onDsSave?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ObjectPageOptions {
}

export declare const ObjectPage: BehaviourComponent<'div', ObjectPageVariant, ObjectPageEvents & ObjectPageOptions, ReturnType<typeof import('../js/object.js').create>>;
