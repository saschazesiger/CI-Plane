/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Banner> (react/banner.js), generated from src/components/banner/. */
import type { BehaviourComponent } from './shared.js';

export type BannerVariant = never;

export interface BannerEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
  /** ds:dismiss on the root. */
  onDsDismiss?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface BannerOptions {
  /** data-ds-banner-max (true: present, false or none: absent). */
  dsBannerMax?: string | number | boolean | object | null;
  /** data-ds-banner-remember (true: present, false or none: absent). */
  remember?: string | number | boolean | object | null;
}

export declare const Banner: BehaviourComponent<'div', BannerVariant, BannerEvents & BannerOptions, ReturnType<typeof import('../js/banner.js').create>>;
