/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <MenuButton> (react/menubutton.js), generated from src/components/menubutton/. */
import type { BehaviourComponent } from './shared.js';

export type MenuButtonVariant = 'adaptive' | 'block' | 'disc' | 'disclosure' | 'elevated' | 'filled' | 'ghost' | 'icon' | 'outlined' | 'quiet' | 'text' | 'tonal';

export interface MenuButtonEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface MenuButtonOptions {
  /** data-ds-value (true: present, false or none: absent). */
  dsValue?: string | number | boolean | object | null;
}

export declare const MenuButton: BehaviourComponent<'button', MenuButtonVariant, MenuButtonEvents & MenuButtonOptions, ReturnType<typeof import('../js/menubutton.js').create>>;
