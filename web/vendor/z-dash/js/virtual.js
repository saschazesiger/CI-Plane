/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Windowing (3.0): a list or the rows of a table with thousands of entries,
 * of which only those near the viewport exist in the DOM.
 *
 *   const rows = DS.virtual.create(scroller, {
 *     count: devices.length,
 *     estimate: 48,
 *     render: (index) => `<tr data-ds-key="${devices[index].id}">...</tr>`,
 *   });
 *   rows.set({ count: devices.length });      // more or fewer rows
 *   rows.refresh();                           // the data changed: patch what shows
 *   rows.scrollTo(4000, { align: 'center' });
 *   rows.focus(4000);
 *   rows.on('range', ({ start, end, count }) => { ... });
 *   rows.destroy();
 *
 * Layout: `content` (option; default the first tbody, list, listbox, rowgroup
 * or grid in the scroller, else the scroller itself; a table's first tbody, an
 * ARIA table or grid with rowgroups its last one) holds the rows in normal
 * flow, between hidden spacers that stand in for what is not rendered, so a
 * sticky header keeps working: scrolling and focus keep a row out from under it.
 * A table keeps its column sizes only with `table-layout: fixed` or explicit
 * column widths: the automatic layout sizes columns by the cells of the rows
 * that exist, which change as the window moves. A row's spacing belongs inside
 * the row: margins and gaps between rows are not measured.
 *
 * Heights: `estimate` (a number or a function of the index, default the first
 * row measured) stands in until a row has been rendered; then its measured
 * height is kept (sizes(), a Fenwick tree, so a jump to any offset stays
 * logarithmic for a million rows). A ResizeObserver catches rows that change
 * later. Rows above the viewport that turn out taller or shorter shift the
 * scroll position by the same amount, so what is on screen stays where it is
 * (overflow-anchor is off on the scroller, which not every engine has).
 *
 * Rendering: render(index) returns the markup of one row, one root element
 * with its data-ds-key (an unkeyed row is patched by position). The rows go
 * through DS.dom.morphHtml, so a row that stays is patched in place and
 * keeps its focus, listeners and running transitions. Each row is rendered
 * once while it shows; refresh() renders them again. A morphHtml of a parent
 * that empties `content` is put right before paint, by an observer.
 *
 * Assistive tech: rows outside the window do not exist, so the system
 * tells their number: in a table or grid aria-rowcount on the table and
 * aria-rowindex on each row (`rowOffset`: rows above them, default those of
 * the thead), elsewhere aria-setsize and aria-posinset on each row. `total`
 * says what these report when `count` is not the whole set (-1: unknown). All
 * of them are owned state, so a morph leaves them alone.
 *
 * Keyboard (`keyboard`, default true): one tab stop, the active row
 * (tabindex 0, the others -1, the scroller -1). The controls inside the other
 * rows wait with tabindex -1 (owned, their own value back when the row turns
 * active), so Tab goes through the active row's controls and leaves the list;
 * with stops in every row each Tab would render more rows and never get out.
 * What a page adds to a row by itself counts from the next render. ArrowUp,
 * ArrowDown, Home, End, PageUp and PageDown move the active row and the focus,
 * rendering the target first; not from inside a text field, and not with a
 * modifier. The active row always stays rendered wherever the scroll position
 * is (its own place, between spacers), so scrolling away never drops the focus
 * or the tab stop. When the row that held the focus goes (the data changed), the
 * focus moves to the active row, and to the scroller when no row is left.
 * `keyboard: false` leaves focus to the page (a combobox, whose focus stays in
 * its input, or a grid's cell navigation).
 *
 * Limits: browser search finds rendered rows only; a browser caps an element's
 * height (about 17 million px in Firefox), so keep count x height under that.
 *
 * ES2022; no DOM is touched until create() runs. Nothing here animates: rows
 * enter and leave outside the viewport.
 */

import { emit } from './core.js';
import { morphHtml } from './dom.js';

/** A row's assumed height until something better is known (the first row measured). */
const ESTIMATE = 44;

/** Rows rendered beyond each end of the viewport. */
const OVERSCAN = 4;

/** Rows rendered while the scroller has no height yet (hidden). */
const BLIND_ROWS = 8;

/** Render, measure, render again: enough to settle. Each pass costs a layout. */
const MAX_PASSES = 4;
/** The input with which a person scrolls a list themselves (and so takes over from a scrollTo()). */
const TAKE_OVER = ['wheel', 'touchstart', 'pointerdown'];

/** Height differences below this are rounding, not a change. */
const EPSILON = 0.01;

const TEXT_ENTRY = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** What is a tab stop inside a row, as far as its markup tells. */
const ROW_STOP = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]';

/** The owned-state record of dom.js (shared by every copy): a morph leaves these names alone. */
const OWNED = Symbol.for('ds.owned');

function own(element, kind, name) {
  const record = element[OWNED] ?? (element[OWNED] = { attrs: new Map(), classes: new Map(), props: new Map() });
  record[kind].set(name, (record[kind].get(name) ?? 0) + 1);
}

function disown(element, kind, name) {
  const map = element[OWNED]?.[kind];
  const count = map?.get(name) ?? 0;
  if (count > 1) map.set(name, count - 1);
  else map?.delete(name);
}

const setAttribute = (element, name, value) => {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
};

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/* ── The height model ───────────────────────────────── */

/**
 * The height of `count` rows and the offsets they add up to: a Fenwick tree,
 * so offset() and indexAt() cost log(count) and a million rows stay quick.
 * `estimate` (a number or a function of the index) stands in until set().
 * Exposed for what windows by itself (a tree, a grid's columns).
 * @param {number} [count]
 * @param {number|((index: number) => number)} [estimate]
 * @returns {{ readonly count: number, size: (index: number) => number, set: (index: number, height: number) => number, measured: (index: number) => boolean, offset: (index: number) => number, total: () => number, indexAt: (offset: number) => number, resize: (count: number) => void, estimate: (estimate: number|((index: number) => number)) => void, forget: () => void }}
 */
export function sizes(count = 0, estimate = ESTIMATE) {
  let guess = estimate;
  let length = 0;
  let values = new Float64Array(0);
  let tree = new Float64Array(1);
  let known = new Uint8Array(0);
  let sum = 0;
  let top = 1;

  const guessAt = (index) => {
    const value = typeof guess === 'function' ? Number(guess(index)) : Number(guess);
    return value > 0 ? value : ESTIMATE;
  };
  /** The tree from the values, in linear time. */
  const rebuild = () => {
    tree = new Float64Array(length + 1);
    sum = 0;
    for (let index = 0; index < length; index += 1) {
      const at = index + 1;
      tree[at] += values[index];
      sum += values[index];
      const parent = at + (at & -at);
      if (parent <= length) tree[parent] += tree[at];
    }
    top = 1;
    while (top * 2 <= length) top *= 2;
  };
  const model = {
    get count() {
      return length;
    },
    size: (index) => values[index] ?? 0,
    measured: (index) => known[index] === 1,
    /** Sets the measured height of a row; returns the difference. */
    set(index, height) {
      if (index < 0 || index >= length) return 0;
      const delta = height - values[index];
      known[index] = 1;
      if (!delta) return 0;
      values[index] = height;
      sum += delta;
      for (let at = index + 1; at <= length; at += at & -at) tree[at] += delta;
      return delta;
    },
    /** The sum of the heights before `index`. */
    offset(index) {
      let total = 0;
      for (let at = clamp(index, 0, length); at > 0; at -= at & -at) total += tree[at];
      return total;
    },
    total: () => sum,
    /** The row that holds `offset`; the last row past the end, the first before the start. */
    indexAt(offset) {
      if (!length) return 0;
      if (offset <= 0) return 0;
      let at = 0;
      let left = offset;
      for (let step = top; step > 0; step = Math.floor(step / 2)) {
        const next = at + step;
        if (next <= length && tree[next] <= left) {
          at = next;
          left -= tree[next];
        }
      }
      return Math.min(at, length - 1);
    },
    /** A new length: rows that stay keep their heights. */
    resize(next) {
      const size = Math.max(0, Math.floor(Number(next) || 0));
      const nextValues = new Float64Array(size);
      const nextKnown = new Uint8Array(size);
      const kept = Math.min(size, length);
      nextValues.set(values.subarray(0, kept));
      nextKnown.set(known.subarray(0, kept));
      for (let index = kept; index < size; index += 1) nextValues[index] = guessAt(index);
      values = nextValues;
      known = nextKnown;
      length = size;
      rebuild();
    },
    /** A better estimate: every row not measured yet takes it. */
    estimate(next) {
      guess = next;
      for (let index = 0; index < length; index += 1) if (!known[index]) values[index] = guessAt(index);
      rebuild();
    },
    /** Forgets what was measured. */
    forget() {
      known.fill(0);
      for (let index = 0; index < length; index += 1) values[index] = guessAt(index);
      rebuild();
    },
  };
  model.resize(count);
  return model;
}

/* ── The windowed list ──────────────────────────────── */

/** The live list of each scroller. @type {WeakMap<Element, any>} */
const lists = new WeakMap();

const ARIA_TABLE = '[role="table"], [role="grid"], [role="treegrid"]';

/** The rowgroups directly in an ARIA table, in order. */
const rowgroupsOf = (host) => Array.from(host.children).filter((child) => child.getAttribute('role') === 'rowgroup');

/**
 * The element that holds the rows (see the header). A table found around them
 * resolves to its body, so a header row group is never taken for rows.
 */
function contentOf(scroller, given) {
  const found = given ?? (scroller.matches(ARIA_TABLE) ? scroller : scroller.querySelector(`tbody, ul, ol, [role="list"], [role="listbox"], [role="rowgroup"], ${ARIA_TABLE}`)) ?? scroller;
  if (found.localName === 'table') return found.tBodies?.[0] ?? found.createTBody?.() ?? found;
  return found.matches(ARIA_TABLE) ? rowgroupsOf(found).at(-1) ?? found : found;
}

/** The element a spacer is, for the markup to parse where it goes. */
const SPACER_TAG = { ul: 'li', ol: 'li', menu: 'li', table: 'tr', tbody: 'tr' };

/**
 * Windows the rows of `scroller` (see the header); once per scroller.
 * render(index) returns one row's markup. Events on the scroller, also through
 * on(type, fn): ds:range `{ start, end, count }` when the rendered rows change
 * (load more near the end), ds:active `{ index, element }` when the active row
 * changes. get() returns `{ start, end, count, active }`. set({ count, total,
 * active, forget }) changes them (`forget`: the data is new, forget measured
 * heights). refresh(index) renders one row again, without an index all of them.
 * scrollTo(index, { align }) brings a row into view ('auto', 'start', 'center',
 * 'end') and returns its element, focus(index) also focuses it, row(index) is
 * its element if rendered and indexOf(element) the index of a row or anything
 * in one (else -1).
 * @param {Element|null|undefined} scroller
 * @param {{ render: (index: number) => string, count?: number, estimate?: number|((index: number) => number), overscan?: number, content?: Element, keyboard?: boolean, active?: number, total?: number, rowOffset?: number, columns?: number }} options
 * @returns {{ get: () => { start: number, end: number, count: number, active: number }, set: (value: { count?: number, total?: number|null, active?: number, forget?: boolean }) => void, on: (type: 'range'|'active', fn: (detail: any) => void) => () => void, refresh: (index?: number) => void, scrollTo: (index: number, options?: { align?: 'auto'|'start'|'center'|'end' }) => Element|null, focus: (index: number) => Element|null, row: (index: number) => Element|null, indexOf: (node: Node|null) => number, destroy: () => void }}
 */
export function create(scroller, options = {}) {
  if (!scroller?.ownerDocument) {
    return { get: () => ({ start: 0, end: 0, count: 0, active: 0 }), set() {}, on: () => () => {}, refresh() {}, scrollTo: () => null, focus: () => null, row: () => null, indexOf: () => -1, destroy() {} };
  }
  const existing = lists.get(scroller);
  if (existing) return existing;
  if (typeof options.render !== 'function') throw new TypeError('DS.virtual.create: options.render(index) returns the markup of one row');

  const doc = scroller.ownerDocument;
  const view = doc.defaultView;
  const content = contentOf(scroller, options.content);
  const onDocument = scroller === doc.scrollingElement;
  const overscan = Math.max(0, options.overscan ?? OVERSCAN);
  const keyboard = options.keyboard !== false;
  const host = content.closest('table, [role="table"], [role="grid"], [role="treegrid"]');
  const spacerTag = SPACER_TAG[content.localName] ?? 'div';

  const model = sizes(options.count ?? 0, options.estimate ?? ESTIMATE);
  let guessed = options.estimate !== undefined;
  let total = options.total ?? null;
  let active = clamp(options.active ?? 0, 0, Math.max(0, model.count - 1));
  let start = 0;
  let end = 0;
  /**
   * The row a scrollTo() brought into view, kept there while rows measured
   * later (an estimate that was short: wrapped text, a late font) change the
   * offsets; a scroll the list did not make itself (the person's, the page's)
   * ends it.
   * @type {{ index: number, align: string }|null}
   */
  let kept = null;
  /** Where the list itself last put the scroll: any other place is a scroll by the person or the page. */
  let ownTop = null;
  let announced = '';
  let lastHtml = null;
  let frame = 0;
  let destroyed = false;
  /** The element that holds the focus: when it leaves the document, the focus moves to the active row. */
  let holder = null;
  let holderTimer = 0;

  /** The rendered rows by index, and the way back. */
  let rendered = new Map();
  const indexOfRow = new WeakMap();
  /** The markup of what shows, so a window that moves renders only the new rows. */
  const markup = new Map();
  const decorated = new WeakSet();
  /** Controls taken out of the tab order: control → its tabindex before (null: none). */
  const parked = new WeakMap();

  const rowCount = () => total ?? model.count;
  /** The header above the rows: a thead, or the row group before them in an ARIA table. */
  const headOf = () => host?.tHead ?? (host ? rowgroupsOf(host).find((group) => group !== content && group.compareDocumentPosition(content) & 4) : null) ?? null;
  const rowOffset = () => {
    if (options.rowOffset !== undefined) return options.rowOffset;
    const head = headOf();
    return head ? head.rows?.length ?? head.querySelectorAll('[role="row"]').length : 0;
  };
  const columns = () => {
    if (options.columns) return options.columns;
    const first = host?.tHead?.rows?.[0] ?? host?.rows?.[0];
    return first ? Array.from(first.cells).reduce((sum, cell) => sum + cell.colSpan, 0) || 1 : 1;
  };

  /* Reads. */
  const topOf = () => (onDocument ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop);
  const viewHeight = () => (onDocument ? view.innerHeight : scroller.clientHeight);
  /** Where row 0 starts, in the scroller's content: the first thing in `content` is always at offset 0. */
  const origin = () => {
    let first = content.firstElementChild;
    while (first && (first.hasAttribute('data-ds-keep') || first.hasAttribute('data-ds-leaving'))) first = first.nextElementSibling;
    return (first ?? content).getBoundingClientRect().top - topOf() + scroller.scrollTop;
  };
  /** How much of the head a stuck row would lie under, from the scroller's top; 0 when it does not stick. */
  const stuckHead = () => {
    const head = headOf();
    if (!head) return 0;
    const bottom = head.getBoundingClientRect().height;
    for (const part of [head, ...head.querySelectorAll('tr, th, td, [role="row"], [role="columnheader"]')]) {
      const style = view.getComputedStyle(part);
      if (style.position === 'sticky') return bottom + (parseFloat(style.insetBlockStart) || 0);
    }
    return 0;
  };
  const insets = () => {
    const style = view.getComputedStyle(scroller);
    return [Math.max(parseFloat(style.scrollPaddingBlockStart) || 0, stuckHead()), parseFloat(style.scrollPaddingBlockEnd) || 0];
  };

  /** Which rows belong in the window now. */
  const windowNow = () => {
    if (!model.count) return [0, 0];
    const height = viewHeight();
    const from = Math.max(0, scroller.scrollTop - origin());
    const first = model.indexAt(from);
    if (height <= 0) return [first, Math.min(model.count, first + BLIND_ROWS)];
    const last = model.indexAt(from + height);
    return [Math.max(0, first - overscan), Math.min(model.count, last + 1 + overscan)];
  };

  /** A spacer: hidden, so a row's hover or stripe never paints on it. Its key is its place, so it patches in place. */
  const spacer = (place, px) => {
    const size = `height:${px}px`;
    if (spacerTag === 'tr') return `<tr data-ds-key="ds-virtual-gap-${place}" data-ds-virtual-gap aria-hidden="true" style="${size};visibility:hidden"><td colspan="${columns()}" style="${size};padding:0;border:0"></td></tr>`;
    return `<${spacerTag} data-ds-key="ds-virtual-gap-${place}" data-ds-virtual-gap aria-hidden="true" style="${size};margin:0;padding:0;border:0;visibility:hidden;list-style:none"></${spacerTag}>`;
  };

  const rowMarkup = (index) => {
    if (!markup.has(index)) markup.set(index, String(options.render(index)));
    return markup.get(index);
  };

  /** The markup for `indices` (sorted), with spacers in the gaps. */
  const compose = (indices) => {
    let html = '';
    let cursor = 0;
    let place = 0;
    for (const index of indices) {
      if (index > cursor) {
        html += spacer(place, model.offset(index) - model.offset(cursor));
        place += 1;
      }
      html += rowMarkup(index);
      cursor = index + 1;
    }
    if (cursor < model.count) html += spacer(place, model.total() - model.offset(cursor));
    return html;
  };

  /** Gives the controls of a row back their tabindex. */
  const releaseControls = (row) => {
    for (const control of row.querySelectorAll(ROW_STOP)) {
      if (!parked.has(control)) continue;
      const before = parked.get(control);
      parked.delete(control);
      if (before === null) control.removeAttribute('tabindex');
      else control.setAttribute('tabindex', before);
      disown(control, 'attrs', 'tabindex');
    }
  };

  /** The tab stop of one row: itself and its controls when it is the active one, else neither. */
  const setStop = (row, isActive) => {
    setAttribute(row, 'tabindex', isActive ? '0' : '-1');
    if (isActive) {
      releaseControls(row);
      return;
    }
    for (const control of row.querySelectorAll(ROW_STOP)) {
      const value = control.getAttribute('tabindex');
      // A negative tabindex of the page's own is out of the tab order already.
      if (parked.has(control) || Number(value) < 0) continue;
      parked.set(control, value);
      own(control, 'attrs', 'tabindex');
      control.setAttribute('tabindex', '-1');
    }
  };

  /** ARIA and the tab stop of one row. */
  const decorate = (row, index) => {
    if (!decorated.has(row)) {
      decorated.add(row);
      for (const name of host ? ['aria-rowindex'] : ['aria-setsize', 'aria-posinset']) own(row, 'attrs', name);
      if (keyboard) own(row, 'attrs', 'tabindex');
    }
    if (host) setAttribute(row, 'aria-rowindex', String(rowOffset() + index + 1));
    else {
      setAttribute(row, 'aria-setsize', String(rowCount()));
      setAttribute(row, 'aria-posinset', String(index + 1));
    }
    if (keyboard) setStop(row, index === active);
  };

  /** Patches the DOM to `indices` and records which element is which row. */
  const write = (html, indices) => {
    const top = scroller.scrollTop;
    morphHtml(content, html);
    // Chromium's moveBefore() of a focused row scrolls it into view: the window decides where it is.
    if (scroller.scrollTop !== top) scroller.scrollTop = top;
    ownTop = scroller.scrollTop;
    watcher?.takeRecords();
    lastHtml = html;
    const next = new Map();
    const rows = Array.from(content.children).filter((child) => !child.hasAttribute('data-ds-virtual-gap') && !child.hasAttribute('data-ds-keep') && !child.hasAttribute('data-ds-leaving'));
    if (rows.length !== indices.length) throw new Error(`DS.virtual: render(index) must return one root element per row (${indices.length} rows, ${rows.length} elements)`);
    rows.forEach((row, at) => {
      const index = indices[at];
      next.set(index, row);
      indexOfRow.set(row, index);
      decorate(row, index);
      if (!rendered.has(index) || rendered.get(index) !== row) resizes?.observe(row);
    });
    const kept = new Set(next.values());
    for (const row of rendered.values()) if (!kept.has(row)) resizes?.unobserve(row);
    rendered = next;
    for (const index of [...markup.keys()]) if (!next.has(index)) markup.delete(index);
  };

  /**
   * Takes the heights of what is rendered. A row above the viewport that
   * turned out another height moved what is on screen: the scroll position
   * moves with it. True when anything changed.
   */
  const measure = () => {
    if (!rendered.size) return false;
    if (!guessed && options.estimate === undefined) {
      const first = rendered.values().next().value;
      const height = first.getBoundingClientRect().height;
      if (height > 0) {
        guessed = true;
        model.estimate(height);
      }
    }
    const from = Math.max(0, scroller.scrollTop - origin());
    let shift = 0;
    let changed = false;
    const order = [...rendered.keys()].sort((a, b) => a - b);
    for (const index of order) {
      const height = rendered.get(index).getBoundingClientRect().height;
      const before = model.size(index);
      if (height <= 0 || (Math.abs(height - before) < EPSILON && model.measured(index))) {
        if (height > 0) model.set(index, height);
        continue;
      }
      if (model.offset(index) + before <= from + shift) shift += height - before;
      model.set(index, height);
      changed = true;
    }
    if (Math.abs(shift) >= EPSILON) {
      scroller.scrollTop += shift;
      ownTop = scroller.scrollTop;
    }
    return changed;
  };

  /** Moves the focus to the active row when the row that held it went. */
  const restoreFocus = () => {
    if (!holder || holder.isConnected) return;
    holder = null;
    if (!keyboard) return;
    const row = rendered.get(active);
    if (row) {
      row.focus({ preventScroll: true });
      return;
    }
    // No row left (a filter that matches nothing): the focus stays here rather than at the start of the page.
    const lent = !scroller.hasAttribute('tabindex');
    if (lent) scroller.setAttribute('tabindex', '-1');
    scroller.focus({ preventScroll: true });
    // Until the focus goes elsewhere. Not on blur: Firefox fires none on <html>, the document's scroller.
    if (lent) doc.addEventListener('focusin', () => scroller.removeAttribute('tabindex'), { once: true });
  };

  /** Brings the DOM in line with the scroll position and the data, in as many passes as it takes to settle. */
  let remeasured = false;
  let revealing = false;
  const update = () => {
    if (destroyed) return;
    active = clamp(active, 0, Math.max(0, model.count - 1));
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      [start, end] = windowNow();
      const indices = [];
      for (let index = start; index < end; index += 1) indices.push(index);
      // The active row stays, wherever the window is: focus and the tab stop live there.
      if (model.count && (active < start || active >= end)) {
        if (active < start) indices.unshift(active);
        else indices.push(active);
      }
      const html = compose(indices);
      const wrote = html !== lastHtml;
      if (wrote) write(html, indices);
      const moved = measure();
      if (moved) remeasured = true;
      if (!wrote && !moved) break;
    }
    // Rows measured since a scrollTo() moved its row: back into view (reveal() calls update(), which then finds nothing new).
    if (remeasured && kept && !revealing && kept.index < model.count) {
      remeasured = false;
      revealing = true;
      try {
        reveal(kept.index, kept.align);
      } finally {
        revealing = false;
      }
    }
    remeasured = false;
    restoreFocus();
    const key = `${start}:${end}:${model.count}`;
    if (key !== announced) {
      announced = key;
      emit(scroller, 'range', { start, end, count: model.count });
    }
  };

  const schedule = () => {
    if (frame || destroyed) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      update();
    });
  };

  const setActive = (index) => {
    const next = clamp(index, 0, Math.max(0, model.count - 1));
    if (next === active) return;
    const before = rendered.get(active);
    active = next;
    if (before && keyboard) setStop(before, false);
    const row = rendered.get(active);
    if (row && keyboard) setStop(row, true);
    emit(scroller, 'active', { index: active, element: row ?? null });
  };

  /** The direct child of `content` that holds `node`. */
  const rowOf = (node) => {
    let at = node?.nodeType === 1 ? node : node?.parentElement;
    while (at && at.parentElement !== content) at = at.parentElement;
    return at && indexOfRow.has(at) ? at : null;
  };


  const scrollTo = (index, { align = 'auto' } = {}) => {
    if (!model.count) return null;
    const target = clamp(Math.trunc(index) || 0, 0, model.count - 1);
    kept = null;
    update();
    reveal(target, align);
    kept = { index: target, align };
    return rendered.get(target) ?? null;
  };

  /** Scrolls `target` into view by `align`; each pass measures what it reached, so the offset gets truer until it stops moving. */
  const reveal = (target, align) => {
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const [insetStart, insetEnd] = insets();
      const top = scroller.scrollTop;
      const height = viewHeight();
      // A rendered row where it really is; the model's offset counts estimates for the rows not measured yet.
      const row = rendered.get(target);
      const box = row?.getBoundingClientRect();
      const rowTop = box && box.height > 0 ? box.top - topOf() + scroller.scrollTop : origin() + model.offset(target);
      const rowEnd = rowTop + (box && box.height > 0 ? box.height : model.size(target));
      let goal = top;
      if (align === 'start') goal = rowTop - insetStart;
      else if (align === 'end') goal = rowEnd - height + insetEnd;
      else if (align === 'center') goal = rowTop - (height - model.size(target)) / 2;
      else if (rowTop < top + insetStart) goal = rowTop - insetStart;
      else if (rowEnd > top + height - insetEnd) goal = rowEnd - height + insetEnd;
      if (Math.abs(goal - top) < 1) break;
      scroller.scrollTop = goal;
      ownTop = scroller.scrollTop;
      update();
      // Past the end the engine clamps: no further to go.
      if (Math.abs(scroller.scrollTop - top) < 1) break;
    }
  };

  const focusRow = (index) => {
    if (!model.count) return null;
    const target = clamp(Math.trunc(index) || 0, 0, model.count - 1);
    setActive(target);
    const row = scrollTo(target);
    (row ?? rendered.get(target))?.focus({ preventScroll: true });
    return row ?? null;
  };

  /* Input. */
  const onKey = (/** @type {KeyboardEvent} */ event) => {
    // keyboard: false leaves the keys to the page (a combobox, a data grid).
    if (!keyboard) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target?.matches?.(TEXT_ENTRY)) return;
    const row = rowOf(event.target);
    if (!row) return;
    const from = indexOfRow.get(row);
    const page = Math.max(1, model.indexAt(scroller.scrollTop - origin() + viewHeight()) - model.indexAt(Math.max(0, scroller.scrollTop - origin())));
    const to = { ArrowDown: from + 1, ArrowUp: from - 1, Home: 0, End: model.count - 1, PageDown: from + page, PageUp: from - page }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    focusRow(to);
  };
  const onFocusIn = (/** @type {FocusEvent} */ event) => {
    clearTimeout(holderTimer);
    holder = /** @type {Element} */ (event.target);
    const row = rowOf(event.target);
    if (row) setActive(indexOfRow.get(row));
  };
  // Removing a focused element fires focusout in some engines: the observer's
  // microtask still sees the holder; a real blur lets go after it.
  const onFocusOut = () => {
    clearTimeout(holderTimer);
    holderTimer = setTimeout(() => {
      holder = null;
    });
  };

  const resizes = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(schedule) : null;
  // A morphHtml from outside that emptied or replaced the rows: back before paint.
  const watcher = typeof view.MutationObserver === 'function' ? new view.MutationObserver((records) => {
    if (!records.length || destroyed) return;
    lastHtml = null;
    update();
  }) : null;

  own(scroller, 'props', 'overflow-anchor');
  const anchorBefore = scroller.style.overflowAnchor;
  scroller.style.overflowAnchor = 'none';
  // Firefox makes a scroller a tab stop of its own; the active row is the one stop.
  const scrollerStop = keyboard && !onDocument && !scroller.hasAttribute('tabindex');
  if (scrollerStop) {
    own(scroller, 'attrs', 'tabindex');
    scroller.setAttribute('tabindex', '-1');
  }
  const rowcountBefore = host?.getAttribute('aria-rowcount') ?? null;
  if (host) {
    own(host, 'attrs', 'aria-rowcount');
    setAttribute(host, 'aria-rowcount', String(rowCount() < 0 ? -1 : rowCount() + rowOffset()));
  }

  const scrollTarget = onDocument ? view : scroller;
  // A scroll the list did not make (the page's own scrollTo, a key the browser handles) ends the hold too.
  const onScroll = () => {
    if (kept && ownTop !== null && Math.abs(scroller.scrollTop - ownTop) >= 1) kept = null;
    schedule();
  };
  scrollTarget.addEventListener('scroll', onScroll, { passive: true });
  // A person's own scroll (wheel, finger, the scrollbar) ends the hold of the last scrollTo().
  const release = () => { kept = null; };
  for (const type of TAKE_OVER) scrollTarget.addEventListener(type, release, { passive: true });
  // <html> is as tall as its content, so the observer below never sees the viewport change.
  if (onDocument) view.addEventListener('resize', schedule);
  content.addEventListener('keydown', onKey);
  content.addEventListener('focusin', onFocusIn);
  content.addEventListener('focusout', onFocusOut);
  resizes?.observe(scroller);
  watcher?.observe(content, { childList: true });

  const controller = {
    get: () => ({ start, end, count: model.count, active }),
    set(value = {}) {
      // New rows (a filter, other data): the row a scrollTo() held is not that row any more.
      if ((value.count !== undefined && value.count !== model.count) || value.forget) kept = null;
      if (value.count !== undefined) model.resize(value.count);
      if (value.total !== undefined) total = value.total;
      if (value.forget) {
        model.forget();
        markup.clear();
      }
      if (host) setAttribute(host, 'aria-rowcount', String(rowCount() < 0 ? -1 : rowCount() + rowOffset()));
      if (value.active !== undefined) setActive(value.active);
      // The sizes may have changed for the rows that stay.
      for (const [index, row] of rendered) decorate(row, index);
      update();
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === scroller) fn(event.detail);
      };
      scroller.addEventListener(`ds:${type}`, listener);
      return () => scroller.removeEventListener(`ds:${type}`, listener);
    },
    refresh(index) {
      if (index === undefined) markup.clear();
      else markup.delete(index);
      lastHtml = null;
      update();
    },
    scrollTo,
    focus: focusRow,
    row: (index) => rendered.get(index) ?? null,
    indexOf(node) {
      const row = rowOf(node);
      return row ? indexOfRow.get(row) : -1;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lists.delete(scroller);
      if (frame) view.cancelAnimationFrame(frame);
      clearTimeout(holderTimer);
      scrollTarget.removeEventListener('scroll', onScroll);
      for (const type of TAKE_OVER) scrollTarget.removeEventListener(type, release);
      if (onDocument) view.removeEventListener('resize', schedule);
      content.removeEventListener('keydown', onKey);
      content.removeEventListener('focusin', onFocusIn);
      content.removeEventListener('focusout', onFocusOut);
      resizes?.disconnect();
      watcher?.disconnect();
      scroller.style.overflowAnchor = anchorBefore;
      disown(scroller, 'props', 'overflow-anchor');
      if (scrollerStop) {
        scroller.removeAttribute('tabindex');
        disown(scroller, 'attrs', 'tabindex');
      }
      // What the system said about the rows is untrue once they stop being windowed.
      if (host) {
        if (rowcountBefore === null) host.removeAttribute('aria-rowcount');
        else host.setAttribute('aria-rowcount', rowcountBefore);
        disown(host, 'attrs', 'aria-rowcount');
      }
      for (const row of rendered.values()) {
        for (const name of host ? ['aria-rowindex'] : ['aria-setsize', 'aria-posinset']) {
          row.removeAttribute(name);
          disown(row, 'attrs', name);
        }
        if (keyboard) {
          releaseControls(row);
          row.removeAttribute('tabindex');
          disown(row, 'attrs', 'tabindex');
        }
      }
      for (const gap of Array.from(content.children)) if (gap.hasAttribute('data-ds-virtual-gap')) gap.remove();
    },
  };
  lists.set(scroller, controller);
  update();
  return controller;
}
