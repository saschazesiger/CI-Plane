/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Search field (DS.search): the filled search pill of form.css with a clear
 * button, the shortcut hint of its data-ds-hotkey, a result count that is
 * shown and spoken, and recent searches remembered through DS.store.
 *
 *   <div class="ds-search ds-combo" data-ds-search data-ds-search-recent="devices" data-ds-search-count="dev-count">
 *     (search icon)
 *     <input class="ds-input" type="search" aria-label="Search devices" placeholder="Search devices" data-ds-hotkey="/">
 *     <kbd class="ds-kbd ds-search__key" aria-hidden="true"></kbd>
 *     <button class="ds-btn ds-btn--quiet ds-btn--icon ds-search__clear" type="button" hidden>(close)</button>
 *   </div>
 *   <span class="ds-search__count" id="dev-count"></span>
 *
 *   const search = DS.search.create(root);
 *   search.set({ count: 12 });          // "12 results", spoken once typing pauses
 *   search.get();                       // { value: 'lap', count: 12, recent: ['laptop', 'router'] }
 *   search.remember('laptop');          // the page decides a search happened
 *
 * Clear: the button shows while the field has a value (the system sets
 * hidden), empties the field, sends an input event (the page's filter runs)
 * and returns the focus to the field; without a name it is called by the
 * string clear. Escape in a filled field does the same, in every engine, and
 * keeps a dialog around it open (the next Escape closes it, as DS.overlay
 * does for any filled search).
 *
 * Shortcut: data-ds-hotkey on the input is the system's hotkey (core.js
 * focuses and selects the field); this module writes its first combo, as the
 * platform says it (DS.hotkeys.format: "/", "Ctrl+K", "⌘K"), into an empty
 * .ds-search__key, and the room it takes into --ds-search-key-room.
 *
 * Count: set({ count }) writes "12 results" (searchResultsOne,
 * searchResultsMany; 0 is the string noResults) into the element whose id
 * data-ds-search-count names, adds it to the field's description and says it
 * once typing pauses (--ds-delay-tooltip). null empties it.
 *
 * Recent searches (data-ds-search-recent="<key>"; -max, default 5): Enter in
 * a filled field, or remember(value), keeps the search at the head of a
 * list in DS.store ("search" namespace, under the key). In an empty field,
 * a click, ArrowDown or Alt+ArrowDown opens the list (a listbox in a
 * .ds-combo__popup, through DS.overlay): the field is a combobox while it
 * has the list; Up and Down move the active option, Enter takes it (the
 * value, an input event and ds:search), Delete forgets it, Escape closes the
 * list and typing closes it too. "Clear recent searches" under the list
 * forgets them all.
 *
 * Events on the root: ds:search ({ value, source: 'enter' | 'recent' }).
 * ds:change is not sent: the input's own input event is the change.
 *
 * Strings: clear, recentSearches, clearRecent, searchResultsOne,
 * searchResultsMany, noResults (DS.core.config({ strings })).
 *
 * ES2022. No Progressive: features (the list's placement is DS.overlay's).
 */
import { define, emit, t } from './core.js';
import { motionDuration } from './motion.js';
import { own } from './dom.js';
import { open as openOverlay, close as closeOverlay } from './overlay.js';
import { announce } from './a11y.js';
import { format as formatCombo } from './hotkeys.js';
import { plural } from './format.js';
import { open as openStore } from './store.js';
import { history as historyGlyph, iconElement } from './icons.js';

/** Numbers the ids this module gives the list and its options. */
let seq = 0;

/**
 * The recent searches after one more: the value at the head (trimmed), an
 * earlier copy of it (in any case) gone, at most `max`.
 * @param {string[]|null|undefined} list
 * @param {string|null|undefined} value
 * @param {{ max?: number }} [options]
 * @returns {string[]}
 */
export function remember(list, value, options = {}) {
  const max = Math.max(1, Math.floor(options.max ?? 5));
  const before = Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim()) : [];
  const text = String(value ?? '').trim();
  if (!text) return before.slice(0, max);
  const key = text.toLocaleLowerCase();
  return [text, ...before.filter((item) => item.trim().toLocaleLowerCase() !== key)].slice(0, max);
}

/** The words of a count: "1 result", "12 results", "No results"; '' for none. */
function countText(count) {
  if (count === null || count === undefined || !Number.isFinite(Number(count))) return '';
  if (Number(count) === 0) return t('noResults');
  return plural(Number(count), { one: t('searchResultsOne'), other: t('searchResultsMany') });
}

function controller(root, signal) {
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('input.ds-input'));
  const clear = /** @type {HTMLButtonElement|null} */ (root.querySelector('.ds-search__clear'));
  const key = root.querySelector('.ds-search__key');
  const doc = root.ownerDocument ?? globalThis.document;
  const listeners = { search: new Set() };
  const on = (target, type, fn, options) => target?.addEventListener?.(type, fn, { signal, ...options });
  let count = null;
  let said = 0;
  let wroteKey = false;

  // Recent searches.
  const recentKey = root.getAttribute('data-ds-search-recent') || '';
  const max = Number(root.getAttribute('data-ds-search-recent-max')) || 5;
  const store = recentKey ? openStore('search') : null;
  const recent = () => remember(store?.get(recentKey, []), '', { max });
  let popup = /** @type {HTMLElement|null} */ (null);
  let list = /** @type {HTMLElement|null} */ (null);
  let active = -1;

  const counter = () => {
    const id = root.getAttribute('data-ds-search-count');
    return id ? doc?.getElementById?.(id) ?? null : null;
  };

  const describe = () => {
    const el = counter();
    if (!input || !el) return;
    const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (!ids.includes(el.id)) input.setAttribute('aria-describedby', [...ids, el.id].join(' '));
  };

  const paintClear = () => {
    if (!clear || !input) return;
    const hide = !input.value || input.disabled || input.readOnly;
    if (clear.hidden !== hide) clear.hidden = hide;
  };

  const paintKey = () => {
    if (!key || !input) return;
    const combo = (input.getAttribute('data-ds-hotkey') ?? '').trim().split(/\s+/)[0];
    if (combo && (!key.textContent.trim() || wroteKey)) {
      try {
        key.textContent = formatCombo(combo).text;
        wroteKey = true;
      } catch {
        // A combo the registry refuses names no key.
      }
    }
    const width = key.getBoundingClientRect?.().width ?? 0;
    if (width) root.style?.setProperty('--ds-search-key-room', `${Math.ceil(width)}px`);
  };

  const paintCount = (speak) => {
    const el = counter();
    const text = countText(count);
    if (el && el.textContent !== text) el.textContent = text;
    clearTimeout(said);
    if (!speak || !text || !input?.value) return;
    said = setTimeout(() => { if (!signal?.aborted && countText(count) === text) announce(text); }, motionDuration(root, '--ds-delay-tooltip'));
  };

  const tell = (value, source) => {
    const detail = { value, source };
    emit(root, 'search', detail);
    listeners.search.forEach((fn) => fn(detail));
  };

  const keep = (value) => {
    if (!store) return;
    const next = remember(store.get(recentKey, []), value, { max });
    store.set(recentKey, next);
  };

  /* ── The list of recent searches ─────────────────── */

  const isOpen = () => Boolean(popup && !popup.hidden && popup.getAttribute('data-state') !== 'closed');

  const options = () => (list ? /** @type {HTMLElement[]} */ ([...list.querySelectorAll('[role="option"]')]) : []);

  const setActive = (index) => {
    const items = options();
    active = items.length ? (index + items.length) % items.length : -1;
    items.forEach((item, at) => item.toggleAttribute('data-active', at === active));
    if (active >= 0) {
      input?.setAttribute('aria-activedescendant', items[active].id);
      items[active].scrollIntoView?.({ block: 'nearest' });
    } else {
      input?.removeAttribute('aria-activedescendant');
    }
  };

  const build = () => {
    if (popup || !input) return;
    seq += 1;
    popup = doc.createElement('div');
    popup.className = 'ds-combo__popup ds-search__popup';
    popup.hidden = true;
    list = doc.createElement('ul');
    list.className = 'ds-combo__list';
    list.id = `ds-search-list-${seq}`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('recentSearches'));
    const foot = doc.createElement('div');
    foot.className = 'ds-search__foot';
    const forget = doc.createElement('button');
    forget.type = 'button';
    forget.className = 'ds-btn ds-btn--text ds-search__forget';
    forget.textContent = t('clearRecent');
    foot.append(forget);
    popup.append(list, foot);
    root.append(popup);
    own(input, 'attrs', 'role');
    own(input, 'attrs', 'aria-controls');
    own(input, 'attrs', 'aria-autocomplete');
    own(input, 'attrs', 'aria-expanded');
    own(input, 'attrs', 'aria-activedescendant');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-autocomplete', 'none');
    input.setAttribute('aria-expanded', 'false');
    // Keep the focus in the field while an option or the foot is pressed; choose on click.
    on(popup, 'mousedown', (event) => event.preventDefault());
    on(list, 'click', (event) => {
      const item = /** @type {Element} */ (event.target).closest?.('[role="option"]');
      if (item) choose(options().indexOf(/** @type {HTMLElement} */ (item)));
    });
    on(forget, 'click', () => {
      store?.remove(recentKey);
      hide();
      input.focus();
    });
  };

  const fill = (items) => {
    if (!list) return;
    const rows = items.map((text, index) => {
      const item = doc.createElement('li');
      item.className = 'ds-combo__option';
      item.id = `${list.id}-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('data-ds-key', text);
      const name = doc.createElement('span');
      name.className = 'ds-combo__name';
      name.textContent = text;
      item.append(iconElement(historyGlyph, 18, 'ds-search__history', doc), name);
      return item;
    });
    list.replaceChildren(...rows);
    active = -1;
    input?.removeAttribute('aria-activedescendant');
  };

  const show = () => {
    if (!input || !store || input.value || input.disabled || input.readOnly) return;
    const items = recent();
    if (!items.length) return;
    build();
    fill(items);
    if (!isOpen() && popup) openOverlay(popup, { opener: input });
  };

  function hide() {
    if (popup && isOpen()) closeOverlay(popup);
    active = -1;
    input?.removeAttribute('aria-activedescendant');
  }

  function choose(index) {
    const items = recent();
    const value = items[index];
    if (!input || value === undefined) return;
    hide();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    keep(value);
    paintClear();
    input.focus();
    tell(value, 'recent');
  }

  const forgetOne = (index) => {
    const items = recent();
    if (index < 0 || index >= items.length || !store) return;
    store.set(recentKey, items.filter((_, at) => at !== index));
    const left = recent();
    if (!left.length) {
      hide();
      return;
    }
    fill(left);
    setActive(Math.min(index, left.length - 1));
  };

  const empty = () => {
    if (!input) return;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    paintClear();
    input.focus();
  };

  /* ── Wiring ───────────────────────────────────────── */

  if (clear && input) {
    if (!clear.hasAttribute('aria-label') && !clear.textContent.trim()) clear.setAttribute('aria-label', t('clear'));
    if (!clear.hasAttribute('aria-controls') && input.id) clear.setAttribute('aria-controls', input.id);
    on(clear, 'click', empty);
  }
  on(input, 'input', () => {
    paintClear();
    if (input?.value) hide();
    paintCount(true);
  });
  on(input, 'click', () => { if (!isOpen()) show(); });
  on(input, 'keydown', (/** @type {KeyboardEvent} */ event) => {
    if (!input || event.defaultPrevented || event.isComposing) return;
    const open = isOpen();
    switch (event.key) {
      case 'ArrowDown':
        if (!open) {
          if (input.value || !store) return;
          event.preventDefault();
          show();
          if (!event.altKey) setActive(0);
          return;
        }
        event.preventDefault();
        setActive(active + 1);
        return;
      case 'ArrowUp':
        if (!open) return;
        event.preventDefault();
        if (event.altKey) {
          hide();
          return;
        }
        setActive(active < 0 ? -1 : active - 1);
        return;
      case 'Enter':
        if (open && active >= 0) {
          event.preventDefault();
          choose(active);
          return;
        }
        if (input.value.trim()) {
          keep(input.value);
          tell(input.value, 'enter');
        }
        return;
      case 'Delete':
        if (open && active >= 0) {
          event.preventDefault();
          forgetOne(active);
        }
        return;
      case 'Escape':
        // An open list is DS.overlay's: it closes on this key. A filled field clears here in every engine.
        if (open || !input.value) return;
        event.preventDefault();
        empty();
        return;
      default:
        break;
    }
  });
  on(root, 'focusout', (/** @type {FocusEvent} */ event) => {
    const next = /** @type {Node|null} */ (event.relatedTarget);
    if (next && root.contains(next)) return;
    hide();
  });
  on(input?.form, 'reset', () => setTimeout(() => {
    paintClear();
    count = null;
    paintCount(false);
  }));
  on(doc, 'ds:config', () => {
    if (list) list.setAttribute('aria-label', t('recentSearches'));
    paintKey();
    paintCount(false);
  });

  describe();
  paintClear();
  paintKey();

  return {
    get() { return { value: input?.value ?? '', count, recent: recent() }; },
    set(next = {}) {
      if (input && typeof next.value === 'string' && next.value !== input.value) {
        input.value = next.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if ('count' in next) {
        count = next.count === null || next.count === undefined ? null : Number(next.count);
        paintCount(true);
      }
      paintClear();
    },
    remember(value) { keep(value); },
    forget() { store?.remove(recentKey); hide(); },
    on(type, fn) {
      const set = listeners[type];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    update() {
      describe();
      paintClear();
      paintKey();
    },
    destroy() {
      clearTimeout(said);
      listeners.search.clear();
      hide();
      if (popup) popup.remove();
      popup = null;
      list = null;
      store?.destroy();
    },
  };
}

define('search', {
  attribute: 'data-ds-search',
  init(el, ctx) {
    return controller(el, ctx.signal);
  },
});

/**
 * A search field driven from the page; the same controller the attribute
 * path makes.
 * @param {Element} el  the .ds-search with its input
 */
export function create(el) {
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const made = controller(el, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
  };
  return made;
}
