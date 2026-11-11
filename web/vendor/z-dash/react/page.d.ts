/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <PageHead> (react/page.js), generated from src/components/page/. */
import type { BehaviourComponent } from './shared.js';

export type PageHeadVariant = 'sticky';

export interface PageHeadEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes. */
export interface PageHeadOptions {
  /** data-ds-page-head-condense (true: present, false or none: absent). */
  condense?: string | number | boolean | object | null;
}

export declare const PageHead: BehaviourComponent<'header', PageHeadVariant, PageHeadEvents & PageHeadOptions, ReturnType<typeof import('../js/page.js').create>>;
