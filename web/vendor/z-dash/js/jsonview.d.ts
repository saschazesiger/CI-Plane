/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.jsonview (src/components/jsonview/jsonview.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */
import type { TreeController } from './tree.js';

/** The viewer's model of a JSON value: every number keeps the text it was written as. */
export type JsonNode =
  | { type: 'object'; entries: Array<[string, JsonNode]> }
  | { type: 'array'; entries: Array<[number, JsonNode]> }
  | { type: 'string'; value: string }
  | { type: 'number'; raw: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' };

/** A parse failure: where, 1-based. */
export interface JsonSyntaxError extends SyntaxError {
  line: number;
  column: number;
  offset: number;
}

export interface JsonviewOptions {
  /** The document as a JavaScript value. */
  value?: unknown;
  /** The document as JSON text (numbers keep their digits). */
  text?: string;
  /** How many levels show open at first (default 1). */
  open?: number;
  /** false leaves out the search bar. */
  search?: boolean;
}

export interface JsonviewController {
  /** The value; integers beyond 2^53 as BigInt; null for text that is no JSON. */
  get(): unknown;
  /** A new value. */
  set(value: unknown): void;
  /** New JSON text. */
  setText(text: string): void;
  /** The JSON text, every number as written, 2 spaces per level. */
  text(): string;
  /** Marks the keys and values that hold `text`, reveals the first. */
  search(text: string): Promise<void>;
  /** The matches of the search. */
  matches(): { query: string; total: number; index: number };
  /** Opens every level (at most 1500 rows), or closes all. */
  expandAll(open?: boolean): void;
  /** The DS.tree controller of the rows. */
  tree(): TreeController | null;
  on(type: 'copy', fn: (detail: { kind: 'value' | 'path'; text: string; path: string }) => void): () => void;
  on(type: 'search', fn: (detail: { query: string; total: number; index: number }) => void): () => void;
  on(type: 'error', fn: (detail: { error: JsonSyntaxError | TypeError }) => void): () => void;
  on(type: string, fn: (detail: any) => void): () => void;
  /** New options: open, search. */
  configure(options?: Pick<JsonviewOptions, 'open' | 'search'>): void;
  /** Reads the attributes again (the attribute path calls it). */
  update(): void;
  destroy(): void;
}

/** JSON text to the model; throws a JsonSyntaxError. */
export declare function parse(text: string): JsonNode;
/** A JavaScript value to the model, as JSON.stringify sees it (BigInt keeps its digits). */
export declare function fromValue(input: unknown): JsonNode;
/** The model to a JavaScript value; integers beyond 2^53 become BigInt. */
export declare function toValue(model: JsonNode): unknown;
/** JSON text of a model or a value, every number as written; `indent` spaces per level. */
export declare function stringify(model: JsonNode | unknown, indent?: number): string;
/** The path of a value from `$`: `$.devices[0].name`, `$["display name"]`. */
export declare function pathOf(segments: Array<string | number>): string;
/** The ranges a container's entries from..to open into (none up to 100). */
export declare function ranges(from: number, to: number): Array<[number, number]>;
/** The entry index paths of every key or primitive value that holds `query`, in document order. */
export declare function search(model: JsonNode, query: string, limit?: number): number[][];
/** A JSON viewer driven from the page, or new options for one the attribute path made. */
export declare function create(el: Element, options?: JsonviewOptions): JsonviewController;
