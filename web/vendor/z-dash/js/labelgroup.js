/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Label group (DS.labelgroup): the tags of one item on one line, as many
 * as fit, then a "+N" button that shows all of them in a popup.
 *
 *   <div class="ds-label-group" data-ds-label-group [data-ds-label-group-max="3"]>
 *     <ul class="ds-label-group__list" aria-label="Labels of ticket 42"><li><span class="ds-tag">Printer</span></li>...</ul>
 *   </div>
 *   const labels = DS.labelgroup.create(group, { max: 3 });   labels.set(true);   // the popup open
 *   DS.labelgroup.visibleCount([60, 80, 70], 200, 32, 4);      2
 *
 * It measures the tags once they show, keeps those that fit on the line
 * (at most data-ds-label-group-max) and hides the others; again when the
 * group's size changes (ResizeObserver) and when the page re-renders the
 * list (DS.dom.morphHtml). Every group of the page is measured in one
 * batch (reads before writes) and each tag's width is kept until the list
 * changes, so a table column of groups costs a layout or two per resize.
 * One tag left alone in too little room ends in an ellipsis. The button
 * (.ds-label-group__more, a .ds-btn) says "+N" and, for a screen reader,
 * how many there are in all; it opens the popup (.ds-label-group__popup,
 * role="dialog", named like the list) with every tag again, through
 * DS.overlay: Escape closes it and focus goes back to the button; a
 * pointerdown outside it or focus that leaves it closes it.
 * The popup is placed at the button by DS.position: anchored in the top
 * layer where the engine can, else by --ds-label-group-x/-y.
 *
 * The tags in the popup are copies (without ids): a page that acts on a
 * tag (a link, a filter) listens on the document or uses links.
 *
 * The controller: get() gives { total, hidden, open }, set(open) opens or
 * closes the popup, on('change', fn) runs when the hidden count or the
 * popup changes, update() measures again, destroy() shows every tag and
 * takes the button and the popup away. Events: ds:change ({ total,
 * hidden, open }) on the group.
 *
 * ES2022. Progressive: CSS anchor positioning (DS.position decides);
 * focus({ focusVisible }) (the popup takes focus without the keyboard ring
 * after a click): without it the engine decides whether the ring shows.
 */
import { define, emit, get, runtime, t } from './core.js';
import { open as openOverlay, close as closeOverlay } from './overlay.js';
import { anchorPopup, place, pxOf, releaseAnchor, supportsAnchoring } from './position.js';

/** The page's label groups: the numbering of popups and anchors, and the open popups. */
const shared = runtime.state('labelgroup', () => ({ seq: 0, open: new Map() }));

/**
 * How many tags of `widths` fit in `room` px: all of them when they fit
 * without the button, else as many as fit beside a button `more` px wide,
 * `gap` px apart; at most `max`, at least one (it may end in an ellipsis).
 * @param {number[]} widths
 * @param {number} room
 * @param {number} more
 * @param {number} gap
 * @param {number} [max]
 * @returns {number}
 */
export function visibleCount(widths, room, more, gap, max = Infinity) {
  const total = widths.length;
  if (!total) return 0;
  const cap = Math.max(1, Math.min(total, Math.floor(Number.isFinite(max) && max >= 0 ? max : total)));
  const span = (n) => widths.slice(0, n).reduce((sum, width) => sum + width, 0) + gap * Math.max(0, n - 1);
  if (cap === total && span(total) <= room + 0.5) return total;
  for (let n = cap; n > 1; n -= 1) {
    if (span(n) + gap + more <= room + 0.5) return n;
  }
  return 1;
}

/* Measuring. Every group that needs measuring (at the start, on a resize,
   after a re-render) joins one batch per window: one ResizeObserver for
   all of them, a microtask after DS.init() or a re-render. The batch reads
   every group before it writes any, so a column of five hundred groups
   costs a layout or two, not one per group; the width of each tag is kept
   until the list changes or a tag shows another width (a size class, a
   font that loaded). */

/** The border-box size [inline, block] as the ResizeObserver reports it. */
function sizeOf(record) {
  const box = record.borderBoxSize;
  const first = Array.isArray(box) || (box && typeof box.length === 'number') ? box[0] : box;
  return first ? [first.inlineSize, first.blockSize] : [record.contentRect.width, record.contentRect.height];
}

/** The batch of each window: the groups to measure, every group, the observer and the sizes it last saw. */
const batches = new WeakMap();

function batchOf(view) {
  let batch = batches.get(view);
  if (batch) return batch;
  batch = { dirty: new Set(), all: new Set(), owners: new Map(), queued: false, seen: new WeakMap(), observer: null };
  if (typeof view.ResizeObserver === 'function') {
    batch.observer = new view.ResizeObserver((records) => {
      for (const record of records) {
        const [inline, block] = sizeOf(record);
        const seen = batch.seen.get(record.target);
        // The size of the last measuring: nothing changed.
        if (seen && Math.abs(seen[0] - inline) < 0.5 && Math.abs(seen[1] - block) < 0.5) continue;
        batch.seen.set(record.target, [inline, block]);
        const one = batch.owners.get(record.target);
        if (one) batch.dirty.add(one);
      }
      flush(batch);
    });
  }
  // A font that loaded changes every tag's width.
  view.document?.fonts?.addEventListener?.('loadingdone', () => {
    for (const one of batch.all) one.stale();
    for (const one of batch.all) batch.dirty.add(one);
    flush(batch);
  });
  batches.set(view, batch);
  return batch;
}

/** Measures the batch soon (a microtask: after DS.init() or a re-render has made all of them). */
function schedule(batch, one) {
  batch.dirty.add(one);
  if (batch.queued) return;
  batch.queued = true;
  queueMicrotask(() => {
    if (batch.queued) flush(batch);
  });
}

/** Every dirty group: reads (free in a ResizeObserver callback), writes, reads, writes. */
function flush(batch) {
  batch.queued = false;
  const list = [...batch.dirty].filter((one) => one.live());
  batch.dirty.clear();
  for (const one of list) one.probe();
  for (const one of list) one.prepare();
  for (const one of list) one.read();
  for (const one of list) one.write();
}

function controller(el, given, now = false) {
  const doc = el.ownerDocument;
  const view = doc?.defaultView ?? globalThis;
  const batch = batchOf(view);
  const listeners = new Set();
  let live = true;
  let hiddenCount = 0;
  let isOpen = false;
  let anchored = null;
  const id = `ds-label-group-${shared.seq += 1}`;

  const list = () => el.querySelector(':scope > .ds-label-group__list');
  const items = () => [...(list()?.children ?? [])];
  const max = () => {
    const named = given.max ?? el.getAttribute('data-ds-label-group-max');
    const value = Number.parseInt(String(named ?? ''), 10);
    return Number.isFinite(value) && value >= 0 ? value : Infinity;
  };
  const name = () => list()?.getAttribute('aria-label') || t('labelGroupAll');

  const more = doc.createElement('button');
  more.type = 'button';
  more.className = 'ds-btn ds-btn--tonal ds-label-group__more';
  more.setAttribute('aria-haspopup', 'dialog');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-controls', `${id}-popup`);
  const count = doc.createElement('span');
  count.setAttribute('aria-hidden', 'true');
  more.append(count);
  more.hidden = true;

  const popup = doc.createElement('div');
  popup.className = 'ds-label-group__popup';
  popup.id = `${id}-popup`;
  popup.setAttribute('role', 'dialog');
  popup.tabIndex = -1;
  popup.hidden = true;
  const all = doc.createElement('ul');
  all.className = 'ds-label-group__all';
  popup.append(all);
  el.append(more, popup);

  const tell = () => {
    const detail = { total: items().length, hidden: hiddenCount, open: isOpen };
    emit(el, 'change', detail);
    for (const fn of [...listeners]) fn(detail);
  };

  const label = (hidden, total) => {
    const shown = `+${hidden}`;
    if (count.textContent !== shown) count.textContent = shown;
    const name = t('labelGroupMore', { count: hidden, total });
    if (more.getAttribute('aria-label') !== name) more.setAttribute('aria-label', name);
  };

  /** The widths of the tags and of the widest button, kept until the list changes or a tag shows another width. */
  let sizes = null;
  /** One measuring: the tags, whether they are measured afresh, the room and the gap. */
  let pass = null;

  const box = () => el.getBoundingClientRect();

  const one = {
    live: () => live,
    stale() {
      sizes = null;
    },
    probe() {
      const tags = items();
      pass = { tags, fresh: false, measured: false, room: 0, gap: 0 };
      if (!el.isConnected || !tags.length) {
        sizes = null;
        return;
      }
      const valid = sizes && sizes.total === tags.length && !(sizes.capped && Math.abs(sizes.room - el.clientWidth) >= 0.5)
        && tags.every((item, index) => item.hidden || Math.abs(item.getBoundingClientRect().width - sizes.widths[index]) < 0.5);
      if (!valid) {
        pass.fresh = true;
        return;
      }
      pass.measured = true;
      pass.room = el.clientWidth;
      pass.gap = parseFloat(view.getComputedStyle(el).columnGap) || 0;
      const rect = box();
      batch.seen.set(el, [rect.width, rect.height]);
    },
    prepare() {
      if (!pass.fresh) return;
      for (const item of pass.tags) item.hidden = false;
      // The widest the button gets: "+N" of every tag.
      label(pass.tags.length, pass.tags.length);
      more.hidden = false;
    },
    read() {
      if (!pass.fresh) return;
      const { tags } = pass;
      const widths = tags.map((item) => item.getBoundingClientRect().width);
      const strip = list();
      const style = view.getComputedStyle(strip);
      // A tag as wide as the list is capped by it: its width holds only for this room.
      const inner = strip.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      pass.measured = true;
      pass.room = el.clientWidth;
      pass.gap = parseFloat(view.getComputedStyle(el).columnGap) || 0;
      sizes = { total: tags.length, widths, button: more.getBoundingClientRect().width, room: pass.room, capped: widths.some((width) => width >= inner - 0.5) };
      const rect = box();
      batch.seen.set(el, [rect.width, rect.height]);
    },
    write() {
      if (!pass) return;
      const { tags, measured, room, gap } = pass;
      pass = null;
      const before = hiddenCount;
      const shown = measured && sizes ? visibleCount(sizes.widths, room, sizes.button, gap, max()) : tags.length;
      tags.forEach((item, index) => {
        const hide = index >= shown;
        if (item.hidden !== hide) item.hidden = hide;
      });
      hiddenCount = tags.length - shown;
      label(hiddenCount, tags.length);
      if (more.hidden !== (hiddenCount === 0)) more.hidden = hiddenCount === 0;
      if (!hiddenCount && isOpen) api.set(false);
      watcher?.takeRecords();
      if (hiddenCount !== before) tell();
    },
  };

  const measure = () => {
    if (!live) return;
    batch.dirty.add(one);
    flush(batch);
  };

  /** Every tag again, copied into the popup (ids dropped: they are the page's). */
  const fill = () => {
    const copies = items().map((item) => {
      const copy = /** @type {Element} */ (item.cloneNode(true));
      copy.removeAttribute('hidden');
      copy.removeAttribute('id');
      for (const inner of copy.querySelectorAll('[id]')) inner.removeAttribute('id');
      return copy;
    });
    all.replaceChildren(...copies);
    popup.setAttribute('aria-label', name());
  };

  const release = () => {
    if (anchored) releaseAnchor(anchored);
    anchored = null;
    if (popup.hasAttribute('popover')) {
      try {
        popup.hidePopover();
      } catch {
        // Not open.
      }
      popup.removeAttribute('popover');
    }
    popup.removeAttribute('data-anchored');
    popup.removeAttribute('data-placement');
    popup.style.removeProperty('position-anchor');
  };

  const show = () => {
    fill();
    // At rest size and closed, then placed at the button; DS.overlay
    // takes it from there (the origin, the entrance, focus, Escape).
    popup.setAttribute('data-state', 'closed');
    popup.hidden = false;
    const offset = pxOf(popup, '--ds-space-1', 4);
    if (supportsAnchoring(view)) {
      if (anchorPopup(popup, more, { nextName: () => `--ds-label-group-anchor-${shared.seq += 1}`, offset })) anchored = more;
    } else {
      place(popup, more, { offset, padding: pxOf(popup, '--ds-space-2', 8), crossFlip: true, x: '--ds-label-group-x', y: '--ds-label-group-y' });
    }
    isOpen = true;
    shared.open.set(popup, { more, close: () => api.set(false) });
    // The ring shows when the button showed it (opened by a key).
    const ring = more.matches(':focus-visible');
    openOverlay(popup, { opener: more });
    // A popup of DS.overlay keeps focus where it is; this one is a
    // dialog, so focus moves into it (Escape gives it back).
    popup.focus({ preventScroll: true, focusVisible: ring });
    tell();
  };

  const hide = () => {
    isOpen = false;
    shared.open.delete(popup);
    closeOverlay(popup);
    tell();
  };

  const onClick = () => api.set(!isOpen);
  more.addEventListener('click', onClick);
  // Focus that leaves the popup (Tab on, a click elsewhere) closes it; to
  // its own button it stays, which closes it on the next press.
  const onFocusOut = (event) => {
    const next = /** @type {Node|null} */ (event.relatedTarget);
    if (isOpen && next && !popup.contains(next) && next !== more) api.set(false);
  };
  popup.addEventListener('focusout', onFocusOut);

  // Closed by DS.overlay itself (Escape): the state follows; once hidden,
  // out of the top layer.
  const popupWatch = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {
    if (!popup.hidden) return;
    release();
    if (isOpen) {
      isOpen = false;
      shared.open.delete(popup);
      tell();
    }
  }) : null;
  popupWatch?.observe(popup, { attributes: true, attributeFilter: ['hidden'] });
  const onClose = () => {
    if (!isOpen) return;
    isOpen = false;
    shared.open.delete(popup);
    tell();
  };
  popup.addEventListener('ds:close', onClose);

  // A re-render of the list: its tags are measured afresh, with every other group that waits.
  const watcher = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {
    if (!live) return;
    sizes = null;
    schedule(batch, one);
  }) : null;
  batch.all.add(one);
  batch.owners.set(el, one);
  batch.observer?.observe(el);

  const api = {
    get() {
      if (batch.dirty.has(one)) flush(batch);
      return { total: items().length, hidden: hiddenCount, open: isOpen };
    },
    set(next) {
      if (!live) return;
      if (batch.dirty.has(one)) flush(batch);
      if (next && !isOpen && hiddenCount) show();
      else if (!next && isOpen) hide();
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      sizes = null;
      measure();
    },
    destroy() {
      if (!live) return;
      if (isOpen) hide();
      live = false;
      watcher?.disconnect();
      batch.dirty.delete(one);
      batch.all.delete(one);
      batch.owners.delete(el);
      batch.observer?.unobserve(el);
      popupWatch?.disconnect();
      shared.open.delete(popup);
      release();
      more.removeEventListener('click', onClick);
      popup.removeEventListener('focusout', onFocusOut);
      popup.removeEventListener('ds:close', onClose);
      for (const item of items()) item.hidden = false;
      more.remove();
      popup.remove();
      listeners.clear();
    },
  };

  // From the page (create()): measured at once, with whatever else waits.
  if (now) measure();
  else schedule(batch, one);
  const target = list();
  if (target) watcher?.observe(target, { childList: true, subtree: true, characterData: true });
  return api;
}

/** A pointerdown outside an open popup and its button closes it. */
function outside(root) {
  const onDown = (event) => {
    const path = event.composedPath?.() ?? [event.target];
    for (const [popup, entry] of [...shared.open]) {
      if (!path.includes(popup) && !path.includes(entry.more)) entry.close();
    }
  };
  root.addEventListener('pointerdown', onDown, true);
  return () => root.removeEventListener('pointerdown', onDown, true);
}

define('labelgroup', {
  attribute: 'data-ds-label-group',
  attributes: ['data-ds-label-group-max'],
  global: outside,
  init(el) {
    return controller(el, {});
  },
});

/**
 * A label group driven from the page; the same controller the attribute
 * path makes (that one itself when DS.init() already made it).
 * @param {Element} el the .ds-label-group
 * @param {{ max?: number }} [options]
 */
export function create(el, options = {}) {
  return get(el, 'labelgroup') ?? controller(el, options, true);
}
