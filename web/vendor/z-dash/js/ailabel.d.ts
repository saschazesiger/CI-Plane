/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.ailabel (src/components/ailabel/ailabel.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export interface AilabelController {
  get(): { open: boolean };
  /** Opens (true) or closes (false) the explainer. */
  set(value: boolean): void;
  on(type: 'toggle', fn: (detail: { open: boolean }) => void): () => void;
  destroy(): void;
}

/** The controller of an AI label's toggletip: the one the attribute path makes. */
export declare function create(el: Element): AilabelController;
