/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The app frame's behaviour (DS.shell): what a 2.x page wired by hand around
 * the frame, the drawer and the top bar, as declarative behaviours. The
 * overlays (the modal drawer, the phone search sheet, the account menu, the
 * app launcher, the breadcrumbs' menu) open and close through DS.overlay, so
 * the stack, Escape order, focus return and the scroll lock stay the core's.
 *
 *   <div class="ds-app ds-app--drawer" data-ds-shell>            the frame
 *   <nav class="ds-drawer" data-ds-drawer>                        the drawer: groups, filter, keys
 *   <div class="ds-topbar__search" id="search" data-ds-search-sheet>   a sheet on phones
 *   <div class="ds-menu ds-launcher" role="menu" data-ds-launcher>     the app switcher's grid keys
 *   <div role="group" data-ds-scheme-switch>                     light, dark, auto, remembered
 *   <nav class="ds-breadcrumbs" data-ds-breadcrumbs>              collapses its middle into a menu
 *
 *   DS.shell.create(app)    DS.shell.drawer(nav)    DS.shell.searchSheet(el)
 *   DS.shell.launcher(menu) DS.shell.schemeSwitch(group)  DS.shell.breadcrumbs(nav)
 *   DS.shell.setScheme('dark')   DS.shell.fitCrumbs(widths, room, more)   DS.shell.matchText(text, query)
 *
 * Frame (data-ds-shell="<key>"): the top bar's menu button opens the modal
 * drawer at 900px and below (DS.overlay) and toggles the rail above it
 * (data-drawer-collapsed, aria-pressed; never on hover), remembered under
 * the key through DS.store (data-ds-shell-rail="off": no rail, the button
 * shows only with the modal drawer). Above 900px the button is a toggle
 * (aria-pressed, no aria-expanded); at and below it a disclosure
 * (aria-expanded, no aria-pressed). A choice in the modal drawer closes it.
 * It attaches the drawer's gliding pill (DS.indicator), the list's cut
 * edges (DS.dom.scrollEdges) and the view's data-scrolled
 * (DS.dom.watchScrolled). Skip links (.ds-skip) focus their target; one
 * that leads into the modal drawer opens it, one that leads to a phone
 * search sheet opens that. ds:change ({ rail }) on the frame.
 *
 * Drawer (data-ds-drawer="<key>"): <details> groups remember being open or
 * closed under the key (DS.store); the group around the current item opens
 * on load. A .ds-drawer__search field filters the items by their labels
 * (every word, any case, without accents; a group whose heading matches
 * shows all of its items), opens the groups that hold a match until the
 * field is cleared, shows .ds-drawer__empty without one and announces the
 * count. ArrowUp, ArrowDown, Home and End move between the visible items
 * and group toggles (the optional keys of the APG disclosure navigation);
 * ArrowDown from the field goes to the first match; Escape clears a filled
 * field. ds:filter ({ query, count }) on the drawer.
 *
 * Search sheet (data-ds-search-sheet): at 720px and below the top bar's
 * search becomes a full-width sheet over the frame, opened by its
 * .ds-topbar__search-open button (DS.overlay: Escape clears a filled field,
 * then closes; focus returns to the button). While it shows, the rest of
 * the page is inert (DS.a11y.inert), Tab stays inside and the scroll is
 * locked; widening the window closes it and the search is back in the bar.
 *
 * Launcher (data-ds-launcher): the arrow keys move in two dimensions over
 * the grid of a .ds-menu.ds-launcher (Left and Right along a row, Up and
 * Down by a column, Home and End); the menu does the rest.
 *
 * Scheme switch (data-ds-scheme-switch="<key>"): items with
 * data-ds-scheme-value="light | dark | auto" (menuitemradio in a menu, whose
 * keys are the menu's, or radio in a radiogroup: one tab stop, the arrow
 * keys move and choose, Space chooses; with aria-checked) set
 * data-ds-scheme on the .ds-theme around it (auto removes it;
 * data-ds-scheme-switch-target names another) and the media of a dark
 * theme link (data-ds-scheme-switch-link), remembered under the key
 * (default "scheme"; data-ds-scheme-switch-remember="off": not stored), in
 * step across switches, tabs and the page pinning the theme itself.
 * ds:change ({ value }).
 *
 * Breadcrumbs (data-ds-breadcrumbs): when the trail is wider than its
 * nav, the middle crumbs go into a menu behind a "more" button after the
 * first; then the first; then the parent; the current page never.
 *
 * Every timing comes from the tokens (motionDuration()); the parts it adds
 * are data-ds-keep, so a re-render with DS.dom.morphHtml leaves them, and
 * the marks it writes (data-ds-filtered, data-ds-collapsed, a group the
 * filter opened) are owned state (DS.dom.own), so a re-render keeps them; a
 * re-render that changes the list or the trail filters or folds again.
 *
 * ES2022. Progressive: ResizeObserver (the breadcrumbs measure again when
 * their nav changes size): without it they measure on load and on a window
 * resize.
 */
import { define, emit, get, runtime, t } from './core.js';
import { motionDuration } from './motion.js';
import { disown, own, scrollEdges, watchScrolled } from './dom.js';
import { iconElement, moreHorizontal } from './icons.js';
import { DRAWER_QUERY, close as closeOverlay, lockScroll, open as openOverlay, unlockScroll } from './overlay.js';
import { create as indicator } from './indicator.js';
import { announce, canTakeFocus, inert, tabbables } from './a11y.js';
import { plural } from './format.js';
import { open as openStore } from './store.js';
import { open as openMenu, close as closeMenu } from './menu.js';

/** Where the top bar's search turns into a sheet (shell.css, the 720px rules). */
export const SEARCH_QUERY = '(max-width: 720px)';

/** The DS.store namespace of everything the frame remembers. */
const NAMESPACE = 'shell';

const SCHEMES = new Set(['light', 'dark', 'auto']);

/**
 * The marker DS.dom.morphHtml never matches, moves or removes, on the parts
 * this module adds. Joined rather than quoted: every quoted data-ds-* name
 * of a component module leads a bundle to it (scripts/build.mjs,
 * moduleAttributes()), and a page's own kept node needs none of this.
 */
const KEEP = ['data', 'ds', 'keep'].join('-');

/**
 * Marks `node` with the attribute `name` or clears it. A mark is owned
 * state while it is set (DS.dom.own), so a re-render with DS.dom.morphHtml
 * keeps it; `claims` holds the marked nodes for the release.
 */
function marker(name) {
  const claims = new Set();
  const set = (node, on) => {
    node.toggleAttribute(name, on);
    if (on && !claims.has(node)) {
      own(node, 'attrs', name);
      claims.add(node);
    } else if (!on && claims.has(node)) {
      disown(node, 'attrs', name);
      claims.delete(node);
    }
  };
  /** Clears every mark, or only those of nodes that left `root`. */
  set.release = (root) => {
    for (const node of [...claims]) if (!root || !root.contains(node)) set(node, false);
  };
  return set;
}

/** Ids of the parts this module adds, numbered per page. */
const shared = runtime.state('shell', () => ({ seq: 0 }));

const viewOf = (node) => node?.ownerDocument?.defaultView ?? globalThis;

const media = (node, query) => {
  const view = viewOf(node);
  return typeof view.matchMedia === 'function' ? view.matchMedia(query) : null;
};

/** An id for `element`, its own when it has one. */
function idOf(element, prefix) {
  if (!element.id) element.id = `ds-${prefix}-${shared.seq += 1}`;
  return element.id;
}

/** A store handle, or null where storage is not wanted. */
const prefsOf = (remember) => (remember === false ? null : openStore(NAMESPACE));

/** A key of the store from an attribute value: what the page named, else the fallback. */
const keyOf = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

/**
 * A listener set for the controller shape: on(type, fn) hears ds:<type>
 * dispatched on `element` itself (the frame holds every component, so the
 * events of what is inside are not its own), with the detail.
 */
function listeners(element, signal) {
  const offs = new Set();
  return {
    on(type, fn) {
      const handler = (/** @type {CustomEvent} */ event) => { if (event.target === element) fn(event.detail); };
      element.addEventListener(`ds:${type}`, handler, signal ? { signal } : undefined);
      const off = () => { element.removeEventListener(`ds:${type}`, handler); offs.delete(off); };
      offs.add(off);
      return off;
    },
    clear() { for (const off of [...offs]) off(); },
  };
}

/* ── Text matching ──────────────────────────────────── */

/** Lower case, without accents, whitespace collapsed. */
function normalise(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Whether `text` holds every word of `query` (any case, without accents);
 * an empty query matches everything.
 * @param {string} text
 * @param {string} query
 * @returns {boolean}
 */
export function matchText(text, query) {
  const words = normalise(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const haystack = normalise(text);
  return words.every((word) => haystack.includes(word));
}

/* ── Frame ──────────────────────────────────────────── */

/**
 * The frame of `app` (a .ds-app): the menu button, the rail, the modal
 * drawer, the skip links and the drawer's pill, edges and the view's
 * data-scrolled. The controller that data-ds-shell makes.
 * @param {Element} app
 * @param {{ key?: string, rail?: boolean, remember?: boolean }} [options]
 */
export function create(app, options = {}) {
  return frame(app, options, null);
}

function frame(app, options, signal) {
  const doc = app.ownerDocument;
  const drawer = app.querySelector(':scope > .ds-drawer');
  const menu = app.querySelector(':scope > .ds-topbar .ds-topbar__menu');
  const view = app.querySelector(':scope > .ds-panel > .ds-view') ?? app.querySelector('.ds-view');
  const list = drawer?.querySelector('.ds-drawer__list') ?? null;
  const railable = options.rail !== false;
  const key = `rail:${keyOf(options.key, 'app')}`;
  const prefs = prefsOf(options.remember);
  const modal = media(app, DRAWER_QUERY);
  const events = listeners(app, signal);
  const abort = new AbortController();
  const on = { signal: abort.signal };

  if (drawer && menu) menu.setAttribute('aria-controls', idOf(drawer, 'drawer'));

  const rail = () => app.hasAttribute('data-drawer-collapsed');
  const isOpen = () => app.hasAttribute('data-drawer-open');

  /** The menu button says what it does at this width: a toggle above 900px, a disclosure below. */
  const sync = () => {
    if (!menu) return;
    if (modal?.matches) {
      menu.removeAttribute('aria-pressed');
      menu.setAttribute('aria-expanded', String(isOpen()));
    } else {
      menu.removeAttribute('aria-expanded');
      if (railable && drawer) menu.setAttribute('aria-pressed', String(rail()));
      else menu.removeAttribute('aria-pressed');
    }
  };

  const setRail = (value, remember) => {
    if (!railable || value === rail()) return;
    app.toggleAttribute('data-drawer-collapsed', value);
    // A filter in the drawer would hide items the rail cannot show it for.
    if (value && drawer) get(drawer, 'drawer')?.set({ query: '' });
    if (remember) prefs?.set(key, value);
    sync();
    emit(app, 'change', { rail: value });
  };

  const openDrawer = () => (drawer && modal?.matches ? openOverlay(drawer, { opener: menu ?? undefined }) : Promise.resolve());
  const closeDrawer = () => (drawer && isOpen() ? closeOverlay(drawer) : Promise.resolve());

  const stored = prefs?.get(key);
  if (railable && typeof stored === 'boolean') app.toggleAttribute('data-drawer-collapsed', stored);
  if (!railable) app.removeAttribute('data-drawer-collapsed');
  sync();

  menu?.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    if (event.defaultPrevented || !drawer) return;
    if (modal?.matches) {
      if (isOpen()) closeDrawer();
      else openDrawer();
    } else setRail(!rail(), true);
  }, on);

  app.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const target = /** @type {Element} */ (event.target);
    const skip = target?.closest?.('.ds-skip');
    if (skip && app.contains(skip)) {
      skipTo(skip, event);
      return;
    }
    // A choice in the modal drawer closes it; the page sets aria-current.
    const item = target?.closest?.('.ds-drawer__item');
    if (item && drawer?.contains(item) && isOpen() && item.getAttribute('aria-disabled') !== 'true') closeDrawer();
  }, on);

  /** A skip link: its target takes the focus; the modal drawer or a phone search sheet opens first. */
  const skipTo = (skip, event) => {
    const href = skip.getAttribute('href') ?? '';
    if (!href.startsWith('#') || href.length < 2) return;
    const target = doc.getElementById(decodeURIComponent(href.slice(1)));
    if (!target) return;
    event.preventDefault();
    if (drawer && (drawer === target || drawer.contains(target)) && modal?.matches) {
      openDrawer();
      return;
    }
    const sheet = target.closest('[data-ds-search-sheet]');
    if (sheet && media(sheet, SEARCH_QUERY)?.matches) {
      get(sheet, 'search-sheet')?.set(true);
      return;
    }
    const focusable = canTakeFocus(target) && (target.matches('a[href], button, input, select, textarea, summary') || target.hasAttribute('tabindex'));
    if (!focusable) target.setAttribute('tabindex', '-1');
    /** @type {HTMLElement} */ (target).focus();
  };

  const onMedia = () => sync();
  modal?.addEventListener('change', onMedia);
  // The drawer's own events (DS.overlay) keep aria-expanded in step; this keeps aria-pressed off meanwhile.
  drawer?.addEventListener('ds:close', (event) => { if (event.target === drawer) sync(); }, on);

  const handles = [];
  if (list) {
    handles.push(indicator(/** @type {HTMLElement} */ (list), { active: '[aria-current="page"]', className: 'ds-drawer__indicator', reveal: true }));
    handles.push(scrollEdges(list, { axis: 'block' }));
  }
  if (view) handles.push(watchScrolled(view, app));

  let alive = true;
  return {
    element: app,
    get: () => ({ rail: rail(), open: isOpen() }),
    set(value = {}) {
      if (!alive) return Promise.resolve();
      if (typeof value.rail === 'boolean') setRail(value.rail, true);
      if (value.open === true) return openDrawer();
      if (value.open === false) return closeDrawer();
      return Promise.resolve();
    },
    on: events.on,
    destroy() {
      if (!alive) return;
      alive = false;
      abort.abort();
      events.clear();
      modal?.removeEventListener('change', onMedia);
      for (const handle of handles) handle?.destroy?.();
      prefs?.destroy();
    },
  };
}

define('shell', {
  attribute: 'data-ds-shell',
  init(el, ctx) {
    return frame(el, {
      key: el.getAttribute('data-ds-shell') ?? '',
      rail: el.getAttribute('data-ds-shell-rail') !== 'off',
      remember: el.getAttribute('data-ds-shell-remember') !== 'off',
    }, ctx.signal);
  },
});

/* ── Drawer ─────────────────────────────────────────── */

/** The visible label of a drawer item or group heading. */
function labelOf(node) {
  if (!node) return '';
  const label = node.querySelector(':scope > .ds-drawer__label, :scope > span:not(.ds-drawer__count, .ds-badge, .ds-sr)');
  return (label ?? node).textContent ?? '';
}

/** The key a <details> group is remembered by: its id, data-ds-key, else its heading. */
function groupKey(group) {
  return group.id || group.getAttribute('data-ds-key') || normalise(labelOf(group.querySelector(':scope > summary')));
}

/** Ends the open or close motion of groups set on load, so nothing slides at the start. */
function settleNow(element) {
  for (const animation of element.getAnimations?.({ subtree: true }) ?? []) {
    try { animation.finish(); } catch { /* an infinite one is none of ours */ }
  }
}

/**
 * The drawer `nav` (a .ds-drawer): remembered groups, the filter, the
 * arrow keys. The controller that data-ds-drawer makes.
 * @param {Element} nav
 * @param {{ key?: string, remember?: boolean }} [options]
 */
export function drawer(nav, options = {}) {
  return navDrawer(nav, options, null);
}

function navDrawer(nav, options, signal) {
  const doc = nav.ownerDocument;
  const list = nav.querySelector('.ds-drawer__list') ?? nav;
  const field = /** @type {HTMLInputElement|null} */ (nav.querySelector('.ds-drawer__search input'));
  const prefs = prefsOf(options.remember);
  const key = `groups:${keyOf(options.key, nav.id || 'main')}`;
  const events = listeners(nav, signal);
  const abort = new AbortController();
  const on = { signal: abort.signal };
  /** The groups the filter opened, closed again when it is cleared. */
  const opened = new Set();
  let query = '';
  let count = 0;
  let timer = 0;

  const groups = () => [...nav.querySelectorAll('details.ds-drawer__group')];

  // Remembered groups, then the way to the current item open (it has the pill).
  const memory = prefs?.get(key, {}) ?? {};
  for (const group of groups()) {
    const value = memory[groupKey(group)];
    if (typeof value === 'boolean') /** @type {HTMLDetailsElement} */ (group).open = value;
  }
  for (let group = nav.querySelector('[aria-current="page"]')?.closest('details.ds-drawer__group'); group && nav.contains(group); group = group.parentElement?.closest('details.ds-drawer__group')) {
    /** @type {HTMLDetailsElement} */ (group).open = true;
  }
  settleNow(nav);

  nav.addEventListener('toggle', (event) => {
    const group = /** @type {HTMLDetailsElement} */ (event.target);
    if (!prefs || query || !group.matches?.('details.ds-drawer__group')) return;
    prefs.set(key, { ...prefs.get(key, {}), [groupKey(group)]: group.open });
  }, { ...on, capture: true });

  let empty = /** @type {HTMLElement|null} */ (list.querySelector(':scope > .ds-drawer__empty'));
  const emptyNote = () => {
    if (!empty) {
      empty = doc.createElement('p');
      empty.className = 'ds-drawer__empty';
      empty.setAttribute(KEEP, '');
      empty.textContent = t('noResults');
      list.append(empty);
    }
    return empty;
  };

  const mark = marker('data-ds-filtered');

  /** Filters the children of `container`; returns how many items show. `all`: a heading above matched. */
  const filterIn = (container, all) => {
    let shown = 0;
    for (const child of container.children) {
      if (child.matches('.ds-drawer__group')) {
        const heading = child.querySelector(':scope > .ds-drawer__heading');
        const headed = all || (Boolean(query) && Boolean(heading) && matchText(labelOf(heading), query));
        const inside = filterIn(child, headed);
        const show = !query || inside > 0 || headed;
        mark(child, !show);
        if (query && show && child.matches('details') && !/** @type {HTMLDetailsElement} */ (child).open) {
          /** @type {HTMLDetailsElement} */ (child).open = true;
          // Open for the query: a re-render keeps it so until the field is cleared.
          own(child, 'attrs', 'open');
          opened.add(child);
        }
        shown += show ? inside : 0;
      } else if (child.matches('.ds-drawer__item, .ds-drawer__row')) {
        const item = child.matches('.ds-drawer__row') ? child.querySelector('.ds-drawer__item') : child;
        const show = !query || all || matchText(labelOf(item), query);
        mark(child, !show);
        if (show) shown += 1;
      }
    }
    return shown;
  };

  /** Marks the items for the query as it stands: the filter, or a re-render of the list during one. */
  const apply = () => {
    count = filterIn(list, false);
    mark.release(list);
    if (!query) {
      for (const group of opened) {
        disown(group, 'attrs', 'open');
        /** @type {HTMLDetailsElement} */ (group).open = false;
      }
      opened.clear();
    }
    if (query && !count) {
      const note = emptyNote();
      mark(note, false);
    } else if (empty) mark(empty, true);
  };

  const filter = (value) => {
    const next = String(value ?? '');
    query = next.trim() ? next : '';
    apply();
    if (field && field.value !== next) field.value = next;
    emit(nav, 'filter', { query, count });
    // Spoken once the typing pauses, not at every key.
    clearTimeout(timer);
    if (!query) return;
    timer = setTimeout(() => {
      announce(count ? plural(count, { one: t('filterMatch'), other: t('filterMatches') }) : t('noResults'));
    }, motionDuration(nav, '--ds-delay-tooltip'));
  };

  field?.addEventListener('input', () => filter(field.value), on);

  // The page re-rendered the list during a filter (new items, other labels): they follow the query.
  const view = viewOf(nav);
  const changes = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {
    if (!query) return;
    const before = count;
    apply();
    if (count !== before) emit(nav, 'filter', { query, count });
  }) : null;
  changes?.observe(list, { childList: true, subtree: true, characterData: true });

  /** The items and group toggles the keys move between: shown, not filtered, not in a closed group. */
  const stops = () => [...nav.querySelectorAll('.ds-drawer__item, .ds-drawer__toggle')]
    .filter((node) => !node.closest('[data-ds-filtered]') && canTakeFocus(node));

  nav.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    const target = /** @type {Element} */ (event.target);
    if (field && target === field) {
      if (event.key === 'Escape' && field.value) {
        event.preventDefault();
        filter('');
      } else if (event.key === 'ArrowDown') {
        // The first match: an item of the list (not a group toggle around it, not the way back above it).
        const all = stops();
        const first = (query && all.find((node) => list.contains(node) && node.matches('.ds-drawer__item'))) || all.find((node) => list.contains(node)) || all[0];
        if (first) {
          event.preventDefault();
          /** @type {HTMLElement} */ (first).focus();
        }
      }
      return;
    }
    if (!target.matches?.('.ds-drawer__item, .ds-drawer__toggle')) return;
    const all = stops();
    const index = all.indexOf(target);
    if (index < 0) return;
    let next = null;
    if (event.key === 'ArrowDown') next = all[index + 1];
    else if (event.key === 'ArrowUp') next = all[index - 1] ?? (index === 0 ? field : null);
    else if (event.key === 'Home') next = all[0];
    else if (event.key === 'End') next = all.at(-1);
    if (!next || !canTakeFocus(next)) return;
    event.preventDefault();
    /** @type {HTMLElement} */ (next).focus();
  }, on);

  if (field?.value) filter(field.value);

  let alive = true;
  return {
    element: nav,
    get: () => ({ query, count, open: groups().filter((group) => /** @type {HTMLDetailsElement} */ (group).open).map(groupKey) }),
    set(value = {}) {
      if (!alive) return;
      if (typeof value.query === 'string') filter(value.query);
      if (value.open && typeof value.open === 'object') {
        for (const group of groups()) {
          const wanted = value.open[groupKey(group)];
          if (typeof wanted === 'boolean') /** @type {HTMLDetailsElement} */ (group).open = wanted;
        }
      }
    },
    on: events.on,
    destroy() {
      if (!alive) return;
      if (query) filter('');
      alive = false;
      clearTimeout(timer);
      changes?.disconnect();
      mark.release();
      abort.abort();
      events.clear();
      prefs?.destroy();
      empty?.remove();
    },
  };
}

define('drawer', {
  attribute: 'data-ds-drawer',
  init(el, ctx) {
    return navDrawer(el, { key: el.getAttribute('data-ds-drawer') ?? '', remember: el.getAttribute('data-ds-drawer-remember') !== 'off' }, ctx.signal);
  },
});

/* ── Search sheet ───────────────────────────────────── */

/**
 * What the sheet leaves inert: everything in the body but the `keep`
 * subtrees and their ancestors, the snackbar regions and the tooltips.
 */
function around(doc, keep) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (keep.includes(child)) continue;
      if (keep.some((element) => child.contains(element))) walk(child);
      else if (!child.matches('script, style, template, link, .ds-toasts, .ds-tooltip')) out.push(child);
    }
  };
  if (doc.body) walk(doc.body);
  return out;
}

/**
 * The top bar's search `el` (a .ds-topbar__search): a full-width sheet at
 * 720px and below. The controller that data-ds-search-sheet makes:
 * get() says whether the sheet is open, set(true|false) opens or closes it.
 * @param {Element} el
 * @param {{ opener?: Element|null }} [options]
 */
export function searchSheet(el, options = {}) {
  return sheet(el, options, null);
}

function sheet(el, options, signal) {
  const doc = el.ownerDocument;
  const phone = media(el, SEARCH_QUERY);
  const opener = options.opener ?? (el.closest('.ds-topbar') ?? doc).querySelector('.ds-topbar__search-open');
  const events = listeners(el, signal);
  const abort = new AbortController();
  const on = { signal: abort.signal };
  let still = /** @type {{ destroy: () => void }|null} */ (null);
  let locked = false;

  if (opener) {
    opener.setAttribute('aria-controls', idOf(el, 'search'));
    if (!opener.hasAttribute('aria-expanded')) opener.setAttribute('aria-expanded', 'false');
  }

  const isOpen = () => el.hasAttribute('data-state') && el.getAttribute('data-state') === 'open';
  const show = () => (phone?.matches ? openOverlay(el, { opener: opener ?? undefined }) : Promise.resolve());
  const hide = () => (el.hasAttribute('data-state') ? closeOverlay(el) : Promise.resolve());

  const engage = () => {
    if (still) return;
    still = inert(around(doc, [el, opener].filter(Boolean)));
    lockScroll(doc);
    locked = true;
    const input = /** @type {HTMLElement|null} */ (el.querySelector('input'));
    if (input && canTakeFocus(input)) input.focus({ preventScroll: true });
  };
  const release = () => {
    still?.destroy();
    still = null;
    if (locked) unlockScroll(doc);
    locked = false;
  };

  opener?.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    if (event.defaultPrevented) return;
    // Taken here, so a data-ds-open on the button does not toggle it a second time.
    event.preventDefault();
    if (isOpen()) hide();
    else show();
  }, on);
  el.addEventListener('ds:open', (event) => { if (event.target === el) engage(); }, on);
  el.addEventListener('ds:close', (event) => { if (event.target === el) release(); }, on);
  // Escape clears a filled field first (DS.overlay closes the sheet on the next one).
  el.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    const field = /** @type {HTMLInputElement} */ (event.target);
    if (event.key !== 'Escape' || !still || event.defaultPrevented || field.localName !== 'input' || !field.value) return;
    event.preventDefault();
    field.value = '';
    field.dispatchEvent(new (viewOf(el).Event)('input', { bubbles: true }));
  }, on);
  // Tab goes round inside the open sheet (the button behind it stays reachable for the focus return only).
  el.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Tab' || !still || event.defaultPrevented) return;
    const stops = tabbables(el);
    if (!stops.length) return;
    const active = doc.activeElement;
    const edge = event.shiftKey ? stops[0] : stops.at(-1);
    if (active !== edge) return;
    event.preventDefault();
    /** @type {HTMLElement} */ (event.shiftKey ? stops.at(-1) : stops[0]).focus();
  }, on);

  // Wider than a phone: the sheet goes, the search is back in the bar (DS.overlay hid it once it closed).
  const onMedia = () => {
    if (phone?.matches) return;
    const back = () => { if (!phone?.matches) /** @type {HTMLElement} */ (el).hidden = false; };
    if (el.hasAttribute('data-state')) hide().then(back);
    else back();
  };
  phone?.addEventListener('change', onMedia);

  let alive = true;
  return {
    element: el,
    get: isOpen,
    set: (value) => (value ? show() : hide()),
    on: events.on,
    destroy() {
      if (!alive) return;
      alive = false;
      abort.abort();
      events.clear();
      phone?.removeEventListener('change', onMedia);
      release();
    },
  };
}

define('search-sheet', {
  attribute: 'data-ds-search-sheet',
  init: (el, ctx) => sheet(el, {}, ctx.signal),
});

/* ── Launcher ───────────────────────────────────────── */

/**
 * The arrow keys of an app launcher `menu` (a .ds-menu.ds-launcher): Left
 * and Right along a row, Up and Down by a column, Home and End. The
 * controller that data-ds-launcher makes: get() is the current app.
 * @param {Element} menu
 */
export function launcher(menu) {
  return grid(menu, null);
}

function grid(menu, signal) {
  const events = listeners(menu, signal);
  const abort = new AbortController();
  const apps = () => [...menu.querySelectorAll('.ds-menu__item')].filter(canTakeFocus);
  /** How many apps sit in the first row, as laid out. */
  const columns = (items) => {
    const top = items[0]?.getBoundingClientRect().top ?? 0;
    const row = items.filter((item) => Math.abs(item.getBoundingClientRect().top - top) < 1).length;
    return Math.max(1, row);
  };
  menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const items = apps();
    const index = items.indexOf(/** @type {Element} */ (event.target)?.closest?.('.ds-menu__item'));
    if (index < 0) return;
    const across = columns(items);
    const rtl = viewOf(menu).getComputedStyle?.(menu).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: across, ArrowUp: -across }[event.key];
    let next = null;
    if (step !== undefined) next = items[index + step] ?? null;
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items.at(-1);
    else return;
    // The key is the grid's at its edges too, so the menu's own wrapping never takes over.
    event.preventDefault();
    if (next) /** @type {HTMLElement} */ (next).focus();
  }, { signal: abort.signal });
  let alive = true;
  return {
    element: menu,
    get: () => menu.querySelector('.ds-menu__item[aria-current]:not([aria-current="false"])'),
    set: (value) => (value ? openMenu(menu) : closeMenu(menu)),
    on: events.on,
    destroy() {
      if (!alive) return;
      alive = false;
      abort.abort();
      events.clear();
    },
  };
}

define('launcher', {
  attribute: 'data-ds-launcher',
  init: (el, ctx) => grid(el, ctx.signal),
});

/* ── Colour scheme ──────────────────────────────────── */

/** The .ds-theme a scheme applies to: `target` (an element or a selector), else the one around `from`, else the page's. */
function themeOf(from, target) {
  const doc = from?.ownerDocument ?? globalThis.document;
  if (target && typeof target === 'object') return target;
  if (typeof target === 'string' && target) return doc?.querySelector(target) ?? null;
  return from?.closest?.('.ds-theme') ?? doc?.querySelector('.ds-theme') ?? null;
}

/**
 * Applies the colour scheme `value` ('light', 'dark' or 'auto'):
 * data-ds-scheme on the theme (auto removes it, the system decides), the
 * media of a dark theme `link` (an element or a selector) and, unless
 * `remember` is false, the stored choice under `key` (default 'scheme'),
 * which every scheme switch follows. Returns the value applied, or null for
 * an unknown one.
 * @param {string} value
 * @param {{ target?: Element|string, link?: Element|string, key?: string, remember?: boolean }} [options]
 * @returns {string|null}
 */
export function setScheme(value, options = {}) {
  if (!SCHEMES.has(value)) return null;
  const theme = themeOf(null, options.target);
  if (theme) {
    if (value === 'auto') theme.removeAttribute('data-ds-scheme');
    else theme.setAttribute('data-ds-scheme', value);
  }
  const doc = theme?.ownerDocument ?? globalThis.document;
  const link = typeof options.link === 'string' ? doc?.querySelector(options.link) : options.link;
  if (link) link.setAttribute('media', value === 'dark' ? 'all' : value === 'light' ? 'not all' : '(prefers-color-scheme: dark)');
  if (options.remember !== false) {
    const prefs = openStore(NAMESPACE);
    prefs.set(keyOf(options.key, 'scheme'), value);
    prefs.destroy();
  }
  return value;
}

/**
 * A scheme switch `el`: its [data-ds-scheme-value] items choose light, dark
 * or auto. The controller that data-ds-scheme-switch makes.
 * @param {Element} el
 * @param {{ key?: string, target?: Element|string, link?: Element|string, remember?: boolean }} [options]
 */
export function schemeSwitch(el, options = {}) {
  return switcher(el, options, null);
}

function switcher(el, options, signal) {
  const key = keyOf(options.key, 'scheme');
  const prefs = prefsOf(options.remember);
  const events = listeners(el, signal);
  const abort = new AbortController();
  const theme = () => themeOf(el, options.target);
  const items = () => [...el.querySelectorAll('[data-ds-scheme-value]')];
  const current = () => {
    const pinned = theme()?.getAttribute('data-ds-scheme');
    return pinned === 'light' || pinned === 'dark' ? pinned : 'auto';
  };
  let value = current();

  /** The radio form (role="radio" items): one tab stop, arrows that move and choose (the APG radio group). */
  const radios = () => items().filter((item) => item.getAttribute('role') === 'radio' && !item.hidden && !item.matches(':disabled'));
  const check = () => {
    for (const item of items()) item.setAttribute('aria-checked', String(item.getAttribute('data-ds-scheme-value') === value));
    const set = radios();
    const stop = set.find((item) => item.getAttribute('aria-checked') === 'true') ?? set[0];
    for (const item of set) item.setAttribute('tabindex', item === stop ? '0' : '-1');
  };
  const apply = (next, remember) => {
    if (!SCHEMES.has(next)) return;
    const changed = next !== value;
    value = next;
    setScheme(next, { target: theme() ?? undefined, link: options.link, key, remember: remember && options.remember !== false });
    check();
    if (changed) emit(el, 'change', { value });
  };

  const stored = prefs?.get(key);
  if (SCHEMES.has(stored)) apply(stored, false);
  else check();

  el.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const item = /** @type {Element} */ (event.target)?.closest?.('[data-ds-scheme-value]');
    if (!item || !el.contains(item) || item.getAttribute('aria-disabled') === 'true') return;
    apply(item.getAttribute('data-ds-scheme-value') ?? '', true);
  }, { signal: abort.signal });
  el.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const set = radios();
    const item = set.find((each) => each === event.target);
    if (!item) return;
    // A radio that is no button chooses on Space itself (a button's click does it).
    if (event.key === ' ' && item.localName !== 'button') {
      event.preventDefault();
      item.click();
      return;
    }
    const rtl = viewOf(el).getComputedStyle?.(el).direction === 'rtl';
    const step = { ArrowDown: 1, ArrowUp: -1, ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const usable = set.filter((each) => each === item || each.getAttribute('aria-disabled') !== 'true');
    const next = usable[(usable.indexOf(item) + step + usable.length) % usable.length];
    if (!next || next === item) return;
    next.focus();
    apply(next.getAttribute('data-ds-scheme-value') ?? '', true);
  }, { signal: abort.signal });
  // Another switch, setScheme() or another tab chose.
  const off = prefs?.on('change', (detail) => {
    if (detail.key === key && SCHEMES.has(detail.value) && detail.value !== value) apply(detail.value, false);
  });
  // The page pinned the theme itself (data-ds-scheme): the checks follow, nothing is stored.
  const view = viewOf(el);
  const watch = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {
    const now = current();
    if (now === value) return;
    value = now;
    check();
    emit(el, 'change', { value });
  }) : null;
  const watched = theme();
  if (watched) watch?.observe(watched, { attributes: true, attributeFilter: ['data-ds-scheme'] });

  let alive = true;
  return {
    element: el,
    get: () => value,
    set: (next) => apply(next, true),
    on: events.on,
    destroy() {
      if (!alive) return;
      alive = false;
      abort.abort();
      events.clear();
      off?.();
      watch?.disconnect();
      prefs?.destroy();
    },
  };
}

define('scheme-switch', {
  attribute: 'data-ds-scheme-switch',
  init(el, ctx) {
    return switcher(el, {
      key: el.getAttribute('data-ds-scheme-switch') ?? '',
      target: el.getAttribute('data-ds-scheme-switch-target') ?? undefined,
      link: el.getAttribute('data-ds-scheme-switch-link') ?? undefined,
      remember: el.getAttribute('data-ds-scheme-switch-remember') !== 'off',
    }, ctx.signal);
  },
});

/* ── Breadcrumbs ────────────────────────────────────── */

/**
 * Which crumbs to fold into the menu so the trail fits: `widths` are the
 * crumbs' natural widths (the last is the current page and never folds),
 * `room` the width there is, `more` the width of the "more" button. The
 * middle goes first, from the start, then the first crumb, then the
 * parent. Returns the folded indexes in order; empty when all fit.
 * @param {number[]} widths
 * @param {number} room
 * @param {number} more
 * @returns {number[]}
 */
export function fitCrumbs(widths, room, more) {
  const n = widths.length;
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (n < 2 || total <= room) return [];
  const order = [];
  for (let i = 1; i < n - 2; i += 1) order.push(i);
  order.push(0);
  if (n > 2) order.push(n - 2);
  const folded = [];
  let width = total + more;
  for (const index of order) {
    if (width <= room) break;
    folded.push(index);
    width -= widths[index];
  }
  return folded.sort((a, b) => a - b);
}

/**
 * Breadcrumbs `nav` (a .ds-breadcrumbs): folds the crumbs that do not fit
 * into a menu behind a "more" button. The controller that
 * data-ds-breadcrumbs makes: get() lists the folded crumbs, set() measures
 * again.
 * @param {Element} nav
 */
export function breadcrumbs(nav) {
  return trail(nav, null);
}

function trail(nav, signal) {
  const doc = nav.ownerDocument;
  const view = viewOf(nav);
  const ol = nav.querySelector('ol');
  const events = listeners(nav, signal);
  const abort = new AbortController();
  if (!ol) return { element: nav, get: () => [], set() {}, on: events.on, destroy() { events.clear(); } };

  // The "more" crumb: a quiet icon button and the menu of what is folded.
  const more = doc.createElement('li');
  more.className = 'ds-breadcrumbs__more';
  more.setAttribute(KEEP, '');
  const collapse = marker('data-ds-collapsed');
  collapse(more, true);
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-xs';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.append(iconElement(moreHorizontal, 20, '', doc));
  const menu = doc.createElement('div');
  menu.className = 'ds-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  // Next to the nav, not in it: page.css styles every link of the trail.
  menu.setAttribute(KEEP, '');
  button.setAttribute('aria-controls', idOf(menu, 'crumbs'));
  more.append(button);
  nav.after(menu);

  const crumbs = () => [...ol.children].filter((li) => li !== more && li.localName === 'li');
  let folded = /** @type {Element[]} */ ([]);

  /** The menu lists the folded crumbs, in their order, as links. */
  const fill = () => {
    const rows = folded.map((li) => {
      const link = li.querySelector('a[href]');
      const row = doc.createElement('a');
      row.className = 'ds-menu__item';
      row.setAttribute('role', 'menuitem');
      row.href = link?.getAttribute('href') ?? '#';
      const label = doc.createElement('span');
      label.className = 'ds-menu__label';
      label.textContent = (link ?? li).textContent?.trim() ?? '';
      row.append(label);
      return row;
    });
    menu.replaceChildren(...rows);
    const label = t('breadcrumbsMore', { count: folded.length });
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tip', label);
    menu.setAttribute('aria-label', label);
  };

  const measure = () => {
    if (!nav.isConnected) return;
    const list = crumbs();
    if (more.parentNode !== ol || more.previousElementSibling !== (list[0] ?? null)) list[0]?.after(more);
    for (const li of list) collapse(li, false);
    collapse.release(ol);
    collapse(more, false);
    // Natural widths: the list as wide as its content for one measure.
    ol.style.setProperty('inline-size', 'max-content');
    const widths = list.map((li) => li.getBoundingClientRect().width);
    const moreWidth = more.getBoundingClientRect().width;
    ol.style.removeProperty('inline-size');
    const room = nav.getBoundingClientRect().width;
    const hide = fitCrumbs(widths, room, moreWidth);
    const next = hide.map((index) => list[index]);
    for (const li of next) collapse(li, true);
    if (!next.length) {
      collapse(more, true);
      if (button.getAttribute('aria-expanded') === 'true') closeMenu(menu);
    }
    const changed = next.length !== folded.length || next.some((li, i) => li !== folded[i]);
    folded = next;
    if (changed) {
      fill();
      emit(nav, 'change', { folded: folded.length });
    }
  };

  let pending = 0;
  const schedule = () => {
    if (pending) return;
    const run = () => { pending = 0; measure(); };
    pending = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(run) : 0;
    if (!pending) run();
  };

  button.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    if (event.detail > 1) return;
    if (button.getAttribute('aria-expanded') === 'true') closeMenu(menu);
    else openMenu(menu, { opener: button });
  }, { signal: abort.signal });
  button.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openMenu(menu, { opener: button });
  }, { signal: abort.signal });

  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(schedule) : null;
  resize?.observe(nav);
  if (!resize) view.addEventListener?.('resize', schedule, { signal: abort.signal });
  // The page changed the trail (crumbs, their text): fold again.
  const changes = typeof view.MutationObserver === 'function' ? new view.MutationObserver(schedule) : null;
  changes?.observe(ol, { childList: true, subtree: true, characterData: true });
  // Text of the system's own changed (another language).
  doc.addEventListener('ds:config', () => { if (folded.length) fill(); }, { signal: abort.signal });
  measure();

  let alive = true;
  return {
    element: nav,
    get: () => [...folded],
    set: () => measure(),
    on: events.on,
    destroy() {
      if (!alive) return;
      alive = false;
      abort.abort();
      events.clear();
      resize?.disconnect();
      changes?.disconnect();
      if (pending) view.cancelAnimationFrame?.(pending);
      collapse.release();
      more.remove();
      if (button.getAttribute('aria-expanded') === 'true') closeMenu(menu).then(() => menu.remove());
      else menu.remove();
    },
  };
}

define('breadcrumbs', {
  attribute: 'data-ds-breadcrumbs',
  init: (el, ctx) => trail(el, ctx.signal),
});
