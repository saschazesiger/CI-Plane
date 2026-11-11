/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Menu> (react/menu.js), generated from src/components/menu/. */
import type { BehaviourComponent } from './shared.js';

export type MenuVariant = never;

export interface MenuEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:contextmenu on the root. */
  onDsContextmenu?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface MenuOptions {
}

export declare const Menu: BehaviourComponent<'div', MenuVariant, MenuEvents & MenuOptions, ReturnType<typeof import('../js/menu.js').create>>;
