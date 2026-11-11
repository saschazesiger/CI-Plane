/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <AvatarGroup> (react/avatar-group.js), generated from src/components/avatar/. */
import type { BehaviourComponent, Controller } from './shared.js';

export type AvatarGroupVariant = 'spread';

export interface AvatarGroupEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:select on the root. */
  onDsSelect?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface AvatarGroupOptions {
  /** data-ds-avatar-group-max (true: present, false or none: absent). */
  dsAvatarGroupMax?: string | number | boolean | object | null;
}

export declare const AvatarGroup: BehaviourComponent<'div', AvatarGroupVariant, AvatarGroupEvents & AvatarGroupOptions, Controller>;
