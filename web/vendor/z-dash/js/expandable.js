/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Expandable text (DS.expandable): a long text shows its first lines and a
 * "Show more" button; the button shows only while the text is longer than
 * those lines.
 *
 *   <div class="ds-expandable" data-ds-expandable>
 *     <div class="ds-expandable__text">A description of many lines ...</div>
 *   </div>
 *   const more = DS.expandable.create(el);   more.set(true);   more.get();   true
 *
 * The module gives the text an id (unless it has one) and adds the toggle
 * after it: <button class="ds-link-btn ds-expandable__toggle" type="button"
 * aria-expanded="false" aria-controls="..."> with the strings showMore and
 * showLess. It writes data-state="closed" or "open" on the element; the
 * stylesheet clamps the text to --ds-expandable-lines (3) only while closed,
 * so without the script the whole text shows. data-ds-expandable="open"
 * starts open.
 *
 * Whether the text is longer than its lines is measured again when its
 * width or its content changes: a text that fits hides the toggle (and is
 * neither open nor closed for the reader). Every expandable text of the
 * page is measured in one batch (one ResizeObserver, every unclamp, then
 * every read, then every state), so a page of hundreds costs one layout
 * per resize, not one per text; opening and closing measure nothing.
 * Opening keeps focus on the toggle, so Tab goes on from it; the text is
 * read whole by a screen reader in both states (the clamp is visual).
 *
 * The controller: get() gives whether it is open, set(open) opens or
 * closes it, on('change', fn) runs with { open }, update() measures again,
 * destroy() removes the toggle and the state. Events: ds:change.
 *
 * ES2022. Progressive:
 * - ResizeObserver: without it the toggle is decided once, at start and on
 *   update().
 */
import { define, emit, t } from './core.js';

let uid = 0;

/**
 * Whether a text clamped to its lines hides some of them: its full height
 * is more than `lines` lines (half a line of slack for rounding).
 * @param {number} fullHeight
 * @param {number} lineHeight
 * @param {number} lines
 * @returns {boolean}
 */
export function overflows(fullHeight, lineHeight, lines) {
  if (!(lineHeight > 0) || !(lines > 0)) return false;
  return fullHeight > lineHeight * (lines + 0.5);
}

/** The border-box inline size as the ResizeObserver reports it. */
function inlineOf(record) {
  const box = record.borderBoxSize;
  const first = Array.isArray(box) || (box && typeof box.length === 'number') ? box[0] : box;
  return first?.inlineSize ?? record.contentRect.width;
}

/** The batch of each window: the texts to measure, the observer and the width it last measured each at. */
const batches = new WeakMap();

function batchOf(view) {
  let batch = batches.get(view);
  if (batch) return batch;
  batch = { dirty: new Set(), all: new Set(), queued: false, owners: new Map(), seen: new WeakMap(), observer: null };
  if (typeof view.ResizeObserver === 'function') {
    batch.observer = new view.ResizeObserver((records) => {
      for (const record of records) {
        // Its own clamp changes only its height: a width it was measured at measures nothing.
        const size = inlineOf(record);
        const seen = batch.seen.get(record.target);
        if (seen !== undefined && Math.abs(seen - size) < 0.5) continue;
        batch.seen.set(record.target, size);
        const one = batch.owners.get(record.target);
        if (one) batch.dirty.add(one);
      }
      flush(batch);
    });
  }
  // A font that loaded wraps every text again.
  view.document?.fonts?.addEventListener?.('loadingdone', () => {
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

/** Every dirty text: unclamped, read, then its state written. */
function flush(batch) {
  batch.queued = false;
  const list = [...batch.dirty].filter((one) => one.live());
  batch.dirty.clear();
  for (const one of list) one.prepare();
  for (const one of list) one.read();
  for (const one of list) one.write();
}

function controller(el, given, now = false) {
  const doc = el.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const batch = batchOf(view);
  const listeners = new Set();
  const text = el.querySelector('.ds-expandable__text') ?? el;
  let open = given.open ?? el.getAttribute('data-ds-expandable') === 'open';
  let live = true;
  let addedId = false;
  if (!text.id) {
    uid += 1;
    text.id = `ds-expandable-${uid}`;
    addedId = true;
  }
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ds-link-btn ds-expandable__toggle';
  toggle.setAttribute('aria-controls', text.id);
  if (text !== el) text.after(toggle);
  else el.append(toggle);

  const linesOf = () => {
    const read = Number.parseFloat(view.getComputedStyle(el).getPropertyValue('--ds-expandable-lines'));
    return Number.isFinite(read) && read > 0 ? read : 3;
  };

  /** Whether the text is longer than its lines, as last measured. */
  let long = false;

  /** The state of the element and the toggle from `long` and `open`; writes only what changed. */
  const apply = () => {
    if (toggle.hidden !== !long) toggle.hidden = !long;
    const state = long ? (open ? 'open' : 'closed') : null;
    if (state === null) el.removeAttribute('data-state');
    else if (el.getAttribute('data-state') !== state) el.setAttribute('data-state', state);
    toggle.setAttribute('aria-expanded', String(open || !long));
    const label = t(open ? 'showLess' : 'showMore');
    if (toggle.textContent !== label) toggle.textContent = label;
  };

  /** The full height of the text: measured unclamped, in the same frame (the batch does every one at once). */
  const one = {
    live: () => live,
    prepare() {
      el.setAttribute('data-state', 'measuring');
    },
    read() {
      const full = text.scrollHeight;
      const line = Number.parseFloat(view.getComputedStyle(text).lineHeight) || 0;
      long = overflows(full, line, linesOf());
      batch.seen.set(el, el.getBoundingClientRect().width);
    },
    write() {
      apply();
    },
  };

  const measure = () => {
    if (!live) return;
    batch.dirty.add(one);
    flush(batch);
  };

  const flip = () => api.set(!open);
  toggle.addEventListener('click', flip);
  // A new text (a re-render) is measured again; the toggle and the state are ours.
  const watcher = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {
    if (live) schedule(batch, one);
  }) : null;
  if (text !== el) watcher?.observe(text, { childList: true, characterData: true, subtree: true });
  batch.all.add(one);
  batch.owners.set(el, one);
  batch.observer?.observe(el);
  // From the page (create()): measured at once, with whatever else waits.
  if (now) measure();
  else schedule(batch, one);

  const api = {
    get() {
      return open;
    },
    set(next) {
      const value = Boolean(next);
      if (value === open) return;
      open = value;
      if (batch.dirty.has(one)) flush(batch);
      else apply();
      emit(el, 'change', { open });
      for (const fn of [...listeners]) fn({ open });
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      measure();
    },
    destroy() {
      if (!live) return;
      live = false;
      watcher?.disconnect();
      batch.dirty.delete(one);
      batch.all.delete(one);
      batch.owners.delete(el);
      batch.observer?.unobserve(el);
      toggle.removeEventListener('click', flip);
      toggle.remove();
      el.removeAttribute('data-state');
      if (addedId) text.removeAttribute('id');
      listeners.clear();
    },
  };
  return api;
}

define('expandable', {
  attribute: 'data-ds-expandable',
  init(el) {
    return controller(el, {});
  },
});

/**
 * Expandable text driven from the page; the same controller the attribute path makes.
 * @param {Element} el
 * @param {{ open?: boolean }} [options]
 */
export function create(el, options = {}) {
  return controller(el, options, true);
}
