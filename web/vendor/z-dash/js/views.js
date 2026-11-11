/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Saved views (DS.views): named sets of filters, a sort and columns for a
 * list or a table, picked from a menu; one is the default, the page's own
 * views come built in, the user's are remembered (DS.store), and the
 * current one travels in the address (views.css has the markup).
 *
 *   <div class="ds-views" data-ds-views data-ds-views-key="devices" data-ds-views-url="sync"> ... </div>
 *
 *   const views = DS.views.create(el);
 *   views.get();                 // { id, name, state, edited, default, views }
 *   views.set({ state });        // the page's current filters, sort and columns: "Edited" when they differ
 *   views.set('mine');           // pick a view; sends nothing (the page applies get().state)
 *   el.addEventListener('ds:view', (event) => apply(event.detail.state));
 *
 * A state is { filters, sort, columns }: filters a name to a list of
 * strings (DS.filterbar.read()), sort a text of DS.sort.stringify() ("-seen"),
 * columns a list of names; each may be left out. In the address it is a
 * query string (toQuery(), fromQuery()): every filter value as one
 * parameter (status=online&status=offline, a range storage=&storage=512),
 * sort=-seen, cols=name,status and view=<id>. With
 * data-ds-views-prefix="d." only parameters that start with it are read
 * and written (another part of the page keeps its own); without one,
 * every parameter but view, sort and cols is a filter.
 *
 * Built-in views are the items of .ds-views__list in the markup
 * (data-ds-view="<id>", their state in data-ds-view-state in the same
 * query form, data-ds-view-default on the default one) or create()'s
 * options.views. They cannot be renamed, saved over or deleted. The user's
 * views and their default sit in DS.store ('views', the key of
 * data-ds-views-key), so another tab follows.
 *
 * The first view: the address (with data-ds-views-url "read", the
 * default, or "sync"; "off" ignores it), else the stored default, else the
 * built-in default, else the first. "sync" also writes the address with
 * history.replaceState on every change. The system renders the user's views
 * after the built-in ones (menuitemradio, aria-checked on the current one,
 * "Default" on the default), writes the trigger's name and its "Edited"
 * word, aria-disabled on the actions that do not apply, and shows
 * .ds-views__save while the current view is edited.
 *
 * Actions (data-ds-views-action on menu items or buttons): save (over the
 * current view; a built-in one saves as new), create (asks a name), rename,
 * default, share (copies a link, else shows it to copy) and delete (asks
 * first, in the error tone: D10). Picking a view sends ds:view
 * ({ id, name, state, reason }) for the page to apply; a change to the saved
 * set sends ds:views ({ views, default, reason }). Each is announced, and
 * saving and copying show a snackbar.
 *
 * Strings: viewEdited, viewDefault, viewApplied, viewSaved, viewDeleted,
 * viewDefaultSet, viewLinkCopied, viewNameLabel, viewNewTitle,
 * viewRenameTitle, viewSave, viewLinkTitle, viewDeleteTitle, viewDeleteText,
 * viewDeleteConfirm (DS.core.config()).
 *
 * ES2022. No progressive feature (the clipboard is feature-detected: without
 * it, or refused, the link shows in a dialog to copy).
 */
import { define, emit, get as controllerOf, t } from './core.js';
import { own } from './dom.js';
import { iconElement, check as checkGlyph, star as starGlyph } from './icons.js';
import { announce } from './a11y.js';
import { open as openStore } from './store.js';
import { toast } from './overlay.js';
import { prompt, confirm } from './dialog.js';

/** The controllers create() made, so the attribute path takes over the same one. */
const built = new WeakMap();

const RESERVED = ['view', 'sort', 'cols'];
const URL_MODES = ['off', 'read', 'sync'];

const listOf = (value) => (value == null ? [] : Array.isArray(value) ? value.map(String) : [String(value)]);

/**
 * A state with its filters in name order and empty parts left out, so two
 * equal states read equal. A filter name is data: Object.fromEntries() keeps
 * one named __proto__ or constructor an own property of plain objects.
 */
function canonical(state) {
  const out = {};
  const filters = [];
  for (const name of Object.keys(state?.filters ?? {}).sort()) {
    const values = listOf(state.filters[name]);
    if (values.some((value) => value !== '')) filters.push([name, values]);
  }
  if (filters.length) out.filters = Object.fromEntries(filters);
  if (state?.sort) out.sort = String(state.sort);
  if (Array.isArray(state?.columns) && state.columns.length) out.columns = state.columns.map(String);
  return out;
}

/**
 * A state as a query string (without "?"): every filter value one
 * parameter, then sort and cols; `options.view` adds view=<id> first,
 * `options.prefix` goes before every name.
 * @param {{ filters?: Record<string, string|string[]>, sort?: string, columns?: string[] }|null|undefined} state
 * @param {{ prefix?: string, view?: string|null }} [options]
 * @returns {string}
 */
export function toQuery(state, options = {}) {
  const prefix = options.prefix ?? '';
  const params = new URLSearchParams();
  const clean = canonical(state);
  if (options.view) params.append(`${prefix}view`, String(options.view));
  for (const [name, values] of Object.entries(clean.filters ?? {})) for (const value of values) params.append(`${prefix}${name}`, value);
  if (clean.sort) params.append(`${prefix}sort`, clean.sort);
  if (clean.columns) params.append(`${prefix}cols`, clean.columns.join(','));
  return params.toString();
}

/**
 * The state a query string holds (what toQuery() writes), with the view's
 * id; null when it holds none of its parameters. Without a prefix every
 * parameter but view, sort and cols is a filter; with one, only those that
 * start with it count.
 * @param {string|URLSearchParams|null|undefined} search
 * @param {{ prefix?: string }} [options]
 * @returns {{ view: string|null, state: { filters?: Record<string, string[]>, sort?: string, columns?: string[] } }|null}
 */
export function fromQuery(search, options = {}) {
  const prefix = options.prefix ?? '';
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  let view = null;
  let found = false;
  /** Filter names from the address are data (constructor, __proto__ ...): a Map, never keys looked up on an object. */
  const filters = new Map();
  const state = {};
  for (const [key, value] of params) {
    if (prefix && !key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (!name) continue;
    found = true;
    if (name === 'view') view = value;
    else if (name === 'sort') state.sort = value;
    else if (name === 'cols') state.columns = value.split(',').map((part) => part.trim()).filter(Boolean);
    else filters.set(name, [...(filters.get(name) ?? []), value]);
  }
  state.filters = Object.fromEntries(filters);
  return found ? { view, state: canonical(state) } : null;
}

/** An id for a new view from its name, not among `taken`. */
function idFor(name, taken) {
  const base = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'view';
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** Options from the attributes. */
function readOptions(el) {
  const url = el.getAttribute('data-ds-views-url');
  return {
    key: el.getAttribute('data-ds-views-key') ?? 'default',
    url: URL_MODES.includes(url) ? url : 'read',
    prefix: el.getAttribute('data-ds-views-prefix') ?? '',
  };
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function controller(el, given, signal) {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  let options = { ...readOptions(el), ...given };
  const listeners = new Map();
  const list = el.querySelector('.ds-views__list');
  const trigger = /** @type {HTMLElement|null} */ (el.querySelector('.ds-views__trigger'));
  const store = openStore('views');
  /** Built-in views from the markup and the options. */
  let builtins = [];
  /** The user's views and the stored default. */
  let saved = { views: [], default: null };
  let current = { id: null, state: {} };

  const tell = (type, detail) => (listeners.get(type) ?? new Set()).forEach((fn) => fn(detail));

  const readBuiltins = () => {
    const fromMarkup = [...(list?.querySelectorAll('[data-ds-view]:not([data-ds-view-user])') ?? [])].map((item) => ({
      id: item.getAttribute('data-ds-view'),
      name: (item.querySelector('.ds-menu__label')?.textContent ?? item.textContent ?? '').replace(/\s+/g, ' ').trim(),
      state: fromQuery(item.getAttribute('data-ds-view-state') ?? '')?.state ?? {},
      builtin: true,
      isDefault: item.hasAttribute('data-ds-view-default'),
    }));
    const fromOptions = (options.views ?? []).map((entry) => ({ id: String(entry.id), name: String(entry.name), state: canonical(entry.state), builtin: true, isDefault: Boolean(entry.default) }));
    builtins = [...fromMarkup, ...fromOptions.filter((entry) => !fromMarkup.some((other) => other.id === entry.id))];
  };

  const readSaved = () => {
    const value = store.get(options.key, null);
    const views = Array.isArray(value?.views) ? value.views.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string') : [];
    saved = { views: views.map((entry) => ({ id: entry.id, name: entry.name, state: canonical(entry.state), builtin: false })), default: typeof value?.default === 'string' ? value.default : null };
  };

  /** Our own writes: the store tells this tab too, and those changes are already here. */
  let writing = false;
  const writeSaved = () => {
    writing = true;
    try {
      store.set(options.key, { views: saved.views.map(({ id, name, state }) => ({ id, name, state })), default: saved.default });
    } finally {
      writing = false;
    }
  };

  const all = () => [...builtins, ...saved.views.filter((entry) => !builtins.some((other) => other.id === entry.id))];
  const find = (id) => all().find((entry) => entry.id === id) ?? null;
  const defaultId = () => (saved.default && find(saved.default) ? saved.default : builtins.find((entry) => entry.isDefault)?.id ?? all()[0]?.id ?? null);
  const edited = () => {
    const entry = find(current.id);
    return entry ? !same(entry.state, current.state) : Object.keys(canonical(current.state)).length > 0;
  };

  /** The address with the current state, the page's other parameters kept. */
  const link = () => {
    const url = new URL(view?.location?.href ?? 'http://localhost/');
    const kept = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      const ours = options.prefix ? key.startsWith(options.prefix) : true;
      if (!ours) kept.append(key, value);
    }
    const query = toQuery(current.state, { prefix: options.prefix, view: current.id });
    const joined = [kept.toString(), query].filter(Boolean).join('&');
    url.search = joined ? `?${joined}` : '';
    return url.href;
  };

  const syncAddress = () => {
    if (options.url !== 'sync' || !view?.history?.replaceState) return;
    const href = link();
    if (href !== view.location.href) view.history.replaceState(view.history.state, '', href);
  };

  /** The rows of the views in the list (the built-in items stay; the user's are rendered after them), the trigger and the actions. */
  const paint = () => {
    const isDefault = defaultId();
    if (list) {
      const users = all().filter((entry) => !entry.builtin);
      const rows = [...list.querySelectorAll('[data-ds-view-user]')];
      const keep = new Set(users.map((entry) => entry.id));
      for (const row of rows) if (!keep.has(row.getAttribute('data-ds-view'))) row.remove();
      for (const entry of users) {
        let row = /** @type {HTMLElement|null} */ (list.querySelector(`[data-ds-view-user][data-ds-view="${CSS.escape(entry.id)}"]`));
        if (!row) {
          row = doc.createElement('button');
          row.type = 'button';
          row.className = 'ds-menu__item';
          row.setAttribute('role', 'menuitemradio');
          row.setAttribute('data-ds-view', entry.id);
          row.setAttribute('data-ds-view-user', '');
          const label = doc.createElement('span');
          label.className = 'ds-menu__label';
          row.append(iconElement(checkGlyph, 20, 'ds-menu__check', doc), label);
        }
        const label = row.querySelector('.ds-menu__label');
        if (label.textContent !== entry.name) label.textContent = entry.name;
        list.append(row);
      }
      for (const row of list.querySelectorAll('[data-ds-view]')) {
        const id = row.getAttribute('data-ds-view');
        own(row, 'attrs', 'aria-checked');
        row.setAttribute('aria-checked', String(id === current.id));
        let mark = row.querySelector('.ds-views__default');
        if (id === isDefault) {
          if (!mark) {
            mark = doc.createElement('span');
            mark.className = 'ds-menu__shortcut ds-views__default';
            mark.append(iconElement(starGlyph, 16, '', doc), doc.createElement('span'));
            row.append(mark);
          }
          const word = mark.querySelector('span');
          if (word.textContent !== t('viewDefault')) word.textContent = t('viewDefault');
        } else mark?.remove();
      }
    }
    const entry = find(current.id);
    const changed = edited();
    for (const name of el.querySelectorAll('.ds-views__name')) {
      const text = entry?.name ?? '';
      if (name.textContent !== text) name.textContent = text;
    }
    for (const word of el.querySelectorAll('.ds-views__edited')) {
      own(word, 'attrs', 'hidden');
      word.hidden = !changed;
      if (word.textContent !== t('viewEdited')) word.textContent = t('viewEdited');
    }
    for (const button of el.querySelectorAll('.ds-views__save')) {
      own(button, 'attrs', 'hidden');
      /** @type {HTMLElement} */ (button).hidden = !changed;
    }
    const off = {
      save: !changed,
      rename: !entry || entry.builtin,
      delete: !entry || entry.builtin,
      default: !entry || current.id === isDefault,
    };
    for (const action of el.querySelectorAll('[data-ds-views-action]')) {
      const kind = action.getAttribute('data-ds-views-action');
      if (!(kind in off)) continue;
      own(action, 'attrs', 'aria-disabled');
      if (off[kind]) action.setAttribute('aria-disabled', 'true');
      else action.removeAttribute('aria-disabled');
    }
  };

  /** Makes `id` the current view; a pick by the user is told and spoken. */
  const pick = (id, reason, user) => {
    const entry = find(id);
    if (!entry) return;
    current = { id: entry.id, state: canonical(entry.state) };
    paint();
    syncAddress();
    if (!user || signal?.aborted) return;
    const detail = { id: entry.id, name: entry.name, state: current.state, reason };
    emit(el, 'view', detail);
    tell('view', detail);
    announce(t('viewApplied', { name: entry.name }));
  };

  /** The saved set changed: store, paint, tell. */
  const commitSaved = (reason) => {
    writeSaved();
    paint();
    syncAddress();
    const detail = { views: all().map(({ id, name, builtin }) => ({ id, name, builtin })), default: defaultId(), reason };
    emit(el, 'views', detail);
    tell('views', detail);
  };

  const done = (text) => {
    toast(null, text, { kind: 'success' });
  };

  const actions = {
    save() {
      const entry = find(current.id);
      if (!entry || entry.builtin) return actions.create();
      entry.state = canonical(current.state);
      commitSaved('save');
      done(t('viewSaved', { name: entry.name }));
      return Promise.resolve(entry.id);
    },
    async create(name) {
      const named = name ?? await prompt({ title: t('viewNewTitle'), label: t('viewNameLabel'), confirmLabel: t('viewSave'), opener: trigger, input: { required: true, autocomplete: 'off' } });
      const text = String(named ?? '').trim();
      if (!text || signal?.aborted) return null;
      const id = idFor(text, new Set(all().map((entry) => entry.id)));
      saved.views.push({ id, name: text, state: canonical(current.state), builtin: false });
      current = { id, state: canonical(current.state) };
      commitSaved('create');
      done(t('viewSaved', { name: text }));
      return id;
    },
    async rename(name) {
      const entry = find(current.id);
      if (!entry || entry.builtin) return null;
      const named = name ?? await prompt({ title: t('viewRenameTitle'), label: t('viewNameLabel'), value: entry.name, confirmLabel: t('viewSave'), opener: trigger, input: { required: true, autocomplete: 'off' } });
      const text = String(named ?? '').trim();
      if (!text || signal?.aborted) return null;
      entry.name = text;
      commitSaved('rename');
      announce(t('viewSaved', { name: text }));
      return entry.id;
    },
    default() {
      const entry = find(current.id);
      if (!entry) return Promise.resolve(null);
      saved.default = entry.id;
      commitSaved('default');
      announce(t('viewDefaultSet', { name: entry.name }));
      return Promise.resolve(entry.id);
    },
    async share() {
      const href = link();
      let copied = false;
      try {
        if (view?.navigator?.clipboard?.writeText) {
          await view.navigator.clipboard.writeText(href);
          copied = true;
        }
      } catch {
        copied = false;
      }
      if (copied) done(t('viewLinkCopied'));
      else await prompt({ title: t('viewLinkTitle'), label: t('viewLinkTitle'), value: href, confirmLabel: t('ok'), opener: trigger, input: { type: 'url', spellcheck: false } });
      return href;
    },
    async delete(ask = true) {
      const entry = find(current.id);
      if (!entry || entry.builtin) return null;
      if (ask) {
        const sure = await confirm({ title: t('viewDeleteTitle', { name: entry.name }), text: t('viewDeleteText'), confirmLabel: t('viewDeleteConfirm'), destructive: true, opener: trigger });
        if (!sure || signal?.aborted) return null;
      }
      saved.views = saved.views.filter((other) => other.id !== entry.id);
      if (saved.default === entry.id) saved.default = null;
      writeSaved();
      announce(t('viewDeleted', { name: entry.name }));
      pick(defaultId(), 'delete', true);
      commitSaved('delete');
      return entry.id;
    },
  };

  el.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const target = /** @type {Element} */ (event.target);
    const item = target?.closest?.('[data-ds-view]');
    if (item && list?.contains(item)) {
      if (item.getAttribute('aria-disabled') === 'true') return;
      pick(item.getAttribute('data-ds-view'), 'select', true);
      return;
    }
    const action = target?.closest?.('[data-ds-views-action]');
    const save = target?.closest?.('.ds-views__save');
    const kind = action?.getAttribute('data-ds-views-action') ?? (save ? 'save' : null);
    if (!kind || !(kind in actions) || (action ?? save).getAttribute('aria-disabled') === 'true') return;
    // From a menu: once it has closed and given the focus back, so a dialog opens over the page, not over the menu.
    if ((action ?? save).closest('.ds-menu') && view?.requestAnimationFrame) view.requestAnimationFrame(() => actions[kind]());
    else actions[kind]();
  }, { signal });

  // Another tab saved, renamed or deleted: the list follows; the current view stays unless it went.
  const offStore = store.on('change', ({ key }) => {
    if (writing || (key !== null && key !== options.key)) return;
    readSaved();
    if (!find(current.id)) pick(defaultId(), 'delete', true);
    else paint();
  });
  doc.addEventListener('ds:config', paint, { signal });

  readBuiltins();
  readSaved();
  const fromAddress = options.url === 'off' ? null : fromQuery(view?.location?.search ?? '', { prefix: options.prefix });
  if (fromAddress) {
    const entry = (fromAddress.view && find(fromAddress.view)) || null;
    const onlyView = entry && fromAddress.view && Object.keys(fromAddress.state).length === 0;
    current = { id: entry?.id ?? defaultId(), state: onlyView ? canonical(entry.state) : fromAddress.state };
  } else {
    const id = defaultId();
    current = { id, state: canonical(find(id)?.state) };
  }
  paint();

  return {
    get() {
      const entry = find(current.id);
      return {
        id: current.id,
        name: entry?.name ?? '',
        state: canonical(current.state),
        edited: edited(),
        default: defaultId(),
        views: all().map(({ id, name, builtin }) => ({ id, name, builtin })),
      };
    },
    set(value) {
      if (typeof value === 'string') {
        pick(value, 'set', false);
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (value.id != null) pick(String(value.id), 'set', false);
      if (value.state) {
        current = { id: current.id, state: canonical(value.state) };
        paint();
        syncAddress();
      }
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    save: () => actions.save(),
    create: (name) => actions.create(name),
    rename: (name) => actions.rename(name),
    setDefault: () => actions.default(),
    share: () => actions.share(),
    remove: (ask = false) => actions.delete(ask),
    link,
    update() {
      // A new key needs no new store (its namespace is 'views'; the key is read per get and set), so the change listener stays.
      options = { ...options, ...readOptions(el), ...given };
      readBuiltins();
      readSaved();
      if (!find(current.id)) current = { id: defaultId(), state: canonical(find(defaultId())?.state) };
      paint();
    },
    destroy() {
      offStore();
      store.destroy();
      listeners.clear();
    },
  };
}

define('views', {
  attribute: 'data-ds-views',
  attributes: ['data-ds-views-key', 'data-ds-views-url', 'data-ds-views-prefix'],
  init(el, ctx) {
    return built.get(el) ?? controller(el, {}, ctx.signal);
  },
});

/**
 * Saved views driven from the page; the same controller data-ds-views
 * makes (an element that has one returns it).
 * @param {Element} el  the .ds-views element
 * @param {{ key?: string, url?: 'off'|'read'|'sync', prefix?: string,
 *   views?: { id: string, name: string, state?: object, default?: boolean }[] }} [options]
 */
export function create(el, options = {}) {
  const existing = controllerOf(el, 'views') ?? built.get(el);
  if (existing) return /** @type {any} */ (existing);
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const made = controller(el, options, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
    built.delete(el);
  };
  built.set(el, made);
  return made;
}
