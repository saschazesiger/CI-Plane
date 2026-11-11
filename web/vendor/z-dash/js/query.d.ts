/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.query (src/components/query/query.js). Hand-written; the
 * build test keeps the declared exports and their parameters equal to the
 * module's.
 */

export type QueryOp = 'is' | 'not' | 'gt' | 'gte' | 'lt' | 'lte';

export interface QueryTerm {
  /** null for free text. */
  key: string | null;
  op: QueryOp;
  /** One or more (any of them); free text: the words. */
  values: string[];
  /** Why the term is no valid filter: an unknown key, a value outside its list (or no number or date), an operator the key does not take. */
  invalid?: 'key' | 'value' | 'op';
}

export interface QueryKey {
  key: string;
  label?: string;
  description?: string;
  /** number and date compare (gt, gte, lt, lte); default text. */
  type?: 'text' | 'number' | 'date';
  values?: Array<string | { value: string; label?: string; description?: string }>;
  /** The operators it takes (default: is and not; number and date all six). */
  operators?: QueryOp[];
  /** true: a value outside `values` is fine. */
  free?: boolean;
}

export interface Query {
  terms: QueryTerm[];
  /** The valid filters. */
  filters: Array<{ key: string; op: QueryOp; values: string[] }>;
  /** The free words. */
  text: string;
  invalid: QueryTerm[];
  /** The query as text. */
  value: string;
}

export interface QuerySuggestion {
  group: 'keys' | 'ops' | 'values' | 'text';
  /** Replaces what is typed. */
  text: string;
  label: string;
  meta: string;
  /** true: choosing it makes a token. */
  commit: boolean;
}

export interface QueryOptions {
  keys?: Array<string | QueryKey>;
  value?: string | QueryTerm[];
  /** The key of the saved queries in DS.store (namespace `query`); memory only without it. */
  store?: string;
  /** The name of a hidden input with the text, for a plain form. */
  name?: string;
  /** A key's values as the person types (or a promise of them). */
  values?: (key: string, typed: string) => Array<string | { value: string; label?: string; description?: string }> | PromiseLike<Array<string | { value: string; label?: string; description?: string }>>;
}

export interface QueryController {
  get(): Query;
  set(value: string | QueryTerm[]): void;
  /** Adds filters from text or terms; returns whether any came of it. */
  add(value: string | QueryTerm | QueryTerm[]): boolean;
  remove(index: number): void;
  clear(): void;
  setKeys(keys: Array<string | QueryKey>): void;
  saved(): Array<{ name: string; value: string }>;
  /** Keeps the query under a name; returns whether it did. */
  save(label: string): boolean;
  on(type: 'change' | 'submit', fn: (detail: Query) => void): () => void;
  on(type: 'saved', fn: (detail: { name: string; value: string }) => void): () => void;
  destroy(): void;
}

/** Reads a query into terms; with `keys`, invalid filters say why. */
export declare function parse(text: string, keys?: Array<string | QueryKey>): QueryTerm[];
/** Writes terms back as text that parse() reads the same way. */
export declare function stringify(terms: Array<{ key: string | null; op?: QueryOp; values: string[] }>): string;
/** The structured query of some terms. */
export declare function toQuery(terms: QueryTerm[]): Query;
/** What the list offers for the text being typed. */
export declare function suggest(typed: string, keys?: Array<string | QueryKey>): { kind: 'keys' | 'values' | 'none'; key: string | null; items: QuerySuggestion[] };
/** A query input driven from the page. */
export declare function create(el: Element, options?: QueryOptions): QueryController;
