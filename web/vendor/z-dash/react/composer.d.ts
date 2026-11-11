/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Composer> (react/composer.js), generated from src/components/composer/. */
import type { BehaviourComponent } from './shared.js';

export type ComposerVariant = never;

export interface ComposerEvents {
  /** ds:attach on the root. */
  onDsAttach?: (event: CustomEvent) => void;
  /** ds:command on the root. */
  onDsCommand?: (event: CustomEvent) => void;
  /** ds:mention on the root. */
  onDsMention?: (event: CustomEvent) => void;
  /** ds:query on the root. */
  onDsQuery?: (event: CustomEvent) => void;
  /** ds:remove on the root. */
  onDsRemove?: (event: CustomEvent) => void;
  /** ds:send on the root. */
  onDsSend?: (event: CustomEvent) => void;
  /** ds:stop on the root. */
  onDsStop?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ComposerOptions {
  /** data-ds-composer-busy (true: present, false or none: absent). */
  busy?: string | number | boolean | object | null;
  /** data-ds-composer-draft (true: present, false or none: absent). */
  draft?: string | number | boolean | object | null;
  /** data-ds-composer-enter (true: present, false or none: absent). */
  enter?: string | number | boolean | object | null;
}

export declare const Composer: BehaviourComponent<'form', ComposerVariant, ComposerEvents & ComposerOptions, ReturnType<typeof import('../js/composer.js').create>>;
