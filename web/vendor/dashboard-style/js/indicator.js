/**
 * Sliding selection indicator for segmented controls and navigation lists:
 * one element behind the items that glides to the active one instead of
 * each item painting its own background (components/indicator.css).
 *
 * Works horizontally and vertically, in scrolling tracks and with wrapping
 * items, because it measures the active item relative to the track (in the
 * track's scroll coordinates). The pill is a box with a clip-path: at rest
 * the box is the active item. A glide makes the box the union of the pill
 * it leaves and the item it goes to (plus an overshoot margin, so the
 * spring's pass beyond the target is never cut off) and moves the four clip
 * edges there on the spatial spring; the trailing edge follows
 * --ds-indicator-lag later, so the pill stretches toward its target and
 * lands. The travel time comes from travelDuration() (--ds-dur-medium for
 * a neighbour, up to --ds-dur-slow), written as --ds-indicator-dur on the
 * track, where the labels read it too (their colour transitions, already
 * started by the flush that measured the items, take it at once). Once
 * every edge has landed the box collapses to the item again (no visual
 * change).
 *
 * When it moves:
 *   - The first placement jumps, and so does a resize with nothing running.
 *   - A change of the active item glides. A placement while the edges still
 *     run (a second click, a resize mid-glide) retargets from the pill as it
 *     is painted now, so it continues without a jump; a placement on the
 *     same running target keeps gliding.
 *   - No active item: the pill contracts to its centre and fades
 *     (data-empty); an item after that grows from its centre, or, while
 *     the pill still contracts, glides on from where it is painted.
 *
 * What it observes (one requestAnimationFrame batch per indicator): the
 * track's subtree for aria-current, -pressed, -selected and -checked and
 * for added or removed items (observe: false turns this off; then call
 * update()), and the size of the track, of each of its element children
 * and of the active item (a badge or a wrap in an earlier item, a group
 * expanding above, the active label growing), plus web fonts that load
 * late. A resize places the pill within the resize callback itself, so it
 * never trails its item by a frame.
 *
 * The span carries data-ds-keep, so DS.dom.morphHtml() on the track never
 * removes it and the observers keep working after a morph; a foreign
 * re-render that dropped it anyway gets it back on the next placement (it
 * jumps there once). destroy() is final: it disconnects the observers,
 * cancels the pending frame, leaves the shared fonts and page listeners,
 * removes the span, the track's class and --ds-indicator-dur, and late
 * callbacks do nothing.
 *
 * One indicator per track (2.0): a second call with the same options
 * returns the live handle (a re-run of the page's setup adds no second
 * pill); other options destroy it and make a new one. The fonts listener
 * (one per document) and the page-transition listeners (one set per
 * window) hold the indicators weakly, so a navigation that a re-render
 * replaced is not kept alive by them; a track out of the document places
 * nothing until it is back. An active item inside a closed <details> (a
 * collapsed drawer group) has no pill: it contracts and comes back when the
 * group opens. With reveal: true the track scrolls itself (never its
 * ancestors) so the active item stays --ds-space-2 clear of its edges (or
 * its scroll-padding, where larger: a drawer list's edge shades), and
 * a .ds-drawer__list gets .ds-drawer__list--overflow while it is taller
 * than its view.
 *
 *   const indicator = createIndicator(nav, { active: '[aria-current="page"]' });
 *   ...change the active item: the pill follows by itself...
 *   indicator.update();   // only needed with observe: false
 *
 * Across page loads: with a `name`, the span carries view-transition-name
 * ds-indicator-<name> for good, so a cross-document View Transition
 * (css/optional/view-transitions.css) pairs the pill of the old page with
 * the one of the new page and glides it there on the
 * ::view-transition-group(*) default of motion.css (--ds-dur-slow on the
 * spring). The name must be unique on the page: a drawer and a segmented
 * switch take different names; name only a pill outside the view (the
 * drawer, a switch in the top bar), since a group floats above every
 * snapshot. A pill that is not wholly inside its track's visible part
 * when the page is left (pageswap) or revealed (pagereveal), such as the
 * active item of a drawer list scrolled down to a link further on, keeps
 * no name for that navigation and goes or comes with its page, so it never
 * glides in over the top bar; so does a pill under an open dialog, side
 * sheet or the modal drawer (1.6.1), which would paint above the overlay
 * or the drawer and its scrim. Within a page, DS.motion.transition() lifts
 * the name while it runs: the docked drawer shows live, so the pill glides
 * as on a click, under its labels and inside its track. Without a name the
 * pill is part of its parent's snapshot and switches with it on a page
 * load.
 *
 * ES2022 (Safari 16.4); a module may import from an earlier module; newer
 * APIs only behind feature detection, named under Progressive:.
 *
 * Progressive:
 * - view-transition-name (the `name` option) and the pageswap and
 *   pagereveal events (they lift it for a pill scrolled out of view):
 *   without View Transitions the property is ignored and the pill glides
 *   as always.
 */
import { motionDuration, travelDuration } from './motion.js';

/**
 * How far past its target the spring may carry an edge, as a share of the
 * edge's travel: the peak contract of --ds-ease-spatial (at most 1.05). The
 * overshoot margin of the glide box is this share plus 1px.
 */
export const OVERSHOOT = 0.05;

/** The clip edges a glide moves (registered lengths, indicator.css). */
const EDGES = ['--ds-indicator-t', '--ds-indicator-r', '--ds-indicator-b', '--ds-indicator-l'];

/** The attributes that make an item the active one. */
const ACTIVE_ATTRIBUTES = ['aria-current', 'aria-pressed', 'aria-selected', 'aria-checked'];

const INSTANT = 'ds-indicator--instant';

/**
 * An open dialog or side sheet: it covers the page frame, which
 * view-transitions.css then leaves unnamed. The same list as MODAL_OPEN
 * in motion.js (test/js.test.js keeps them equal); a contained dialog
 * covers only its container and never counts.
 */
const MODAL_OPEN = [
  '.ds-dialog[data-state="open"]:not(.ds-dialog--contained)',
  '.ds-sheet[data-state="open"]',
  'dialog.ds-dialog[open]:not(.ds-dialog--contained)',
  'dialog.ds-sheet[open]',
  '.ds-dialog:not(dialog, [hidden], [data-state], .ds-dialog--contained, .ds-dialog--hidden, .ds-dialog--closing)',
  '.ds-sheet[aria-modal="true"]:not(dialog, [hidden], [data-state], .ds-sheet--closing)',
].join(', ');

/**
 * The live indicator of each track, with the options it was made with: a
 * second createIndicator() for the same track and options returns it, other
 * options replace it (2.0).
 * @type {WeakMap<Element, { key: string, handle: { update: () => void, destroy: () => void } }>}
 */
const live = new WeakMap();

/**
 * The indicators that follow late web fonts, per document, and the named
 * ones that follow page transitions, per window: one listener each, holding
 * the indicators weakly, so a navigation that a re-render replaced is not
 * kept alive by the fonts or the window.
 * @type {WeakMap<object, Set<WeakRef<{ fonts: () => void, page: (event: Event) => void, shown: (event: Event) => void, gone: () => boolean }>>>}
 */
const fontWatchers = new WeakMap();
const pageWatchers = new WeakMap();

/** A weak reference where the engine has them (ES2021), else a strong one. */
const weak = (value) => (typeof WeakRef === 'function' ? new WeakRef(value) : { deref: () => value });

/** Calls `method` of every watcher in `set` that is still alive; drops the dead ones. */
function notify(set, method, event) {
  for (const ref of set) {
    const watcher = ref.deref();
    if (!watcher || watcher.gone()) set.delete(ref);
    else watcher[method](event);
  }
}

/**
 * Registers `watcher` in the set of `owner`, adding the shared listeners
 * once (`listen(set)` returns their removal). Returns the unregistration,
 * which removes the listeners with the last watcher.
 */
function watch(registry, owner, watcher, listen) {
  let entry = registry.get(owner);
  if (!entry) {
    const set = new Set();
    entry = { set, stop: listen(set) };
    registry.set(owner, entry);
  }
  const ref = weak(watcher);
  entry.set.add(ref);
  return () => {
    entry.set.delete(ref);
    if (entry.set.size || registry.get(owner) !== entry) return;
    registry.delete(owner);
    entry.stop();
  };
}

/** Within half a pixel two placements are the same. */
const same = (a, b) => Boolean(a && b) && ['left', 'top', 'right', 'bottom'].every((side) => Math.abs(a[side] - b[side]) < 0.5);

const px = (value) => `${value}px`;

/** A node the indicator ignores in mutations: its own span, ripples. */
const kept = (node) => node?.nodeType === 1 && node.hasAttribute?.('data-ds-keep');

/** Whether an item is rendered: not inside a closed <details> (besides its summary), and laid out. */
function rendered(item) {
  if (item.closest?.('details:not([open]) > :not(summary)')) return false;
  return typeof item.getClientRects !== 'function' || item.getClientRects().length > 0;
}

/**
 * @param {HTMLElement} track   positioned container of the items
 * @param {{ active: string, className?: string, observe?: boolean, name?: string, reveal?: boolean }} options
 *   active     selector of the active item inside the track
 *   className  extra class for the indicator (its look is up to the component)
 *   observe    follow attribute and item changes by itself (default true)
 *   name       view-transition-name ds-indicator-<name> on the pill, so it
 *              glides across page loads (unique per page; letters, digits,
 *              - and _)
 *   reveal     scroll the track (only the track) so the active item is
 *              --ds-space-2 clear of its edges when it changes or the track
 *              resizes; a .ds-drawer__list also gets
 *              .ds-drawer__list--overflow while it is taller than its view
 *              (default false)
 *
 * A second call for the same track with the same options returns the live
 * handle; other options destroy it and make a new one.
 */
export function createIndicator(track, options) {
  const { active, className = '', observe = true, name = '', reveal = false } = options;
  const key = JSON.stringify([active, className, Boolean(observe), name, Boolean(reveal)]);
  const existing = live.get(track);
  if (existing) {
    if (existing.key === key) return existing.handle;
    existing.handle.destroy();
  }
  const doc = track.ownerDocument ?? document;
  const view = doc.defaultView ?? globalThis;
  const indicator = doc.createElement('span');
  indicator.className = `ds-indicator ${INSTANT}${className ? ` ${className}` : ''}`;
  indicator.setAttribute('aria-hidden', 'true');
  indicator.setAttribute('data-ds-keep', '');
  if (name) indicator.style.setProperty('view-transition-name', `ds-indicator-${name}`);
  track.prepend(indicator);
  // The items take their look under the pill at once (a pressed toggle
  // drops its own tint, a label its colour): one style flush with their
  // transitions off (data-ds-moving, motion.css), as the pill's first
  // placement jumps. Without it a track styled before the script ran would
  // fade its tint out on load while the pill is already there.
  const settling = !track.hasAttribute('data-ds-moving');
  if (settling) track.setAttribute('data-ds-moving', '');
  track.classList.add('ds-has-indicator');
  if (settling) {
    if (typeof view.getComputedStyle === 'function') void view.getComputedStyle(track).opacity;
    track.removeAttribute('data-ds-moving');
  }

  /** The item of the last placement (null: none, or the pill is leaving). */
  let placed = /** @type {Element|null} */ (null);
  /** Where the pill rests or glides to, in track coordinates. */
  let target = /** @type {{ left: number, top: number, right: number, bottom: number }|null} */ (null);
  /** The current box (the union during a glide). */
  let box = target;
  /** The next placement jumps: the first one, after a hidden track, after a re-insertion. */
  let jump = true;
  /** Bumped by every placement, so a glide that was superseded never collapses. */
  let generation = 0;
  let destroyed = false;
  let frame = 0;

  const computed = () => (typeof view.getComputedStyle === 'function' ? view.getComputedStyle(indicator) : null);

  /** One style flush, so the next change starts transitions from here. */
  const flush = () => computed()?.getPropertyValue(EDGES[0]);

  /** The running (or delayed) transitions of the edges. */
  function edgeTransitions() {
    if (typeof indicator.getAnimations !== 'function') return [];
    return indicator.getAnimations().filter((animation) => EDGES.includes(animation.transitionProperty));
  }

  /** The rect of an item in the track's scroll coordinates. */
  function measure(item, trackRect) {
    const rect = item.getBoundingClientRect();
    const left = rect.left - trackRect.left - track.clientLeft + track.scrollLeft;
    const top = rect.top - trackRect.top - track.clientTop + track.scrollTop;
    return { left, top, right: left + rect.width, bottom: top + rect.height };
  }

  /** The pill as it is painted now: the box minus the current (animated) insets. */
  function painted() {
    const style = computed();
    if (!box || !style) return target;
    const edge = (index) => parseFloat(style.getPropertyValue(EDGES[index])) || 0;
    return { left: box.left + edge(3), top: box.top + edge(0), right: box.right - edge(1), bottom: box.bottom - edge(2) };
  }

  /** Writes the box and the insets that paint `rect` inside it. */
  function write(nextBox, rect) {
    box = nextBox;
    const style = indicator.style;
    style.setProperty('--ds-indicator-x', px(nextBox.left));
    style.setProperty('--ds-indicator-y', px(nextBox.top));
    style.setProperty('--ds-indicator-w', px(nextBox.right - nextBox.left));
    style.setProperty('--ds-indicator-h', px(nextBox.bottom - nextBox.top));
    insets(rect);
  }

  function insets(rect) {
    const style = indicator.style;
    style.setProperty(EDGES[0], px(rect.top - box.top));
    style.setProperty(EDGES[1], px(box.right - rect.right));
    style.setProperty(EDGES[2], px(box.bottom - rect.bottom));
    style.setProperty(EDGES[3], px(rect.left - box.left));
  }

  /**
   * Step 1 of every motion: the edges stop (--instant), the box takes its
   * glide shape, and the insets keep the painted pill where it is.
   */
  function prepare(nextBox, from) {
    indicator.classList.add(INSTANT);
    delete indicator.dataset.dir;
    indicator.dataset.glide = '';
    // Unlayered project CSS beats [data-glide] in indicator.css: inline, a
    // radius of the indicator's own class never cuts into the union.
    indicator.style.setProperty('border-radius', '0px');
    write(nextBox, from);
    flush();
  }

  /** Step 2: the edges run again; when every one has landed, the pill rests. */
  function release(gen, done) {
    indicator.classList.remove(INSTANT);
    const running = edgeTransitions();
    if (!running.length) {
      done();
      return;
    }
    Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
      if (!destroyed && gen === generation) done();
    });
  }

  /** The union of `from` and `to`, widened where an edge travels outward by its overshoot. */
  function glideBox(from, to) {
    const margin = (travel) => (travel > 0 ? Math.ceil(OVERSHOOT * travel) + 1 : 0);
    const union = {
      left: Math.min(from.left, to.left) - margin(from.left - to.left),
      top: Math.min(from.top, to.top) - margin(from.top - to.top),
      right: Math.max(from.right, to.right) + margin(to.right - from.right),
      bottom: Math.max(from.bottom, to.bottom) + margin(to.bottom - from.bottom),
    };
    // A track that clips or scrolls: the box never adds scroll range (what
    // passes its edge would be clipped by the track anyway).
    const style = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(track) : null;
    if (style && style.overflowX !== 'visible') {
      union.left = Math.max(union.left, Math.min(from.left, to.left, 0));
      union.right = Math.min(union.right, Math.max(from.right, to.right, track.scrollWidth));
    }
    if (style && style.overflowY !== 'visible') {
      union.top = Math.max(union.top, Math.min(from.top, to.top, 0));
      union.bottom = Math.min(union.bottom, Math.max(from.bottom, to.bottom, track.scrollHeight));
    }
    return union;
  }

  /**
   * A project class that only sets border-radius keeps its corners: at
   * rest, when no --ds-indicator-radius is set, its computed radius (capped
   * at half the smaller side) is copied in, without a spring.
   */
  function adoptRadius(rect) {
    const style = computed();
    if (!style || style.getPropertyValue('--ds-indicator-radius').trim() !== '0px') return;
    const own = String(style.borderTopLeftRadius || '').trim().split(/\s+/)[0];
    const side = Math.min(rect.right - rect.left, rect.bottom - rect.top);
    const value = parseFloat(own);
    // A percentage resolves against the smaller side (an ellipse is not a pill).
    const radius = Math.min(own.endsWith('%') ? value * side * 0.01 : value, side / 2);
    if (!(radius > 0)) return;
    indicator.style.setProperty('transition', 'none');
    indicator.style.setProperty('--ds-indicator-radius', px(radius));
    flush();
    indicator.style.removeProperty('transition');
  }

  /** No glide: the edges stop, the box may take its own radius again. */
  function still() {
    indicator.classList.add(INSTANT);
    delete indicator.dataset.glide;
    delete indicator.dataset.dir;
    indicator.style.removeProperty('border-radius');
  }

  /** The rest state: the box is the item, insets 0, no glide. */
  function rest(item, rect) {
    generation += 1;
    still();
    delete indicator.dataset.empty;
    write(rect, rect);
    target = rect;
    jump = false;
    adoptRadius(rect);
    setPlaced(item);
  }

  /** The placed item changes: the resize observer follows it in the next batch. */
  function setPlaced(item) {
    if (placed === item) return;
    placed = item;
    schedule();
  }

  /** The time the labels resolved from --ds-indicator-dur before this placement. */
  function labelTime() {
    const own = parseFloat(track.style.getPropertyValue('--ds-indicator-dur'));
    return Number.isFinite(own) ? own : motionDuration(track, '--ds-dur-medium');
  }

  /**
   * Writes this motion's time on the track. The labels read it for their
   * colour (shell.css), but their transitions started at the style flush
   * that measured the items, before the time was known: the colour
   * transitions that have just started on the previous time take the new
   * one, so a label lands with its pill.
   */
  function setTime(duration) {
    const previous = labelTime();
    track.style.setProperty('--ds-indicator-dur', `${duration}ms`);
    if (typeof track.getAnimations !== 'function' || Math.abs(previous - duration) < 0.5) return;
    const fresh = motionDuration(track, '--ds-dur-micro');
    for (const animation of track.getAnimations({ subtree: true })) {
      if (animation.transitionProperty !== 'color' || animation.effect?.target === indicator) continue;
      if (Math.abs(Number(animation.effect.getTiming().duration) - previous) >= 0.5) continue;
      if (Number(animation.currentTime ?? 0) > fresh) continue;
      animation.effect.updateTiming({ duration });
    }
  }

  function glide(item, from, to) {
    const gen = ++generation;
    const dx = (to.left + to.right - from.left - from.right) / 2;
    const dy = (to.top + to.bottom - from.top - from.bottom) / 2;
    const distance = Math.hypot(dx, dy);
    setTime(travelDuration(track, distance));
    prepare(glideBox(from, to), from);
    // A pure size change (the centres stay within half a pixel) has no trailing edge.
    if (distance >= 0.5) {
      indicator.dataset.dir = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    }
    insets(to);
    target = to;
    setPlaced(item);
    release(gen, () => rest(item, to));
  }

  /**
   * An active item after an empty state: the pill grows from its centre.
   * While it still contracts, it turns from where it is painted instead (a
   * glide; its fade turns back from the current opacity), so a pill that is
   * half gone never snaps to a sliver and grows again.
   */
  function appear(item, to) {
    if (edgeTransitions().length) {
      const from = painted();
      delete indicator.dataset.empty;
      glide(item, from, to);
      return;
    }
    const gen = ++generation;
    setTime(motionDuration(track, '--ds-dur-medium'));
    indicator.dataset.empty = '';
    const half = (to.right - to.left) / 2;
    prepare(to, { left: to.left + half, top: to.top, right: to.right - half, bottom: to.bottom });
    delete indicator.dataset.empty;
    insets(to);
    target = to;
    setPlaced(item);
    release(gen, () => rest(item, to));
  }

  /** The active item went away: the pill contracts to its centre and fades. */
  function disappear() {
    const gen = ++generation;
    const from = edgeTransitions().length ? painted() : target;
    placed = null;
    target = null;
    if (!from || jump) {
      still();
      indicator.dataset.empty = '';
      jump = false;
      return;
    }
    prepare(box, from);
    indicator.dataset.empty = '';
    const half = (from.right - from.left) / 2;
    insets({ left: from.left + half, top: from.top, right: from.right - half, bottom: from.bottom });
    release(gen, still);
  }

  /**
   * The room reveal keeps at each edge of the track, in px: --ds-space-2,
   * or the track's scroll-padding where that is larger (a drawer list's
   * edge shades), so the item lands where keyboard focus would.
   */
  function room() {
    const style = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(track) : null;
    // 'auto' (no scroll-padding) and a missing value read as NaN.
    const px = (name) => (style ? parseFloat(style.getPropertyValue(name)) : NaN);
    const space = px('--ds-space-2');
    const base = Number.isFinite(space) ? space : 8;
    const side = (name) => Math.max(base, px(name) || 0);
    return { top: side('scroll-padding-top'), bottom: side('scroll-padding-bottom'), left: side('scroll-padding-left'), right: side('scroll-padding-right') };
  }

  /** reveal: scrolls only the track, so `rect` (track scroll coordinates) is clear of its edges. */
  function revealRect(rect, instant) {
    const margin = room();
    const axis = (start, end, scroll, size, range, before, after) => {
      if (range <= size + 1) return scroll;
      if (start - before < scroll || end - start + before + after > size) return Math.max(0, start - before);
      if (end + after > scroll + size) return end + after - size;
      return scroll;
    };
    const top = axis(rect.top, rect.bottom, track.scrollTop, track.clientHeight, track.scrollHeight, margin.top, margin.bottom);
    const left = axis(rect.left, rect.right, track.scrollLeft, track.clientWidth, track.scrollWidth, margin.left, margin.right);
    if (Math.abs(top - track.scrollTop) < 0.5 && Math.abs(left - track.scrollLeft) < 0.5) return;
    if (typeof track.scrollTo === 'function') track.scrollTo({ top, left, behavior: instant ? 'auto' : 'smooth' });
  }

  function place() {
    if (destroyed) return;
    // Out of the document (a re-render took it out): nothing to do until it is back.
    if (track.isConnected === false) return;
    // Gone after a re-render that replaced the track's content: back in, without a glide.
    if (indicator.parentNode !== track) {
      track.prepend(indicator);
      jump = true;
    }
    const trackRect = track.getBoundingClientRect();
    // Not rendered (display: none): nothing to measure; it jumps once it shows.
    if (trackRect.width === 0) {
      generation += 1;
      still();
      indicator.dataset.empty = '';
      placed = null;
      target = null;
      jump = true;
      return;
    }
    // reveal on a drawer list: its thumb stays while it is taller than its view.
    if (reveal && track.classList.contains('ds-drawer__list')) {
      track.classList.toggle('ds-drawer__list--overflow', track.scrollHeight > track.clientHeight + 1);
    }
    // An active item inside a closed group has no pill (it comes back when the group opens).
    const found = track.querySelector(active);
    const item = found && rendered(found) ? found : null;
    if (!item) {
      if (placed !== null || jump) disappear();
      return;
    }
    const to = measure(item, trackRect);
    if (reveal) revealRect(to, jump);
    if (jump) {
      rest(item, to);
      return;
    }
    if (placed === null) {
      appear(item, to);
      return;
    }
    const running = edgeTransitions().length > 0;
    if (running && same(to, target)) return;
    if (running || item !== placed) {
      glide(item, running ? painted() : target, to);
      return;
    }
    if (!same(to, target)) rest(item, to);
  }

  /* ── Observing ─────────────────────────────────────────────────────── */

  /** The elements whose size can move the pill: the track, its items, the active one. */
  let observed = new Set();
  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => place()) : null;

  function syncObserved() {
    if (!resize) return;
    const wanted = new Set([track]);
    for (const child of track.children ?? []) if (child !== indicator) wanted.add(child);
    if (placed) wanted.add(placed);
    for (const element of observed) if (!wanted.has(element)) resize.unobserve(element);
    for (const element of wanted) if (!observed.has(element)) resize.observe(element);
    observed = wanted;
  }

  /**
   * A record that is not the indicator's own write or a ripple. Only a kept
   * node inside the track counts: a track inside a wrapper that the page
   * keeps across morphs still follows its items.
   */
  function relevant(record) {
    if (record.target === indicator) return false;
    const keep = record.target?.closest?.('[data-ds-keep]');
    if (keep && keep !== track && track.contains(keep)) return false;
    if (record.type !== 'childList') return true;
    return ![...record.addedNodes, ...record.removedNodes].every(kept);
  }

  const mutations = observe && typeof view.MutationObserver === 'function'
    ? new view.MutationObserver((records) => {
      if (records.some(relevant)) schedule();
    })
    : null;
  mutations?.observe(track, { subtree: true, childList: true, attributes: true, attributeFilter: ACTIVE_ATTRIBUTES });

  /** One pending frame: re-sync the observed elements, then place. */
  function schedule() {
    if (destroyed || frame || typeof view.requestAnimationFrame !== 'function') return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      if (destroyed) return;
      syncObserved();
      place();
    });
  }

  /**
   * A page load captures a named pill where it is painted, and its group
   * floats above every snapshot, outside its track's clip. A pill
   * scrolled out of its track's view (the active item of a long drawer
   * list the user scrolled down to click a link) would glide in from
   * outside the drawer, across the top bar; a pill under something modal
   * (a page left with a dialog, a side sheet or the modal drawer open,
   * whose frame view-transitions.css leaves in the root snapshot) would
   * paint above the overlay or the drawer and its scrim, over the labels.
   * For that navigation it keeps no name and goes or comes with its page;
   * the name returns once the transition ended (or the page comes back
   * from the back/forward cache).
   */
  function shownWhole() {
    const rect = indicator.getBoundingClientRect();
    let clip = { left: 0, top: 0, right: view.innerWidth ?? Infinity, bottom: view.innerHeight ?? Infinity };
    for (let el = indicator.parentElement; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
      const cs = view.getComputedStyle(el);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const outer = el.getBoundingClientRect();
      const left = outer.left + el.clientLeft;
      const top = outer.top + el.clientTop;
      clip = { left: Math.max(clip.left, left), top: Math.max(clip.top, top), right: Math.min(clip.right, left + el.clientWidth), bottom: Math.min(clip.bottom, top + el.clientHeight) };
    }
    return rect.left >= clip.left - 0.5 && rect.top >= clip.top - 0.5 && rect.right <= clip.right + 0.5 && rect.bottom <= clip.bottom + 0.5;
  }

  const ownName = name ? `ds-indicator-${name}` : '';
  const rename = () => {
    if (!destroyed) indicator.style.setProperty('view-transition-name', ownName);
  };
  const covered = () => Boolean(doc.querySelector?.(`${MODAL_OPEN}, .ds-app[data-drawer-open]`));
  const onPageTransition = (event) => {
    if (destroyed || !event.viewTransition || typeof view.getComputedStyle !== 'function') return;
    if (!covered() && shownWhole()) return;
    indicator.style.setProperty('view-transition-name', 'none');
    event.viewTransition.finished?.then(rename, rename);
  };
  const onPageShow = (event) => {
    if (event.persisted) rename();
  };

  /*
   * The shared listeners (one per document for the fonts, one set per
   * window for page transitions) hold this watcher weakly; the track's
   * entry in `live` and the handle hold it strongly, so it lives as long
   * as either does. A track that left the document is skipped.
   */
  const watcher = {
    fonts: () => schedule(),
    page: onPageTransition,
    shown: onPageShow,
    gone: () => destroyed,
  };
  const unwatch = [];
  // Web fonts change the size of the items when they arrive.
  const fonts = doc.fonts;
  if (fonts) {
    unwatch.push(watch(fontWatchers, fonts, watcher, (set) => {
      const onFonts = () => notify(set, 'fonts');
      fonts.addEventListener?.('loadingdone', onFonts);
      return () => fonts.removeEventListener?.('loadingdone', onFonts);
    }));
    fonts.ready?.then(() => watcher.fonts()).catch(() => {});
  }
  if (name) {
    unwatch.push(watch(pageWatchers, view, watcher, (set) => {
      const onTransition = (event) => notify(set, 'page', event);
      const onShow = (event) => notify(set, 'shown', event);
      view.addEventListener?.('pageswap', onTransition);
      view.addEventListener?.('pagereveal', onTransition);
      view.addEventListener?.('pageshow', onShow);
      return () => {
        view.removeEventListener?.('pageswap', onTransition);
        view.removeEventListener?.('pagereveal', onTransition);
        view.removeEventListener?.('pageshow', onShow);
      };
    }));
  }

  place();
  syncObserved();

  const handle = {
    /** Moves the indicator to the current active item (glides when it changed). */
    update() {
      place();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      resize?.disconnect();
      mutations?.disconnect();
      if (frame) view.cancelAnimationFrame?.(frame);
      frame = 0;
      for (const stop of unwatch) stop();
      if (live.get(track)?.handle === handle) live.delete(track);
      indicator.remove();
      track.classList.remove('ds-has-indicator');
      track.style.removeProperty('--ds-indicator-dur');
    },
  };
  live.set(track, { key, handle, watcher });
  return handle;
}
