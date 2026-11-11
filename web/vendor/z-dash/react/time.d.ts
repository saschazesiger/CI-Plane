/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Time> (react/time.js), generated from src/js/format.js. */
import type { BehaviourComponent, Controller } from './shared.js';

export type TimeVariant = never;

export interface TimeEvents {
}

/** The options of its documented attributes, and its content. */
export interface TimeOptions {
  /** data-ds-time-style (true: present, false or none: absent). */
  dsTimeStyle?: string | number | boolean | object | null;
  /** data-ds-time-numeric (true: present, false or none: absent). */
  numeric?: string | number | boolean | object | null;
  /** data-ds-time-smallest (true: present, false or none: absent). */
  smallest?: string | number | boolean | object | null;
  /** data-ds-time-largest (true: present, false or none: absent). */
  largest?: string | number | boolean | object | null;
  /** data-ds-time-tip (true: present, false or none: absent). */
  tip?: string | number | boolean | object | null;
  /** None: the behaviour writes the content itself. */
  children?: never;
}

export declare const Time: BehaviourComponent<'time', TimeVariant, TimeEvents & TimeOptions, Controller>;
