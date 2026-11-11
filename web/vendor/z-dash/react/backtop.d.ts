/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <BackToTop> (react/backtop.js), generated from src/components/backtop/. */
import type { BehaviourComponent } from './shared.js';

export type BackToTopVariant = 'fixed';

export interface BackToTopEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface BackToTopOptions {
  /** data-ds-backtop-after (true: present, false or none: absent). */
  after?: string | number | boolean | object | null;
  /** data-ds-backtop-target (true: present, false or none: absent). */
  dsBacktopTarget?: string | number | boolean | object | null;
  /** data-ds-backtop-focus (true: present, false or none: absent). */
  focus?: string | number | boolean | object | null;
}

export declare const BackToTop: BehaviourComponent<'button', BackToTopVariant, BackToTopEvents & BackToTopOptions, ReturnType<typeof import('../js/backtop.js').create>>;
