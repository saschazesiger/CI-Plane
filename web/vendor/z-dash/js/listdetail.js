/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * List-detail layout (DS.listdetail): which level shows, list, detail or
 * sub-detail, and what follows when it changes. This module writes the level
 * (data-state), measures the layout's own width and writes how many columns
 * fit and which show (data-columns, data-shown: arrange(); listdetail.css
 * folds them), wires the triggers and the back buttons, moves the focus when
 * the column that held it goes, and plays the column that comes.
 *
 *   <div class="ds-listdetail" data-ds-listdetail="list"> ... </div>
 *   <a class="ds-list__action" href="#d42" data-ds-listdetail-show="detail">LAPTOP-0042</a>
 *   <button class="ds-btn ds-btn--icon ds-btn--quiet ds-listdetail__back" type="button" aria-label="Back to devices">...</button>
 *
 *   const layout = DS.listdetail.create(el, { level: 'list' });
 *   layout.set('detail');               // after the page rendered the record
 *   layout.back();                      // up one level (back('sub'): up from that level)
 *   layout.get();                       // 'detail'
 *   layout.visible();                   // ['list', 'detail'] at this width
 *   DS.listdetail.arrange(390, 'detail');   // { columns: 1, shown: ['detail'] }
 *   layout.on('change', ({ level, previous }) => { ... });
 *
 * Levels: 'list', 'detail' (needs a .ds-listdetail__detail) and 'sub' (needs
 * a .ds-listdetail__sub); an unknown or missing one is 'list'. The
 * attribute data-ds-listdetail holds the page's level: its value at init,
 * and a later change of it (a re-render through DS.dom.morphHtml) sets the
 * level. set() drives it from the page and never writes the attribute.
 *
 * Triggers (one delegated listener per root of DS.init(), so it runs after
 * the page's own click handlers, which render what the level shows): a
 * click on [data-ds-listdetail-show="detail|sub|list"] goes to that level,
 * also when a router called preventDefault() on the link (a page that must
 * keep the level leaves the attribute out and calls set());
 * .ds-listdetail__back and .ds-listdetail__close go up one level from their
 * column. A back or close button the page left unnamed is named t('back')
 * or t('close').
 *
 * Focus (only when the column that held it is no longer shown, or the
 * focused control hid in a column that stays, such as the close button
 * just pressed; so a wide layout leaves the focus in the list): going
 * deeper it moves to the title of the level's column (.ds-listdetail__title
 * or its first heading, with tabindex="-1"), else to the column; going back
 * to the trigger that opened the level below the one it lands on (the
 * latest, also a row picked while the detail showed), else to that
 * column's title. A resize that hides the focused column or control does
 * the same. A screen reader reads the title it lands on.
 *
 * Widths: the columns fit by the hooks --ds-listdetail-list-width (320px),
 * --ds-listdetail-detail-min (400px) and --ds-listdetail-sub-width (360px),
 * read in px or rem (anything else: those defaults); a ResizeObserver folds
 * and unfolds them as the layout's width changes, before the next paint.
 *
 * Motion: the column that comes into view by a change of level enters
 * (DS.motion.enter, 'slide'), from the end going deeper and from the start
 * going back (data-direction on the layout); none on init or a resize.
 * Events: ds:change ({ level, previous }) on the layout.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, get, t } from './core.js';
import { enter } from './motion.js';
import { canTakeFocus } from './a11y.js';

const LEVELS = ['list', 'detail', 'sub'];
/** The column widths of listdetail.css, for a layout whose hooks are not px or rem. */
const WIDTHS = Object.freeze({ list: 320, detail: 400, sub: 360 });
const COLUMN = { list: 'ds-listdetail__list', detail: 'ds-listdetail__detail', sub: 'ds-listdetail__sub' };
const SHOW = 'data-ds-listdetail-show';

/**
 * The level a value names among those `available`, else 'list'.
 * @param {string|null|undefined} value
 * @param {string[]} [available]
 * @returns {'list'|'detail'|'sub'}
 */
export function level(value, available = LEVELS) {
  const name = String(value ?? '').trim().toLowerCase();
  return /** @type {any} */ (LEVELS.includes(name) && available.includes(name) ? name : 'list');
}

/**
 * The level above `current` (list stays list).
 * @param {string} current
 * @returns {'list'|'detail'|'sub'}
 */
export function parent(current) {
  const index = LEVELS.indexOf(current);
  return /** @type {any} */ (LEVELS[Math.max(0, index - 1)]);
}

/**
 * How many columns fit in `width` and which levels show: one column under
 * the list and the detail's minimum (the level's own), two up to that plus
 * the sub-detail (the list and the detail; at the sub level the detail and
 * the sub-detail), else three (the sub-detail beside both). `available`
 * names the columns the layout has.
 * @param {number} width
 * @param {string} current
 * @param {{ list?: number, detail?: number, sub?: number, available?: string[] }} [options]
 * @returns {{ columns: 1|2|3, shown: ('list'|'detail'|'sub')[] }}
 */
export function arrange(width, current, options = {}) {
  const available = options.available ?? LEVELS;
  const at = level(current, available);
  const list = options.list ?? WIDTHS.list;
  const detail = options.detail ?? WIDTHS.detail;
  const sub = options.sub ?? WIDTHS.sub;
  const columns = width >= list + detail + sub ? 3 : width >= list + detail ? 2 : 1;
  if (columns === 1 || !available.includes('detail')) return { columns: available.includes('detail') ? columns : 1, shown: [at] };
  if (at !== 'sub') return { columns, shown: ['list', 'detail'] };
  return { columns, shown: columns === 3 ? ['list', 'detail', 'sub'] : ['detail', 'sub'] };
}

function controller(el, start, signal) {
  const view = el.ownerDocument.defaultView ?? globalThis;
  const listeners = new Set();
  /** The trigger that opened each level, for the focus going back. */
  const openers = new Map();

  const column = (name) => [...el.children].find((child) => child.classList.contains(COLUMN[name])) ?? null;
  const available = () => LEVELS.filter((name) => column(name));
  let shownNow = [];

  /** A width hook in px: px or rem; anything else (a calc, a percentage) the stylesheet's own default. */
  function hook(name, fallback) {
    const text = view.getComputedStyle(el).getPropertyValue(name).trim();
    const match = /^(\d*\.?\d+)(px|rem)$/.exec(text);
    if (!match) return fallback;
    const root = match[2] === 'rem' ? parseFloat(view.getComputedStyle(el.ownerDocument.documentElement).fontSize) || 16 : 1;
    return Number(match[1]) * root;
  }

  /** Writes what shows at this width and level; the levels that show. */
  function arrangeNow() {
    const width = el.getBoundingClientRect().width;
    const result = arrange(width, current, {
      available: available(),
      list: hook('--ds-listdetail-list-width', WIDTHS.list),
      detail: hook('--ds-listdetail-detail-min', WIDTHS.detail),
      sub: hook('--ds-listdetail-sub-width', WIDTHS.sub),
    });
    el.setAttribute('data-columns', String(result.columns));
    el.setAttribute('data-shown', result.shown.join(' '));
    shownNow = result.shown;
    return result.shown;
  }

  const visible = () => [...shownNow];
  const shown = (node) => Boolean(node) && shownNow.some((name) => column(name) === node);

  let current = level(start, available());
  el.setAttribute('data-state', current);
  arrangeNow();

  function name() {
    for (const button of el.querySelectorAll('.ds-listdetail__back, .ds-listdetail__close')) {
      if (button.closest('.ds-listdetail') !== el) continue;
      if (button.hasAttribute('aria-label') || button.hasAttribute('aria-labelledby') || button.textContent.trim()) continue;
      button.setAttribute('aria-label', t(button.classList.contains('ds-listdetail__back') ? 'back' : 'close'));
    }
  }

  /** Where the focus lands in a column: its title (made focusable by script only), else the column. */
  function landing(name) {
    const node = column(name);
    if (!node) return null;
    const title = node.querySelector('.ds-listdetail__title') ?? node.querySelector('h1, h2, h3, h4, h5, h6');
    const target = title && title.closest('.ds-listdetail') === el ? title : node;
    if (!target.hasAttribute('tabindex') && !target.matches('a[href], button, input, select, textarea')) target.setAttribute('tabindex', '-1');
    return target;
  }

  function focusIn(name, opener) {
    const target = opener?.isConnected && el.contains(opener) && canTakeFocus(opener) ? opener : landing(name);
    target?.focus();
  }

  /**
   * Moves the focus out of a column that no longer shows, or off a control
   * that hid in a column that stays (the close or back button just pressed),
   * to the level's own; going back, to the trigger that opened the level
   * below the one it lands on (the row, also when it skips a level).
   */
  function rescue(back) {
    const active = el.ownerDocument.activeElement;
    const holder = active && el.contains(active) ? active.closest(Object.values(COLUMN).map((cls) => `.${cls}`).join(', ')) : null;
    if (!holder || (shown(holder) && canTakeFocus(active))) return;
    focusIn(current, back ? openers.get(LEVELS[LEVELS.indexOf(current) + 1]) : null);
  }

  function go(next, options = {}) {
    const target = level(next, available());
    // A trigger of the level that already shows (another row on a wide layout) is the one going back returns to.
    if (target === current && options.opener && LEVELS.indexOf(target) > 0) openers.set(target, options.opener);
    if (target === current) return;
    const previous = current;
    const deeper = LEVELS.indexOf(target) > LEVELS.indexOf(previous);
    const before = visible();
    if (deeper && options.opener) openers.set(target, options.opener);
    current = target;
    el.setAttribute('data-direction', deeper ? 'forward' : 'back');
    el.setAttribute('data-state', current);
    const after = arrangeNow();
    if (options.animate !== false) for (const name of after) if (!before.includes(name)) enter(column(name), 'slide');
    if (options.focus !== false) rescue(!deeper);
    if (!deeper) for (const name of LEVELS.slice(LEVELS.indexOf(current) + 1)) openers.delete(name);
    if (signal.aborted) return;
    const detail = { level: current, previous };
    emit(el, 'change', detail);
    listeners.forEach((fn) => fn(detail));
  }

  name();

  // A resize folds or unfolds the columns; one that hides the column holding the focus moves it to the level's own.
  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => {
    const before = shownNow.join();
    if (arrangeNow().join() !== before) rescue(false);
  }) : null;
  resize?.observe(el);

  return {
    get: () => current,
    set(next, options) {
      go(next, options);
    },
    back(from) {
      go(parent(level(from ?? current, available())));
    },
    visible,
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The attribute path: the page's level changed. */
    update() {
      go(el.getAttribute('data-ds-listdetail'));
    },
    destroy() {
      resize?.disconnect();
      listeners.clear();
      openers.clear();
    },
  };
}

define('listdetail', {
  attribute: 'data-ds-listdetail',
  init(el, ctx) {
    return controller(el, el.getAttribute('data-ds-listdetail'), ctx.signal);
  },
  global(root) {
    const onClick = (/** @type {MouseEvent} */ event) => {
      const node = /** @type {Element} */ (event.target)?.closest?.(`[${SHOW}], .ds-listdetail__back, .ds-listdetail__close`);
      if (!node || /** @type {any} */ (node).disabled || node.getAttribute('aria-disabled') === 'true') return;
      const layout = node.closest('.ds-listdetail');
      const handle = layout ? get(layout, 'listdetail') : null;
      if (!handle) return;
      if (node.hasAttribute(SHOW)) {
        handle.set(node.getAttribute(SHOW), { opener: node });
        return;
      }
      const holder = node.closest('.ds-listdetail__list, .ds-listdetail__detail, .ds-listdetail__sub');
      handle.back(LEVELS.find((name) => holder?.classList.contains(COLUMN[name])));
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  },
});

/**
 * A list-detail layout driven from the page; the same controller the
 * attribute path makes. `level` is where it starts (default 'list').
 * @param {Element} el
 * @param {{ level?: string }} [options]
 */
export function create(el, options = {}) {
  const abort = new AbortController();
  const handle = controller(el, options.level ?? 'list', abort.signal);
  const destroy = handle.destroy;
  handle.destroy = () => {
    destroy();
    abort.abort();
  };
  return handle;
}
