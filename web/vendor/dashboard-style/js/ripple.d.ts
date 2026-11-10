/**
 * Types of DS.ripple (js/ripple.js). Hand-written; test/build.test.js keeps
 * the declared exports and their parameters equal to the module's.
 */

/** The selector of the default ripple hosts. */
export declare const RIPPLE_HOSTS: string;

export interface RippleHandle {
  /** Removes the listeners and .ds-ripples; ripples already shown finish. */
  destroy(): void;
  /** Ends the running press of `host`, or every press under the root. */
  release(host?: Element): void;
  /** @deprecated Use destroy() (removed in 3.0 at the earliest). */
  detach(): void;
}
/** The pointer ripple on every action inside `root`; also installs DS.motion.guard(). */
export declare function attach(root?: Document | Element | ShadowRoot): RippleHandle;
