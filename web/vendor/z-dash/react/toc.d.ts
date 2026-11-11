/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Toc> (react/toc.js), generated from src/components/toc/. */
import type { BehaviourComponent } from './shared.js';

export type TocVariant = 'bar' | 'sticky';

export interface TocEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface TocOptions {
  /** data-ds-toc-offset (true: present, false or none: absent). */
  offset?: string | number | boolean | object | null;
  /** data-ds-toc-hash (true: present, false or none: absent). */
  hash?: string | number | boolean | object | null;
}

export declare const Toc: BehaviourComponent<'nav', TocVariant, TocEvents & TocOptions, ReturnType<typeof import('../js/toc.js').create>>;
