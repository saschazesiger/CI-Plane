/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.loadingoverlay (js/loadingoverlay.js). */

/** What a loading overlay shows. */
export interface LoadingOverlayState {
  shown: boolean;
  message: string;
  detail: string;
}

/** A change of a loading overlay. */
export interface LoadingOverlayChange {
  shown?: boolean;
  message?: string;
  detail?: string;
  /** 0 to 1: the share of a .ds-spinner--determinate ring in the box. */
  progress?: number;
  /** Said as it hides ("Saved"). */
  done?: string;
}

/** The controller of a loading overlay. */
export interface LoadingOverlayController {
  element: Element;
  get(): LoadingOverlayState;
  /** Shows (true) or hides (false) it, or changes what it says; resolves once a hide is done. */
  set(value: boolean | LoadingOverlayChange): Promise<void>;
  /** Shows it until the promise settles; resolves or rejects with it once it is hidden. */
  wait<T>(promise: PromiseLike<T> | T, options?: { message?: string; detail?: string; done?: string }): Promise<T>;
  /** Hears ds:show, ds:hide and ds:cancel; returns the unsubscribe. */
  on(type: 'show' | 'hide' | 'cancel' | string, fn: (event: Event) => void): () => void;
  destroy(): void;
}

/** How long a hide waits so a visible overlay stays for --ds-hold-loader (ms). */
export declare function holdMs(shownAt: number, now: number, timing: { delay: number; minVisible: number }): number;
/** The controller of an overlay element, the one [data-ds-loadingoverlay] makes. */
export declare function create(element: Element): LoadingOverlayController;
/** Shows the overlay of `region`, built when it has none; returns its controller. */
export declare function show(region: Element, options?: { message?: string; detail?: string; progress?: number; cancel?: boolean | string }): LoadingOverlayController;
/** Hides the overlay of `region`; resolves once it is hidden. */
export declare function hide(region: Element, options?: { done?: string }): Promise<void>;
/** Shows the overlay of `region` until `promise` settles. */
export declare function wait<T>(region: Element, promise: PromiseLike<T> | T, options?: { message?: string; detail?: string; done?: string; cancel?: boolean | string }): Promise<T>;
