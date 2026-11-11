/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/** Types of <Markdown> (react/markdown.js), generated from src/components/markdown/. */
import type { BehaviourComponent } from './shared.js';

export type MarkdownVariant = 'compact' | 'dense';

export interface MarkdownEvents {
  /** ds:change on the root. */
  onDsChange?: (event: CustomEvent) => void;
}

/** The options of its documented attributes, and its content. */
export interface MarkdownOptions {
  /** data-ds-markdown-anchors (true: present, false or none: absent). */
  anchors?: string | number | boolean | object | null;
  /** data-ds-markdown-breaks (true: present, false or none: absent). */
  breaks?: string | number | boolean | object | null;
  /** data-ds-markdown-code (true: present, false or none: absent). */
  code?: string | number | boolean | object | null;
  /** data-ds-markdown-images (true: present, false or none: absent). */
  images?: string | number | boolean | object | null;
  /** The text the behaviour renders; string children give it too. */
  source?: string;
  children?: string | number;
}

export declare const Markdown: BehaviourComponent<'div', MarkdownVariant, MarkdownEvents & MarkdownOptions, ReturnType<typeof import('../js/markdown.js').create>>;
