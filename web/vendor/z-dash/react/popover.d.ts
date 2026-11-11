/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Popover> (react/popover.js), generated from src/components/popover/. */
import type { BehaviourComponent } from './shared.js';

export type PopoverVariant = 'adaptive' | 'block' | 'disc' | 'disclosure' | 'elevated' | 'filled' | 'ghost' | 'icon' | 'outlined' | 'quiet' | 'text' | 'tonal';

export interface PopoverEvents {
  /** ds:close on the root. */
  onDsClose?: (event: CustomEvent) => void;
  /** ds:open on the root. */
  onDsOpen?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface PopoverOptions {
  /** data-ds-popover-placement (true: present, false or none: absent). */
  placement?: string | number | boolean | object | null;
  /** data-ds-popover-align (true: present, false or none: absent). */
  align?: string | number | boolean | object | null;
  /** data-ds-popover-trigger (true: present, false or none: absent). */
  trigger?: string | number | boolean | object | null;
}

export declare const Popover: BehaviourComponent<'button', PopoverVariant, PopoverEvents & PopoverOptions, ReturnType<typeof import('../js/popover.js').create>>;
