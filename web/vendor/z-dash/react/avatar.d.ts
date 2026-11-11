/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Avatar> (react/avatar.js), generated from src/components/avatar/. */
import type { BehaviourComponent } from './shared.js';

export type AvatarVariant = 'hue-1' | 'hue-2' | 'hue-3' | 'hue-4' | 'hue-5' | 'hue-6' | 'ring' | 'square';

export interface AvatarEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:select on the root. */
  onDsSelect?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface AvatarOptions {
  /** data-ds-avatar-status (true: present, false or none: absent). */
  status?: string | number | boolean | object | null;
  /** data-ds-avatar-initials (true: present, false or none: absent). */
  initials?: string | number | boolean | object | null;
}

export declare const Avatar: BehaviourComponent<'span', AvatarVariant, AvatarEvents & AvatarOptions, ReturnType<typeof import('../js/avatar.js').create>>;
