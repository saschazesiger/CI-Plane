/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.markdown (src/components/markdown/markdown.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export interface MarkdownOptions {
  /** Headings link to themselves (.ds-prose__anchor). */
  anchors?: boolean;
  /** Every line break is a <br> (chat), not only a hard break. */
  breaks?: boolean;
  /** 'block': a fenced block becomes a .ds-code frame with its language and a copy button. */
  code?: 'plain' | 'block';
  /** false: code stays plain (no DS.highlight). */
  highlight?: boolean;
  /** false: an image becomes a link to it. */
  images?: boolean;
  /** Before every id the markup writes (headings, footnotes, code); letters, digits, - and _. */
  idPrefix?: string;
  /** Added to every heading level (1: # becomes h2), at most h6. */
  headingOffset?: number;
  /** The schemes a link may name (default http, https, mailto); relative links always. */
  schemes?: string[];
  /** The target of external links ('_blank'). */
  target?: string;
  /** The rel of external links (default noopener; with a target noopener noreferrer). */
  rel?: string;
  /** The page's own renderer: Markdown in, markup out (then sanitize). */
  renderer?: (source: string) => string;
  /** The page's own sanitiser, run on every result. */
  sanitize?: (html: string) => string;
}

export interface MarkdownCreateOptions extends MarkdownOptions {
  /** The Markdown (default: the element's text, or a script type="text/markdown" in it). */
  source?: string;
}

export interface MarkdownController {
  get(): string;
  /** Renders new Markdown, patching the element in place. */
  set(source: string): void;
  on(type: 'change', fn: (detail: { source: string }) => void): () => void;
  /** Reads the option attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** An id from heading text. */
export declare function slug(text: string): string;
/** Markdown as safe markup for .ds-prose. */
export declare function render(source: string, options?: MarkdownOptions): string;
/** The page's defaults for every render; null clears them. */
export declare function use(defaults: MarkdownOptions | null): void;
/** Renders Markdown into an element and keeps it there. */
export declare function create(el: Element, options?: MarkdownCreateOptions): MarkdownController;
