/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.truncate (src/components/truncate/truncate.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export type TruncatePosition = 'end' | 'start' | 'middle';

export interface TruncateState {
  /** The whole text. */
  text: string;
  /** What shows. */
  shown: string;
  /** Whether it is cut. */
  cut: boolean;
}

export interface TruncateController {
  get(): TruncateState;
  set(next: string): void;
  on(type: 'change', fn: (detail: TruncateState) => void): () => void;
  /** Reads the attributes again and measures. */
  update(): void;
  destroy(): void;
}

/** `text` with `keep` graphemes kept around an ellipsis at `position`. */
export declare function cut(text: string, keep: number, position?: TruncatePosition): string;
/** The longest cut of `text` for which `fits(shown)` is true. */
export declare function fit(text: string, position: TruncatePosition, fits: (shown: string) => boolean): string;
/** Truncation driven from the page. */
export declare function create(el: Element, options?: { position?: TruncatePosition; text?: string }): TruncateController;
