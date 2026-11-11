/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Truncate (DS.truncate): a text too long for its place is cut at its end,
 * its start or its middle with an ellipsis, and shows whole in a tooltip
 * while it is cut. A screen reader always reads it whole.
 *
 *   <span class="ds-truncate" data-ds-truncate="middle">inventory-export-2026-11-04-final.csv</span>
 *   <a class="ds-truncate" data-ds-truncate="start" href="...">/devices/north/floor-2/printer-7</a>
 *   const cut = DS.truncate.create(el, { position: 'middle' });
 *   DS.truncate.fit('abcdefghij', 'middle', (text) => text.length <= 7);   'abc…hij'
 *
 * Positions: `end` (default) is CSS alone (text-overflow), the module only
 * writes the tip while the text is cut. `start` keeps the end (a path, the
 * last part of a breadcrumb); `middle` keeps both ends (a file name with its
 * extension, an ID that differs at the end). For those the module cuts the
 * text itself, as many characters (graphemes) as fit, on every resize. It
 * sizes the candidates on a canvas in the element's font, never with a
 * layout per candidate: every text that needs measuring joins one batch
 * per window (one ResizeObserver for all of them, a microtask after
 * DS.init() or a re-render) that writes, reads, writes and checks once, so
 * a list of a thousand file names costs a few layouts, not thousands:
 *
 *   <span class="ds-truncate" data-ds-truncate="middle" data-tip="inventory-export-2026-11-04-final.csv">
 *     <span class="ds-truncate__shown" aria-hidden="true">inventory-ex…final.csv</span>
 *     <span class="ds-sr">inventory-export-2026-11-04-final.csv</span></span>
 *
 * The whole text: the element's text when the behaviour starts, or
 * data-ds-truncate-text. A re-render (DS.dom.morphHtml) that writes a new
 * text into the element is taken as the new whole text. data-tip is owned
 * state, written only while the text is cut and only when the page wrote
 * no tip of its own.
 *
 * The controller: get() gives { text, shown, cut }, set(text) writes a new
 * whole text, on('change', fn) runs when the cut changed, update() measures
 * again, destroy() puts the whole text back.
 *
 * ES2022. Progressive:
 * - Intl.Segmenter (cuts between graphemes, so an emoji or an accented
 *   letter stays whole): without it the text is cut between code points.
 * - ResizeObserver: without it the text is cut once, at start and on
 *   update().
 * - A 2D canvas (measureText): without it the layout decides, one
 *   candidate at a time.
 */
import { define, emit } from './core.js';
import { own, disown } from './dom.js';

const POSITIONS = Object.freeze(['end', 'start', 'middle']);
const ELLIPSIS = '…';

/** The graphemes of a text (code points where Intl.Segmenter is missing). */
let segmenter = null;

function graphemes(text) {
  if (typeof Intl.Segmenter !== 'function') return Array.from(text);
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** cut() on a text split into graphemes already. */
function cutParts(parts, keep, position) {
  if (keep >= parts.length) return parts.join('');
  const n = Math.max(0, Math.floor(keep));
  if (position === 'start') return ELLIPSIS + parts.slice(parts.length - n).join('').trimStart();
  if (position === 'middle') {
    const head = Math.ceil(n / 2);
    const tail = n - head;
    return parts.slice(0, head).join('').trimEnd() + ELLIPSIS + (tail ? parts.slice(parts.length - tail).join('').trimStart() : '');
  }
  return parts.slice(0, n).join('').trimEnd() + ELLIPSIS;
}

/** How many graphemes of `parts` stay in the longest cut that fits (all of them when the text fits whole). */
function keepParts(parts, position, fits) {
  if (fits(parts.join(''))) return parts.length;
  return largest(parts.length, (keep) => fits(cutParts(parts, keep, position)));
}

/**
 * `text` with `keep` graphemes kept around an ellipsis at `position`.
 * @param {string} text
 * @param {number} keep
 * @param {'end'|'start'|'middle'} [position]
 * @returns {string}
 */
export function cut(text, keep, position = 'end') {
  return cutParts(graphemes(String(text ?? '')), keep, position);
}

/**
 * The longest cut of `text` at `position` for which `fits(shown)` is true
 * (a binary search over how many graphemes stay): the text itself when it
 * fits whole, else at least the ellipsis.
 * @param {string} text
 * @param {'end'|'start'|'middle'} position
 * @param {(shown: string) => boolean} fits
 * @returns {string}
 */
export function fit(text, position, fits) {
  const parts = graphemes(String(text ?? ''));
  return cutParts(parts, keepParts(parts, position, fits), position);
}

/* Measuring. A cut is sized on a canvas (the advance of each grapheme,
   scaled to the layout of the whole text), never by a layout per
   candidate: every text that needs measuring (at the start, on a resize,
   after a re-render) joins one batch per window, which writes the whole
   texts, reads every width in one layout, writes every cut, and reads
   once more to check them. A cut that overflows a narrower room needs no
   whole text: its room is its width. One ResizeObserver per window watches
   every element and its container; a size the batch itself left behind
   measures nothing. */

/** The 2D context that sizes the candidates, one per document (null without a canvas: the layout decides). */
const contexts = new WeakMap();

function contextOf(doc) {
  if (!contexts.has(doc)) {
    let context = null;
    try {
      context = doc.createElement('canvas').getContext?.('2d') ?? null;
    } catch {
      context = null;
    }
    contexts.set(doc, context);
  }
  return contexts.get(doc);
}

/** The advance of each grapheme by font, measured once: a cut is a sum of them. */
const advances = new Map();

/** The width of every grapheme of `parts` in `font` (text-transform applied), from the cache. */
function advancesOf(context, font, transform, parts) {
  let known = advances.get(font);
  if (!known) {
    known = new Map();
    advances.set(font, known);
  }
  if (context.font !== font) context.font = font;
  return parts.map((part) => {
    let width = known.get(part);
    if (width === undefined) {
      width = context.measureText(transform(part)).width;
      known.set(part, width);
    }
    return width;
  });
}

/** The largest n in [0, total - 1] for which fits(n) holds (0 when none does). */
function largest(total, fits) {
  let low = 0;
  let high = total - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Writes a text into an element: the text node's data when it has one, nothing when it is the same. */
function setText(node, value) {
  const first = node.firstChild;
  if (first && first === node.lastChild && first.nodeType === 3) {
    if (first.data !== value) first.data = value;
  } else if (node.textContent !== value) {
    node.textContent = value;
  }
}

/** The canvas font of a computed style (font-stretch left out: a percentage breaks the shorthand). */
function fontOf(style) {
  const variant = style.fontVariantCaps === 'small-caps' ? 'small-caps ' : '';
  return `${style.fontStyle} ${variant}${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

/** A grapheme as it is drawn, for text-transform (capitalize is left to the ratio of the whole text). */
function transformOf(style) {
  if (style.textTransform === 'uppercase') return (text) => text.toUpperCase();
  if (style.textTransform === 'lowercase') return (text) => text.toLowerCase();
  return (text) => text;
}

/** The border-box inline size as the ResizeObserver reports it. */
function sizeOf(record) {
  const box = record.borderBoxSize;
  const first = Array.isArray(box) || (box && typeof box.length === 'number') ? box[0] : box;
  return first?.inlineSize ?? record.contentRect.width;
}

/** The batch of each window: the dirty controllers, the observer and what it watches. */
const batches = new WeakMap();

function batchOf(view) {
  let batch = batches.get(view);
  if (batch) return batch;
  batch = { dirty: new Set(), all: new Set(), queued: false, targets: new Map(), seen: new WeakMap(), observer: null };
  if (typeof view.ResizeObserver === 'function') {
    batch.observer = new view.ResizeObserver((records) => {
      for (const record of records) {
        const size = sizeOf(record);
        const seen = batch.seen.get(record.target);
        // The size the last cut left: nothing to measure.
        if (seen !== undefined && Math.abs(seen - size) < 0.5) continue;
        batch.seen.set(record.target, size);
        for (const one of batch.targets.get(record.target) ?? []) batch.dirty.add(one);
      }
      flush(batch);
    });
  }
  // A font that loaded draws every grapheme at another width.
  view.document?.fonts?.addEventListener?.('loadingdone', () => {
    advances.clear();
    for (const one of batch.all) one.stale();
    for (const one of batch.all) batch.dirty.add(one);
    flush(batch);
  });
  batches.set(view, batch);
  return batch;
}

function watch(batch, target, one) {
  if (!batch.observer || !target) return;
  const list = batch.targets.get(target) ?? new Set();
  if (!list.size) batch.observer.observe(target);
  list.add(one);
  batch.targets.set(target, list);
}

function unwatch(batch, target, one) {
  const list = target ? batch.targets.get(target) : null;
  if (!list) return;
  list.delete(one);
  if (!list.size) {
    batch.targets.delete(target);
    batch.observer?.unobserve(target);
  }
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

/**
 * Every dirty controller of the batch: reads, writes, reads, writes, then
 * one read to check. A cut that overflows its narrowed room knows that room
 * at once (in a ResizeObserver callback the layout is clean, so the first
 * reads are free); the others show their whole text first to find it.
 */
function flush(batch) {
  batch.queued = false;
  const list = [...batch.dirty].filter((one) => one.live());
  batch.dirty.clear();
  if (!list.length) return;
  for (const one of list) one.probe();
  for (const one of list) one.prepare();
  for (const one of list) one.read();
  for (const one of list) one.write();
  // The canvas and the layout may differ by a fraction of a pixel: a cut
  // that still overflows loses one more grapheme, all of them per round.
  let over = list.filter((one) => one.check());
  for (let round = 0; over.length && round < 8; round += 1) {
    for (const one of over) one.shorter();
    over = over.filter((one) => one.check());
  }
  for (const one of list) one.done();
}

function controller(el, given, measureNow = false) {
  const doc = el.ownerDocument;
  const view = doc?.defaultView ?? globalThis;
  const batch = batchOf(view);
  const listeners = new Set();
  let live = true;
  let text = given.text ?? el.getAttribute('data-ds-truncate-text') ?? el.textContent ?? '';
  let shownText = text;
  let wroteTip = false;
  let parts = null;
  /** One measurement: the position, the graphemes, how many stay, what showed before. */
  let pass = null;
  /** The graphemes of the whole text, split once per text. */
  let split = { text: null, parts: [] };
  /** The layout against the sum of the advances, by text and font (see write()). */
  let scale = { text: null, font: null, ratio: 1 };
  let parent = null;

  const position = () => {
    const named = given.position ?? el.getAttribute('data-ds-truncate');
    return POSITIONS.includes(named) ? named : 'end';
  };

  const tip = (on) => {
    if (on) {
      if (!wroteTip && el.hasAttribute('data-tip')) return;
      if (!wroteTip) {
        wroteTip = true;
        own(el, 'attrs', 'data-tip');
      }
      if (el.getAttribute('data-tip') !== text) el.setAttribute('data-tip', text);
    } else if (wroteTip) {
      wroteTip = false;
      el.removeAttribute('data-tip');
      disown(el, 'attrs', 'data-tip');
    }
  };

  /** The whole text back in place of our parts; a page's own markup (end) is never touched. */
  const plain = () => {
    if (!parts) return;
    parts = null;
    el.textContent = text;
  };

  /** Our parts in the element, the whole text showing. */
  const whole = () => {
    if (!parts) {
      const shown = doc.createElement('span');
      shown.className = 'ds-truncate__shown';
      shown.setAttribute('aria-hidden', 'true');
      const sr = doc.createElement('span');
      sr.className = 'ds-sr';
      parts = { shown, whole: sr };
    }
    setText(parts.whole, text);
    setText(parts.shown, text);
    if (parts.shown.parentNode !== el || parts.whole.parentNode !== el) el.replaceChildren(parts.shown, parts.whole);
  };

  const overflowing = () => el.scrollWidth > el.clientWidth + 0.5;

  /** Follows the container: a cut element is only as wide as its cut text, its container says when more fits. */
  const follow = () => {
    const next = el.parentElement;
    if (next === parent) return;
    unwatch(batch, parent, one);
    parent = next;
    watch(batch, parent, one);
  };

  const one = {
    live: () => live,
    stale() {
      scale = { text: null, font: null, ratio: 1 };
    },
    probe() {
      follow();
      const at = position();
      pass = { at, before: shownText, graphemes: null, keep: 0, fits: true, sized: null, over: false, known: false };
      // Cut, and the cut overflows: the element is as wide as its room.
      if (at === 'end' || !parts || shownText === text || scale.text !== text || !el.isConnected || !overflowing()) return;
      const style = view.getComputedStyle(parts.shown);
      const font = fontOf(style);
      if (font !== scale.font || !contextOf(doc)) return;
      const box = view.getComputedStyle(el);
      pass.fits = false;
      pass.known = true;
      pass.graphemes = split.parts;
      pass.sized = { room: el.clientWidth - (parseFloat(box.paddingLeft) || 0) - (parseFloat(box.paddingRight) || 0), drawn: 0, font, transform: transformOf(style) };
    },
    prepare() {
      if (pass.known) return;
      if (pass.at === 'end' || !el.isConnected) plain();
      else whole();
    },
    read() {
      if (pass.known || pass.at === 'end' || !el.isConnected) return;
      pass.fits = !overflowing();
      if (pass.fits) return;
      if (split.text !== text) split = { text, parts: graphemes(text) };
      pass.graphemes = split.parts;
      const context = contextOf(doc);
      if (!context) return;
      const box = view.getComputedStyle(el);
      const style = view.getComputedStyle(parts.shown);
      const room = el.clientWidth - (parseFloat(box.paddingLeft) || 0) - (parseFloat(box.paddingRight) || 0);
      const drawn = parts.shown.getBoundingClientRect().width;
      pass.sized = { room, drawn, font: fontOf(style), transform: transformOf(style) };
    },
    write() {
      const { at } = pass;
      if (at === 'end' || !el.isConnected) {
        shownText = text;
        return;
      }
      if (pass.fits) {
        pass.keep = Infinity;
      } else if (pass.sized) {
        const { room, drawn, font, transform } = pass.sized;
        const context = contextOf(doc);
        const widths = advancesOf(context, font, transform, pass.graphemes);
        const [ellipsis] = advancesOf(context, font, transform, [ELLIPSIS]);
        const count = widths.length;
        const before = [0];
        for (const width of widths) before.push(before.at(-1) + width);
        const sum = before[count];
        // The sum against the layout of the whole text: kerning, letter
        // spacing, a font still loading and rounding come out in the ratio.
        if (!pass.known) scale = { text, font, ratio: sum > 0 && drawn > 0 ? drawn / sum : 1 };
        const { ratio } = scale;
        const span = (keep) => {
          if (at === 'start') return sum - before[count - keep];
          const head = Math.ceil(keep / 2);
          return before[head] + sum - before[count - (keep - head)];
        };
        pass.keep = largest(count, (keep) => (span(keep) + ellipsis) * ratio <= room + 0.5);
      } else {
        // No canvas: the layout decides, a candidate at a time.
        pass.keep = keepParts(pass.graphemes, at, (candidate) => {
          setText(parts.shown, candidate);
          return !overflowing();
        });
      }
      shownText = pass.graphemes && pass.keep < pass.graphemes.length ? cutParts(pass.graphemes, pass.keep, at) : text;
      if (shownText === text) plain();
      else setText(parts.shown, shownText);
    },
    /** Whether the cut still overflows; records the sizes it leaves, so they measure nothing again. */
    check() {
      if (!el.isConnected) return false;
      batch.seen.set(el, el.getBoundingClientRect().width);
      if (parent) batch.seen.set(parent, parent.getBoundingClientRect().width);
      pass.over = overflowing();
      return Boolean(parts) && pass.graphemes !== null && pass.keep > 0 && pass.over;
    },
    shorter() {
      pass.keep -= 1;
      shownText = cutParts(pass.graphemes, pass.keep, pass.at);
      setText(parts.shown, shownText);
    },
    done() {
      // Measured again meanwhile (a listener's set() on another one): told there.
      if (!pass) return;
      const { at, before } = pass;
      if (at === 'end' || !el.isConnected) tip(el.isConnected && pass.over);
      else tip(shownText !== text);
      watcher?.takeRecords();
      pass = null;
      if (shownText !== before) {
        const detail = { text, shown: shownText, cut: shownText !== text };
        for (const fn of [...listeners]) fn(detail);
      }
    },
  };

  /** Measures this one now (with every other one waiting in the batch). */
  const now = () => {
    if (!live) return;
    batch.dirty.add(one);
    flush(batch);
  };

  const watcher = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {
    if (!live) return;
    // Our own parts gone, or a text that is not ours: a re-render wrote a new whole text.
    const ours = parts ? parts.shown.parentNode === el : el.textContent === text;
    if (!ours) {
      text = el.textContent ?? '';
      parts = null;
    }
    schedule(batch, one);
  }) : null;
  watcher?.observe(el, { childList: true, characterData: true, subtree: true });
  batch.all.add(one);
  watch(batch, el, one);
  follow();
  // From the page (create()): measured at once, with whatever else waits.
  if (measureNow) now();
  else schedule(batch, one);

  const api = {
    get() {
      if (batch.dirty.has(one)) flush(batch);
      return { text, shown: shownText, cut: shownText !== text };
    },
    set(next) {
      text = String(next ?? '');
      if (el.hasAttribute('data-ds-truncate-text')) el.setAttribute('data-ds-truncate-text', text);
      now();
      if (live) emit(el, 'change', { text, shown: shownText, cut: shownText !== text });
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      const named = el.getAttribute('data-ds-truncate-text');
      if (named !== null) text = named;
      now();
    },
    destroy() {
      if (!live) return;
      live = false;
      watcher?.disconnect();
      batch.dirty.delete(one);
      batch.all.delete(one);
      unwatch(batch, el, one);
      unwatch(batch, parent, one);
      listeners.clear();
      tip(false);
      if (parts) el.textContent = text;
    },
  };
  return api;
}

define('truncate', {
  attribute: 'data-ds-truncate',
  attributes: ['data-ds-truncate-text'],
  init(el) {
    return controller(el, {});
  },
});

/**
 * Truncation driven from the page; the same controller the attribute path makes.
 * @param {Element} el
 * @param {{ position?: 'end'|'start'|'middle', text?: string }} [options]
 */
export function create(el, options = {}) {
  return controller(el, options, true);
}
