/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Kbd> (react/kbd.js), generated from src/components/kbd/. */
import type { BehaviourComponent } from './shared.js';

export type KbdVariant = never;

export interface KbdEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes, and its content. */
export interface KbdOptions {
  /** data-ds-kbd-platform (true: present, false or none: absent). */
  platform?: string | number | boolean | object | null;
  /** None: the behaviour writes the content itself. */
  children?: never;
}

export declare const Kbd: BehaviourComponent<'kbd', KbdVariant, KbdEvents & KbdOptions, ReturnType<typeof import('../js/kbd.js').create>>;
