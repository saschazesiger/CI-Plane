/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.avatar (src/components/avatar/avatar.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export type AvatarStatus = 'online' | 'away' | 'busy' | 'offline';

export interface AvatarOptions {
  /** The name: initials, hue and label come from it. */
  name?: string;
  /** A status dot in the corner, its word in the label. */
  status?: AvatarStatus | null;
}

export interface AvatarState {
  name: string;
  /** The status, or '' for none. */
  status: AvatarStatus | '';
}

export interface AvatarController {
  get(): AvatarState;
  /** A new name (a string), or `{ name, status }` (a missing key stays; `status: null` takes the dot away). */
  set(next: string | AvatarOptions): void;
  on(type: 'change', fn: (detail: AvatarState) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

export interface AvatarGroupOptions {
  /** The most discs it shows, "+N" included (default 4). */
  max?: number;
}

export interface AvatarGroupState {
  max: number;
  /** The avatars it shows. */
  shown: number;
  /** The avatars behind "+N". */
  hidden: number;
}

export interface AvatarGroupController {
  get(): AvatarGroupState;
  /** A new maximum. */
  set(next: number): void;
  on(type: 'change', fn: (detail: AvatarGroupState) => void): () => void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** The initials of a name: first and last word (`max` 1: the first only), upper case. */
export declare function initials(name: string, max?: number): string;
/** The hue class of a name, 1 ... 6 (FNV-1a over its UTF-8 bytes, trimmed, NFC, lower case). */
export declare function hue(name: string): number;
/** An avatar driven from the page. */
export declare function create(el: Element, options?: AvatarOptions): AvatarController;
/** A group driven from the page. */
export declare function group(el: Element, options?: AvatarGroupOptions): AvatarGroupController;
