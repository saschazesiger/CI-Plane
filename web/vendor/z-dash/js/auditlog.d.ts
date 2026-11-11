/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.auditlog (src/components/auditlog/auditlog.js). Hand-written;
 * the build test keeps the declared exports and their parameters equal to
 * the module's.
 */

/** Who did it: a name, or a person or system with its marker. */
export type AuditActor = string | { name: string; id?: string; initials?: string; image?: string; icon?: 'sync' | 'user' | 'globe' };

/** One changed field of an entry. */
export interface AuditChange {
  /** The label shown (else the path). */
  field?: string;
  /** The key of the field (else the label). */
  path?: string;
  before?: unknown;
  after?: unknown;
}

/** One record of the log. */
export interface AuditEntry {
  /** The key of its row (data-ds-key). */
  id?: string;
  /** When: a Date, a timestamp or a date text. */
  at?: Date | number | string;
  actor?: AuditActor;
  /** The verb and what follows it: "changed", "signed in to". */
  action?: string;
  /** What it was done to: a text, or a link (href: relative, #, http(s) or mailto; else text). */
  target?: string | { label: string; href?: string };
  /** Where it came from: "Web · 10.20.4.17". */
  source?: string;
  /** An outcome, always with its word: { tone: 'error', text: 'Failed' }. */
  status?: { tone?: 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'error'; text: string };
  /** An entry that changed nothing (a sync with no difference). */
  muted?: boolean;
  /** A line of text under it: a reason, a comment. */
  note?: string;
  /** The changed fields, or before and after (changes() finds them). */
  changes?: AuditChange[];
  before?: unknown;
  after?: unknown;
  /** Labels of the paths of before and after. */
  fields?: Record<string, string>;
  /** Values the filters compare by name (else the entry's own field). */
  facets?: Record<string, string | string[]>;
  [key: string]: unknown;
}

/** A changed field as changes() finds it. */
export interface AuditDiff {
  path: string;
  field: string;
  before: unknown;
  after: unknown;
  kind: 'added' | 'removed' | 'changed';
}

/** The filters by name: "text", "from", "to" (YYYY-MM-DD) or a facet. */
export type AuditFilters = Record<string, string | string[] | null | undefined>;

export interface AuditlogOptions {
  entries?: AuditEntry[];
  fields?: Record<string, string>;
  format?: (value: unknown, path: string, entry: AuditEntry) => string | undefined | null;
  filters?: AuditFilters;
  locale?: string;
  timeZone?: string;
  now?: Date | number;
  order?: 'newest' | 'oldest';
  /** set() holds a reorder while the log is pointed at (default true). */
  live?: boolean;
  /** How many matching entries draw before "Show more" (default 200; 0 for all). */
  limit?: number;
}

export interface AuditlogController {
  /** Every entry, also those the filters hide. */
  get(): AuditEntry[];
  /** New entries; what changed glides. */
  set(value: AuditEntry[]): Promise<void>;
  /** The filters now, or new ones (the controls follow). */
  filter(values?: AuditFilters): AuditFilters;
  count(): { shown: number; total: number };
  on(type: 'filter' | 'render', fn: (detail: any) => void): () => void;
  configure(next?: AuditlogOptions): void;
  update(): void;
  destroy(): void;
}

export declare function changes(before: unknown, after: unknown, options?: { fields?: Record<string, string>; ignore?: string[] }): AuditDiff[];
export declare function group<T extends { at?: Date | number | string }>(entries: T[], options?: { now?: Date | number; locale?: string; timeZone?: string; order?: 'newest' | 'oldest' }): Array<{ key: string; label: string; entries: T[] }>;
export declare function matches(entry: AuditEntry, filters?: AuditFilters, options?: { timeZone?: string; format?: (value: unknown, path: string, entry: AuditEntry) => string | undefined | null }): boolean;
export declare function create(el: Element, options?: AuditlogOptions): AuditlogController;
