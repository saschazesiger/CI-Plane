/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.password (src/components/password/password.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

export type PasswordStrength = 0 | 1 | 2 | 3 | 4;

export interface PasswordOptions {
  /** Shorter than this scores 1, where the input has no minlength and the root no data-ds-password-min (default 8). */
  minLength?: number;
  /** A scoring of the page's own: 0 to 4 for the value (empty is always 0). */
  score?: (value: string) => number;
}

export interface PasswordState {
  revealed: boolean;
  strength: PasswordStrength;
  capsLock: boolean;
}

export interface PasswordController {
  get(): PasswordState;
  set(next: { revealed?: boolean }): void;
  on(type: 'change', fn: (detail: { strength: PasswordStrength; text: string }) => void): () => void;
  on(type: 'reveal', fn: (detail: { revealed: boolean }) => void): () => void;
  /** Reads the attributes again and measures once more. */
  update(): void;
  destroy(): void;
}

/** How strong a password is: 0 (empty), 1 weak, 2 fair, 3 good, 4 strong. */
export declare function strength(value: string | null | undefined, options?: { minLength?: number }): PasswordStrength;
/** A password field driven from the page. */
export declare function create(el: Element, options?: PasswordOptions): PasswordController;
