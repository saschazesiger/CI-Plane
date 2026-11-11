/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of useToast() (react/toast.js). */
import type { closeToasts, progress, promise, toast } from '../js/toast.js';

type Rest<F> = F extends (region: any, ...rest: infer R) => infer T ? (...rest: R) => T : never;

export interface Toaster {
  /** A snackbar (DS.toast.toast in the page's region). */
  (...args: Parameters<Rest<typeof toast>>): ReturnType<typeof toast>;
  /** A pending message that turns into the success or the error. */
  promise: Rest<typeof promise>;
  /** A message with a progress bar. */
  progress: Rest<typeof progress>;
  /** Closes messages by kind or key. */
  close: Rest<typeof closeToasts>;
}

/** The page's snackbars; stable for the life of the component. */
export declare function useToast(): Toaster;
