/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.lightbox (js/lightbox.js). */

/** One image of a lightbox. */
export interface LightboxImage {
  /** The full image. */
  src: string;
  /** What it shows, for those who cannot see it. */
  alt?: string;
  /** The line under it. */
  caption?: string;
  /** A smaller image for the row of thumbnails (default: src). */
  thumb?: string;
}

/** Where a lightbox is. */
export interface LightboxState {
  open: boolean;
  index: number;
  total: number;
  zoom: number;
}

/** The controller of a lightbox. */
export interface LightboxController {
  element: Element;
  get(): LightboxState;
  /** An image, or { index, zoom }. */
  set(value: number | { index?: number; zoom?: number }): void;
  /** Opens the viewer at `index`; `opener` gets focus back. */
  open(index?: number, opener?: Element | null): Promise<void>;
  close(): Promise<void>;
  next(): void;
  prev(): void;
  /** Hears ds:open, ds:close, ds:change ({ index, total }) and ds:zoom ({ zoom }); returns the unsubscribe. */
  on(type: string, fn: (event: Event) => void): () => void;
  /** Removes the viewer. */
  destroy(): void;
}

/** The largest zoom (a pinch); the buttons and keys step 1, 2, 4. */
export declare const MAX_ZOOM: number;
/** The zoom after a step: 1 doubles, -1 halves, 0 is the fit. */
export declare function nextZoom(zoom: number, direction: number): number;
/** The pan within reach, so the zoomed image still covers the frame. */
export declare function clampPan(x: number, y: number, size: { width: number; height: number }, frame: { width: number; height: number }, zoom: number): { x: number; y: number };
/** The controller of a gallery, the one [data-ds-lightbox] makes. */
export declare function create(gallery: Element, options?: { images?: () => LightboxImage[]; label?: string; home?: Element }): LightboxController;
/** Opens the viewer of a gallery at `index`. */
export declare function open(gallery: Element, options?: { index?: number; opener?: Element | null }): Promise<void>;
/** Closes the viewer of a gallery. */
export declare function close(gallery: Element): Promise<void>;
/** Shows a list of images without a gallery in the page; the viewer goes once it closed. */
export declare function show(images: LightboxImage[], options?: { index?: number; opener?: Element | null; label?: string }): LightboxController;
