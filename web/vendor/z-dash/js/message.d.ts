/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.message (src/components/message/message.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export type MessageState = 'streaming' | 'partial' | 'error' | 'done';

export interface MessageOptions {
  /** The state at start (default: data-ds-message, else done). */
  state?: MessageState;
  /** The text of the error note (default: the string messageFailed). */
  error?: string | null;
  /** What the copy action writes: text, or a function of the message (default: the content's rendered text). */
  copy?: string | ((el: Element) => string) | null;
}

export interface MessageSet {
  state?: MessageState;
  /** Replaces the content's text. */
  text?: string;
  error?: string | null;
  copy?: string | ((el: Element) => string) | null;
}

export interface MessageController {
  get(): { state: MessageState; text: string };
  set(value: MessageState | MessageSet): void;
  /** Adds plain text at the end of the content. */
  append(text: string): void;
  /** Copies as the copy action does; false where the clipboard is missing or refused. */
  copy(): Promise<boolean>;
  on(type: 'change', fn: (detail: { state: MessageState; previous: MessageState }) => void): () => void;
  on(type: 'copy' | 'edit', fn: (detail: { text: string }) => void): () => void;
  on(type: 'retry', fn: (detail: Record<string, never>) => void): () => void;
  on(type: 'action', fn: (detail: { action: string }) => void): () => void;
  /** Reads data-ds-message again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** The state a value names ('done' for an empty or unknown value). */
export declare function state(value: unknown): MessageState;
/** The controller of a message: the one the attribute path makes. */
export declare function create(el: Element, options?: MessageOptions): MessageController;
