/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of DS.banner (js/banner.js): the app's message strip in priority order. */

export type BannerTone = 'error' | 'warning' | 'info' | 'primary' | 'neutral' | 'success';

/** A message built from data. */
export interface BannerSpec {
  /** Its key: the dismissal is remembered under it. Without one it cannot be dismissed. */
  id?: string;
  tone?: BannerTone | null;
  title?: string;
  text?: string;
  /** A glyph of DS.icons (default: the tone's). */
  icon?: string;
  action?: { label: string; href?: string; onClick?: (event: MouseEvent, banner: BannerController) => void };
  /** Higher first; default the tone's rank. */
  priority?: number;
  /** false: no dismiss button. */
  dismissible?: boolean;
  /** Default: alert for an error, else status. */
  role?: 'alert' | 'status';
}

export interface BannerController {
  /** The ids of the messages shown now, in order. */
  get(): string[];
  /** Replaces the messages built from data (those of the markup stay). */
  set(banners: BannerSpec[]): void;
  add(banners: BannerSpec | BannerSpec[]): void;
  remove(id: string): void;
  dismiss(id: string): void;
  /** Forgets a dismissal: the message shows again. */
  restore(id: string): void;
  /** Shows every message (or only the first data-ds-banner-max again). */
  expand(on?: boolean): void;
  /** Applies a change of data-ds-banner-max or -remember (core calls it); the messages from data stay. */
  update(names?: string[]): void;
  on(type: 'change', fn: (detail: { shown: string[]; hidden: string[] }) => void): () => void;
  on(type: 'dismiss', fn: (detail: { id: string }) => void): () => void;
  destroy(): void;
}

/** A message's priority: the number given, else its tone's rank. */
export declare function priorityOf(banner: { priority?: number | string | null; tone?: string | null }): number;
/** Messages in the order they show, the highest priority first; equal ones keep their order. */
export declare function order<B extends { priority?: number | string | null; tone?: string | null }>(banners: B[]): B[];
/** The controller of a .ds-banner (the same one data-ds-banner makes). */
export declare function create(el: Element, options?: { banners?: BannerSpec[] }): BannerController;
