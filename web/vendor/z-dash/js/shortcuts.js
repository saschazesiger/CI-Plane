/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Shortcut sheet (DS.shortcuts): "?" opens a dialog that lists every
 * shortcut registered with DS.hotkeys (DS.hotkeys.list()), grouped by scope
 * when more than one has shortcuts, then by group, each with its keys.
 *
 *   <dialog class="ds-dialog ds-dialog--lg ds-shortcuts" id="keys" data-ds-shortcuts aria-labelledby="keys-title">
 *     <div class="ds-dialog__backdrop" data-ds-close></div>
 *     <div class="ds-dialog__box">
 *       <div class="ds-dialog__head"><h2 class="ds-dialog__title" id="keys-title">Keyboard shortcuts</h2> (close button)</div>
 *       [<input class="ds-input ds-shortcuts__filter" type="search" aria-label="Find a shortcut">]
 *       <div class="ds-dialog__body ds-shortcuts__list"></div>
 *   </dialog>
 *
 *   DS.shortcuts.open(sheet);                 // also "?" and any [data-ds-open]
 *   DS.shortcuts.create(sheet, { scopes: { board: 'Board' } });
 *   DS.shortcuts.render(panel);               // the same list in any element (a help page)
 *
 * The sheet registers its own key, "?" (data-ds-shortcuts-hotkey: another
 * combo, "off": none; a plain key, so it never types into a field), which
 * also closes the open sheet and passes while another overlay is open. The
 * list is rendered when the sheet opens (the shortcuts of the page as it
 * stands: a control that is hidden is left out, one that is disabled shows
 * "Not available here") and again on every registration or scope change
 * while it is open. Scopes: the scope that counts first leads, "global"
 * ("Everywhere") last; a scope's heading is its label from `scopes` (or
 * data-ds-shortcuts-scopes, JSON), else its name. The filter field hides
 * what does not match its words (in the description or the keys).
 *
 * Strings: shortcutsOpen, shortcutsGlobal, shortcutsOff, shortcutsOr,
 * shortcutsEmpty and noResults.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { open as openOverlay, close as closeOverlay, topmost } from './overlay.js';
import { format as formatCombo, list as listShortcuts, onChange, register, scopes as activeScopes } from './hotkeys.js';

/** The sheet's own key, by default. */
const HOTKEY = '?';

/** The scope of DS.hotkeys that counts everywhere. */
const GLOBAL = 'global';

let sheets = 0;

/** A scope's heading: its label, "Everywhere" for global, else its name with a capital. */
function scopeLabel(name, labels) {
  if (labels && Object.hasOwn(labels, name)) return String(labels[name]);
  if (name === GLOBAL) return t('shortcutsGlobal');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The groups of DS.hotkeys.list() by scope: [{ scope, groups: [{ name,
 * items }] }], in the order of `order` (DS.hotkeys.scopes(): the scope
 * that counts first first), then the scopes that do not count now, then
 * 'global'. Each scope keeps the groups' order.
 * @param {{ name: string, items: { scope: string }[] }[]} groups
 * @param {string[]} [order]
 * @returns {{ scope: string, groups: { name: string, items: any[] }[] }[]}
 */
export function byScope(groups, order = []) {
  const scopes = new Map();
  for (const group of groups) {
    for (const item of group.items) {
      if (!scopes.has(item.scope)) scopes.set(item.scope, new Map());
      const named = scopes.get(item.scope);
      if (!named.has(group.name)) named.set(group.name, []);
      named.get(group.name).push(item);
    }
  }
  const rank = (scope) => {
    if (scope === GLOBAL) return order.length + 1;
    const at = order.indexOf(scope);
    return at < 0 ? order.length : at;
  };
  return [...scopes].sort((a, b) => rank(a[0]) - rank(b[0])).map(([scope, named]) => ({
    scope,
    groups: [...named].map(([name, items]) => ({ name, items })),
  }));
}

/**
 * Renders the shortcut list into `container` with DOM APIs: the scopes
 * (only when more than one has shortcuts), the groups with their headings,
 * each shortcut its description and keys (<kbd class="ds-kbd"> each, its
 * combos joined by "or"), one that does nothing now marked data-off with
 * the words "Not available here". `filter` (words) leaves out what does not
 * match; `labels` names the scopes; `root` is the DS.hotkeys root (default
 * the container's document); `apple` overrides the platform. Returns how
 * many shortcuts it shows.
 * @param {Element} container
 * @param {{ filter?: string, labels?: Record<string, string>, root?: Document|ShadowRoot|Element, apple?: boolean, headingLevel?: number }} [options]
 * @returns {number}
 */
export function render(container, options = {}) {
  const doc = container.ownerDocument;
  const root = options.root ?? doc;
  const all = listShortcuts({ root, apple: options.apple });
  const words = String(options.filter ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (item) => {
    if (!words.length) return true;
    const text = `${item.description} ${item.combos.map((combo) => `${combo.text} ${combo.keys.join(' ')}`).join(' ')}`.toLowerCase();
    return words.every((word) => text.includes(word));
  };
  const filtered = all.map((group) => ({ name: group.name, items: group.items.filter(matches) })).filter((group) => group.items.length);
  const scoped = byScope(filtered, activeScopes({ root }));
  const level = Math.min(5, Math.max(2, options.headingLevel ?? 3));
  sheets += 1;
  const uid = `ds-shortcuts-${sheets}`;
  let count = 0;
  let headings = 0;
  const nodes = [];

  const groupNode = (group, depth) => {
    const section = doc.createElement('section');
    section.className = 'ds-shortcuts__group';
    const heading = doc.createElement(`h${depth}`);
    heading.className = 'ds-shortcuts__heading';
    headings += 1;
    heading.id = `${uid}-h${headings}`;
    heading.textContent = group.name;
    section.setAttribute('aria-labelledby', heading.id);
    const listNode = doc.createElement('dl');
    listNode.className = 'ds-shortcuts__items';
    for (const item of group.items) {
      count += 1;
      const row = doc.createElement('div');
      row.className = 'ds-shortcuts__item';
      if (!item.active) row.setAttribute('data-off', '');
      const label = doc.createElement('dt');
      label.className = 'ds-shortcuts__label';
      label.textContent = item.description;
      const keys = doc.createElement('dd');
      keys.className = 'ds-shortcuts__keys';
      item.combos.forEach((combo, index) => {
        if (index) {
          const or = doc.createElement('span');
          or.className = 'ds-shortcuts__or';
          or.textContent = t('shortcutsOr');
          keys.append(or);
        }
        // One combo is one phrase for a screen reader: its keys, then the line it reads.
        const set = doc.createElement('span');
        set.className = 'ds-shortcuts__combo';
        set.setAttribute('aria-label', combo.text);
        set.setAttribute('role', 'img');
        for (const key of combo.keys) {
          const kbd = doc.createElement('kbd');
          kbd.className = 'ds-kbd';
          kbd.textContent = key;
          set.append(kbd);
        }
        keys.append(set);
      });
      if (!item.active) {
        const off = doc.createElement('span');
        off.className = 'ds-shortcuts__off';
        off.textContent = t('shortcutsOff');
        label.append(off);
      }
      row.append(label, keys);
      listNode.append(row);
    }
    section.append(heading, listNode);
    return section;
  };

  if (scoped.length > 1) {
    for (const { scope, groups } of scoped) {
      const block = doc.createElement('section');
      block.className = 'ds-shortcuts__scope';
      const title = doc.createElement(`h${level}`);
      title.className = 'ds-shortcuts__title';
      headings += 1;
      title.id = `${uid}-h${headings}`;
      title.textContent = scopeLabel(scope, options.labels);
      block.setAttribute('aria-labelledby', title.id);
      const columns = doc.createElement('div');
      columns.className = 'ds-shortcuts__groups';
      columns.append(...groups.map((group) => groupNode(group, Math.min(6, level + 1))));
      block.append(title, columns);
      nodes.push(block);
    }
  } else if (scoped.length === 1) {
    const columns = doc.createElement('div');
    columns.className = 'ds-shortcuts__groups';
    columns.append(...scoped[0].groups.map((group) => groupNode(group, level)));
    nodes.push(columns);
  }
  if (!count) {
    const empty = doc.createElement('p');
    empty.className = 'ds-shortcuts__empty';
    empty.textContent = all.length ? t('noResults') : t('shortcutsEmpty');
    nodes.push(empty);
  }
  container.replaceChildren(...nodes);
  return count;
}

/** The scope labels of the markup (data-ds-shortcuts-scopes, JSON), else none. */
function labelsOf(el) {
  const text = el.getAttribute('data-ds-shortcuts-scopes');
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function controller(el, given = {}, signal = null) {
  const doc = el.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const body = el.querySelector('.ds-shortcuts__list');
  if (!body) return null;
  const filter = /** @type {HTMLInputElement|null} */ (el.querySelector('.ds-shortcuts__filter'));
  // DS.overlay focuses [autofocus] first: without it the close button in the
  // head would take focus (and show its tooltip) before the filter does.
  if (filter && !el.querySelector('[autofocus]')) filter.autofocus = true;
  const lifetime = new AbortController();
  signal?.addEventListener('abort', () => lifetime.abort(), { once: true });
  const on = { signal: lifetime.signal };
  const listeners = new Map();
  let labels = given.scopes ?? labelsOf(el);
  let shown = 0;
  const isOpen = () => el.getAttribute('data-state') === 'open';

  const paint = () => {
    shown = render(body, { filter: filter?.value ?? '', labels, root: doc });
  };

  const fire = (type, detail) => {
    emit(el, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  };

  // Opened by any door: the list as the page stands now, the filter empty.
  el.addEventListener('ds:open', (event) => {
    if (event.target !== el) return;
    if (filter) filter.value = '';
    paint();
    // The filter first: typing finds a shortcut at once.
    if (filter && !filter.disabled) filter.focus({ preventScroll: true });
  }, on);
  filter?.addEventListener('input', () => {
    paint();
    fire('filter', { query: filter.value, count: shown });
  }, on);
  const unsubscribe = onChange(() => {
    if (isOpen()) paint();
  }, { root: doc });

  const openSheet = (options = {}) => {
    if (filter) filter.value = '';
    paint();
    return openOverlay(el, { opener: options.opener ?? doc.activeElement });
  };

  const combo = el.getAttribute('data-ds-shortcuts-hotkey') ?? given.hotkey ?? HOTKEY;
  let own = null;
  if (combo && combo !== 'off') {
    try {
      own = register(combo, () => {
        const top = topmost(doc);
        if (top === el) closeOverlay(el, { reason: 'hotkey' });
        else if (top) return false;
        else openSheet();
        return undefined;
      }, { description: t('shortcutsOpen'), overlays: true, root: doc });
    } catch (error) {
      view.reportError?.(error);
    }
  }

  const api = {
    get() {
      return { open: isOpen(), count: shown, filter: filter?.value ?? '' };
    },
    set(next = {}) {
      if (next.scopes) labels = next.scopes;
      if (typeof next.filter === 'string' && filter) filter.value = next.filter;
      paint();
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    open: (options) => openSheet(options),
    close: () => closeOverlay(el, { reason: 'api' }),
    refresh: () => paint(),
    destroy() {
      // A later create(el) or open(el) makes a new sheet, never this dead one.
      made.delete(el);
      lifetime.abort();
      unsubscribe();
      own?.destroy();
      listeners.clear();
    },
  };
  return api;
}

const made = new WeakMap();

/**
 * The sheet of `el` (a dialog with a .ds-shortcuts__list): the same
 * controller [data-ds-shortcuts] makes. `scopes` names the scopes
 * ({ board: 'Board' }), `hotkey` is its own combo (default "?", "off":
 * none; data-ds-shortcuts-hotkey wins). Once per element. Null without the
 * list.
 * @param {Element} el
 * @param {{ scopes?: Record<string, string>, hotkey?: string }} [options]
 */
export function create(el, options = {}) {
  const known = made.get(el);
  if (known) {
    if (options.scopes) known.set({ scopes: options.scopes });
    return known;
  }
  const sheet = controller(el, options);
  if (sheet) made.set(el, sheet);
  return sheet;
}

/**
 * Opens the sheet of `el` (made on first use) with the shortcuts as the
 * page stands.
 * @param {Element} el
 * @param {{ opener?: Element|null }} [options]
 * @returns {Promise<void>}
 */
export function open(el, options = {}) {
  return create(el)?.open(options) ?? Promise.resolve();
}

/**
 * Closes the sheet of `el` (DS.overlay.close()).
 * @param {Element} el
 * @returns {Promise<void>}
 */
export function close(el) {
  return closeOverlay(el, { reason: 'api' });
}

define('shortcuts', {
  attribute: 'data-ds-shortcuts',
  init(el, ctx) {
    const known = made.get(el);
    if (known) return known;
    const sheet = controller(el, {}, ctx.signal);
    if (!sheet) return undefined;
    made.set(el, sheet);
    const destroy = sheet.destroy;
    sheet.destroy = () => {
      made.delete(el);
      destroy();
    };
    return sheet;
  },
});
