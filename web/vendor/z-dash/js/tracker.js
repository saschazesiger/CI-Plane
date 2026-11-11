/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Tracker (DS.tracker): the cells of a status row as one tab stop, and
 * the row rendered from data.
 *
 *   <div class="ds-tracker__cells" role="group" aria-label="..." data-ds-tracker>...cells...</div>
 *   const row = DS.tracker.create(cells);
 *   row.set([{ state: 'success', label: 'Nov 3: up' }, { state: 'error', label: 'Nov 4: down 42 min' }]);
 *   DS.tracker.counts(['success', 'error', 'success']);   { success: 2, error: 1, ..., total: 3 }
 *
 * The cells (.ds-tracker__cell): the arrow keys, Home and End move focus
 * between them (DS.a11y.roving, no wrap); the row's one tab stop starts on
 * the last cell, the most recent. A focused cell shows its tooltip
 * (data-tip, DS.overlay.tooltips). A cell with a data-tip and no name gets
 * that tip as its aria-label, and role="img" when it has no role.
 *
 * set(list) renders the cells from data, in place: [{ state, label }],
 * where state is success, info, warning, error or empty. The existing
 * cells are reused in order (their focus stays), extra ones go (focus on
 * one of them moves to the nearest cell that stays, with the tab stop),
 * new ones come. The summary in words stays the page's: counts() gives the figures
 * it is made of.
 *
 * The controller: get() gives { cells: [{ state, label }], counts },
 * set(list), on('change', fn) after set(), update() reads the cells
 * again, destroy() lets go of the keys and of what it wrote. Events:
 * ds:change ({ cells, counts }) after set().
 *
 * ES2022. No Progressive: features.
 */
import { define, emit } from './core.js';
import { roving } from './a11y.js';

const STATES = Object.freeze(['success', 'info', 'warning', 'error', 'empty']);

const CELL = '.ds-tracker__cell';

/**
 * How many cells of each state, and in all.
 * @param {Iterable<string|{ state?: string }>} cells
 * @returns {{ success: number, info: number, warning: number, error: number, empty: number, total: number }}
 */
export function counts(cells) {
  const out = { success: 0, info: 0, warning: 0, error: 0, empty: 0, total: 0 };
  for (const cell of cells ?? []) {
    const state = typeof cell === 'string' ? cell : cell?.state;
    out.total += 1;
    if (STATES.includes(state)) out[state] += 1;
    else out.empty += 1;
  }
  return out;
}

/** The state a cell's class names (empty without one). */
function stateOf(cell) {
  return STATES.find((state) => cell.classList.contains(`ds-tracker__cell--${state}`)) ?? 'empty';
}

function read(el) {
  return [...el.querySelectorAll(CELL)].map((cell) => ({ state: stateOf(cell), label: cell.getAttribute('aria-label') ?? cell.getAttribute('data-tip') ?? '' }));
}

/** A cell's name from its tip, and its role, where the page wrote neither. */
function name(cell) {
  const tip = cell.getAttribute('data-tip');
  if (tip && !cell.hasAttribute('aria-label')) cell.setAttribute('aria-label', tip);
  if (!cell.hasAttribute('role')) cell.setAttribute('role', 'img');
}

function controller(el) {
  const doc = el.ownerDocument;
  const listeners = new Set();
  let live = true;

  const cells = () => [...el.querySelectorAll(CELL)];
  const prepare = () => {
    const all = cells();
    all.forEach(name);
    // The most recent cell holds the tab stop until focus chose another.
    if (all.length && !all.some((cell) => cell.getAttribute('tabindex') === '0')) all.at(-1).setAttribute('tabindex', '0');
  };
  prepare();
  const keys = roving(el, { items: CELL, orientation: 'horizontal', wrap: false, activate: false });
  // A re-render (DS.dom.morphHtml) brings cells without a name or a stop.
  const view = doc?.defaultView ?? globalThis;
  const watcher = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {
    if (live) prepare();
  }) : null;
  watcher?.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tip'] });

  const api = {
    get() {
      const list = read(el);
      return { cells: list, counts: counts(list) };
    },
    set(list) {
      if (!live) return;
      const data = [...(list ?? [])].map((item) => ({
        state: STATES.includes(item?.state) ? item.state : 'empty',
        label: String(item?.label ?? ''),
      }));
      const present = cells();
      data.forEach((item, index) => {
        let cell = present[index];
        if (!cell) {
          cell = doc.createElement('span');
          cell.setAttribute('tabindex', '-1');
          el.append(cell);
        }
        cell.className = `ds-tracker__cell ds-tracker__cell--${item.state}`;
        cell.setAttribute('role', 'img');
        cell.setAttribute('aria-label', item.label);
        cell.setAttribute('data-tip', item.label);
      });
      const gone = present.slice(data.length);
      // Focus on a cell that goes (a live row dropping old days under a
      // keyboard user): it and the tab stop move to the nearest cell that
      // stays, before the cell goes, so focus never falls to the page.
      const active = doc.activeElement;
      const lost = gone.find((cell) => cell === active || cell.contains(active));
      if (lost && data.length) {
        const next = present[Math.min(present.indexOf(lost), data.length - 1)];
        for (const cell of present.slice(0, data.length)) cell.setAttribute('tabindex', cell === next ? '0' : '-1');
        next.focus({ preventScroll: true });
      }
      for (const cell of gone) cell.remove();
      prepare();
      const detail = { cells: data, counts: counts(data) };
      emit(el, 'change', detail);
      for (const fn of [...listeners]) fn(detail);
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      prepare();
    },
    destroy() {
      if (!live) return;
      live = false;
      watcher?.disconnect();
      keys.destroy();
      listeners.clear();
    },
  };
  return api;
}

define('tracker', {
  attribute: 'data-ds-tracker',
  init(el) {
    return controller(el);
  },
});

/**
 * A status row driven from the page; the same controller the attribute path makes.
 * @param {Element} el the .ds-tracker__cells row
 */
export function create(el) {
  return controller(el);
}
