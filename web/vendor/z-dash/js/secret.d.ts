/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.secret (src/components/secret/secret.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export type SecretState = 'empty' | 'set' | 'replace' | 'clear';
export type SecretAction = 'keep' | 'set' | 'clear';

export interface SecretController {
  get(): { state: SecretState; stored: boolean; action: SecretAction };
  /** Goes to a state (after a save: 'set' or 'empty'). */
  set(next: SecretState): void;
  on(type: 'change', fn: (detail: { state: SecretState; action: SecretAction }) => void): () => void;
  /** Reads data-ds-secret again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** What the server should do with this state and field value: keep, set or clear. */
export declare function action(state: SecretState, value: string | null | undefined): SecretAction;
/** A secret field driven from the page. */
export declare function create(el: Element, options?: { stored?: boolean }): SecretController;
