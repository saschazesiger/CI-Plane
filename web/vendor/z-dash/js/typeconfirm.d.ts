/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.typeconfirm (src/components/typeconfirm/typeconfirm.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export interface TypeConfirmDetail {
  name: string;
  /** Hands the action's promise to the component: busy until it settles, an error if it rejects. */
  wait(promise: PromiseLike<unknown>): void;
}

export interface TypeConfirmController {
  get(): { name: string; typed: string; match: boolean };
  /** Another name (writes data-ds-typeconfirm). */
  set(name: string): void;
  /** Empties the field; the button waits again. */
  reset(): void;
  on(type: 'change', fn: (detail: { match: boolean }) => void): () => void;
  /** A confirm listener may return the action's promise instead of calling wait(). */
  on(type: 'confirm', fn: (detail: TypeConfirmDetail) => unknown): () => void;
  /** Reads the name and the options again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** Whether what was typed confirms the name: equal but for the outer spaces (and the case, when asked). */
export declare function matches(typed: string | null | undefined, name: string | null | undefined, options?: { caseInsensitive?: boolean }): boolean;
/** A type-to-confirm driven from the page. */
export declare function create(el: Element): TypeConfirmController;
