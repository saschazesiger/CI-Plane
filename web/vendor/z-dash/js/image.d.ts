/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.image (src/components/image/image.js).
 * Hand-written; the build test keeps the declared exports and their
 * parameters equal to the module's.
 */

export type ImageState = 'loading' | 'loaded' | 'error';

export interface ImageController {
  get(): { state: ImageState | ''; src: string };
  /** Loads another picture: from "loading" again. */
  set(src: string): void;
  on(type: 'change', fn: (detail: { state: ImageState; src: string }) => void): () => void;
  /** Reads the picture again. */
  update(): void;
  destroy(): void;
}

/** A picture driven from the page (the .ds-image__frame). */
export declare function create(el: Element, options?: { src?: string; fallback?: string }): ImageController;
