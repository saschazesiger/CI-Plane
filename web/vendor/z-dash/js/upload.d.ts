/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.upload (src/components/upload/upload.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';

export interface UploadEntry {
  /** A page-wide id (`upload-3`), or the one set() was given. */
  id: string;
  /** The file to send; null for one set() showed as already stored. */
  file: File | null;
  name: string;
  size: number | null;
  type: string;
  status: UploadStatus;
  /** 0 to 1 while uploading; null while waiting. */
  progress: number | null;
  /** The reason fail() gave. */
  error: string;
  /** The preview: an object URL of an image file, or the url done() or set() gave. */
  url: string;
}

export interface UploadSource {
  id?: string | number;
  file?: File;
  name?: string;
  size?: number;
  type?: string;
  status?: UploadStatus;
  progress?: number;
  error?: string;
  url?: string;
}

export interface ResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** 0 to 1 (default 0.9). */
  quality?: number;
  /** image/jpeg, image/png or image/webp (default the file's own). */
  type?: string;
}

export interface UploadOptions {
  /** Like the input's accept (default the input's). */
  accept?: string;
  /** Bytes, or a text such as `10 MB`. */
  maxSize?: number | string;
  /** The most files the upload holds. */
  maxFiles?: number;
  /** `1600`, `1600x1200` or the options of resizeImage(). */
  resize?: number | string | ResizeOptions;
  /** Files pasted while focus is inside (default true). */
  paste?: boolean;
}

export type UploadReason = 'type' | 'count' | 'size' | 'empty';

export interface UploadRejected<F = File> {
  file: F;
  reason: UploadReason;
  limit: number | string | null;
}

export interface UploadLimits {
  accept?: string;
  maxSize?: number | null;
  minSize?: number | null;
  maxFiles?: number | null;
  /** Files already shown, which count against maxFiles. */
  count?: number;
}

export interface UploadController {
  get(): UploadEntry[];
  /** Shows these entries instead (files already stored: status done). */
  set(entries: Iterable<UploadSource | File>): void;
  /** Checks, resizes and adds files as the zone does; resolves with the entries added. */
  add(files: Iterable<File>): Promise<UploadEntry[]>;
  progress(id: string, value: number): void;
  done(id: string, result?: { url?: string }): void;
  fail(id: string, message?: string): void;
  retry(id: string): void;
  remove(id: string): Promise<void>;
  clear(): void;
  on(type: 'files', fn: (detail: { entries: UploadEntry[] }) => void): () => void;
  on(type: 'reject', fn: (detail: { rejected: UploadRejected[] }) => void): () => void;
  on(type: 'retry' | 'remove', fn: (detail: { entry: UploadEntry }) => void): () => void;
  on(type: 'change', fn: (detail: { entries: UploadEntry[] }) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** Whether a file matches an accept list (extensions, MIME types, image/*). */
export declare function accepts(file: { name?: string; type?: string }, accept?: string): boolean;
/** A size as people write it (`10 MB`, `2 MiB`, `500kB`), in bytes; null for anything else. */
export declare function parseSize(text: string | number | null | undefined): number | null;
/** Sorts files into accepted and rejected ones, with the reason. */
export declare function validate<F extends { name: string; size: number; type?: string }>(files: Iterable<F>, limits?: UploadLimits): { accepted: F[]; rejected: UploadRejected<F>[] };
/** The size a picture takes inside the limits, its proportions kept, never larger. */
export declare function fitSize(width: number, height: number, options?: { maxWidth?: number; maxHeight?: number }): { width: number; height: number; scale: number };
/** A JPEG, PNG or WebP made smaller on a canvas; the file itself when nothing is gained. */
export declare function resizeImage(file: File, options?: ResizeOptions): Promise<File>;
/** A file upload driven from the page. */
export declare function create(el: Element, options?: UploadOptions): UploadController;
