/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Remembered UI preferences (3.0): columns, density, dismissed banners, sheet
 * widths. JSON values in localStorage under `ds:<namespace>:<key>`, so a host
 * page and a widget never read each other's.
 *
 *   const prefs = DS.store.open('devices');
 *   prefs.get('columns', ['name', 'status']);     // the default while nothing is stored
 *   prefs.set('columns', ['name']);
 *   const off = prefs.on('change', ({ key, value, external }) => { ... });
 *   prefs.remove('columns');
 *   prefs.destroy();
 *
 * Never a store of record: a preference may vanish at any time, and nothing
 * here throws because storage did. Where localStorage cannot be reached
 * (blocked, a sandboxed frame) or refuses a write (quota), the value stays in
 * memory for this page, so the choice holds until it reloads; available()
 * says which one is in use. What cannot be parsed reads as not stored.
 *
 * Change events: a write that changes a value tells every listener of the
 * namespace, in this tab and, through the `storage` event, in other tabs
 * (`external: true`), and dispatches a bubbling ds:store on the document. A
 * write of the same value is no change. A clear from another tab that does
 * not say which keys went (localStorage.clear()) arrives as `key: null`:
 * read again. The memory fallback cannot reach other tabs. Other tabs are heard
 * from the first open() until the last handle's destroy().
 *
 * Shared through runtime.state('store'): the memory values of each storage,
 * the listeners, the handles and the one `storage` listener, so two copies on
 * a page see each other's writes at once.
 *
 * ES2022; no DOM or storage is touched until open() is used.
 */

import { emit, runtime } from './core.js';

const PREFIX = 'ds';

/**
 * This module's shared state.
 * @type {{ memory: Map<any, Map<string, string>>, listeners: Set<{ namespace: string, area: any, fn: (detail: any) => void }>, handles: Set<{ namespace: string, area: any }>, stop: (() => void)|null }}
 */
const shared = runtime.state('store', () => ({
  memory: new Map(),
  listeners: new Set(),
  handles: new Set(),
  stop: null,
}));

/** The values kept in memory for one storage area (null: memory only), by full key. */
const memoryOf = (area) => shared.memory.get(area);

function remember(area, full, raw) {
  if (!shared.memory.has(area)) shared.memory.set(area, new Map());
  shared.memory.get(area).set(full, raw);
}

function forget(area, full) {
  const values = shared.memory.get(area);
  if (values?.delete(full) && !values.size) shared.memory.delete(area);
}

/** localStorage, or null where reaching it throws (blocked, a sandboxed frame). */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Runs one storage call; undefined when it threw. */
function attempt(work) {
  try {
    return work();
  } catch {
    return undefined;
  }
}

/** Tells the listeners of `namespace` and the document. */
function publish(area, namespace, detail) {
  const full = { namespace, ...detail };
  for (const listener of [...shared.listeners]) {
    if (listener.namespace !== namespace || listener.area !== area) continue;
    try {
      listener.fn(full);
    } catch (error) {
      if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
      else globalThis.console?.error?.(error);
    }
  }
  const doc = globalThis.document;
  if (typeof doc?.dispatchEvent === 'function') emit(doc, 'store', full);
}

const parse = (raw) => {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** What a `storage` event from another tab means for the namespaces open here. */
function onStorage(event) {
  if (event.key === null) {
    // localStorage.clear() elsewhere: every namespace of that area.
    for (const key of [...(memoryOf(event.storageArea)?.keys() ?? [])]) if (key.startsWith(`${PREFIX}:`)) forget(event.storageArea, key);
    const told = new Set();
    // The handles too: ds:store tells a namespace that holds no on() of its own.
    for (const { namespace, area } of [...shared.handles, ...shared.listeners]) {
      if (area !== event.storageArea || told.has(namespace)) continue;
      told.add(namespace);
      publish(area, namespace, { key: null, value: undefined, previous: undefined, external: true });
    }
    return;
  }
  if (!event.key.startsWith(`${PREFIX}:`)) return;
  const separator = event.key.indexOf(':', PREFIX.length + 1);
  if (separator < 0) return;
  // The other tab's value is newer than a write only this page kept.
  forget(event.storageArea, event.key);
  publish(event.storageArea, event.key.slice(PREFIX.length + 1, separator), {
    key: event.key.slice(separator + 1),
    value: parse(event.newValue),
    previous: parse(event.oldValue),
    external: true,
  });
}

/** One `storage` listener while a handle is open: ds:store tells a page that holds no on() of its own too. */
function listenStorage() {
  if (shared.stop) return;
  const view = globalThis.window ?? globalThis;
  if (typeof view.addEventListener !== 'function') return;
  view.addEventListener('storage', onStorage);
  shared.stop = () => view.removeEventListener('storage', onStorage);
}

function unlistenStorage() {
  if (shared.handles.size || shared.listeners.size) return;
  shared.stop?.();
  shared.stop = null;
}

/**
 * Whether values reach real storage (they survive a reload): false in a page
 * where localStorage is blocked or refuses a small write, so they stay in
 * memory.
 * @param {{ storage?: Storage|null }} [options]
 * @returns {boolean}
 */
export function available(options = {}) {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return false;
  const probe = `${PREFIX}:__probe__`;
  try {
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * The preferences of `namespace` (no colon): get(key, fallback), set(key,
 * value), remove(key), clear(), keys(), on('change', fn) and destroy(), which
 * takes this handle's listeners off. `set` with undefined removes. `storage`
 * replaces localStorage (sessionStorage for this tab only; null: memory only).
 * @param {string} namespace
 * @param {{ storage?: Storage|null }} [options]
 * @returns {{ get: <T = any>(key: string, fallback?: T) => T, set: (key: string, value: any) => void, remove: (key: string) => void, clear: () => void, keys: () => string[], on: (type: 'change', fn: (detail: { namespace: string, key: string|null, value: any, previous: any, external: boolean }) => void) => () => void, destroy: () => void }}
 */
export function open(namespace, options = {}) {
  if (typeof namespace !== 'string' || !namespace || namespace.includes(':')) throw new TypeError(`DS.store.open: "${namespace}" is no namespace (a text without a colon)`);
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const prefix = `${PREFIX}:${namespace}:`;
  const mine = new Set();
  const record = { namespace, area: storage };
  shared.handles.add(record);
  listenStorage();
  const fullKey = (key) => `${prefix}${key}`;

  /** The stored text of a key: a value kept in memory goes first (it is what storage refused). */
  const readRaw = (full) => {
    const kept = memoryOf(storage);
    if (kept?.has(full)) return kept.get(full);
    return storage ? attempt(() => storage.getItem(full)) ?? null : null;
  };

  const handle = {
    get(key, fallback) {
      const value = parse(readRaw(fullKey(key)));
      return value === undefined ? fallback : value;
    },
    set(key, value) {
      const full = fullKey(key);
      const raw = JSON.stringify(value);
      // undefined and a function have no JSON: nothing to keep.
      if (raw === undefined) {
        handle.remove(key);
        return;
      }
      const before = readRaw(full);
      if (raw === before) return;
      let written = false;
      if (storage) {
        try {
          storage.setItem(full, raw);
          written = true;
        } catch {
          // Quota or blocked: memory keeps it, below.
        }
      }
      if (written) forget(storage, full);
      else remember(storage, full, raw);
      publish(storage, namespace, { key, value: parse(raw), previous: parse(before), external: false });
    },
    remove(key) {
      const full = fullKey(key);
      const before = readRaw(full);
      forget(storage, full);
      if (storage) attempt(() => storage.removeItem(full));
      if (before !== null) publish(storage, namespace, { key, value: undefined, previous: parse(before), external: false });
    },
    clear() {
      for (const key of handle.keys()) handle.remove(key);
    },
    keys() {
      const found = new Set();
      if (storage) {
        const length = attempt(() => storage.length) ?? 0;
        for (let index = 0; index < length; index += 1) {
          const name = attempt(() => storage.key(index));
          if (name?.startsWith(prefix)) found.add(name.slice(prefix.length));
        }
      }
      for (const name of memoryOf(storage)?.keys() ?? []) if (name.startsWith(prefix)) found.add(name.slice(prefix.length));
      return [...found].sort();
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      const listener = { namespace, area: storage, fn };
      shared.listeners.add(listener);
      mine.add(listener);
      listenStorage();
      return () => {
        shared.listeners.delete(listener);
        mine.delete(listener);
        unlistenStorage();
      };
    },
    destroy() {
      for (const listener of mine) shared.listeners.delete(listener);
      mine.clear();
      shared.handles.delete(record);
      unlistenStorage();
    },
  };
  return handle;
}
