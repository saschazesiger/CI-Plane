/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * useToast() (dist/react/toast.js): snackbars of docs/components.md,
 * "Snackbar", from a React component.
 *
 *   const toast = useToast();
 *   toast('Saved', { kind: 'success' });
 *   toast.promise(() => save(), { pending: 'Saving', success: 'Saved', error: 'Not saved' });
 *   const bar = toast.progress('Uploading 3 files'); bar.set(0.4); bar.done('Uploaded');
 *   toast.close({ kind: 'error' });
 *
 * The region (.ds-toasts) is the system's, not React's: toastRegion()
 * finds or makes it inside the .ds-theme, and DS.overlay moves it into an
 * open dialog or sheet and back, which React must not see. So render no
 * region of your own; one already in the page's markup is used.
 *
 * ES2022, no JSX. Progressive: none.
 */
import { useMemo } from 'react';
import { closeToasts, progress, promise, toast } from '../js/toast.js';

/**
 * The page's snackbars: show(content, options) as a function, with
 * promise(work, texts), progress(text, options) and close(filter); stable
 * for the life of the component.
 */
export function useToast() {
  return useMemo(() => {
    const show = (content, options) => toast(null, content, options);
    show.promise = (work, options) => promise(null, work, options);
    show.progress = (text, options) => progress(null, text, options);
    show.close = (filter) => closeToasts(null, filter);
    return show;
  }, []);
}
