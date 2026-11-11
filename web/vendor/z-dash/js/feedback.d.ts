/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.feedback (src/components/feedback/feedback.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export interface FeedbackGiven {
  value: string;
  /** The checked "reason" fields of the reason dialog. */
  reasons: string[];
  /** The "comment" field of the reason dialog. */
  comment: string;
}

export interface FeedbackController {
  get(): { value: string | null };
  /** Turns a value on (null: none); no ds:feedback. */
  set(next: string | null): void;
  on(type: 'change', fn: (detail: { value: string | null; previous: string | null }) => void): () => void;
  on(type: 'feedback', fn: (detail: FeedbackGiven) => void): () => void;
  destroy(): void;
}

/** The value after a press: on, or off when it was on. */
export declare function toggle(current: string | null, pressed: string): string | null;
/** Whether the reason dialog opens for a value ("up", "down" or "both"; default "down"). */
export declare function asks(value: string | null, when?: string | null): boolean;
/** The controller of a feedback pair: the one the attribute path makes. */
export declare function create(el: Element): FeedbackController;
