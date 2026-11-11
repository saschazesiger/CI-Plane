/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Message> (react/message.js), generated from src/components/message/. */
import type { BehaviourComponent } from './shared.js';

export type MessageVariant = 'assistant' | 'system' | 'tool' | 'user';

export interface MessageEvents {
  /** ds:action on the root. */
  onDsAction?: (event: CustomEvent) => void;
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:copy on the root. */
  onDsCopy?: (event: CustomEvent) => void;
  /** ds:edit on the root. */
  onDsEdit?: (event: CustomEvent) => void;
  /** ds:retry on the root. */
  onDsRetry?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface MessageOptions {
}

export declare const Message: BehaviourComponent<'article', MessageVariant, MessageEvents & MessageOptions, ReturnType<typeof import('../js/message.js').create>>;
