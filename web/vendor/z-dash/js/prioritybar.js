/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Priority action bar (DS.prioritybar): a row of actions that folds the
 * least important ones into a "More" menu when the bar is too narrow for
 * all of them (an overflow set). The menu holds the same commands: picking
 * one presses the action it stands for.
 *
 *   <div class="ds-priority-bar" role="toolbar" aria-label="Ticket actions" data-ds-prioritybar>
 *     <button class="ds-btn ds-btn--quiet" type="button" data-ds-priority="2">(pencil 16) Edit</button>
 *     <button class="ds-btn ds-btn--quiet" type="button">(userPlus 16) Assign</button>
 *     <button class="ds-btn ds-btn--quiet" type="button" aria-pressed="false" data-ds-toggle>(bellOff 16) Mute</button>
 *     <button class="ds-btn ds-btn--quiet" type="button">(archive 16) Archive</button>
 *   </div>
 *
 *   const bar = DS.prioritybar.create(element);   get() the folded actions, update(), on('change', fn)
 *   DS.prioritybar.plan({ widths, priorities, available, gap, more, pinned })   the indexes to fold
 *
 * The actions are the bar's .ds-btn children (buttons and links), except
 * its More button; any other child (a divider, a search) never folds and
 * keeps its room. Each action may carry data-ds-priority (a number, default
 * 0): the lower folds first, and among equals the last one first. An
 * action the page hides (hidden) is left out.
 *
 * The bar measures on every change of its width (ResizeObserver), of its
 * content (MutationObserver: an action added or relabelled) and once the
 * fonts are ready; it shows every action that fits and folds the rest
 * (data-ds-folded on the action, written by the system: it is not
 * displayed). While anything is folded, the More button shows at the end:
 * the bar's own .ds-priority-bar__more, else one the module adds (a quiet
 * icon button, moreHorizontal, named by the strings' moreActions), with the
 * menu .ds-priority-bar__menu (a .ds-menu, added the same way). Both added
 * ones carry data-ds-keep, so DS.dom.morphHtml of the bar leaves them.
 *
 * The menu lists the folded actions in the bar's order, built through DOM
 * APIs each time it opens: the action's label (aria-label, else
 * .ds-btn__label, else its text) and its first icon; a toggle
 * (aria-pressed) as a menuitemcheckbox with its check; a disabled or
 * aria-disabled one as an aria-disabled item. Picking an item clicks the
 * action, so the page's own handlers run as for a press in the bar. The
 * More button is a menu button (DS.menubutton): Enter, Space, ArrowDown and
 * ArrowUp open the menu, Escape brings focus back.
 *
 * Keys: a role="toolbar" bar is one tab stop (DS.a11y.roving): ArrowLeft
 * and ArrowRight move between the shown actions and More, Home and End to
 * the ends. A focused action that folds hands its focus to More; a focused
 * More that hides hands it (and the stop) to the last action, its open
 * menu closed first. An open menu keeps its items when the fold changes
 * (rebuilding them would drop the focus inside); the next open rebuilds.
 *
 * Press feedback inside an action (.ds-pressed, the ripple's spans) does
 * not measure the bar again. create() and the attribute share one
 * controller per bar.
 *
 * ES2022; no progressive feature (ResizeObserver and containment are at
 * the floor).
 */
import { define, emit, t } from './core.js';
import { roving } from './a11y.js';
import { check, iconElement, moreHorizontal } from './icons.js';
import { create as menuButton } from './menubutton.js';

const FOLDED = 'data-ds-folded';

/**
 * The actions to fold (their indexes, ascending) so the rest fits:
 * `widths` of the actions, their `priorities` (higher stays longer; equal:
 * the later folds first), the `available` width, the `gap` between items,
 * the width of the More button and of the children that never fold
 * (`pinned`, with `pinnedCount` of them). Pure.
 * @param {{ widths: number[], priorities?: number[], available: number, gap?: number, more?: number, pinned?: number, pinnedCount?: number }} input
 * @returns {number[]}
 */
export function plan(input) {
  const { widths, available } = input;
  const gap = input.gap ?? 0;
  const pinned = input.pinned ?? 0;
  const pinnedCount = input.pinnedCount ?? 0;
  const priorities = input.priorities ?? widths.map(() => 0);
  // Half a pixel of slack: widths come in fractions, and a rounding must not fold an action.
  const fits = (shown, extra, count) => shown + pinned + extra + Math.max(0, count - 1) * gap <= available + 0.5;
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (fits(total, 0, widths.length + pinnedCount)) return [];
  const order = widths.map((_, index) => index)
    .sort((a, b) => (priorities[a] - priorities[b]) || (b - a));
  const folded = new Set();
  let shown = total;
  for (const index of order) {
    folded.add(index);
    shown -= widths[index];
    if (fits(shown, input.more ?? 0, widths.length - folded.size + pinnedCount + 1)) break;
  }
  return [...folded].sort((a, b) => a - b);
}

/** The words of an action: aria-label, else its .ds-btn__label, else its text; collapsed. */
function labelOf(action) {
  const text = action.getAttribute('aria-label') || action.querySelector('.ds-btn__label')?.textContent || action.textContent || '';
  return text.replace(/\s+/g, ' ').trim();
}

const priorityOf = (action) => {
  const value = Number.parseFloat(action.getAttribute('data-ds-priority') ?? '');
  return Number.isFinite(value) ? value : 0;
};

const blocked = (action) => Boolean(action.disabled) || action.getAttribute('aria-disabled') === 'true' || action.getAttribute('aria-busy') === 'true';

function controller(bar, signal) {
  const doc = bar.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const listeners = new Set();
  const local = new AbortController();
  signal?.addEventListener('abort', () => local.abort(), { once: true });
  const on = { signal: local.signal };
  const added = [];

  // The More button and its menu: the bar's own, else made here.
  let more = bar.querySelector(':scope > .ds-priority-bar__more');
  if (!more) {
    more = doc.createElement('button');
    more.type = 'button';
    more.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-priority-bar__more';
    more.setAttribute('aria-label', t('moreActions'));
    more.setAttribute('data-tip', t('moreActions'));
    more.setAttribute('data-ds-keep', '');
    more.append(iconElement(moreHorizontal, 20, undefined, doc));
    bar.append(more);
    added.push(more);
  }
  let menu = bar.querySelector(':scope > .ds-priority-bar__menu');
  if (!menu) {
    menu = doc.createElement('div');
    menu.className = 'ds-menu ds-priority-bar__menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', more.getAttribute('aria-label') || t('moreActions'));
    menu.setAttribute('data-ds-keep', '');
    menu.hidden = true;
    bar.append(menu);
    added.push(menu);
  }

  const actions = () => [...bar.children].filter((child) => child !== more && child !== menu && child.matches('.ds-btn') && !child.hidden);
  const pinnedOf = () => [...bar.children].filter((child) => child !== more && child !== menu && !child.matches('.ds-btn') && !child.hidden && !child.matches('.ds-menu'));
  let folded = [];

  /** The menu's items for the folded actions, in the bar's order. */
  const build = () => {
    const items = folded.map((action, index) => {
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'ds-menu__item';
      item.setAttribute('data-ds-key', String(index));
      const toggle = action.hasAttribute('aria-pressed');
      item.setAttribute('role', toggle ? 'menuitemcheckbox' : 'menuitem');
      if (toggle) item.setAttribute('aria-checked', String(action.getAttribute('aria-pressed') === 'true'));
      if (blocked(action)) item.setAttribute('aria-disabled', 'true');
      const glyph = action.querySelector('svg');
      if (toggle) item.append(iconElement(check, 20, 'ds-menu__check', doc));
      else if (glyph) {
        const copy = /** @type {SVGElement} */ (glyph.cloneNode(true));
        copy.setAttribute('width', '20');
        copy.setAttribute('height', '20');
        copy.removeAttribute('class');
        copy.setAttribute('aria-hidden', 'true');
        item.append(copy);
      }
      const label = doc.createElement('span');
      label.className = 'ds-menu__label';
      label.textContent = labelOf(action);
      item.append(label);
      item.addEventListener('click', () => {
        if (item.getAttribute('aria-disabled') === 'true') return;
        /** @type {HTMLElement} */ (action).click();
      });
      return item;
    });
    menu.replaceChildren(...items);
  };

  /** Measures every action at its full size and folds what does not fit. */
  const measure = () => {
    if (local.signal.aborted || !bar.isConnected) return;
    const style = view.getComputedStyle(bar);
    const available = bar.clientWidth - (Number.parseFloat(style.paddingInlineStart) || 0) - (Number.parseFloat(style.paddingInlineEnd) || 0);
    if (available <= 0) return;
    const list = actions();
    // Everything shown for one synchronous read (no frame paints in between).
    for (const action of list) action.removeAttribute(FOLDED);
    more.removeAttribute(FOLDED);
    const width = (element) => element.getBoundingClientRect().width;
    const pinned = pinnedOf();
    const indexes = plan({
      widths: list.map(width),
      priorities: list.map(priorityOf),
      available,
      gap: Number.parseFloat(style.columnGap) || 0,
      more: width(more),
      pinned: pinned.reduce((sum, child) => sum + width(child), 0),
      pinnedCount: pinned.length,
    });
    const next = indexes.map((index) => list[index]);
    for (const action of next) action.setAttribute(FOLDED, '');
    const changed = next.length !== folded.length || next.some((action, index) => action !== folded[index]);
    const open = more.getAttribute('aria-expanded') === 'true';
    // More goes: its open menu closes first (focus comes back to More), so
    // the focus has somewhere to go.
    if (!next.length && open) trigger.close();
    const holds = (element) => {
      const active = doc.activeElement;
      return Boolean(active) && (element === active || element.contains(active));
    };
    if (next.some(holds)) /** @type {HTMLElement} */ (more).focus({ preventScroll: true });
    else if (!next.length && (holds(more) || holds(menu))) {
      // A focused More that hides hands its focus (and the tab stop) to the
      // last action, before it is gone.
      const shown = list.filter((action) => !action.hasAttribute(FOLDED));
      const heir = /** @type {HTMLElement|undefined} */ (shown.at(-1));
      if (heir) {
        if (keys) for (const item of [...list, more]) item.setAttribute('tabindex', item === heir ? '0' : '-1');
        heir.focus({ preventScroll: true });
      }
    }
    if (!next.length) more.setAttribute(FOLDED, '');
    folded = next;
    if (!changed) return;
    // An open menu keeps its items (replacing them would drop the focus
    // inside it); the next open builds it afresh.
    if (!open) build();
    // The one tab stop must not rest on a folded action.
    if (keys && ![...list, more].some((item) => !item.hasAttribute(FOLDED) && item.getAttribute('tabindex') === '0')) {
      const first = [...list, more].find((item) => !item.hasAttribute(FOLDED));
      for (const item of [...list, more]) item.setAttribute('tabindex', item === first ? '0' : '-1');
    }
    const detail = { folded: [...folded] };
    emit(bar, 'change', detail);
    for (const fn of [...listeners]) fn(detail);
  };

  // The menu is fresh when it opens: labels, toggles and blocked states as they are now.
  const refresh = (/** @type {Event} */ event) => {
    if (event.type === 'keydown' && /** @type {KeyboardEvent} */ (event).key !== 'ArrowDown' && /** @type {KeyboardEvent} */ (event).key !== 'ArrowUp') return;
    if (more.getAttribute('aria-expanded') !== 'true') build();
  };
  more.addEventListener('click', refresh, on);
  more.addEventListener('keydown', refresh, on);
  const trigger = menuButton(more, { menu });
  const keys = bar.getAttribute('role') === 'toolbar' ? roving(bar, { items: ':scope > .ds-btn:not([data-ds-folded])', activate: false }) : null;

  // Width, content and fonts.
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      measure();
    });
  };
  const sizes = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => measure()) : null;
  sizes?.observe(bar);
  // What changes an action's width: actions added, removed, relabelled or
  // hidden. Not the press feedback inside an action (.ds-pressed, the
  // ripple's nodes), which comes and goes on every press.
  const press = (name) => /^ds-(pressed|ripples|press-ripple(--[\w-]+)?)$/.test(name);
  const lasting = (text) => String(text ?? '').split(/\s+/).filter((name) => name && !press(name)).sort().join(' ');
  const pressOnly = (record) => {
    if (record.type === 'attributes' && record.attributeName === 'class') return lasting(record.oldValue) === lasting(/** @type {Element} */ (record.target).getAttribute('class'));
    if (record.type === 'childList' && record.target !== bar) {
      const nodes = [...record.addedNodes, ...record.removedNodes];
      return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && String(/** @type {Element} */ (node).getAttribute('class') ?? '').split(/\s+/).some(press));
    }
    return false;
  };
  const content = typeof view.MutationObserver === 'function' ? new view.MutationObserver((records) => {
    if (records.some((record) => !menu.contains(record.target) && !more.contains(record.target) && !pressOnly(record))) later();
  }) : null;
  content?.observe(bar, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'hidden', 'aria-label', 'data-ds-priority'] });
  doc.fonts?.ready?.then(later);
  doc.fonts?.addEventListener?.('loadingdone', later, on);
  measure();

  local.signal.addEventListener('abort', () => {
    sizes?.disconnect();
    content?.disconnect();
    trigger.destroy();
    keys?.destroy();
    for (const action of actions()) action.removeAttribute(FOLDED);
    for (const node of added) node.remove();
  }, { once: true });

  const api = {
    element: bar,
    more,
    menu,
    get: () => [...folded],
    update: () => measure(),
    on(type, fn) {
      if (type !== 'change' || typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      listeners.clear();
      local.abort();
      if (controllers.get(bar) === api) controllers.delete(bar);
    },
  };
  return api;
}

/** One controller per bar, whichever of create() and the attribute came first. @type {WeakMap<Element, ReturnType<typeof controller>>} */
const controllers = new WeakMap();

function controllerOf(bar, signal) {
  const existing = controllers.get(bar);
  if (existing) return existing;
  const made = controller(bar, signal);
  controllers.set(bar, made);
  return made;
}

/**
 * A priority action bar driven from the page; the controller
 * data-ds-prioritybar makes (the same one, when the attribute set it up).
 * @param {Element} bar
 */
export function create(bar) {
  return controllerOf(bar, null);
}

define('prioritybar', {
  attribute: 'data-ds-prioritybar',
  init: (bar, ctx) => controllerOf(bar, ctx.signal),
});
