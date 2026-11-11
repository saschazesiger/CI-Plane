/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Drawer> (react/drawer.js), generated from src/components/shell/. */
import type { BehaviourComponent, Controller } from './shared.js';

export type DrawerVariant = 'instant';

export interface DrawerEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:filter on the root. */
  onDsFilter?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface DrawerOptions {
}

export declare const Drawer: BehaviourComponent<'nav', DrawerVariant, DrawerEvents & DrawerOptions, Controller>;
