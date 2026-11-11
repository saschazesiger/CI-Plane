/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Thinking> (react/thinking.js), generated from src/components/thinking/. */
import type { BehaviourComponent } from './shared.js';

export type ThinkingVariant = never;

export interface ThinkingEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface ThinkingOptions {
  /** data-ds-thinking-since (true: present, false or none: absent). */
  since?: string | number | boolean | object | null;
  /** data-ds-thinking-tokens (true: present, false or none: absent). */
  tokens?: string | number | boolean | object | null;
  /** data-ds-thinking-done (true: present, false or none: absent). */
  done?: string | number | boolean | object | null;
}

export declare const Thinking: BehaviourComponent<'div', ThinkingVariant, ThinkingEvents & ThinkingOptions, ReturnType<typeof import('../js/thinking.js').create>>;
