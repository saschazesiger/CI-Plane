/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Types of DS.store (js/store.js). Hand-written; test/build.test.js keeps
 * the declared exports and their parameters equal to the module's.
 */

export interface StoreOptions {
  /** Instead of localStorage: sessionStorage for this tab only, null for memory only. */
  storage?: Storage | null;
}

export interface StoreChange {
  namespace: string;
  /** null: another tab cleared the storage without saying what went; read again. */
  key: string | null;
  /** The new value; undefined when it was removed. */
  value: any;
  previous: any;
  /** true when it came from another tab. */
  external: boolean;
}

export interface StoreHandle {
  /** The stored value, or `fallback` while nothing (readable) is stored. */
  get<T = any>(key: string, fallback?: T): T;
  /** Stores a JSON value; undefined removes it. A write of the same value is no change. */
  set(key: string, value: unknown): void;
  remove(key: string): void;
  /** Removes every key of this namespace. */
  clear(): void;
  /** The stored keys of this namespace, sorted. */
  keys(): string[];
  /** Runs on every change of the namespace, here and in other tabs; returns the unsubscribe. */
  on(type: 'change', fn: (detail: StoreChange) => void): () => void;
  /** Takes this handle's listeners off; the values stay. */
  destroy(): void;
}

/** Whether values reach real storage, so they survive a reload. */
export declare function available(options?: StoreOptions): boolean;
/** The preferences of `namespace` (no colon), under `ds:<namespace>:<key>`. */
export declare function open(namespace: string, options?: StoreOptions): StoreHandle;
