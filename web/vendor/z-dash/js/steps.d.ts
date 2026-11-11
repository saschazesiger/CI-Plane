/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.steps (src/components/steps/steps.js). Hand-written; the build
 * test keeps the declared exports and their parameters equal to the
 * module's.
 */

export interface StepsChange {
  /** The 0-based index of the step. */
  index: number;
  step: HTMLElement;
  /** The index of the step that was current, or -1. */
  previous: number;
}

export interface StepsController {
  /** The 0-based index of the current step, or -1. */
  get(): number;
  /** Makes a step (its 0-based index) the current one and announces it; whether it changed. */
  set(value: number): boolean;
  /** After every change of the current step (a click that went through, or set()). */
  on(type: 'change', fn: (detail: StepsChange) => void): () => void;
  destroy(): void;
}

/** The 1-based position (clamped), the total and the trimmed label a step announces. */
export declare function position(index: number, total: number, label: string): { position: number; total: number; label: string };
/** A list of steps driven from the page. */
export declare function create(el: HTMLElement): StepsController;
