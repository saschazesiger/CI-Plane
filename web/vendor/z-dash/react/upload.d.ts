/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Upload> (react/upload.js), generated from src/components/upload/. */
import type { BehaviourComponent } from './shared.js';

export type UploadVariant = never;

export interface UploadEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:files on the root. */
  onDsFiles?: (event: CustomEvent) => void;
  /** ds:reject on the root. */
  onDsReject?: (event: CustomEvent) => void;
  /** ds:remove on the root. */
  onDsRemove?: (event: CustomEvent) => void;
  /** ds:retry on the root. */
  onDsRetry?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface UploadOptions {
  /** data-ds-upload-accept (true: present, false or none: absent). */
  dsUploadAccept?: string | number | boolean | object | null;
  /** data-ds-upload-max-size (true: present, false or none: absent). */
  maxSize?: string | number | boolean | object | null;
  /** data-ds-upload-max-files (true: present, false or none: absent). */
  maxFiles?: string | number | boolean | object | null;
  /** data-ds-upload-resize (true: present, false or none: absent). */
  resize?: string | number | boolean | object | null;
  /** data-ds-upload-quality (true: present, false or none: absent). */
  quality?: string | number | boolean | object | null;
  /** data-ds-upload-resize-type (true: present, false or none: absent). */
  resizeType?: string | number | boolean | object | null;
  /** data-ds-upload-paste (true: present, false or none: absent). */
  paste?: string | number | boolean | object | null;
}

export declare const Upload: BehaviourComponent<'div', UploadVariant, UploadEvents & UploadOptions, ReturnType<typeof import('../js/upload.js').create>>;
