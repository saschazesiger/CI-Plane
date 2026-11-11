/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The behaviour of a menu (DS.menu): what only a menu does once DS.overlay
 * opened it (the stack, focus return, Escape, a pointerdown outside and the
 * placement stay in the core, js/overlay.js).
 *
 *   <button aria-haspopup="menu" aria-expanded="false" data-ds-open="#row-menu">...</button>
 *   <div class="ds-menu" id="row-menu" role="menu" hidden>...</div>
 *
 *   DS.menu.open(menu, { opener });   DS.menu.close(menu);   // DS.overlay.open and close
 *   DS.menu.openAt(menu, { x, y, opener })                    // a context menu at a point
 *   DS.menu.create(menu)              // get(), set(), on(), destroy()
 *
 * It focuses its first enabled item (the last one when an ArrowUp keydown
 * opened it), moves focus with ArrowUp, ArrowDown, Home and End (wrapping), to
 * the next item whose label starts with the typed letters (type-ahead; the
 * letters reset after --ds-delay-tooltip) and closes a task after an item's
 * click, once the item's handlers ran. Tab closes it and moves on from its
 * trigger. A menu the script placed follows its trigger through scrolling and
 * resizing. data-ds-menu-checks on the menu: the system flips its check items
 * (a menuitemcheckbox toggles, a menuitemradio takes its group's one check)
 * once the item's own handlers ran and sends ds:change ({ item, checked });
 * without it the page flips aria-checked itself, as in 2.x.
 *
 * Submenus (3.0): an item with aria-haspopup="menu" and aria-controls naming
 * a .ds-menu (inside this menu, right after the item) opens it beside itself,
 * in the top layer at --ds-menu-x/-y (towards the end, flipped towards the
 * start without room, its first item level with the item): on ArrowRight,
 * Enter or Space (focus on its first item), on a click, and when a mouse or
 * pen rests on the item for --ds-delay-submenu (focus stays). ArrowLeft
 * and Escape close it onto its item; a pointer that moves to another item
 * closes it after --ds-delay-submenu-close unless it reaches the submenu
 * first (hover intent: a diagonal path across other items keeps it). An item
 * chosen in a submenu closes the whole chain, and Tab too; a menu that closes
 * closes its open submenus.
 *
 * Search (3.0): a menu with a .ds-menu__search (an input type="search";
 * the .ds-menu is then a plain container and its items sit in a
 * .ds-menu__list with role="menu", since a menu owns only items) focuses it
 * on opening; typing filters the items by label and description
 * (hiding the groups, headings and dividers left empty, showing
 * .ds-menu__empty with the string noResults, which is also announced);
 * ArrowDown and ArrowUp move between the field and the items, Enter chooses
 * the first match, a letter typed on an item goes on in the field, and the
 * first Escape clears a filled field (DS.overlay).
 *
 * Context menus (3.0): [data-ds-contextmenu="<selector or id>"] on a row, a
 * tile or a region opens that menu at the pointer on a right click, at the
 * press after a long touch (--ds-delay-long-press, cancelled by a move past
 * 10px; the click and the native menu it would end in never happen), and
 * below the focused element on Shift+F10 or the ContextMenu key. The element
 * gets ds:contextmenu first ({ menu, x, y }, cancelable: preventDefault()
 * keeps the browser's own menu), so the page can fit the items to it; it is
 * the opener (focus goes back to it), and it gets no aria-expanded.
 *
 * Timing comes from the computed tokens (motionDuration); ES2022; no
 * progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { motionDuration, originFrom, settled } from './motion.js';
import { computePlacement, place, pxOf, releaseAnchor, round, viewportBounds } from './position.js';
import { announce } from './a11y.js';
import { internals, open as openOverlay, close as closeOverlay, typeAhead } from './overlay.js';

const { overlays, stack, viewOf, canFocus, activeIn, inside, closeFrom, arrowTarget, placeMenu, controllerOf, clock, topOpen, flushStyle, own, disown, composedContains } = internals;

/** The items of a menu that take focus (aria-disabled ones too: their name is read), not those of its submenus. */
function menuItems(menu) {
  return [...menu.querySelectorAll('.ds-menu__item')].filter((item) => item.closest('.ds-menu') === menu && canFocus(item));
}

const enabled = (item) => item.getAttribute('aria-disabled') !== 'true';

/** The first enabled item of a menu. */
function firstItem(menu) {
  return menuItems(menu).find(enabled) ?? null;
}

/** A menu's own search field, if it has one. */
function searchOf(menu) {
  const field = menu.querySelector('.ds-menu__search input');
  return field && field.closest('.ds-menu') === menu ? /** @type {HTMLInputElement} */ (field) : null;
}

/** The submenu an item opens: aria-haspopup="menu" (or true) and aria-controls naming a .ds-menu. */
function subOf(item) {
  const popup = item?.getAttribute?.('aria-haspopup');
  if (popup !== 'menu' && popup !== 'true') return null;
  const id = item.getAttribute('aria-controls');
  if (!id) return null;
  const scope = item.getRootNode?.() ?? item.ownerDocument;
  const sub = scope.getElementById?.(id) ?? item.ownerDocument.getElementById(id);
  return sub?.matches('.ds-menu') ? sub : null;
}

/**
 * Menus this module places itself: a submenu (beside its item) or a context
 * menu (at a point). DS.overlay placed them under their opener first; the
 * entrance is played again from here.
 * @type {WeakMap<Element, { kind: 'sub'|'point', anchor: Element|{ x: number, y: number } }>}
 */
const custom = new WeakMap();

/** The opener of an open context menu that had no aria-expanded of its own (a row, a tile). @type {WeakMap<Element, Element>} */
const unexpanded = new WeakMap();

/** How the next open of a menu focuses: 'first' (default), 'last' or 'none' (a submenu opened by hover). */
const focusMode = new WeakMap();

/** The menu an item or a menu is in, through its opener: the root of a chain of submenus. */
function rootOf(menu) {
  let at = menu;
  for (let guard = 0; guard < 16; guard += 1) {
    const opener = overlays.get(at)?.opener;
    const parent = opener?.closest?.('.ds-menu');
    if (!parent || !custom.has(at) || custom.get(at)?.kind !== 'sub') return at;
    at = parent;
  }
  return at;
}

const isOpen = (element) => overlays.get(element)?.phase === 'open';

/** The open submenus opened from items of `menu`. */
const openSubsOf = (menu) => stack.filter((other) => custom.get(other)?.kind === 'sub' && isOpen(other) && overlays.get(other)?.opener?.closest?.('.ds-menu') === menu);

const isTop = (element) => {
  try {
    return element.matches(':popover-open');
  } catch {
    return false;
  }
};

/**
 * place() of position.js for a point: the same geometry (computePlacement)
 * and the same writes (the cap, data-placement), with the page's direction.
 */
function placeAtPoint(menu, point, options) {
  const style = /** @type {HTMLElement} */ (menu).style;
  style.removeProperty('max-height');
  const size = { width: /** @type {HTMLElement} */ (menu).offsetWidth, height: /** @type {HTMLElement} */ (menu).offsetHeight };
  const rtl = viewOf(menu).getComputedStyle?.(menu).direction === 'rtl';
  const result = computePlacement({ left: point.x, right: point.x, top: point.y, bottom: point.y }, size, viewportBounds(menu), { ...options, rtl });
  if (size.height > result.room) style.setProperty('max-height', `${round(result.room)}px`);
  if (result.side === 'bottom') menu.removeAttribute('data-placement');
  else menu.setAttribute('data-placement', result.side);
  return result;
}

/**
 * Places a submenu beside its item or a context menu at its point, in the
 * top layer at --ds-menu-x/-y (the viewport's terms): out of the anchored
 * path DS.overlay may have taken (its anchor-name goes), into the top layer
 * where the script placed it (a submenu inside its parent menu would be cut
 * by the parent's clip and scroll).
 */
function placeCustom(menu) {
  const how = custom.get(menu);
  if (!how) return;
  const style = /** @type {HTMLElement} */ (menu).style;
  if (menu.hasAttribute('data-anchored')) {
    menu.removeAttribute('data-anchored');
    style.removeProperty('position-anchor');
    const state = overlays.get(menu);
    if (state?.anchor) {
      releaseAnchor(state.anchor);
      state.anchor = null;
    }
  }
  if (!isTop(menu) && typeof /** @type {any} */ (menu).showPopover === 'function') {
    menu.setAttribute('popover', 'manual');
    try {
      /** @type {HTMLElement} */ (menu).showPopover();
    } catch {
      // The engine refused: it stays a fixed box.
    }
  }
  const padding = pxOf(menu, '--ds-space-2', 8);
  const result = how.kind === 'sub'
    ? place(/** @type {HTMLElement} */ (menu), /** @type {Element} */ (how.anchor), { side: 'end', align: 'start', offset: 0, padding, flip: 'room', size: false })
    : placeAtPoint(menu, /** @type {{ x: number, y: number }} */ (how.anchor), { side: 'bottom', align: 'start', offset: 0, padding, flip: 'room', crossFlip: true });
  if (!result) return;
  // A submenu's first item lines up with its item: up by the menu's own block padding.
  const lift = how.kind === 'sub' ? parseFloat(viewOf(menu).getComputedStyle(menu).paddingTop) || 0 : 0;
  const height = /** @type {HTMLElement} */ (menu).offsetHeight;
  const bottom = (menu.ownerDocument.documentElement.clientHeight || viewOf(menu).innerHeight) - padding;
  const y = Math.max(padding, Math.min(result.y - lift, bottom - height));
  style.setProperty('--ds-menu-x', `${round(result.x)}px`);
  style.setProperty('--ds-menu-y', `${round(y)}px`);
  if (result.side === 'bottom') menu.removeAttribute('data-placement');
}

/**
 * Plays a custom menu's entrance again at its own place: the closed state
 * at rest size without a transition, placed, the origin at its item or
 * point, then open (all before the next frame, so nothing shows in
 * between).
 */
function enterCustom(menu) {
  const how = custom.get(menu);
  if (!how) return;
  const style = /** @type {HTMLElement} */ (menu).style;
  style.setProperty('transition', 'none');
  style.setProperty('scale', 'none');
  menu.setAttribute('data-state', 'closed');
  placeCustom(menu);
  originFrom(how.kind === 'sub' ? /** @type {Element} */ (how.anchor) : how.anchor, menu);
  style.removeProperty('scale');
  flushStyle(menu);
  style.removeProperty('transition');
  menu.setAttribute('data-state', 'open');
}

/** Documents with the Tab and follow listeners. */
const listening = new WeakSet();

/** Tab out of a menu, and following its trigger: one set of listeners per document, from the first menu on. */
function listen(doc) {
  if (listening.has(doc)) return;
  listening.add(doc);
  doc.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Tab' || event.isComposing || event.defaultPrevented) return;
    const top = topOpen();
    if (!top || overlays.get(top)?.kind !== 'menu' || !top.contains(activeIn(top))) return;
    // Tab moves on from the trigger of the whole chain, as if the menus had not been there.
    const root = rootOf(top);
    const opener = overlays.get(root)?.opener;
    if (canFocus(opener)) opener.focus({ preventScroll: true });
    closeChain(top, 'tab');
  }, true);
  // A context menu closes on a press anywhere outside it, its own row too
  // (DS.overlay keeps a menu open for a press on its opener, the trigger
  // that toggles it).
  doc.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
    for (const element of [...stack].reverse()) {
      if (custom.get(element)?.kind !== 'point' || !isOpen(element) || inside(element, event)) continue;
      if (stack.slice(stack.indexOf(element) + 1).some((other) => isOpen(other) && inside(other, event))) continue;
      closeFrom(element, 'outside');
    }
  }, true);
  // A menu that closes takes its open submenus with it; a context menu's
  // row says nothing about being expanded; once the close settled, the menu
  // is placed by DS.overlay again.
  doc.addEventListener('ds:close', (event) => {
    const menu = /** @type {Element} */ (event.target);
    if (!menu?.matches?.('.ds-menu')) return;
    for (const sub of openSubsOf(menu)) closeFrom(sub, 'parent');
    const row = unexpanded.get(menu);
    if (row) {
      unexpanded.delete(menu);
      row.removeAttribute('aria-expanded');
    }
    const state = overlays.get(menu);
    state?.closing?.then(() => {
      if (state.phase === 'closed') custom.delete(menu);
    });
  });
  // A menu the script placed follows its trigger through scrolling and
  // resizing, within one frame (an anchored one follows by itself).
  const view = doc.defaultView ?? globalThis;
  let frame = 0;
  const follow = (/** @type {Event} */ event) => {
    // A menu's own scroll moves nothing it is placed by, and placing it
    // again (its cap lifted to measure) would clamp that scroll.
    if (event?.type === 'scroll' && /** @type {Element} */ (event.target)?.closest?.('.ds-menu')) return;
    if (frame || !stack.some((element) => overlays.get(element)?.kind === 'menu')) return;
    const run = () => {
      frame = 0;
      for (const element of stack) {
        const state = overlays.get(element);
        if (state?.kind !== 'menu' || state.phase === 'closed') continue;
        // A context menu stays at its point; a submenu goes with its item.
        if (custom.has(element)) {
          if (custom.get(element)?.kind === 'sub') placeCustom(element);
        } else if (!element.hasAttribute('data-anchored')) placeMenu(element, state.opener);
      }
    };
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(run) : 0;
    if (!frame) run();
  };
  doc.addEventListener('scroll', follow, { capture: true, passive: true });
  view.addEventListener?.('resize', follow);
}

/**
 * Closes `menu` and every menu above it in its chain up to the root: the
 * innermost first, so focus steps back through the items to the root's
 * trigger.
 */
function closeChain(menu, cause) {
  const chain = [];
  for (let at = menu; at; ) {
    chain.push(at);
    const how = custom.get(at);
    const opener = overlays.get(at)?.opener;
    at = how?.kind === 'sub' ? opener?.closest?.('.ds-menu') ?? null : null;
    if (chain.length > 16) break;
  }
  for (const element of chain) closeFrom(element, cause);
}

/** The check items: only on a menu that asked for it (data-ds-menu-checks), since a 2.x page flips them itself. */
function flipCheck(menu, item) {
  if (!menu.hasAttribute('data-ds-menu-checks')) return;
  const role = item.getAttribute('role');
  if (role !== 'menuitemcheckbox' && role !== 'menuitemradio') return;
  const was = item.getAttribute('aria-checked') === 'true';
  // The radio that is already the one: nothing changed, so nothing to tell.
  if (role === 'menuitemradio' && was) return;
  const checked = role === 'menuitemradio' || !was;
  if (role === 'menuitemradio') {
    const group = item.closest('[role="group"]') ?? menu;
    for (const other of group.querySelectorAll('[role="menuitemradio"]')) {
      if (other.closest('.ds-menu') === menu) other.setAttribute('aria-checked', 'false');
    }
  }
  item.setAttribute('aria-checked', String(checked));
  emit(menu, 'change', { item, checked });
}

/**
 * Opens the submenu of `item` beside it. `mode`: 'first' moves focus to its
 * first item (the keys, a click from the keyboard), 'none' leaves it (hover,
 * a pointer click). Any other submenu of the same menu closes.
 */
function openSub(item, mode) {
  const sub = subOf(item);
  const menu = item.closest('.ds-menu');
  if (!sub || !menu || !enabled(item)) return;
  for (const other of openSubsOf(menu)) if (other !== sub) closeFrom(other, 'parent');
  if (isOpen(sub) && overlays.get(sub)?.opener === item) {
    if (mode === 'first') firstItem(sub)?.focus({ preventScroll: true });
    return;
  }
  // Taken back mid-exit by its own item: it turns back from where it is.
  const reverse = overlays.get(sub)?.phase === 'closing' && overlays.get(sub)?.opener === item && custom.get(sub)?.anchor === item;
  custom.set(sub, { kind: 'sub', anchor: item });
  focusMode.set(sub, mode);
  openOverlay(sub, { opener: item });
  if (!reverse) enterCustom(sub);
  // A parent opened a moment ago is still growing, so its item's box is
  // scaled: once the parent rests, the submenu goes beside the item's
  // final box (a few pixels; it is still entering itself).
  if (menu.getAnimations?.().some((animation) => animation.playState === 'running')) {
    settled(menu, { transitions: true }).then(() => {
      if (custom.get(sub)?.anchor === item && isOpen(sub)) placeCustom(sub);
    });
  }
}

/** Search: hides what does not match `query`, shows the empty row when nothing does. */
function filter(menu, query) {
  const text = query.replace(/\s+/g, ' ').trim().toLowerCase();
  let shown = 0;
  for (const item of menu.querySelectorAll('.ds-menu__item')) {
    if (item.closest('.ds-menu') !== menu) continue;
    const words = (item.querySelector('.ds-menu__content') ?? item.querySelector('.ds-menu__label') ?? item).textContent.replace(/\s+/g, ' ').toLowerCase();
    const match = !text || words.includes(text);
    setHidden(item, !match);
    if (match) shown += 1;
  }
  for (const group of menu.querySelectorAll('[role="group"]')) {
    if (group.closest('.ds-menu') !== menu) continue;
    const any = [...group.querySelectorAll('.ds-menu__item')].some((item) => !item.hidden);
    setHidden(group, !any);
  }
  for (const divider of menu.querySelectorAll('.ds-menu__divider')) {
    if (divider.closest('.ds-menu') === menu) setHidden(divider, Boolean(text));
  }
  let empty = menu.querySelector('.ds-menu__empty');
  if (!shown && !empty) {
    empty = menu.ownerDocument.createElement('p');
    empty.className = 'ds-menu__empty';
    empty.setAttribute('role', 'none');
    // A runtime node: a re-render of the menu (DS.dom.morphHtml) keeps it.
    empty.setAttribute('data-ds-keep', '');
    menu.append(empty);
  }
  if (empty) {
    if (!shown) empty.textContent = t('noResults');
    setHidden(empty, shown > 0);
  }
  if (!shown && text) {
    try {
      announce(t('noResults'));
    } catch {
      // A bundle without the snackbar module has no announcer: the row says it.
    }
  }
}

/** `hidden` that the search writes, owned while it holds (a live re-render keeps it). */
function setHidden(node, value) {
  if (node.hidden === value) return;
  node.hidden = value;
  if (value) own(node, 'attrs', 'hidden');
  else disown(node, 'attrs', 'hidden');
}

/** The key that goes towards a submenu, and the one that leaves it: ArrowRight and ArrowLeft, mirrored right to left. */
function sideKeys(menu) {
  const rtl = viewOf(menu).getComputedStyle?.(menu).direction === 'rtl';
  return rtl ? { into: 'ArrowLeft', out: 'ArrowRight' } : { into: 'ArrowRight', out: 'ArrowLeft' };
}

/** The pointer's hover intent over a menu's items, for its submenus. */
function hoverIntent(menu) {
  let openTimer = /** @type {any} */ (0);
  let closeTimer = /** @type {any} */ (0);
  let pending = /** @type {Element|null} */ (null);
  const time = (token) => motionDuration(menu, token);
  const cancelOpen = () => {
    clearTimeout(openTimer);
    openTimer = 0;
    pending = null;
  };
  const cancelClose = () => {
    clearTimeout(closeTimer);
    closeTimer = 0;
  };
  menu.addEventListener('pointerover', (/** @type {PointerEvent} */ event) => {
    if (event.pointerType === 'touch' || !isOpen(menu)) return;
    const target = /** @type {Element} */ (event.target);
    // Back inside an open submenu of this menu: it stays.
    if (openSubsOf(menu).some((sub) => sub.contains(target))) {
      cancelClose();
      cancelOpen();
      return;
    }
    if (target.closest?.('.ds-menu') !== menu) return;
    const item = target.closest('.ds-menu__item');
    if (!item || item === pending) return;
    cancelOpen();
    const sub = subOf(item);
    const others = openSubsOf(menu).filter((other) => other !== sub);
    // Another item: the open submenu goes after the grace, unless the pointer reaches it first.
    if (others.length && !closeTimer) {
      closeTimer = setTimeout(() => {
        closeTimer = 0;
        for (const other of openSubsOf(menu)) if (overlays.get(other)?.opener !== pending && overlays.get(other)?.opener !== item) closeFrom(other, 'parent');
      }, time('--ds-delay-submenu-close'));
    }
    if (sub && enabled(item) && !(isOpen(sub) && overlays.get(sub)?.opener === item)) {
      pending = item;
      openTimer = setTimeout(() => {
        openTimer = 0;
        pending = null;
        if (!isOpen(menu)) return;
        cancelClose();
        openSub(item, 'none');
      }, time('--ds-delay-submenu'));
    } else if (sub) cancelClose();
  });
  menu.addEventListener('pointerleave', () => cancelOpen());
  // A click or a key decides first: a hover open still pending would
  // otherwise reopen a submenu that an Escape right after the click closes.
  menu.addEventListener('click', () => cancelOpen(), true);
  menu.addEventListener('keydown', () => cancelOpen(), true);
}

/**
 * A menu's own keys and items: ArrowUp, ArrowDown, Home and End move focus
 * (wrapping); an item's click closes the menu once its handlers ran (a
 * task later, so a handler further up the tree still sees it open).
 */
function wireMenu(menu) {
  // Type-ahead: the letters typed within --ds-delay-tooltip of each other.
  let typed = '';
  let typedAt = 0;
  menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const target = /** @type {Element} */ (event.target);
    // A key of a submenu inside this one belongs to that menu.
    if (target?.closest?.('.ds-menu') !== menu) return;
    const items = menuItems(menu);
    const search = searchOf(menu);
    const keys = sideKeys(menu);
    const item = target.closest?.('.ds-menu__item');
    if (search && target === search) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        (event.key === 'ArrowDown' ? items[0] : items.at(-1))?.focus();
      } else if (event.key === 'Enter') {
        const first = items.find(enabled);
        if (!first) return;
        event.preventDefault();
        /** @type {HTMLElement} */ (first).click();
      }
      return;
    }
    // Into a submenu, and out of one.
    if (item && event.key === keys.into && subOf(item)) {
      event.preventDefault();
      openSub(item, 'first');
      return;
    }
    if (event.key === keys.out && custom.get(menu)?.kind === 'sub') {
      event.preventDefault();
      closeOverlay(menu, { reason: 'collapse' });
      return;
    }
    // With a search, the field is one more stop above the first item.
    if (search && ((event.key === 'ArrowUp' && item === items[0]) || (event.key === 'ArrowDown' && item === items.at(-1)))) {
      event.preventDefault();
      search.focus();
      return;
    }
    const next = arrowTarget(items, event);
    if (next) {
      typed = '';
      event.preventDefault();
      next.focus();
      return;
    }
    // A printable key; a space only within a word (alone it activates the item).
    if (event.key.length !== 1 || (event.key === ' ' && !typed)) return;
    if (search) {
      // Typing on an item goes on in the search field.
      event.preventDefault();
      search.focus();
      search.value += event.key;
      search.dispatchEvent(new (viewOf(menu).Event)('input', { bubbles: true }));
      return;
    }
    const now = clock();
    if (now - typedAt > motionDuration(menu, '--ds-delay-tooltip')) typed = '';
    typedAt = now;
    typed += event.key.toLowerCase();
    const match = typeAhead(items, item, typed);
    if (!match) return;
    event.preventDefault();
    match.focus();
  });
  menu.addEventListener('input', (event) => {
    const search = searchOf(menu);
    if (search && event.target === search) filter(menu, search.value);
  });
  menu.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const item = /** @type {Element} */ (event.target)?.closest?.('.ds-menu__item');
    if (!item || item.closest('.ds-menu') !== menu || !enabled(item) || /** @type {any} */ (item).disabled) return;
    const state = overlays.get(menu);
    if (state?.phase !== 'open') return;
    // An item that opens a submenu opens it, and the menu stays.
    if (subOf(item)) {
      openSub(item, event.detail === 0 ? 'first' : 'none');
      return;
    }
    const gen = state.gen;
    flipCheck(menu, item);
    setTimeout(() => {
      if (state.gen === gen && state.phase === 'open') closeChain(menu, 'item');
    });
  });
  hoverIntent(menu);
}

/** Focus when it opens: from an ArrowUp keydown (the trigger's handler is running) the last item, as in a native menu. */
function focusInto(menu) {
  const mode = focusMode.get(menu);
  focusMode.delete(menu);
  const search = searchOf(menu);
  if (search) {
    if (search.value) {
      search.value = '';
      filter(menu, '');
    }
    if (mode !== 'none') search.focus({ preventScroll: true });
    return;
  }
  if (mode === 'none') return;
  const event = /** @type {any} */ (viewOf(menu)).event;
  const last = mode === 'last' || (event?.type === 'keydown' && event.key === 'ArrowUp');
  (last ? menuItems(menu).filter(enabled).at(-1) : firstItem(menu))?.focus({ preventScroll: true });
}

/**
 * Opens a menu: DS.overlay.open().
 * @param {Element} element
 * @param {{ opener?: Element|null, returnTo?: () => Element|null|undefined }} [options]
 * @returns {Promise<void>}
 */
export function open(element, options = {}) {
  custom.delete(element);
  return openOverlay(element, options);
}

/**
 * Opens a menu at a point (a context menu): below and after it, flipped
 * above or before it without room, in the top layer. `opener` gets focus
 * back on close (default: the focused element) and no aria-expanded.
 * Without `x` and `y` it opens under the opener, as a menu does.
 * @param {Element} element
 * @param {{ x?: number, y?: number, opener?: Element|null, returnTo?: () => Element|null|undefined }} [options]
 * @returns {Promise<void>}
 */
export function openAt(element, options = {}) {
  if (!element?.isConnected) return Promise.resolve();
  const opener = options.opener ?? activeIn(element) ?? null;
  const point = Number.isFinite(options.x) && Number.isFinite(options.y) ? { x: Number(options.x), y: Number(options.y) } : null;
  const expanded = opener?.getAttribute?.('aria-expanded') ?? null;
  // Taken back mid-exit at the same point by the same opener: it turns back from where it is.
  const before = custom.get(element);
  const reverse = Boolean(point) && overlays.get(element)?.phase === 'closing' && overlays.get(element)?.opener === opener
    && before?.kind === 'point' && before.anchor.x === point.x && before.anchor.y === point.y;
  if (point) custom.set(element, { kind: 'point', anchor: point });
  else custom.delete(element);
  let entrance = openOverlay(element, { opener, returnTo: options.returnTo });
  // The replayed entrance cancelled the one DS.overlay waits for: wait for this one.
  if (point && !reverse) {
    enterCustom(element);
    entrance = settled(element, { transitions: true });
  }
  // A row or a tile is no menu button: it says nothing about being expanded.
  if (opener && (expanded === null || unexpanded.get(element) === opener)) {
    opener.removeAttribute('aria-expanded');
    unexpanded.set(element, opener);
  } else unexpanded.delete(element);
  return entrance;
}

/**
 * Closes a menu: DS.overlay.close().
 * @param {Element} element
 * @param {{ reason?: string }} [options]
 * @returns {Promise<void>}
 */
export function close(element, options = {}) {
  return closeOverlay(element, options);
}

/**
 * The controller of a menu, the one [data-ds-menu] makes.
 * @param {Element} element
 * @returns {ReturnType<typeof controllerOf>}
 */
export function create(element) {
  return controllerOf(element);
}

define('menu', {
  attribute: 'data-ds-menu',
  init: (element) => create(element),
});

/** The menu a context target names: a selector or an id. */
function contextMenuOf(target) {
  const value = target.getAttribute('data-ds-contextmenu') ?? '';
  if (!value) return null;
  const scope = target.getRootNode?.() ?? target.ownerDocument;
  let found = null;
  try {
    found = scope.querySelector(value);
  } catch {
    // No selector: an id.
  }
  found ??= scope.getElementById?.(value) ?? null;
  return found?.matches('.ds-menu') ? found : null;
}

/** A tap moves at most this far (px) before it is a scroll, as for the tooltips' long press. */
const PRESS_SLOP_PX = 10;

/** Events this module has handled already (nested roots of DS.init() see them twice). */
const handled = new WeakSet();

/*
 * [data-ds-contextmenu] (see the header): one set of delegated listeners per
 * root of DS.init(). Opening asks the target first (ds:contextmenu,
 * cancelable), so a page that wants the browser's menu there keeps it.
 */
define('contextmenu', {
  attribute: 'data-ds-contextmenu',
  global(root) {
    const doc = root.nodeType === 9 ? /** @type {Document} */ (root) : root.ownerDocument;
    if (!doc) return () => {};
    let press = /** @type {{ target: Element, id: number, x: number, y: number, timer: any } | null} */ (null);
    let swallow = /** @type {((event: Event) => void) | null} */ (null);
    // When the key last opened a menu here (performance.now()) and how long
    // the browser's own contextmenu event after it is swallowed; none yet. A
    // right click opens no window: the next one is a real one.
    let keyOpen = { at: -Infinity, within: 0 };
    const targetOf = (/** @type {Event} */ event) => /** @type {Element|null} */ (/** @type {Element} */ (event.composedPath?.()[0] ?? event.target)?.closest?.('[data-ds-contextmenu]') ?? null);
    /** Opens the menu of `target` at a point, or under it (the keyboard). */
    const show = (target, point) => {
      const menu = contextMenuOf(target);
      if (!menu) return false;
      const rect = target.getBoundingClientRect();
      const at = point ?? { x: rect.left, y: rect.bottom };
      if (!emit(target, 'contextmenu', { menu, x: at.x, y: at.y }, { cancelable: true })) return false;
      // The focusable element the menu came from gets focus back: the
      // target itself, or the control inside it that had focus.
      const active = activeIn(target);
      const opener = active && target.contains(active) && active !== doc.body ? active : target;
      openAt(menu, { x: at.x, y: at.y, opener });
      return true;
    };
    const unswallow = () => {
      if (!swallow) return;
      doc.removeEventListener('click', swallow, true);
      doc.removeEventListener('contextmenu', swallow, true);
      swallow = null;
    };
    const cancelPress = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    const onContextMenu = (/** @type {MouseEvent} */ event) => {
      if (handled.has(event)) return;
      handled.add(event);
      if (event.defaultPrevented) return;
      // The key opened a menu a moment ago: the browser's own event that
      // follows (on keyup on some systems, at the menu item that has focus by
      // then, outside every target) is no second one, and its native menu
      // stays shut. Once: the next one is the user's. (The long press
      // swallows its own, see onPointerDown.)
      if (clock() - keyOpen.at < keyOpen.within) {
        keyOpen = { at: -Infinity, within: 0 };
        event.preventDefault();
        return;
      }
      const target = targetOf(event);
      if (!target) return;
      cancelPress();
      // A keyboard's context menu event comes at no pointer position (0, 0 or the element's corner).
      const keyboard = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
      if (show(target, keyboard ? null : { x: event.clientX, y: event.clientY })) event.preventDefault();
    };
    const onKeyDown = (/** @type {KeyboardEvent} */ event) => {
      if (handled.has(event)) return;
      handled.add(event);
      const contextKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
      if (!contextKey || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = targetOf(event);
      if (!target || !show(target, null)) return;
      // --ds-delay-dismiss: as for a scrim, an event this soon after the open is the tail of the opening gesture.
      keyOpen = { at: clock(), within: motionDuration(target, '--ds-delay-dismiss') };
      event.preventDefault();
    };
    const onPointerDown = (/** @type {PointerEvent} */ event) => {
      unswallow();
      cancelPress();
      if (event.pointerType !== 'touch' || handled.has(event)) return;
      handled.add(event);
      const target = targetOf(event);
      if (!target || !contextMenuOf(target)) return;
      const x = event.clientX;
      const y = event.clientY;
      press = { target, id: event.pointerId, x, y, timer: 0 };
      press.timer = setTimeout(() => {
        if (!press || press.target !== target) return;
        press = null;
        if (!show(target, { x, y })) return;
        // The click and the native menu the press would end in never happen.
        swallow = (/** @type {Event} */ next) => {
          next.preventDefault();
          next.stopImmediatePropagation();
          if (next.type === 'click') unswallow();
        };
        doc.addEventListener('click', swallow, true);
        doc.addEventListener('contextmenu', swallow, true);
      }, motionDuration(target, '--ds-delay-long-press'));
    };
    const onPointerMove = (/** @type {PointerEvent} */ event) => {
      if (!press || event.pointerId !== press.id) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_SLOP_PX) cancelPress();
    };
    const onPointerEnd = (/** @type {PointerEvent} */ event) => {
      if (press && event.pointerId === press.id) cancelPress();
    };
    root.addEventListener('contextmenu', onContextMenu);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove, { passive: true });
    root.addEventListener('pointerup', onPointerEnd);
    root.addEventListener('pointercancel', onPointerEnd);
    return () => {
      cancelPress();
      unswallow();
      root.removeEventListener('contextmenu', onContextMenu);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerEnd);
      root.removeEventListener('pointercancel', onPointerEnd);
    };
  },
});

internals.use('menu', {
  focusInto,
  wire(menu) {
    listen(menu.ownerDocument);
    wireMenu(menu);
  },
});
