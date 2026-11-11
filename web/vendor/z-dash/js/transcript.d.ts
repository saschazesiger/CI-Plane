/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.transcript (src/components/transcript/transcript.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export interface TranscriptController {
  /** Whether the reader is at the end, and how many messages arrived since they left it. */
  get(): { atEnd: boolean; unread: number };
  /** more: false hides the "load earlier" row, true shows it again. */
  set(value: { more?: boolean }): void;
  /** Back to the end (smoothly within one screen), the count gone. */
  stick(): void;
  /** The page loaded what ds:earlier asked for: the button is free again, more: false hides it. */
  loaded(options?: { more?: boolean }): void;
  on(type: 'earlier', fn: (detail: Record<string, never>) => void): () => void;
  destroy(): void;
}

/** The label of a day separator: "Today", "Yesterday", a weekday, else the date. */
export declare function day(value: Date | number | string, options?: { now?: Date | number | string; locale?: string }): string;
/** The controller of a transcript: the one the attribute path makes. */
export declare function create(el: Element): TranscriptController;
