/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Tabs (DS.tabs): the behaviour of a row of tabs, so a page writes only the
 * markup and listens to what changed.
 *
 *   <div class="ds-tabs__bar">                                    (optional: overflow, add)
 *     <div class="ds-tabs" role="tablist" aria-label="Device" data-ds-tabs data-ds-tabs-overflow> tabs </div>
 *     <button class="ds-btn ds-btn--quiet ds-btn--icon ds-tabs__add" type="button" aria-label="New report">(plus)</button>
 *   </div>
 *   <div class="ds-tabs__panel" role="tabpanel" ...> ... </div>
 *
 *   const tabs = DS.tabs.create(tablist, { overflow: true });
 *   tabs.get();  tabs.set('t-history');  tabs.close(tab);  tabs.add({ label: 'May' });
 *   tabs.on('change', ({ tab, panel, first }) => ...);
 *
 * What it does:
 * - Selection (ARIA tabs, role="tablist"): a click, or the arrow keys
 *   (DS.dom.roving(): Left and Right, Up and Down in a vertical row, Home
 *   and End; data-ds-tabs-activate="manual" waits for Enter or Space),
 *   selects a tab: aria-selected, the one tab stop, the panels' hidden (the
 *   new one enters with DS.motion.enter(panel, 'swap')) and ds:change
 *   ({ tab, panel, previous, value, first }). aria-disabled tabs take the
 *   focus, never the selection. Link tabs (a <nav> of links) keep their
 *   aria-current: the page navigates.
 * - Panels kept alive: a panel that hides keeps its DOM, its fields and its
 *   own scroll position; `first` says when one shows for the first time, so a
 *   page may fill it then.
 * - The indicator (DS.indicator, .ds-tabs__indicator) follows the selected
 *   tab; a row that scrolls keeps it in view.
 * - Closing: a tab whose wrapper (.ds-tabs__item) holds a .ds-tabs__close,
 *   or that says aria-keyshortcuts="Delete", closes from that button, from
 *   Delete, and from a [data-ds-tabs-close] button in its panel. ds:close
 *   ({ tab, panel }) may be cancelled (unsaved work); otherwise the tab and
 *   its panel go, a neighbour takes the selection when the selected one
 *   closed, the focus stays in the row and a screen reader hears it.
 * - Adding: a .ds-tabs__add button in the bar sends ds:add on the row; the
 *   page appends a tab (add() writes one, and for a tab that closes a panel
 *   with its named close action) and selects it.
 * - Overflow (data-ds-tabs-overflow, in a .ds-tabs__bar, not in a vertical
 *   row): the tabs that do not fit the bar's width hide and a "More" button
 *   after the last one lists them in a menu (DS.menu, so DS.overlay opens
 *   and closes it); the selected tab always stays in the row. A
 *   ResizeObserver on the bar and a MutationObserver on the row lay it out
 *   again.
 *
 * Owned state (DS.dom.morphHtml keeps it): aria-selected on the tabs, hidden
 * on the panels and on the tabs that overflow. The More button and its menu
 * are the system's own (data-ds-keep).
 *
 * ES2022. Progressive: none (ResizeObserver and MutationObserver are at the
 * floor; without them, in a test fake, the row lays out once).
 */
import { define, emit, t } from './core.js';
import { enter } from './motion.js';
import { morphHtml, roving, own, disown } from './dom.js';
import { create as makeIndicator } from './indicator.js';
import { announce } from './a11y.js';
import { icon, iconElement, chevronDown, close as closeGlyph } from './icons.js';
import { open as openMenu, close as closeMenu } from './menu.js';

/** The numbering of the ids this module writes (More menus, added tabs). */
let serial = 0;

/** The tabs of a row, not those of a row nested in one of its panels. */
function tabsOf(list) {
  return [...list.querySelectorAll('.ds-tabs__tab')].filter((tab) => tab.closest('.ds-tabs') === list);
}

/** What a tab stands in: its .ds-tabs__item wrapper, else itself. */
function slotOf(tab) {
  const parent = tab.parentElement;
  return parent?.classList.contains('ds-tabs__item') ? parent : tab;
}

/** Whether a tab is the selected (or, for a link, the current) one. */
function isSelected(tab) {
  if (tab.getAttribute('aria-selected') === 'true') return true;
  const current = tab.getAttribute('aria-current');
  return current !== null && current !== 'false';
}

/** Whether a tab can take the selection. */
function selectable(tab) {
  return !tab.matches(':disabled') && tab.getAttribute('aria-disabled') !== 'true';
}

/** Whether a tab closes: it has a close button beside it, or says so to a keyboard. */
function closable(tab) {
  return Boolean(slotOf(tab).querySelector?.(':scope > .ds-tabs__close')) || /\bDelete\b/.test(tab.getAttribute('aria-keyshortcuts') ?? '');
}

/** The label of a tab: data-label, else its text without the count. */
function labelOf(tab) {
  const label = tab.getAttribute('data-label');
  if (label) return label;
  const copy = tab.cloneNode(true);
  for (const part of copy.querySelectorAll('.ds-tabs__count, .ds-badge, .ds-sr')) part.remove();
  return copy.textContent.trim();
}

/** The element an id names, in the tree of `node` (a shadow root or the document). */
function byId(node, id) {
  if (!id) return null;
  const root = node.getRootNode?.();
  const found = typeof root?.getElementById === 'function' ? root.getElementById(id) : null;
  return found ?? node.ownerDocument?.getElementById(id) ?? null;
}

/**
 * Which slots stay in a row that has `room` px: in order while they fit, the
 * selected one always (it may push the ones before it out), at least the
 * selected one. `widths` are the slots' widths, `gap` the room between two,
 * `pad` the row's own inline padding. Returns the indices that stay.
 * @param {number[]} widths
 * @param {{ room: number, gap?: number, pad?: number, selected?: number }} options
 * @returns {number[]}
 */
export function fit(widths, options) {
  const { room, gap = 0, pad = 0, selected = -1 } = options;
  const need = (indices) => (indices.length ? pad + indices.reduce((sum, index) => sum + widths[index], 0) + gap * (indices.length - 1) : 0);
  const kept = [];
  for (let index = 0; index < widths.length; index += 1) {
    if (index === selected) continue;
    const trial = [...kept, index];
    if (selected >= 0) trial.push(selected);
    if (need(trial) > room) break;
    kept.push(index);
  }
  if (selected >= 0) kept.push(selected);
  return kept.sort((a, b) => a - b);
}

/**
 * The controller of one row.
 * @param {HTMLElement} list
 * @param {{ overflow?: boolean, activate?: 'focus'|'manual' }} options
 * @param {AbortSignal} [signal]
 */
function controller(list, options, signal) {
  const doc = list.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const aria = list.getAttribute('role') === 'tablist';
  const vertical = list.getAttribute('aria-orientation') === 'vertical' || list.classList.contains('ds-tabs--vertical');
  const bar = list.parentElement?.classList.contains('ds-tabs__bar') ? list.parentElement : null;
  const abort = new AbortController();
  const listen = { signal: abort.signal };
  signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const listeners = new Set();
  /** Panels shown at least once, and the scroll position of each hidden one. */
  const seen = new WeakSet();
  const scrolls = new WeakMap();
  /** Panels whose close actions are wired. */
  const wired = new WeakSet();
  /** Slots this module hid because they overflow. */
  const folded = new Set();
  /** The menu item of each folded tab. */
  const itemsOf = new WeakMap();
  const owned = [];
  /** Tabs whose aria-selected this module owns. */
  const held = new WeakSet();
  const take = (element, name) => {
    own(element, 'attrs', name);
    owned.push([element, name]);
  };

  const hold = (tab) => {
    if (held.has(tab)) return;
    held.add(tab);
    take(tab, 'aria-selected');
  };

  const tabs = () => tabsOf(list);
  const selectedTab = () => tabs().find(isSelected) ?? null;
  const panelOf = (tab) => byId(tab, tab.getAttribute('aria-controls'));

  const tell = (type, detail, cancelable = false) => {
    const go = emit(list, type, detail, { cancelable });
    for (const entry of listeners) if (entry.type === type) entry.fn(detail);
    return go;
  };

  /* Panels: kept alive, the close action wired once. */
  const wirePanel = (panel) => {
    if (!panel || wired.has(panel)) return;
    wired.add(panel);
    take(panel, 'hidden');
    panel.addEventListener('click', (event) => {
      const action = /** @type {Element} */ (event.target)?.closest?.('[data-ds-tabs-close]');
      if (!action || action.closest('[role="tabpanel"], .ds-tabs__panel') !== panel) return;
      const tab = tabs().find((each) => panelOf(each) === panel);
      if (tab) closeTab(tab);
    }, listen);
  };

  const show = (panel, animate) => {
    if (!panel) return false;
    const first = !seen.has(panel);
    seen.add(panel);
    if (animate && panel.hidden) enter(panel, 'swap');
    else panel.hidden = false;
    const top = scrolls.get(panel);
    if (top) panel.scrollTop = top;
    return first;
  };

  const hide = (panel) => {
    if (!panel || panel.hidden) return;
    if (panel.scrollTop) scrolls.set(panel, panel.scrollTop);
    panel.hidden = true;
  };

  /** Brings the markup into one state: one selected tab, its panel shown, the others hidden. */
  const sync = () => {
    if (!aria) return;
    const all = tabs();
    const current = all.find(isSelected) ?? all.find(selectable) ?? null;
    for (const tab of all) {
      hold(tab);
      const on = tab === current;
      if (tab.getAttribute('aria-selected') !== String(on)) tab.setAttribute('aria-selected', String(on));
      const panel = panelOf(tab);
      wirePanel(panel);
      if (on) show(panel, false);
      else hide(panel);
    }
  };

  /**
   * Selects a tab (an element, or its id).
   * @param {Element|string|null} target
   * @param {{ focus?: boolean, animate?: boolean }} [how]
   */
  const select = (target, how = {}) => {
    const tab = typeof target === 'string' ? tabs().find((each) => each.id === target) : target;
    if (!tab || !list.contains(tab) || !selectable(tab)) return false;
    const previous = selectedTab();
    if (!aria) {
      // Link tabs navigate: the page sets aria-current.
      tab.click();
      return true;
    }
    if (previous !== tab) {
      for (const other of tabs()) {
        const on = other === tab;
        hold(other);
        other.setAttribute('aria-selected', String(on));
        if (!on) hide(panelOf(other));
      }
      layout();
    }
    if (how.focus) tab.focus();
    if (previous === tab) return false;
    const panel = panelOf(tab);
    wirePanel(panel);
    const first = show(panel, how.animate !== false);
    tell('change', { tab, panel, previous, value: tab.id || null, first });
    return true;
  };

  /**
   * Closes a tab and its panel, unless a ds:close listener cancels it.
   * @param {Element} tab
   */
  const closeTab = (tab) => {
    if (!tab || !list.contains(tab)) return false;
    const panel = panelOf(tab);
    if (!tell('close', { tab, panel }, true)) return false;
    const all = tabs();
    const at = all.indexOf(tab);
    const next = all.slice(at + 1).find(selectable) ?? all.slice(0, at).reverse().find(selectable) ?? null;
    const slot = slotOf(tab);
    const active = doc.activeElement;
    const focused = Boolean(active) && (slot.contains(active) || Boolean(panel?.contains(active)) || active === doc.body);
    const label = labelOf(tab);
    if (isSelected(tab) && next) select(next, { focus: focused });
    else if (focused) (selectedTab() !== tab ? selectedTab() : null)?.focus();
    slot.remove();
    panel?.remove();
    if (focused && !list.contains(doc.activeElement)) bar?.querySelector('.ds-tabs__add')?.focus();
    announce(t('tabClosed', { label }));
    layout();
    return true;
  };

  /**
   * Writes a new tab (and, unless one is given, its panel) at the end of the
   * row, and selects it unless `select: false`. The panel it writes for a tab
   * that closes holds the named close action ([data-ds-tabs-close], the string
   * closeTab): the close button beside the tab is for the pointer only, so
   * this action is how a screen reader on a touch screen closes the tab. The
   * page puts its content before it (panel.prepend()).
   * @param {{ label: string, id?: string, closable?: boolean, select?: boolean, panel?: HTMLElement }} spec
   */
  const add = (spec) => {
    serial += 1;
    const id = spec.id || `ds-tab-${serial}`;
    const tab = doc.createElement('button');
    tab.className = 'ds-tabs__tab';
    tab.type = 'button';
    tab.id = id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = -1;
    tab.setAttribute('data-label', spec.label);
    tab.textContent = spec.label;
    let panel = spec.panel ?? null;
    if (!panel) {
      panel = doc.createElement('div');
      panel.className = 'ds-tabs__panel';
      panel.setAttribute('role', 'tabpanel');
      panel.tabIndex = 0;
      panel.hidden = true;
      if (spec.closable !== false) {
        const action = doc.createElement('button');
        action.className = 'ds-btn ds-btn--text';
        action.type = 'button';
        action.setAttribute('data-ds-tabs-close', '');
        action.textContent = t('closeTab', { label: spec.label });
        panel.append(action);
      }
    }
    if (!panel.id) panel.id = `${id}-panel`;
    panel.setAttribute('aria-labelledby', id);
    tab.setAttribute('aria-controls', panel.id);
    let slot = tab;
    if (spec.closable !== false) {
      tab.setAttribute('aria-keyshortcuts', 'Delete');
      slot = doc.createElement('span');
      slot.className = 'ds-tabs__item';
      slot.setAttribute('role', 'none');
      const button = doc.createElement('button');
      button.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-xs ds-tabs__close';
      button.type = 'button';
      button.tabIndex = -1;
      button.setAttribute('aria-hidden', 'true');
      button.setAttribute('data-tip', t('close'));
      button.append(iconElement(closeGlyph, 16, '', doc));
      slot.append(tab, button);
    }
    list.append(slot);
    if (!panel.isConnected) {
      const panels = tabs().map(panelOf).filter((each) => each && each !== panel);
      const after = panels.at(-1) ?? bar ?? list;
      after.after(panel);
    }
    wirePanel(panel);
    if (spec.select !== false) select(tab, { focus: true });
    else layout();
    return { tab, panel };
  };

  /* Overflow: the More button and its menu, the system's own parts. */
  let more = null;
  let menu = null;
  if (options.overflow && bar && !vertical) {
    serial += 1;
    const menuId = `ds-tabs-more-${serial}`;
    more = doc.createElement('button');
    more.className = 'ds-btn ds-btn--quiet ds-tabs__more';
    more.type = 'button';
    more.hidden = true;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-controls', menuId);
    more.setAttribute('aria-label', t('moreTabs'));
    more.dataset.dsKeep = '';
    morphHtml(more, `${t('more')}${icon(chevronDown, 18)}`);
    menu = doc.createElement('div');
    menu.className = 'ds-menu';
    menu.id = menuId;
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('moreTabs'));
    menu.dataset.dsKeep = '';
    list.after(more, menu);
    more.addEventListener('click', (event) => {
      if (event.detail > 1) return;
      if (more.getAttribute('aria-expanded') === 'true') closeMenu(menu);
      else openMenu(menu, { opener: more });
    }, listen);
    more.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openMenu(menu, { opener: more });
    }, listen);
    menu.addEventListener('click', (event) => {
      const item = /** @type {Element} */ (event.target)?.closest?.('.ds-menu__item');
      const tab = item ? itemsOf.get(item) : null;
      if (!tab || item.getAttribute('aria-disabled') === 'true') return;
      // Closed first (the focus goes back to More), then the tab takes it: the
      // layout that follows the selection rewrites the menu's items.
      closeMenu(menu);
      if (aria) select(tab, { focus: true });
      else tab.click();
    }, listen);
  }

  /** The menu's items: one per folded tab, its icon, label and count. */
  const fillMenu = (hiddenTabs) => {
    if (!menu) return;
    const items = hiddenTabs.map((tab) => {
      const item = doc.createElement('button');
      item.className = 'ds-menu__item';
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      if (!selectable(tab)) item.setAttribute('aria-disabled', 'true');
      const glyph = tab.querySelector(':scope > svg');
      if (glyph) item.append(glyph.cloneNode(true));
      const label = doc.createElement('span');
      label.className = 'ds-menu__label';
      label.textContent = labelOf(tab);
      item.append(label);
      const count = tab.querySelector('.ds-tabs__count');
      if (count) {
        const meta = doc.createElement('span');
        meta.className = 'ds-menu__meta';
        meta.append(count.cloneNode(true));
        item.append(meta);
      }
      itemsOf.set(item, tab);
      return item;
    });
    menu.replaceChildren(...items);
  };

  /** Lays the row out: the tabs that fit stay, the others go into the menu. */
  function layout() {
    if (!more || !list.isConnected) return;
    for (const slot of folded) slot.hidden = false;
    folded.clear();
    more.hidden = true;
    const all = tabs();
    if (list.scrollWidth <= list.clientWidth + 1) {
      fillMenu([]);
      if (more.getAttribute('aria-expanded') === 'true') closeMenu(menu);
      return;
    }
    more.hidden = false;
    const style = view.getComputedStyle(list);
    const gap = parseFloat(style.columnGap) || 0;
    const pad = (parseFloat(style.paddingInlineStart) || 0) + (parseFloat(style.paddingInlineEnd) || 0);
    const slots = all.map(slotOf);
    const widths = slots.map((slot) => slot.getBoundingClientRect().width);
    const current = all.findIndex(isSelected);
    const kept = new Set(fit(widths, { room: list.clientWidth, gap, pad, selected: current }));
    const hiddenTabs = [];
    slots.forEach((slot, index) => {
      if (kept.has(index)) return;
      if (!owned.some(([element, name]) => element === slot && name === 'hidden')) take(slot, 'hidden');
      slot.hidden = true;
      folded.add(slot);
      hiddenTabs.push(all[index]);
    });
    list.scrollLeft = 0;
    fillMenu(hiddenTabs);
  }

  /* Events on the row. */
  // The close button is aria-hidden: a press must not focus it (the focus
  // would sit outside the accessibility tree when ds:close is cancelled).
  list.addEventListener('mousedown', (event) => {
    const closer = /** @type {Element} */ (event.target)?.closest?.('.ds-tabs__close');
    if (closer && list.contains(closer)) event.preventDefault();
  }, listen);
  list.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    const closer = target?.closest?.('.ds-tabs__close');
    if (closer && list.contains(closer)) {
      const tab = closer.parentElement?.querySelector(':scope > .ds-tabs__tab');
      if (tab && !closeTab(tab) && closer.contains(doc.activeElement)) /** @type {HTMLElement} */ (tab).focus();
      return;
    }
    if (!aria) return;
    const tab = target?.closest?.('.ds-tabs__tab');
    if (!tab || !list.contains(tab) || isSelected(tab)) return;
    select(tab);
  }, listen);

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const tab = /** @type {Element} */ (event.target)?.closest?.('.ds-tabs__tab');
    if (!tab || !list.contains(tab) || !closable(tab)) return;
    event.preventDefault();
    closeTab(tab);
  }, listen);

  bar?.addEventListener('click', (event) => {
    const button = /** @type {Element} */ (event.target)?.closest?.('.ds-tabs__add');
    if (!button || button.parentElement !== bar || button.getAttribute('aria-disabled') === 'true') return;
    tell('add', {});
  }, listen);

  sync();
  const rover = aria ? roving(list, { items: '.ds-tabs__tab', orientation: vertical ? 'vertical' : 'horizontal', activate: options.activate === 'manual' ? 'manual' : 'focus' }) : null;
  const indicator = makeIndicator(list, {
    active: aria ? '[aria-selected="true"]' : '[aria-current]:not([aria-current="false"])',
    className: 'ds-tabs__indicator',
    reveal: !more,
  });

  // Overflow follows the bar's width and the row's tabs.
  let frame = 0;
  const later = () => {
    if (frame) return;
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(() => { frame = 0; layout(); }) : 0;
    if (!frame) layout();
  };
  const resize = more && typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => layout()) : null;
  resize?.observe(bar);
  const changes = typeof view.MutationObserver === 'function' ? new view.MutationObserver((records) => {
    // New or removed tabs: their panels, and the layout.
    if (records.some((record) => record.type === 'childList')) {
      for (const tab of tabs()) wirePanel(panelOf(tab));
      later();
    } else if (records.some((record) => record.type === 'characterData' || record.attributeName === 'data-label')) later();
  }) : null;
  changes?.observe(list, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-label'] });
  layout();
  doc.fonts?.ready?.then(() => { if (!abort.signal.aborted) layout(); });

  let gone = false;
  return {
    /** The id of the selected tab (for link tabs: the current one), or null. */
    get() {
      const tab = selectedTab();
      return tab ? tab.id || null : null;
    },
    /** Selects a tab by its id or element; returns whether the selection changed. */
    set(value) {
      return select(value);
    },
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    select,
    close: closeTab,
    add,
    /** Lays the row out again (after a change the observers cannot see, such as a font). */
    refresh() {
      layout();
      indicator.update?.();
    },
    destroy() {
      if (gone) return;
      gone = true;
      abort.abort();
      listeners.clear();
      resize?.disconnect();
      changes?.disconnect();
      if (frame) view.cancelAnimationFrame?.(frame);
      for (const slot of folded) slot.hidden = false;
      folded.clear();
      if (menu && more?.getAttribute('aria-expanded') === 'true') closeMenu(menu);
      more?.remove();
      menu?.remove();
      for (const [element, name] of owned) disown(element, 'attrs', name);
      owned.length = 0;
      rover?.destroy();
      indicator.destroy();
    },
  };
}

define('tabs', {
  attribute: 'data-ds-tabs',
  attributes: ['data-ds-tabs-overflow', 'data-ds-tabs-activate'],
  init(el, ctx) {
    return controller(/** @type {HTMLElement} */ (el), {
      overflow: el.hasAttribute('data-ds-tabs-overflow'),
      activate: el.getAttribute('data-ds-tabs-activate') === 'manual' ? 'manual' : 'focus',
    }, ctx.signal);
  },
});

/**
 * A row of tabs driven from the page; the same controller the attribute path
 * makes.
 * @param {HTMLElement} el  the .ds-tabs row (role="tablist", or a <nav> of link tabs)
 * @param {{ overflow?: boolean, activate?: 'focus'|'manual' }} [options]
 */
export function create(el, options = {}) {
  return controller(el, options);
}
