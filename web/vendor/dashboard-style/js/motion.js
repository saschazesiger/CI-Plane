/**
 * Motion helpers: the JS half of motion.css.
 *
 * Timing comes from the computed tokens (motionDuration, motionEasing), so
 * --ds-time-scale slows JS and CSS together. The constants are only the
 * fallbacks outside a .ds-theme (MOTION_FALLBACKS; test/tokens.test.js
 * keeps them equal to tokens.css).
 *
 * enter() and leave() toggle the .ds-enter / .ds-leave classes and keep one
 * state per element: a generation that every call (and cancel()) bumps. A
 * continuation (removing classes, hiding, removing, moving focus) only acts
 * while its generation is current, so a later call supersedes an earlier
 * one, whose promise then resolves without acting.
 *
 * Interrupted motion continues from where it is (handoff): the computed
 * opacity, translate, scale and clip-path are read, the running animation
 * is cancelled, the new classes are applied, and each track of the new
 * CSS animation is played from the snapshot with el.animate() (id
 * 'ds-handoff'), on the new direction's curve, for the share of its
 * duration that is left. A value that was moving but has no track in the
 * new motion (the lift of enter() under the fade-only leave()) glides to
 * its rest value the same way. Nothing is reversed, nothing restarts from
 * zero, nothing snaps, and no inline style is written, so a page's inline
 * transform stays.
 *
 * settled() waits for the element's own finite animations (their finished
 * promises), with a ceiling derived from their timing; it resolves on the
 * next frame when nothing runs.
 *
 * Data glides: countUp() counts from the shown value on the curve of
 * progress bars (one loop per element), flip() moves reordered items from
 * their old places (retargeting mid-flight; live data waits while pointed
 * at or focused). roll() and crossfade() swap content in a .ds-swap slot
 * through enter() and leave(), so they are interruptible too; an icon
 * crossfade (kind 'icon') only flips the CSS transitions of .ds-icon-swap.
 * busy() drives the faces of a button (busy, done) through aria-busy and
 * .ds-btn--done; the faces themselves are CSS. originFrom() writes where a
 * popup grows from.
 *
 * Blocked actions (2.0): guard() cancels, in the capture phase on the
 * window, every activation (click, middle click, Enter and Space, a label
 * click, a form submission by its submitter) of a busy or done .ds-btn and
 * of an aria-disabled action inside .ds-theme, before any page listener
 * sees it; [data-ds-guard="off"] opts a control out. busy() installs it.
 *
 * Views: transition() moves from one view to the next (navigation only,
 * never data): fade-through, shared axis X (forward, back) or a container
 * transform, as a View Transition keyed on data-ds-vt on <html> (the
 * rules are in motion.css), else as an .ds-enter--swap fade-through of
 * the new view (D30). No component calls it, except DS.overlay.open with
 * `container: true`.
 *
 * ES2022 (Safari 16.4); a module may import from an earlier module (the
 * build bundles it into dist/ds.js as DS.motion); newer APIs only behind
 * feature detection, named under Progressive:.
 *
 * Progressive:
 * - linear() easings (the spring) in el.animate(): an engine without them
 *   (Chrome/Edge 111-112, Safari 16.4-17.1) throws a TypeError and gets
 *   the token's cubic fallback instead (animateSafe).
 * - document.startViewTransition (same-document View Transitions, for
 *   transition(), only with .ds-theme on <html>): without it, or for an
 *   embedded widget, the new view fades through with .ds-enter--swap.
 * - moveBefore (sortable() moves a row with it, so the row keeps its
 *   focus and animations): without it insertBefore, and the handle gets
 *   the focus back.
 * - ScrollTimeline (scroll-driven animations; settled(), the handoffs and
 *   flip() tell those animations apart and leave them be, and
 *   resyncScroll() restarts those whose scroller stopped overflowing):
 *   without it there are none.
 */

/**
 * The motion tokens outside a .ds-theme (or without a DOM): durations and
 * delays in ms, easings as their cubic-bezier() fallbacks. The spring
 * (--ds-ease-spatial) falls back to --ds-ease-out like the CSS does, the
 * emphasized path to its cubic. test/tokens.test.js compares every entry
 * with tokens.css.
 * @type {Readonly<Record<string, number|string>>}
 */
export const MOTION_FALLBACKS = Object.freeze({
  '--ds-dur-micro': 50,
  '--ds-dur-instant': 100,
  '--ds-dur-fast': 150,
  '--ds-dur-base': 200,
  '--ds-dur-medium': 250,
  '--ds-dur-slow': 350,
  '--ds-dur-long': 450,
  '--ds-dur-glide': 600,
  '--ds-delay-loader': 200,
  '--ds-delay-boot': 400,
  '--ds-hold-loader': 450,
  '--ds-hold-success': 600,
  '--ds-hold-status': 900,
  '--ds-delay-tooltip': 500,
  '--ds-delay-tooltip-skip': 300,
  '--ds-delay-tooltip-hide': 100,
  '--ds-delay-dismiss': 300,
  '--ds-ease-in-out': 'cubic-bezier(.2, 0, 0, 1)',
  '--ds-ease-out': 'cubic-bezier(.05, .7, .1, 1)',
  '--ds-ease-in': 'cubic-bezier(.3, 0, 1, 1)',
  '--ds-ease-exit': 'cubic-bezier(.3, 0, .8, .15)',
  '--ds-ease-emphasized': 'cubic-bezier(.2, 0, 0, 1)',
  '--ds-ease-spatial': 'cubic-bezier(.05, .7, .1, 1)',
  '--ds-ease-value': 'cubic-bezier(.2, 0, 0, 1)',
});

/** --ds-delay-loader outside a theme (MOTION_FALLBACKS). */
export const LOADER_DELAY_MS = /** @type {number} */ (MOTION_FALLBACKS['--ds-delay-loader']);

/**
 * Once a loading indicator became visible it stays at least this long: one
 * that appears and vanishes a moment later is what reads as flickering.
 * --ds-hold-loader outside a theme (MOTION_FALLBACKS).
 */
export const LOADER_MIN_VISIBLE_MS = /** @type {number} */ (MOTION_FALLBACKS['--ds-hold-loader']);

/**
 * settled() without anything to read its timing from (the event fallback
 * without getAnimations()): longer than the longest animation of the
 * system (--ds-dur-glide), stretched by --ds-time-scale.
 */
const DEFAULT_TIMEOUT_MS = 1000;

/** settled()'s ceiling lies this far behind the end of what it waits for. */
const CEILING_MARGIN_MS = 100;

/** A travel this long (px) or longer takes the longest step of travelDuration(). */
const TRAVEL_FULL_PX = 480;

/** Highest stagger index: 30ms × at most six steps (0…5), the motion rule. */
export const STAGGER_MAX = 5;

/**
 * The focused element as seen from `node`'s tree: inside a shadow root its
 * own activeElement (document.activeElement is the shadow host there, so a
 * widget in a shadow root would never see its own focus), else the
 * document's.
 * @param {any} node
 * @returns {any}
 */
function activeIn(node) {
  const root = node?.getRootNode?.();
  return (root?.nodeType === 11 ? root.activeElement : null) ?? node?.ownerDocument?.activeElement ?? null;
}

/* ── Timing from tokens ─────────────────────────────── */

/**
 * The window of an element (an iframe's own), or the global one.
 * @param {any} element
 * @returns {any}
 */
function windowOf(element) {
  return element?.ownerDocument?.defaultView ?? globalThis;
}

/** A computed style, or null without a DOM. */
function computed(element) {
  const view = windowOf(element);
  return typeof view.getComputedStyle === 'function' ? view.getComputedStyle(element) : null;
}

/** Inside a .ds-theme the tokens exist; outside, the fallbacks apply. */
function themed(element) {
  return Boolean(element?.closest?.('.ds-theme'));
}

/* ── Runtime state that a re-render keeps ───────────── */

/**
 * The runtime state a DS helper owns on an element right now, for
 * DS.dom.morphHtml: { attrs, classes, props }, each a Map of name to a
 * count of owners. A patch keeps an owned name as it is, present or
 * absent (an open overlay's dropped `hidden` is not added back from the
 * template); once the last owner lets go, the next patch takes the
 * template's value again. The record sits under a symbol of the global
 * registry, so a morph of any copy of ds.js (another version on the page,
 * another frame) sees what any copy owns; overlay.js keeps its own copy
 * of these two helpers.
 */
const OWNED = Symbol.for('ds.owned');

/** `kind`: 'attrs', 'classes' or 'props' (a style property, kebab-case). */
function own(element, kind, name) {
  if (!element || typeof element !== 'object') return;
  const record = element[OWNED] ?? (element[OWNED] = { attrs: new Map(), classes: new Map(), props: new Map() });
  record[kind].set(name, (record[kind].get(name) ?? 0) + 1);
}

function disown(element, kind, name) {
  const map = element?.[OWNED]?.[kind];
  const count = map?.get(name) ?? 0;
  if (count > 1) map.set(name, count - 1);
  else map?.delete(name);
}

const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
const TIME = new RegExp(`^(${NUMBER})(ms|s)$`, 'i');
const PLAIN = new RegExp(`^${NUMBER}$`, 'i');

/** `250ms`, `.25s` → ms, else null. */
function parseTime(text) {
  const match = TIME.exec(text.trim());
  return match ? Number(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1) : null;
}

/**
 * A computed duration token: `250ms`, `.25s` or `calc(250ms * 10)` (an
 * unregistered token keeps its calc() with --ds-time-scale substituted).
 * @param {string} text
 * @returns {number|null} ms, or null for anything else
 */
function parseDuration(text) {
  const value = text.trim();
  const time = parseTime(value);
  if (time !== null) return time;
  const product = /^calc\(\s*([^\s*()]+)\s*\*\s*([^\s*()]+)\s*\)$/i.exec(value);
  if (!product) return null;
  const [, left, right] = product;
  if (parseTime(left) !== null && PLAIN.test(right)) return parseTime(left) * Number(right);
  if (PLAIN.test(left) && parseTime(right) !== null) return Number(left) * parseTime(right);
  return null;
}

/** Durations the probe resolved, by computed text. */
const probed = new Map();
let probe = /** @type {any} */ (null);

/**
 * Resolves a computed duration this file cannot parse (another calc()
 * form) through a hidden element: the browser computes it as
 * transition-duration and returns seconds. Cached by text.
 * @param {Element} element
 * @param {string} text
 * @returns {number|null}
 */
function probeDuration(element, text) {
  if (probed.has(text)) return probed.get(text);
  const doc = element.ownerDocument;
  const parent = doc?.body ?? doc?.documentElement;
  let ms = null;
  if (parent && typeof doc.createElement === 'function') {
    if (!probe || probe.ownerDocument !== doc) probe = doc.createElement('span');
    probe.hidden = true;
    probe.style.transitionDuration = '';
    probe.style.transitionDuration = text;
    if (probe.style.transitionDuration) {
      parent.append(probe);
      ms = parseTime(computed(probe)?.transitionDuration.split(',')[0] ?? '');
      probe.remove();
    }
  }
  if (probed.size >= 64) probed.clear();
  probed.set(text, ms);
  return ms;
}

/**
 * A duration token as computed on the element, in ms. It includes
 * --ds-time-scale, so slow motion slows JS and CSS together. Outside a
 * .ds-theme (or without a DOM) it returns MOTION_FALLBACKS[token].
 * @param {Element|null|undefined} element
 * @param {string} token  e.g. '--ds-dur-medium'
 * @returns {number} ms
 */
export function motionDuration(element, token) {
  const fallback = typeof MOTION_FALLBACKS[token] === 'number' ? /** @type {number} */ (MOTION_FALLBACKS[token]) : 0;
  if (!themed(element)) return fallback;
  const text = computed(element)?.getPropertyValue(token).trim();
  if (!text) return fallback;
  return parseDuration(text) ?? probeDuration(/** @type {Element} */ (element), text) ?? fallback;
}

/**
 * An easing token as computed on the element: `cubic-bezier(...)` or, where
 * supported, `linear(...)`. Outside a .ds-theme it returns the cubic of
 * MOTION_FALLBACKS.
 * @param {Element|null|undefined} element
 * @param {string} token  e.g. '--ds-ease-spatial'
 * @returns {string}
 */
export function motionEasing(element, token) {
  const fallback = typeof MOTION_FALLBACKS[token] === 'string' ? /** @type {string} */ (MOTION_FALLBACKS[token]) : 'ease';
  if (!themed(element)) return fallback;
  return computed(element)?.getPropertyValue(token).trim() || fallback;
}

/**
 * How long something takes to travel `px`: --ds-dur-medium for a short
 * hop, growing with the distance up to --ds-dur-slow at 480px and beyond.
 * The one distance rule of FLIP and the indicator.
 * @param {Element|null|undefined} element  where the tokens are read
 * @param {number} px
 * @returns {number} ms
 */
export function travelDuration(element, px) {
  return travelBetween(motionDuration(element, '--ds-dur-medium'), motionDuration(element, '--ds-dur-slow'), px);
}

/** travelDuration() with its two tokens already read (a FLIP reads them once for all its movers). */
function travelBetween(medium, slow, px) {
  return medium + (slow - medium) * Math.min(1, Math.abs(Number(px) || 0) / TRAVEL_FULL_PX);
}

/**
 * Splits a computed list at its top-level commas (cubic-bezier() and
 * linear() hold commas of their own).
 * @param {string} text
 * @returns {string[]}
 */
function splitList(text) {
  const items = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      items.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(text.slice(start).trim());
  return items.filter(Boolean);
}

/**
 * The points of a linear() easing, with every position filled in
 * (CSS Easing 2: first 0, last 1, runs spaced evenly, never decreasing).
 * @param {string} body  the text between the parentheses
 * @returns {{ value: number, at: number }[]|null}
 */
function linearPoints(body) {
  const points = [];
  for (const part of body.split(',')) {
    const [value, ...stops] = part.trim().split(/\s+/);
    if (!PLAIN.test(value ?? '') || stops.length > 2) return null;
    const positions = stops.map((stop) => (/%$/.test(stop) && PLAIN.test(stop.slice(0, -1)) ? Number(stop.slice(0, -1)) / 100 : NaN));
    if (positions.some((at) => Number.isNaN(at))) return null;
    if (positions.length) positions.forEach((at) => points.push({ value: Number(value), at }));
    else points.push({ value: Number(value), at: /** @type {number|null} */ (null) });
  }
  if (points.length < 2) return null;
  points[0].at ??= 0;
  points.at(-1).at ??= 1;
  let highest = 0;
  for (const point of points) {
    if (point.at === null) continue;
    point.at = Math.max(point.at, highest);
    highest = point.at;
  }
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].at !== null) continue;
    let next = index;
    while (points[next].at === null) next += 1;
    const from = /** @type {number} */ (points[index - 1].at);
    const span = /** @type {number} */ (points[next].at) - from;
    for (let step = index; step < next; step += 1) points[step].at = from + (span * (step - index + 1)) / (next - index + 1);
    index = next;
  }
  return /** @type {{ value: number, at: number }[]} */ (points);
}

/**
 * cubic-bezier(x1, y1, x2, y2) as a function of time: Newton's method on
 * x, with bisection where Newton leaves [0, 1] or stalls.
 */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const x = (s) => ((ax * s + bx) * s + cx) * s;
  const y = (s) => ((ay * s + by) * s + cy) * s;
  const slope = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (/** @type {number} */ t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let step = 0; step < 8; step += 1) {
      const error = x(s) - t;
      if (Math.abs(error) < 1e-7) return y(s);
      const d = slope(s);
      if (Math.abs(d) < 1e-6) break;
      s -= error / d;
      if (s < 0 || s > 1) break;
    }
    let low = 0;
    let high = 1;
    s = t;
    for (let step = 0; step < 50; step += 1) {
      const value = x(s);
      if (Math.abs(value - t) < 1e-7) break;
      if (value < t) low = s;
      else high = s;
      s = (low + high) / 2;
    }
    return y(s);
  };
}

const KEYWORDS = /** @type {Record<string, number[]>} */ ({
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
});

/**
 * An easing as a function `t => value` for JS-driven motion (countUp):
 * cubic-bezier(), linear() (values above 1 allowed: the spring) and the
 * keywords. Anything else is linear.
 * @param {string} css
 * @returns {(t: number) => number}
 */
function curve(css) {
  const text = String(css ?? '').trim().toLowerCase();
  if (Object.hasOwn(KEYWORDS, text)) return bezier(...KEYWORDS[text]);
  const cubic = /^cubic-bezier\(([^)]*)\)$/.exec(text);
  if (cubic) {
    const numbers = cubic[1].split(',').map((part) => Number(part.trim()));
    if (numbers.length === 4 && numbers.every(Number.isFinite)) return bezier(...numbers);
  }
  const linear = /^linear\((.*)\)$/.exec(text);
  const points = linear ? linearPoints(linear[1]) : null;
  if (points) {
    return (t) => {
      const last = points.at(-1);
      if (t >= last.at) return last.value;
      if (t <= points[0].at) return points[0].value;
      let index = 0;
      while (points[index + 1].at <= t) index += 1;
      const from = points[index];
      const to = points[index + 1];
      return from.value + ((to.value - from.value) * (t - from.at)) / (to.at - from.at);
    };
  }
  return (t) => Math.min(1, Math.max(0, t));
}

/**
 * The cubic that stands in for a linear() easing in an engine without
 * linear(): the token's fallback when known, else the spring's for a
 * curve that overshoots and the emphasized one for the rest.
 * @param {string} easing
 * @param {string} [token]
 */
function cubicFor(easing, token) {
  if (token && typeof MOTION_FALLBACKS[token] === 'string') return /** @type {string} */ (MOTION_FALLBACKS[token]);
  const points = linearPoints(easing.slice(easing.indexOf('(') + 1, easing.lastIndexOf(')')));
  const springy = Boolean(points?.some((point) => point.value > 1));
  return /** @type {string} */ (MOTION_FALLBACKS[springy ? '--ds-ease-spatial' : '--ds-ease-emphasized']);
}

/**
 * el.animate() that survives an engine without linear() in the Web
 * Animations API: on its TypeError it retries with the cubic fallback.
 * Every WAAPI call of the system goes through here.
 * @param {Element} element
 * @param {Keyframe[]} keyframes
 * @param {KeyframeAnimationOptions} timing
 * @param {string} [token]  the easing token, for its exact fallback
 * @returns {Animation}
 */
function animateSafe(element, keyframes, timing, token) {
  try {
    return element.animate(keyframes, timing);
  } catch (error) {
    const easing = String(timing.easing ?? '');
    if (/** @type {any} */ (error)?.name !== 'TypeError' || !easing.includes('linear(')) throw error;
    return element.animate(keyframes, { ...timing, easing: cubicFor(easing, token) });
  }
}

/* ── Per-element state ──────────────────────────────── */

/**
 * @typedef {object} MotionState
 * @property {number} gen  bumped by enter(), leave(), cancel()
 * @property {Element|null} opener  focus when enter() was called
 * @property {Animation[]} handoffs  the 'ds-handoff' animations of the current call
 * @property {boolean} inert  leave() set `inert` (and so may clear it)
 * @property {boolean} marked  leave() set `data-ds-leaving` (and so may clear it)
 */

/** @type {WeakMap<Element, MotionState>} */
const states = new WeakMap();

/** @returns {MotionState} */
function stateOf(element) {
  let state = states.get(element);
  if (!state) {
    state = { gen: 0, opener: null, handoffs: [], inert: false, marked: false };
    states.set(element, state);
  }
  return state;
}

const MOTION_CLASS = /^ds-(enter|leave)(--[\w-]+)?$/;

/**
 * The enterAll() batch that wrote an item's `--ds-i` (it removes it again
 * once it is done, whoever took the item over meanwhile). A page's own
 * --ds-i (stagger()) has no entry and is never touched.
 * @type {WeakMap<Element, object>}
 */
const stepOwners = new WeakMap();

/**
 * Removes a style attribute that a helper emptied (style="" left behind),
 * so the element's shell equals its template again (DS.dom.morphHtml keeps
 * identical nodes as they are).
 */
function tidyStyle(element) {
  if (element?.getAttribute?.('style')?.trim() === '') element.removeAttribute('style');
}

/** Removes the `--ds-i` an enterAll() batch wrote: a single entrance never staggers. */
function dropStep(element) {
  if (!stepOwners.has(element)) return;
  stepOwners.delete(element);
  /** @type {HTMLElement} */ (element).style.removeProperty('--ds-i');
  tidyStyle(element);
}

/** Removes every .ds-enter / .ds-leave class and variant; true if there was one. */
function clearMotion(element) {
  const names = Array.from(element.classList).filter((name) => MOTION_CLASS.test(name));
  if (names.length) element.classList.remove(...names);
  return names.length > 0;
}

/**
 * Commits pending class changes to style without layout (works on SVG,
 * which has no offsetWidth): a removed animation is gone, so adding it
 * back starts afresh.
 */
function flushStyle(element) {
  void computed(element)?.animationName;
}

/** Stops the handoff animations of the element's current call. */
function cancelHandoffs(element, state = stateOf(element)) {
  for (const animation of state.handoffs) animation.cancel();
  state.handoffs = [];
}

/**
 * Marks an element that leave() will remove as a pending removal
 * (`data-ds-leaving`), so DS.dom.morphHtml() skips it instead of patching
 * it into another item that would then go with it. `on: false` takes back
 * only a mark that leave() set (flip() and the swaps set their own).
 */
function markLeaving(element, state, on) {
  if (on) {
    if (state.marked || element.hasAttribute?.('data-ds-leaving')) return;
    element.setAttribute?.('data-ds-leaving', '');
    state.marked = true;
  } else if (state.marked) {
    element.removeAttribute?.('data-ds-leaving');
    state.marked = false;
  }
}

/**
 * A scroll-driven animation (a ScrollTimeline or ViewTimeline: the panel
 * hairline, a table's edge fades, .ds-reveal--scroll). It follows the
 * scroll position, never ends by time and takes no time-based currentTime,
 * so no helper waits for it, snapshots it or hands it off. Told by the
 * timeline's `axis` (scroll timelines have one, the document timeline has
 * none) rather than instanceof, so a timeline of another realm (an element
 * in a same-origin iframe, driven from the parent's DS) counts too.
 */
function scrollDriven(animation) {
  return typeof animation.timeline?.axis === 'string';
}

/**
 * Restarts the scroll-driven animations whose scroller stopped
 * overflowing: its timeline turned inactive, yet Chromium and WebKit keep
 * the animation's last progress, so a scrolled view whose content shrank
 * kept the top bar tinted and its hairline shown, and a table that now
 * fits kept its left edge fade. A restarted animation has no effect until
 * its scroller overflows again, as on a fresh load. It waits two frames
 * first: a timeline sees a new layout only a frame or two later.
 * transition() calls it after every update; call it after a change in
 * place that may shrink a scroller (a table filter, columns hidden, a
 * record swap with morphHtml outside transition()). `root` (an element or
 * a document, default the document) limits it to the scrollers inside it,
 * the one around it and the animations of its descendants (the top bar's
 * tint follows the view's timeline). Without scroll timelines it does
 * nothing. Resolves to the number of animations restarted.
 *
 * @param {Element|Document} [root]
 * @returns {Promise<number>}
 */
export function resyncScroll(root = globalThis.document) {
  const doc = root?.nodeType === 9 ? root : root?.ownerDocument;
  const win = doc?.defaultView ?? globalThis;
  if (typeof win.ScrollTimeline !== 'function' || typeof doc?.getAnimations !== 'function' || typeof win.requestAnimationFrame !== 'function') return Promise.resolve(0);
  const related = (node) => Boolean(node) && (root === doc || root.contains(node) || node.contains?.(root));
  // Two frames: a frame snapshots its timelines from the layout it starts
  // with, so a change made in a task shows in the frame after the next.
  return new Promise((resolve) => {
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
      let restarted = 0;
      for (const animation of doc.getAnimations()) {
        if (!scrollDriven(animation) || animation.timeline.currentTime !== null || animation.currentTime === null) continue;
        if (!related(animation.timeline.source) && !related(animation.effect?.target)) continue;
        animation.cancel();
        animation.play();
        restarted += 1;
      }
      resolve(restarted);
    }));
  });
}

/** The element's own time-based animations (no pseudo-elements, no descendants, nothing scroll-driven). */
function ownAnimations(element) {
  if (typeof element.getAnimations !== 'function') return [];
  return element.getAnimations().filter((animation) => !animation.effect?.pseudoElement && !scrollDriven(animation));
}

/** @returns {number} */
function iterationsOf(animation) {
  const timing = animation.effect?.getComputedTiming?.() ?? animation.effect?.getTiming?.() ?? {};
  return timing.iterations ?? 1;
}

/**
 * A ds-* motion of the element that is running or holds its end (an exit
 * that filled forwards, an earlier handoff); loops do not count.
 */
function holdsMotion(animation) {
  const name = animation.animationName;
  const ours = animation.id === 'ds-handoff' || (typeof name === 'string' && name.startsWith('ds-'));
  if (!ours || iterationsOf(animation) === Infinity) return false;
  if (animation.playState === 'running' || animation.playState === 'paused') return true;
  if (animation.playState !== 'finished') return false;
  const fill = animation.effect?.getComputedTiming?.().fill;
  return fill === 'forwards' || fill === 'both';
}

/** The computed animation-name list of the element (undefined without a DOM). */
function animationNames(element) {
  const value = computed(element)?.animationName;
  return typeof value === 'string' ? splitList(value).filter((name) => name !== 'none') : undefined;
}

/* ── Interruption ───────────────────────────────────── */

/** What a handoff reads and animates (no keyframe animates transform). */
const TRACKED = ['opacity', 'translate', 'scale', 'clip-path', 'stroke-dashoffset'];

const camel = (property) => property.replace(/-([a-z])/g, (match, char) => char.toUpperCase());
const kebab = (property) => property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

/** Computed values of `properties` as { property: value }. */
function readStyle(element, properties) {
  const style = computed(element);
  return Object.fromEntries(properties.map((property) => [property, style ? style.getPropertyValue(property) : '']));
}

/** The tracked properties an animation's keyframes name. */
function trackedProperties(animation) {
  const names = new Set();
  for (const keyframe of animation.effect?.getKeyframes?.() ?? []) {
    for (const key of Object.keys(keyframe)) if (TRACKED.includes(kebab(key))) names.add(kebab(key));
  }
  return [...names];
}

/** The numbers in a computed value; `none` is the identity of its property. */
function numbersOf(property, value) {
  if (!value || value === 'none') return property === 'scale' ? [1, 1, 1] : [0, 0, 0];
  return (value.match(new RegExp(NUMBER, 'gi')) ?? []).map(Number);
}

/**
 * The share of a motion still to go, 0 to 1: from the fade track (the
 * opacity left to change), else from the first track that travels.
 */
function remainingShare(tracks, now) {
  const ordered = [...tracks].sort((a, b) => Number(b.properties.includes('opacity')) - Number(a.properties.includes('opacity')));
  for (const track of ordered) {
    for (const property of track.properties) {
      const start = numbersOf(property, track.start[property]);
      const end = numbersOf(property, track.end[property]);
      const current = numbersOf(property, now[property]);
      let share = -1;
      start.forEach((value, index) => {
        const span = Math.abs(value - (end[index] ?? 0));
        if (span > 1e-3 && Number.isFinite(current[index])) share = Math.max(share, Math.abs(current[index] - (end[index] ?? 0)) / span);
      });
      if (share >= 0) return Math.min(1, share);
    }
  }
  return 1;
}

/**
 * Applies `classes` to an element whose own motion is running or holds
 * its end, so that the new motion continues from the current state:
 *   1. snapshot the computed opacity, translate, scale and clip-path;
 *   2. cancel the running own animations;
 *   3. apply the new classes;
 *   4. read each new CSS animation's curve (the computed list, by index),
 *      duration and its start and end values (paused at both ends);
 *   5. cancel those and play each track from the snapshot to its end with
 *      el.animate(): id 'ds-handoff', the new direction's curve, the share
 *      of the duration left (at least --ds-dur-micro), no delay, and for an
 *      exit fill: forwards; a snapshot value that no new track covers and
 *      that differs from the rest style glides to it on one more track
 *      (the new direction's movement curve; the spring when an entrance
 *      has none, its effects curve for opacity).
 * @param {Element} element
 * @param {string[]} classes
 * @param {boolean} leaving
 * @param {MotionState} state
 * @returns {string[]|undefined} the animation names of the new classes
 */
function handoff(element, classes, leaving, state) {
  const now = readStyle(element, TRACKED);
  for (const animation of ownAnimations(element)) if (holdsMotion(animation)) animation.cancel();
  state.handoffs = [];
  clearMotion(element);
  flushStyle(element);
  element.classList.add(...classes);
  const names = animationNames(element) ?? [];
  const easings = splitList(computed(element)?.animationTimingFunction ?? '');
  const used = new Set();
  const tracks = [];
  for (const animation of ownAnimations(element)) {
    const name = animation.animationName;
    if (typeof name !== 'string' || !names.includes(name) || iterationsOf(animation) === Infinity) continue;
    // A name listed twice takes its next position.
    let index = names.indexOf(name);
    while (used.has(index) && names.indexOf(name, index + 1) >= 0) index = names.indexOf(name, index + 1);
    used.add(index);
    const timing = animation.effect.getComputedTiming();
    const properties = trackedProperties(animation);
    animation.pause();
    animation.currentTime = 0;
    const start = readStyle(element, properties);
    animation.currentTime = Number(timing.endTime) || 0;
    const end = readStyle(element, properties);
    tracks.push({ animation, properties, start, end, easing: easings[index % (easings.length || 1)] || 'linear', duration: Number(timing.duration) || 0 });
  }
  for (const track of tracks) track.animation.cancel();
  const share = remainingShare(tracks, now);
  const floor = motionDuration(element, '--ds-dur-micro');
  // A property that was moving but has no track in the new motion (the
  // lift of enter() under the fade-only leave()) glides to its rest value
  // instead of snapping there: one more track on the new direction's curve.
  const covered = new Set(tracks.flatMap((track) => track.properties));
  const rest = readStyle(element, TRACKED.filter((property) => !covered.has(property)));
  const longest = Math.max(0, ...tracks.map((track) => track.duration)) || motionDuration(element, leaving ? '--ds-dur-fast' : '--ds-dur-medium');
  for (const [property, value] of Object.entries(rest)) {
    if (!differs(property, now[property], value)) continue;
    const opacity = property === 'opacity';
    let easing = leaving ? easings.at(-1) : (easings.length > 1 && !opacity ? easings.at(-1) : '');
    let token;
    if (!easing) {
      token = opacity ? '--ds-ease-in-out' : '--ds-ease-spatial';
      easing = motionEasing(element, token);
    }
    const end = value === 'none' && property === 'clip-path' && now[property].startsWith('inset(') ? 'inset(0px)' : value;
    tracks.push({ properties: [property], end: { [property]: end }, easing, token, duration: longest });
  }
  for (const track of tracks) {
    if (!track.properties.length) continue;
    const from = {};
    const to = {};
    for (const property of track.properties) {
      from[camel(property)] = now[property];
      to[camel(property)] = track.end[property];
    }
    const animation = animateSafe(element, [from, to], {
      id: 'ds-handoff',
      duration: Math.max(floor, track.duration * share),
      delay: 0,
      easing: track.easing,
      fill: leaving ? 'forwards' : 'none',
    }, track.token);
    animation.id = 'ds-handoff';
    state.handoffs.push(animation);
  }
  return names;
}

/** Whether two computed values of a property differ visibly (`none` is the property's identity). */
function differs(property, a, b) {
  if (a === b) return false;
  // A missing component is the identity (a one-value scale is uniform).
  const pad = (values) => (property === 'scale' && values.length === 1 ? [values[0], values[0]] : values);
  const x = pad(numbersOf(property, a));
  const y = pad(numbersOf(property, b));
  const identity = property === 'scale' ? 1 : 0;
  return Array.from({ length: Math.max(x.length, y.length) }, (_, index) => index)
    .some((index) => Math.abs((x[index] ?? identity) - (y[index] ?? identity)) > 1e-3);
}

/**
 * Applies the classes of enter() or leave(): through a handoff when the
 * element is in motion, else by restarting them from the start.
 * @returns {string[]|undefined} the animation names to wait for
 */
function play(element, classes, leaving, state) {
  return playEach([{ element, classes, state }], leaving)[0];
}

/**
 * play() for many elements at once (a FLIP's entering or leaving items):
 * every read for all of them, then every write, with one style flush in
 * between, so that n items cost a few style recalculations rather than
 * three each. For each element it does what play() does for it alone.
 * @param {{ element: Element, classes: string[], state: MotionState }[]} entries
 * @param {boolean} leaving
 * @returns {(string[]|undefined)[]} the animation names to wait for, per entry
 */
function playEach(entries, leaving) {
  // Read: what is still moving continues from where it is (handoff()).
  const moving = entries.map(({ element }) => ownAnimations(element).some(holdsMotion));
  // Write: the classes of an earlier call go, then one flush, so that
  // adding them back starts the animation afresh.
  let dirty = null;
  entries.forEach(({ element, state }, index) => {
    if (moving[index]) return;
    cancelHandoffs(element, state);
    if (clearMotion(element)) dirty ??= element;
  });
  if (dirty) flushStyle(dirty);
  entries.forEach(({ element, classes }, index) => {
    if (!moving[index]) element.classList.add(...classes);
  });
  // Read: the animations the classes started.
  return entries.map(({ element, classes, state }, index) => (moving[index]
    ? handoff(element, classes, leaving, state)
    : animationNames(element)));
}

/**
 * Moves focus out of a leaving element before it turns inert: to `focus`,
 * else the opener enter() recorded, else the closest ancestor with
 * tabindex="-1" (a view); else focus is dropped.
 */
function releaseFocus(element, focus, state) {
  const active = activeIn(element);
  if (!active || !element.contains?.(active)) return;
  const usable = (node) => Boolean(node) && node.isConnected !== false && !element.contains(node)
    && typeof node.focus === 'function' && !node.closest?.('[inert]');
  const wanted = typeof focus === 'function' ? focus() : focus;
  const target = [wanted, state.opener, element.parentElement?.closest?.('[tabindex="-1"]')].find(usable);
  if (target) target.focus({ preventScroll: true });
  const still = activeIn(element);
  if (still && element.contains(still)) still.blur?.();
}

/* ── Classes, waiting, entrances and exits ──────────── */

/**
 * Numbers the items of a list for staggered entrances (`--ds-i`, read by
 * .ds-enter and by .ds-stagger > *). Set through the CSSOM, so it also
 * works on pages whose CSP forbids inline style attributes. Items after
 * the sixth share the last step, so a long list never trails in.
 * @param {Iterable<Element>} elements
 * @param {{ from?: number, max?: number }} [options] `max` caps the index
 *   (default STAGGER_MAX)
 */
export function stagger(elements, options = {}) {
  const from = options.from || 0;
  const max = options.max === undefined ? STAGGER_MAX : options.max;
  let index = 0;
  for (const element of elements) {
    /** @type {HTMLElement} */ (element).style.setProperty('--ds-i', String(Math.min(from + index, max)));
    index += 1;
  }
}

/**
 * Restarts a one-shot animation class on an element that may already carry
 * it (the browser only replays an animation when its name changes). Only
 * an element that carries one of the classes is flushed, with a style
 * flush (no layout, works on SVG). The class may animate descendants only
 * (.ds-stagger > *): Firefox and WebKit skip the flush of a computed-style
 * read when the element itself is unaffected, so the flush here is
 * getAnimations(), which commits the whole document's style.
 * @param {Element|null|undefined} element
 * @param {...string} classNames
 */
export function replay(element, ...classNames) {
  if (!element) return;
  if (classNames.some((name) => element.classList.contains(name))) {
    element.classList.remove(...classNames);
    if (typeof element.getAnimations === 'function') void element.getAnimations();
    else flushStyle(element);
  }
  element.classList.add(...classNames);
}

/**
 * The `--ds-time-scale` in effect on the element: 10 at the styleguide's
 * ?speed=0.1; 1 outside a theme, before ds.css has loaded or without a DOM.
 * @param {Element} element
 * @returns {number}
 */
function timeScale(element) {
  const style = computed(element);
  const value = style ? parseFloat(style.getPropertyValue('--ds-time-scale')) : NaN;
  return value > 0 ? value : 1;
}

/** Resolves on the next frame (or soon, where frames do not run: a hidden tab). */
function nextFrame(view) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CEILING_MARGIN_MS);
    if (typeof view.requestAnimationFrame === 'function') {
      view.requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve(undefined);
      });
    }
  });
}

/** How long the animation still runs, in ms (its delay included). */
function remainingMs(animation) {
  const timing = animation.effect?.getComputedTiming?.() ?? {};
  const end = Number(timing.endTime);
  if (!Number.isFinite(end)) return DEFAULT_TIMEOUT_MS;
  const rate = Math.abs(animation.playbackRate ?? 1) || 1;
  return Math.max(0, end - (Number(animation.currentTime) || 0)) / rate;
}

/** The animations settled() waits for (see there). */
function watched(element, options) {
  const transitionsOnly = options.event === 'transitionend';
  const transitions = transitionsOnly || options.transitions === true;
  const names = options.names;
  return element.getAnimations({ subtree: options.subtree === true }).filter((animation) => {
    if (!animation.effect || animation.effect.pseudoElement || scrollDriven(animation)) return false;
    if (animation.playState === 'idle' || iterationsOf(animation) === Infinity) return false;
    if (typeof animation.transitionProperty === 'string') {
      return transitions && (!options.property || animation.transitionProperty === options.property);
    }
    if (transitionsOnly) return false;
    if (typeof animation.animationName === 'string') return !names || names.includes(animation.animationName);
    return animation.id === 'ds-handoff' || Boolean(names?.includes(animation.id));
  });
}

/**
 * Resolves when every animation finished or was cancelled, or at the
 * ceiling: `timeout`, else the time the animations still need plus a
 * margin. A paused animation (a frozen page, a scrubbed demo) has not
 * ended, so the derived ceiling is set again while one is paused.
 */
function allFinished(list, timeout) {
  return new Promise((resolve) => {
    let timer = 0;
    let done = false;
    let wasPaused = false;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      resolve(undefined);
    };
    const arm = (first) => {
      if (done) return;
      const open = list.filter((animation) => animation.playState === 'running' || animation.playState === 'paused');
      const paused = timeout === undefined && open.some((animation) => animation.playState === 'paused');
      if (!first && !paused && !wasPaused) {
        finish();
        return;
      }
      wasPaused = paused;
      const wait = first && timeout !== undefined ? timeout : Math.max(0, ...open.map(remainingMs)) + CEILING_MARGIN_MS;
      timer = /** @type {any} */ (setTimeout(() => arm(false), wait));
    };
    arm(true);
    Promise.allSettled(list.map((animation) => animation.finished)).then(finish);
  });
}

/**
 * Without getAnimations() (a test fake): the element's own end and cancel
 * events, one per expected name, or the timeout.
 */
function settledByEvents(element, options) {
  const transitions = options.event === 'transitionend' || options.transitions === true;
  const types = transitions ? ['transitionend', 'transitioncancel'] : ['animationend', 'animationcancel'];
  const expected = !transitions && options.names?.length ? new Set(options.names) : null;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS * timeScale(element);
  return new Promise((resolve) => {
    let timer = 0;
    const finish = () => {
      clearTimeout(timer);
      for (const type of types) element.removeEventListener(type, done);
      resolve(undefined);
    };
    const done = (/** @type {any} */ evt) => {
      if (evt.target !== element || evt.pseudoElement) return;
      if (transitions && options.property && evt.propertyName !== options.property) return;
      if (expected && evt.animationName) {
        expected.delete(evt.animationName);
        if (expected.size) return;
      }
      finish();
    };
    for (const type of types) element.addEventListener(type, done);
    timer = /** @type {any} */ (setTimeout(finish, timeout));
  });
}

/**
 * Resolves when the element's own motion has finished. Call it right after
 * the class change that starts the motion: it reads the element's
 * animations at once (getAnimations() flushes style) and keeps
 *   - CSS animations named in `names` (all, without `names`),
 *   - 'ds-handoff' animations (an interrupted enter() or leave()),
 *   - CSS transitions only with `transitions: true`, or with
 *     `event: 'transitionend'` (then only those), of `property` if given;
 * never pseudo-elements (state layers, ripples), loops or scroll-driven
 * animations (they follow the scroll, not time). A cancelled
 * animation counts as done. With nothing to wait for it resolves on the
 * next frame. The ceiling is `timeout`, else the end of the longest kept
 * animation (delay and duration) plus 100ms.
 * @param {Element|null|undefined} element
 * @param {{ names?: string[], property?: string, transitions?: boolean, subtree?: boolean, timeout?: number, event?: 'animationend'|'transitionend' }} [options]
 * @returns {Promise<void>}
 */
export function settled(element, options = {}) {
  if (!element) return Promise.resolve();
  if (typeof element.getAnimations !== 'function') return settledByEvents(element, options);
  const first = watched(element, options);
  if (first.length) return allFinished(first, options.timeout);
  return nextFrame(windowOf(element)).then(() => {
    const later = watched(element, options);
    return later.length ? allFinished(later, options.timeout) : undefined;
  });
}

/**
 * Plays a .ds-enter animation once (see motion.css for variants) and
 * cleans the classes up afterwards, so later re-renders do not replay it.
 * Clears `hidden` and `inert` first, records the focused element outside
 * as the opener (leave() returns focus there) and, when the element is
 * still moving (a running exit), continues from where it is.
 * @param {Element|null|undefined} element
 * @param {''|'fade'|'scale'|'slide'|'swap'|'delayed'|'pop'|'fill'|'fill-x'|'fill-y'} [variant]
 * @returns {Promise<void>} resolves without acting once a later call took over
 */
export function enter(element, variant = '') {
  if (!element) return Promise.resolve();
  return enterEach([element], variant)[0];
}

/**
 * enter() for each of many elements, as one batch of reads and writes
 * (playEach()); a FLIP's items that come. Not a stagger: see enterAll().
 * @param {Element[]} elements
 * @param {string} [variant]
 * @returns {Promise<void>[]} one per element, as enter() returns it
 */
function enterEach(elements, variant = '') {
  const classes = variant ? ['ds-enter', `ds-enter--${variant}`] : ['ds-enter'];
  const entries = elements.map((element) => {
    const state = stateOf(element);
    const gen = ++state.gen;
    const doc = element.ownerDocument;
    const active = activeIn(element);
    state.opener = active && active !== doc?.body && !element.contains?.(active) ? active : null;
    dropStep(element);
    if (/** @type {HTMLElement} */ (element).hidden) /** @type {HTMLElement} */ (element).hidden = false;
    if (/** @type {HTMLElement} */ (element).inert) /** @type {HTMLElement} */ (element).inert = false;
    state.inert = false;
    markLeaving(element, state, false);
    return { element, classes, state, gen };
  });
  const names = playEach(entries, false);
  return entries.map(({ element, state, gen }, index) => settled(element, { names: names[index] }).then(() => {
    if (state.gen !== gen) return;
    clearMotion(element);
    cancelHandoffs(element, state);
  }));
}

/**
 * Plays a .ds-leave animation, then removes or hides the element. Focus
 * inside moves out first (to `focus`, else the opener, else the closest
 * tabindex="-1" ancestor), then the element is `inert` for the exit.
 *   then 'remove' (default)  removes it; meanwhile it is a pending removal
 *                            (data-ds-leaving) that DS.dom.morphHtml() and
 *                            flip() skip, until enter() or cancel()
 *        'hide'              sets `hidden`, clears `inert` and the classes
 *        'keep'              leaves it in the DOM, invisible (the exit's
 *                            end holds) and inert, until enter() or cancel()
 * @param {Element|null|undefined} element
 * @param {''|'sink'|'scale'|'slide'|'pop'} [variant]
 * @param {{ then?: 'remove'|'hide'|'keep', focus?: Element|(() => Element|null)|null }} [options]
 * @returns {Promise<void>} resolves without acting once a later call took over
 */
export function leave(element, variant = '', options = {}) {
  if (!element) return Promise.resolve();
  return leaveEach([element], variant, options)[0];
}

/**
 * leave() for each of many elements, as one batch of reads and writes
 * (playEach()); a FLIP's items that go.
 * @param {Element[]} elements
 * @param {string} [variant]
 * @param {{ then?: 'remove'|'hide'|'keep', focus?: Element|(() => Element|null)|null }} [options]
 * @returns {Promise<void>[]} one per element, as leave() returns it
 */
function leaveEach(elements, variant = '', options = {}) {
  const then = options.then || 'remove';
  const classes = variant ? ['ds-leave', `ds-leave--${variant}`] : ['ds-leave'];
  const entries = elements.map((element) => {
    const state = stateOf(element);
    const gen = ++state.gen;
    releaseFocus(element, options.focus, state);
    if (!(/** @type {HTMLElement} */ (element).inert)) {
      /** @type {HTMLElement} */ (element).inert = true;
      state.inert = true;
    }
    markLeaving(element, state, then === 'remove');
    return { element, classes, state, gen };
  });
  const names = playEach(entries, true);
  return entries.map(({ element, state, gen }, index) => settled(element, { names: names[index] }).then(() => {
    if (state.gen !== gen) return;
    if (then === 'remove') element.remove();
    else if (then === 'hide') {
      /** @type {HTMLElement} */ (element).hidden = true;
      if (state.inert) /** @type {HTMLElement} */ (element).inert = false;
      state.inert = false;
      clearMotion(element);
      cancelHandoffs(element, state);
    }
  }));
}

/**
 * Stops what enter() or leave() started: pending continuations are called
 * off, handoffs cancelled, the motion classes removed and the `inert` that
 * leave() set cleared. The element shows its rest state at once; the way
 * to take back a pending leave() without an entrance.
 * @param {Element|null|undefined} element
 */
export function cancel(element) {
  if (!element) return;
  const state = stateOf(element);
  state.gen += 1;
  cancelHandoffs(element, state);
  clearMotion(element);
  dropStep(element);
  if (state.inert) /** @type {HTMLElement} */ (element).inert = false;
  state.inert = false;
  markLeaving(element, state, false);
}

/** Whether any part of the element lies inside the viewport. */
function inView(element, view) {
  const rect = element.getBoundingClientRect?.();
  const width = view.innerWidth;
  const height = view.innerHeight;
  if (!rect || !(width > 0) || !(height > 0)) return true;
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
}

/**
 * enter() for many elements at once, in batches: one write pass clears
 * the motion classes, one style flush, one read pass (the rects, only for
 * `visibleOnly`), one write pass sets `--ds-i` and the classes. Items
 * entirely outside the viewport get no entrance (they show at rest);
 * items still in motion continue through enter(), without a stagger step.
 * The batch removes the `--ds-i` it wrote once everything settled, also
 * from items a later call took over; a later enter() or enterAll() on an
 * item drops it at once, so an interrupted item never keeps its step.
 * @param {Iterable<Element>} elements
 * @param {string} [variant]  as for enter()
 * @param {{ stagger?: boolean, max?: number, visibleOnly?: boolean }} [options]
 * @returns {Promise<void>}
 */
export function enterAll(elements, variant = '', options = {}) {
  const { stagger: staggered = true, max = STAGGER_MAX, visibleOnly = true } = options;
  const items = Array.from(elements ?? []).filter(Boolean);
  if (!items.length) return Promise.resolve();
  const classes = variant ? ['ds-enter', `ds-enter--${variant}`] : ['ds-enter'];
  const batchId = {};
  // Read: what is still moving continues from where it is.
  const moving = items.filter((item) => ownAnimations(item).some(holdsMotion));
  const batch = items.filter((item) => !moving.includes(item));
  // Write: one pass of class removals (and of the steps an earlier batch left).
  const gens = new Map();
  let dirty = null;
  for (const item of batch) {
    const state = stateOf(item);
    gens.set(item, ++state.gen);
    cancelHandoffs(item, state);
    dropStep(item);
    if (item.hidden) item.hidden = false;
    if (item.inert) item.inert = false;
    state.inert = false;
    if (clearMotion(item)) dirty ??= item;
  }
  // One flush, on an element that changed (WebKit only recalculates for a dirty one).
  if (dirty) flushStyle(dirty);
  // Read: the rects.
  const shown = visibleOnly && batch.length ? batch.filter((item) => inView(item, windowOf(batch[0]))) : batch;
  // Write: steps and classes.
  shown.forEach((item, index) => {
    if (staggered) {
      item.style.setProperty('--ds-i', String(Math.min(index, max)));
      stepOwners.set(item, batchId);
    }
    item.classList.add(...classes);
  });
  const current = (item) => stateOf(item).gen === gens.get(item);
  const playing = shown.map((item) => settled(item, { names: animationNames(item) }).then(() => {
    if (current(item)) clearMotion(item);
  }));
  // A handoff never staggers: enter() drops the step an earlier batch wrote.
  const continued = moving.map((item) => enter(item, variant));
  return Promise.all([...playing, ...continued]).then(() => {
    for (const item of shown) if (stepOwners.get(item) === batchId) dropStep(item);
  });
}

/**
 * The first-render stagger of a container: enterAll() on its element
 * children that are in view, not data-ds-keep helpers such as the
 * data-scrolled sentinel of watchScrolled() (default variant 'swap': the fade and 4px
 * rise of .ds-stagger). It marks the container data-ds-staggered, so later
 * calls (refreshes) resolve at once without motion, and it leaves no
 * classes or `--ds-i` behind.
 * @param {Element|null|undefined} container
 * @param {{ variant?: string, max?: number }} [options]
 * @returns {Promise<void>}
 */
export function staggerOnce(container, options = {}) {
  if (!container || container.hasAttribute('data-ds-staggered')) return Promise.resolve();
  container.setAttribute('data-ds-staggered', '');
  // A kept helper (the 1px sentinel first in a .ds-view) would take the
  // first step and push the real content one step later.
  const items = Array.from(container.children).filter((child) => !child.hasAttribute('data-ds-keep'));
  return enterAll(items, options.variant ?? 'swap', { max: options.max ?? STAGGER_MAX, visibleOnly: true });
}

/* ── Loaders ────────────────────────────────────────── */

/**
 * How much longer a loading indicator inserted at `startedAt` must stay
 * before its content may replace it: none when it never became visible (it
 * fades in after `delay`), else until it was visible for `minVisible`, so
 * it never flashes up and away half-faded. With `element` (the indicator)
 * the times come from its computed tokens, so they follow --ds-time-scale:
 * the delay from --ds-delay-boot when it is or sits in a .ds-boot, else
 * --ds-delay-loader, the minimum from --ds-hold-loader. Without it they are
 * LOADER_DELAY_MS and LOADER_MIN_VISIBLE_MS. Explicit numbers win.
 * @param {number} startedAt  Date.now() when the indicator was inserted
 * @param {number} [now]
 * @param {{ element?: Element|null, delay?: number, minVisible?: number }} [options]  ms
 * @returns {number} ms
 */
export function loaderHoldMs(startedAt, now = Date.now(), options = {}) {
  const element = options.element ?? null;
  const delayToken = element?.closest?.('.ds-boot') ? '--ds-delay-boot' : '--ds-delay-loader';
  const delay = options.delay ?? (element ? motionDuration(element, delayToken) : LOADER_DELAY_MS);
  const minVisible = options.minVisible ?? (element ? motionDuration(element, '--ds-hold-loader') : LOADER_MIN_VISIBLE_MS);
  const visible = now - startedAt - delay;
  if (visible <= 0 || visible >= minVisible) return 0;
  return minVisible - visible;
}

/**
 * Waits until a loading indicator inserted at `startedAt` may disappear
 * (see loaderHoldMs, which takes the same `element`, `delay` and
 * `minVisible`; `now` defaults to Date.now()).
 *
 * Deprecated (removed in 3.0 at the earliest): a number as the second
 * argument (`now`, then the options third); it still works. Pass
 * `{ now }` instead.
 * @param {number} startedAt  Date.now() when the indicator was inserted
 * @param {{ now?: number, element?: Element|null, delay?: number, minVisible?: number }|number} [options]
 * @param {{ element?: Element|null, delay?: number, minVisible?: number }} [legacy]  the options after a numeric `now`
 * @returns {Promise<void>}
 */
export function settleLoader(startedAt, options, legacy = {}) {
  const numeric = typeof options === 'number';
  const settings = numeric ? legacy : (options !== null && typeof options === 'object' ? options : {});
  const now = numeric ? options : settings.now ?? Date.now();
  const ms = loaderHoldMs(startedAt, now, { element: settings.element, delay: settings.delay, minVisible: settings.minVisible });
  return ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/* ── Refresh ─────────────────────────────────────────── */

/**
 * The refreshes running on each container: how many, the loading bar they
 * share and the container's aria-busy before the first.
 * @type {WeakMap<Element, { count: number, bar: Element|null, busy: string|null, startedAt: number }>}
 */
const refreshes = new WeakMap();

/** The error a refresh rethrows when its signal aborts. */
function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return typeof DOMException === 'function' ? new DOMException('The refresh was aborted', 'AbortError') : Object.assign(new Error('The refresh was aborted'), { name: 'AbortError' });
}

/**
 * The documented refresh as one call: `container` (the content about to be
 * replaced) gets .ds-stale and aria-busy="true" at once (it dims only after
 * --ds-delay-loader, so a fast answer changes nothing); when it sits
 * directly in .ds-content or .ds-page (and `loadbar` is not false) a
 * .ds-loadbar goes in at the top of that parent, where the bar reaches the
 * panel edges; then `load()` runs. Once it settled, a bar that
 * showed stays for --ds-hold-loader (settleLoader()), leaves (leave()), the
 * stale state goes and the promise resolves with the data: render it in
 * the continuation (the same task as the stale removal, so the old content
 * never shows undimmed). On a rejection or an abort of `signal` it cleans
 * up the same way and rethrows (an AbortError when aborted). Two
 * refreshes of one container share the bar and the stale state until the
 * last one settled. Times are the computed tokens.
 * @template T
 * @param {Element|null|undefined} container
 * @param {() => T|PromiseLike<T>} load
 * @param {{ signal?: AbortSignal, loadbar?: boolean }} [options]
 * @returns {Promise<T>}
 */
export function refresh(container, load, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (!container) return Promise.resolve().then(() => load());
  let run = refreshes.get(container);
  if (!run) {
    const doc = container.ownerDocument;
    run = { count: 0, bar: null, busy: container.getAttribute('aria-busy'), startedAt: Date.now() };
    refreshes.set(container, run);
    own(container, 'classes', 'ds-stale');
    own(container, 'attrs', 'aria-busy');
    container.classList.add('ds-stale');
    container.setAttribute('aria-busy', 'true');
    const parent = container.parentElement;
    if (options.loadbar !== false && parent?.matches?.('.ds-content, .ds-page') && doc) {
      const bar = doc.createElement('span');
      bar.className = 'ds-loadbar';
      bar.setAttribute('aria-hidden', 'true');
      const fill = doc.createElement('span');
      fill.className = 'ds-loadbar__bar';
      bar.append(fill);
      // At the top of the panel, where its margins take back the padding (loading.css).
      parent.insertBefore(bar, parent.firstChild);
      run.bar = bar;
    }
  }
  run.count += 1;
  const current = run;
  const done = () => {
    current.count -= 1;
    if (current.count > 0) return Promise.resolve();
    return settleLoader(current.startedAt, { element: current.bar ?? container }).then(() => {
      if (current.count > 0 || refreshes.get(container) !== current) return;
      refreshes.delete(container);
      if (current.bar) leave(current.bar);
      container.classList.remove('ds-stale');
      disown(container, 'classes', 'ds-stale');
      disown(container, 'attrs', 'aria-busy');
      if (current.busy === null) container.removeAttribute('aria-busy');
      else container.setAttribute('aria-busy', current.busy);
    });
  };
  const loading = new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => load()).then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', onAbort));
  });
  return loading.then(
    (data) => done().then(() => {
      if (signal?.aborted) throw abortError(signal);
      return data;
    }),
    (error) => done().then(() => {
      throw error;
    }),
  );
}

/* ── Blocked actions ────────────────────────────────── */

/** A busy button or one that shows its success face: blocked like a disabled one. */
const BUSY_ACTION = '.ds-btn:is([aria-busy="true"], .ds-btn--done)';

/** An action that says it is blocked (aria-disabled): it stays focusable, so its tooltip can say why. */
const DISABLED_ACTION = `:is(${[
  'a',
  'button',
  'input',
  'summary',
  '[role="button"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
].join(', ')})[aria-disabled="true"]`;

/** The events of an activation: a click (Enter and Space on buttons and links too), a middle click, a submission. */
const GUARDED_EVENTS = ['click', 'auxclick', 'submit'];

/** The key events a page's own handler activates an ARIA-role action on (they never arrive as clicks there). */
const GUARDED_KEY_EVENTS = ['keydown', 'keyup'];

/** Elements whose Enter and Space arrive as a click (the click guard takes them). */
const NATIVE_ACTION = new Set(['A', 'BUTTON', 'INPUT', 'SUMMARY']);

/**
 * The installed guard of each document or shadow root: the target it
 * listens on and how many holders keep it.
 * @type {WeakMap<object, { target: EventTarget, holders: number }>}
 */
const guards = new WeakMap();

/** The blocked action that `node` (an event's target) sits in, or null. */
function blockedAction(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement ?? null;
  if (typeof element?.closest !== 'function' || !element.closest('.ds-theme')) return null;
  const action = element.closest(`${BUSY_ACTION}, ${DISABLED_ACTION}`);
  return action && !action.closest('[data-ds-guard="off"]') ? action : null;
}

/** Cancels the activation of a blocked action before any page listener sees it. */
function blockActivation(event) {
  // The page's own script (el.click(), requestSubmit()) is never blocked.
  if (event.isTrusted === false) return;
  const source = event.type === 'submit' ? event.submitter : event.target;
  if (!blockedAction(source)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * Cancels Enter and Space on a blocked action that is no native control
 * (a div with role="button", an option, a menu item): the page's key
 * handler would activate it. Only with the focus on the action itself,
 * so a field inside it still types.
 */
function blockKeys(event) {
  if (event.isTrusted === false || (event.key !== 'Enter' && event.key !== ' ')) return;
  const action = blockedAction(event.target);
  if (!action || action !== event.target || NATIVE_ACTION.has(action.tagName)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** Installs the guard on `root` (a document or a shadow root) once, or adds a holder. */
function holdGuard(root) {
  const installed = guards.get(root);
  if (installed) {
    installed.holders += 1;
    return true;
  }
  const target = root.nodeType === 9 ? root.defaultView ?? root : root;
  if (typeof target?.addEventListener !== 'function') return false;
  for (const type of GUARDED_EVENTS) target.addEventListener(type, blockActivation, true);
  for (const type of GUARDED_KEY_EVENTS) target.addEventListener(type, blockKeys, true);
  guards.set(root, { target, holders: 1 });
  return true;
}

/** Lets go of one holder; the last one removes the listeners. */
function releaseGuard(root) {
  const installed = guards.get(root);
  if (!installed) return;
  installed.holders -= 1;
  if (installed.holders > 0) return;
  for (const type of GUARDED_EVENTS) installed.target.removeEventListener(type, blockActivation, true);
  for (const type of GUARDED_KEY_EVENTS) installed.target.removeEventListener(type, blockKeys, true);
  guards.delete(root);
}

/**
 * Blocks what says it is blocked, for every input: a click, a middle
 * click (auxclick), Enter or Space (on a native control they arrive as
 * clicks; on an ARIA-role action that has the focus, a div with
 * role="button" or an option, their keydown and keyup are cancelled
 * before the page's key handler), a label click
 * (it arrives as a click on its input) and a form submission (by its
 * submitter, also the default button of Enter in a field) never reach the
 * page's listeners or their default action when their target is inside
 * .ds-theme and inside
 *   - a busy or done button (.ds-btn[aria-busy="true"], .ds-btn--done), or
 *   - an aria-disabled action (a, button, input, summary and the roles
 *     button, switch, checkbox, radio, tab, option, menuitem,
 *     menuitemcheckbox, menuitemradio with aria-disabled="true"),
 * and not inside [data-ds-guard="off"] (a control that explains itself on
 * click). Focus, hover and tooltips stay, so the reason still shows; a
 * region with aria-busy (a container under a loading bar) is no action and
 * stays usable. Capture-phase listeners on the root's window (a shadow
 * root: on the root), installed once per document or shadow root and
 * shared by every holder: busy() installs it on its first call (for good),
 * DS.ripple.attach() while it is attached; a page that blocks actions with
 * neither calls it once at start-up.
 * Only user input is blocked, never the page's own script.
 * @param {Document|ShadowRoot} [root]
 * @returns {{ destroy: () => void }} destroy() lets go of this call's hold (the last holder removes the listeners)
 */
export function guard(root = globalThis.document) {
  let held = Boolean(root) && holdGuard(root);
  return {
    destroy() {
      if (!held) return;
      held = false;
      releaseGuard(root);
    },
  };
}

/** The documents and shadow roots busy() guarded (for good). @type {WeakSet<object>} */
const busyGuarded = new WeakSet();

/** Guards the document or shadow root of `element` once for busy(). */
function guardFor(element) {
  const root = element?.getRootNode?.();
  const usable = root && (root.nodeType === 9 || root.nodeType === 11) ? root : element?.ownerDocument;
  if (!usable || busyGuarded.has(usable)) return;
  if (holdGuard(usable)) busyGuarded.add(usable);
}

/* ── Busy buttons ───────────────────────────────────── */

/** The running busy() of each button. @type {WeakMap<Element, Promise<any>>} */
const busyRuns = new WeakMap();

/** The timer that ends each button's success face. @type {WeakMap<Element, any>} */
const doneTimers = new WeakMap();

/** A label setLabel() keeps until its button is back at rest. @type {WeakMap<Element, string>} */
const pendingLabels = new WeakMap();

/** Takes the success face off at once (a new busy() starts). */
function clearDone(button) {
  if (doneTimers.has(button)) {
    clearTimeout(doneTimers.get(button));
    doneTimers.delete(button);
    disown(button, 'classes', 'ds-btn--done');
  }
  button.classList?.remove('ds-btn--done');
  applyLabel(button);
}

/** The rest face of a faces button (the .ds-btn__face that is neither --busy nor --done), or null. */
function restFace(button) {
  const faces = Array.from(button.children ?? []).find((child) => child.classList?.contains('ds-btn__faces'));
  if (!faces) return null;
  return Array.from(faces.children ?? []).find((face) => face.classList?.contains('ds-btn__face')
    && !face.classList.contains('ds-btn__face--busy') && !face.classList.contains('ds-btn__face--done')) ?? null;
}

/** Writes `text` into the text of `slot`, keeping its elements (an icon, the faces, the ripple layer). */
function writeLabel(slot, text) {
  const texts = Array.from(slot.childNodes ?? []).filter((node) => node.nodeType === 3 && node.nodeValue.trim());
  if (!texts.length) {
    slot.append(slot.ownerDocument.createTextNode(text));
    return;
  }
  texts[0].nodeValue = text;
  for (const node of texts.slice(1)) node.remove();
}

/** Writes the label setLabel() kept, once its button is at rest. */
function applyLabel(button) {
  if (!pendingLabels.has(button) || busyRuns.has(button) || doneTimers.has(button)) return;
  const text = /** @type {string} */ (pendingLabels.get(button));
  pendingLabels.delete(button);
  const slot = restFace(button) ?? button;
  // An adaptive button (or a face) keeps its text in .ds-btn__label, which folds away on phones.
  const label = Array.from(slot.children ?? []).find((child) => child.classList?.contains('ds-btn__label'));
  writeLabel(label ?? slot, text);
}

/**
 * Sets the label of a button without dropping what it holds: the text of
 * its rest face (the .ds-btn__face that is neither --busy nor --done) on a
 * faces button, else its own text; in either, the text of a
 * .ds-btn__label child (an adaptive button); icons and the ripple layer
 * stay. While busy() runs or the success face shows, the new label
 * waits and shows once the button is back at rest, so the faces keep one
 * width while they roll.
 * @param {Element|null|undefined} button
 * @param {string} text
 */
export function setLabel(button, text) {
  if (!button) return;
  pendingLabels.set(button, String(text ?? ''));
  applyLabel(button);
}

/**
 * Runs `work` while `button` shows that it works, through the faces of
 * button.css: aria-busy="true" at once (blocked for every input: the first
 * call installs guard(); the busy face shows after --ds-delay-loader, so
 * fast work changes nothing); once a busy face showed it stays for the
 * loader minimum (settleLoader(), --ds-hold-loader); on success aria-busy
 * goes and, when the button has a success face (.ds-btn__face--done in its
 * .ds-btn__faces) and `done` is not false, .ds-btn--done shows it for
 * --ds-hold-success (`done: true` on a button without one changes
 * nothing). On failure aria-busy goes at once and the error is rethrown. A
 * second call while the button is busy returns the running promise and
 * does not start `work` again; a call during the success face takes it off
 * first. Times are the computed tokens (--ds-time-scale applies).
 * Announcing the result stays the page's job (aria-live).
 * @template T
 * @param {Element|null|undefined} button  a .ds-btn, best with .ds-btn__faces
 * @param {(() => T|PromiseLike<T>)|PromiseLike<T>|T} work  a function (called at once) or a promise
 * @param {{ done?: boolean }} [options]  done: false skips the success face (default: whether the button has one)
 * @returns {Promise<T>} the work's result, once the button is no longer busy
 */
export function busy(button, work, options = {}) {
  const start = () => {
    try {
      return typeof work === 'function' ? /** @type {Function} */ (work)() : work;
    } catch (error) {
      return Promise.reject(error);
    }
  };
  if (!button) return Promise.resolve(start());
  const running = busyRuns.get(button);
  if (running) return running;
  guardFor(button);
  const face = Boolean(button.querySelector?.(':scope > .ds-btn__faces > .ds-btn__face--done'));
  const done = face && (options.done ?? true);
  clearDone(button);
  // A re-render of the list around it (DS.dom.morphHtml) keeps both faces.
  own(button, 'attrs', 'aria-busy');
  button.setAttribute('aria-busy', 'true');
  const startedAt = Date.now();
  const delay = motionDuration(button, '--ds-delay-loader');
  /** @type {Promise<any>} */
  let promise;
  const finish = () => {
    if (busyRuns.get(button) === promise) busyRuns.delete(button);
    button.removeAttribute('aria-busy');
    disown(button, 'attrs', 'aria-busy');
  };
  promise = Promise.resolve(start()).then(
    (value) => settleLoader(startedAt, { element: button, delay }).then(() => {
      finish();
      if (done) {
        own(button, 'classes', 'ds-btn--done');
        button.classList.add('ds-btn--done');
        doneTimers.set(button, setTimeout(() => clearDone(button), motionDuration(button, '--ds-hold-success')));
      } else applyLabel(button);
      return value;
    }),
    (error) => {
      finish();
      applyLabel(button);
      throw error;
    },
  );
  busyRuns.set(button, promise);
  return promise;
}

/* ── Values ─────────────────────────────────────────── */

/** --ds-dur-glide outside a theme (MOTION_FALLBACKS): how long countUp() counts. */
export const COUNT_UP_MS = /** @type {number} */ (MOTION_FALLBACKS['--ds-dur-glide']);

/**
 * @typedef {object} CountRun
 * @property {number} to
 * @property {{ cancel: () => void, finished: Promise<void> }} handle
 * @property {(final: boolean) => void} stop
 */

/** The running count of an element (one loop per element). @type {WeakMap<Element, CountRun>} */
const counts = new WeakMap();

/** The figure each element shows, as a number (where the next count starts). @type {WeakMap<Element, number>} */
const shownValues = new WeakMap();

const doneHandle = () => ({ cancel() {}, finished: Promise.resolve() });

/**
 * A count's clock (see countUp): an animation without keyframes on the
 * element, id 'ds-count', or null without the Web Animations API.
 * @returns {Animation|null}
 */
function startClock(element, duration) {
  if (typeof element.animate !== 'function') return null;
  try {
    const clock = animateSafe(element, [], { id: 'ds-count', duration });
    clock.id = 'ds-count';
    return clock;
  } catch {
    return null;
  }
}

/**
 * Keeps a counting figure steady: tabular figures (kept afterwards, so the
 * final figure does not shift), a min-width of the wider of the old and
 * the final string (measured once) and aria-busy. Returns the undo of
 * what must not stay.
 * @returns {() => void}
 */
function steady(element, fromText, toText) {
  const busy = element.getAttribute?.('aria-busy') ?? null;
  // A re-render meanwhile (DS.dom.morphHtml) keeps what the count holds.
  for (const name of ['min-width', 'font-variant-numeric']) own(element, 'props', name);
  own(element, 'attrs', 'aria-busy');
  element.setAttribute?.('aria-busy', 'true');
  const style = computed(element);
  const inline = element.style;
  const minWidth = typeof inline?.minWidth === 'string' ? inline.minWidth : null;
  if (style && inline && typeof style.fontVariantNumeric === 'string' && !style.fontVariantNumeric.includes('tabular-nums')) {
    inline.fontVariantNumeric = style.fontVariantNumeric === 'normal' ? 'tabular-nums' : `${style.fontVariantNumeric} tabular-nums`;
  }
  // min-width does not apply to inline boxes; there the figure flows anyway.
  if (style && minWidth !== null && style.display !== 'inline' && typeof element.getBoundingClientRect === 'function') {
    element.textContent = fromText;
    const before = element.getBoundingClientRect().width;
    element.textContent = toText;
    const after = element.getBoundingClientRect().width;
    const box = style.boxSizing === 'border-box' ? 0
      : ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
    inline.minWidth = `${Math.max(before, after) - box}px`;
  }
  return () => {
    if (minWidth !== null) inline.minWidth = minWidth;
    tidyStyle(element);
    if (busy === null) element.removeAttribute?.('aria-busy');
    else element.setAttribute?.('aria-busy', busy);
    for (const name of ['min-width', 'font-variant-numeric']) disown(element, 'props', name);
    disown(element, 'attrs', 'aria-busy');
  };
}

/**
 * Counts a key figure in the element's text from the value it shows (the
 * last value it wrote, or one that a re-render wrote since and that reads
 * back through `format`; 0 on the first call, or `from`) to `to`, up or down, on --ds-ease-value over
 * --ds-dur-glide: the curve and time of progress bars, so a figure and its
 * bar land together: its clock is an animation on the element (id
 * 'ds-count'), which starts in the same frame as a CSS transition set with
 * it, and pausing or seeking it holds the figure. A new call takes over from
 * the shown value (one loop per element); the same value again changes nothing. While it counts the
 * element is aria-busy, keeps the width of its wider string and shows
 * tabular figures. A non-finite value, `duration: 0` or no animation
 * frames show the value at once; a disconnected element gets the final
 * value.
 * @param {Element|null|undefined} element
 * @param {number} to
 * @param {{ from?: number, format?: (value: number) => string, duration?: number, win?: any }} [options]
 * @returns {{ cancel: () => void, finished: Promise<void> }} cancel() writes the final value
 */
export function countUp(element, to, options = {}) {
  if (!element) return doneHandle();
  const format = options.format || ((value) => String(Math.round(value)));
  const target = Number(to);
  const running = counts.get(element);
  if (running && running.to === target && options.from === undefined) return running.handle;
  const cached = shownValues.get(element);
  let start = options.from !== undefined ? Number(options.from) : cached ?? 0;
  // Something else wrote the figure since the last count (a re-render by
  // DS.dom.morphHtml, the page): go on from what it shows when that reads
  // back through `format` ('1,284', '94 %'), else land at once.
  const text = String(element.textContent ?? '');
  if (!running && options.from === undefined && cached !== undefined && text !== format(cached)) {
    const parsed = Number(text.replace(/[^\d.-]/g, ''));
    start = text.trim() && Number.isFinite(parsed) && format(parsed) === text ? parsed : target;
  }
  const from = Number.isFinite(start) ? start : 0;
  running?.stop(false);
  if (!Number.isFinite(target)) {
    element.textContent = format(target);
    shownValues.delete(element);
    return doneHandle();
  }
  const write = (value) => {
    element.textContent = format(value);
    shownValues.set(element, value);
  };
  if (from === target) {
    if (element.textContent !== format(target)) write(target);
    else shownValues.set(element, target);
    return doneHandle();
  }
  const duration = options.duration ?? motionDuration(element, '--ds-dur-glide');
  const win = 'win' in options ? options.win : windowOf(element);
  if (!(duration > 0) || typeof win?.requestAnimationFrame !== 'function' || element.isConnected === false) {
    write(target);
    return doneHandle();
  }
  const ease = curve(motionEasing(element, '--ds-ease-value'));
  const undo = steady(element, format(from), format(target));
  // The count's clock: an animation without keyframes on the element. Its
  // start time resolves in the same step as a CSS transition started with
  // it (the same frame, whether the call comes from a task or a frame
  // callback), so a bar set together with the figure moves in step; and
  // pausing or seeking the page's animations holds the figure too. Without
  // the Web Animations API the count starts at its first frame.
  const clock = startClock(element, duration);
  let began = /** @type {number|null} */ (null);
  let frame = 0;
  let resolve = () => {};
  const finished = new Promise((done) => { resolve = done; });
  /** @type {CountRun} */
  const run = {
    to: target,
    handle: { cancel: () => { if (counts.get(element) === run) run.stop(true); }, finished },
    stop(final) {
      win.cancelAnimationFrame?.(frame);
      clock?.cancel();
      if (counts.get(element) === run) counts.delete(element);
      if (final) write(target);
      undo();
      resolve();
    },
  };
  counts.set(element, run);
  const tick = (/** @type {number} */ time) => {
    if (counts.get(element) !== run) return;
    let elapsed;
    if (clock) {
      // Cancelled from outside (no time any more): the count lands.
      elapsed = clock.playState === 'idle' ? duration : Number(clock.currentTime) || 0;
    } else {
      began ??= time;
      elapsed = time - began;
    }
    const progress = Math.min(1, Math.max(0, elapsed / duration));
    if (progress >= 1 || element.isConnected === false) {
      run.stop(true);
      return;
    }
    // A value never overshoots, whatever the curve.
    write(from + (target - from) * Math.min(1, Math.max(0, ease(progress))));
    frame = win.requestAnimationFrame(tick);
  };
  write(from);
  frame = win.requestAnimationFrame(tick);
  return run.handle;
}

/* ── Helpers: popup origin, swaps ───────────────────── */

const round = (value) => Math.round(value * 100) / 100;

/** A rect as plain numbers (DOMRect or a fake with edges only). */
function edges(rect) {
  return { left: rect.left, top: rect.top, right: rect.right ?? rect.left + rect.width, bottom: rect.bottom ?? rect.top + rect.height };
}

/**
 * The room a popup's clip keeps beyond its box on the sides that do not
 * move (--ds-space-6, the shadow of --ds-elev-popover), the same as its
 * resting clip-path: inset(calc(-1 * var(--ds-space-6))). Both ends are
 * then inset() shapes with the same side insets, so a clip-path
 * transition between them only moves the edge at the trigger and the
 * shadow never snaps on.
 */
const CLIP_BLEED = 'calc(-1 * var(--ds-space-6, 24px))';

/** The hidden end of ds-clip-in / ds-clip-out per side: closed towards the trigger. */
const CLIP_FROM = {
  bottom: `${CLIP_BLEED} ${CLIP_BLEED} 100% ${CLIP_BLEED}`,
  top: `100% ${CLIP_BLEED} ${CLIP_BLEED} ${CLIP_BLEED}`,
  right: `${CLIP_BLEED} 100% ${CLIP_BLEED} ${CLIP_BLEED}`,
  left: `${CLIP_BLEED} ${CLIP_BLEED} ${CLIP_BLEED} 100%`,
};

/**
 * Where a popup grows from: writes `--ds-motion-origin` (the trigger's
 * centre projected onto the panel's border box and clamped to it, in px)
 * and `--ds-clip-from` (the panel closed towards the trigger, with its
 * computed radius; its other three edges stay --ds-space-6 beyond the box,
 * like a popup's resting clip) on the panel through the CSSOM. Call it
 * once the panel is laid out at its place, before its entrance plays.
 * @param {Element|{ x: number, y: number }} trigger  an element, or a point (a context menu at the pointer)
 * @param {Element} panel
 * @returns {{ origin: string, side: 'bottom'|'top'|'right'|'left' }} side: where the panel lies from the trigger
 */
export function originFrom(trigger, panel) {
  const box = edges(panel.getBoundingClientRect());
  const anchor = typeof /** @type {any} */ (trigger)?.getBoundingClientRect === 'function'
    ? edges(/** @type {Element} */ (trigger).getBoundingClientRect())
    : (() => {
      const point = /** @type {{ x: number, y: number }} */ (trigger);
      return { left: point.x, right: point.x, top: point.y, bottom: point.y };
    })();
  const x = Math.min(box.right - box.left, Math.max(0, (anchor.left + anchor.right) / 2 - box.left));
  const y = Math.min(box.bottom - box.top, Math.max(0, (anchor.top + anchor.bottom) / 2 - box.top));
  // The side with the widest gap between trigger and panel (an overlapping
  // panel, a select-like menu, still gets the nearest edge); ties keep the
  // order below, so a panel over its trigger opens downwards.
  const gaps = { bottom: box.top - anchor.bottom, top: anchor.top - box.bottom, right: box.left - anchor.right, left: anchor.left - box.right };
  const side = /** @type {'bottom'|'top'|'right'|'left'} */ (['top', 'right', 'left'].reduce((best, name) => (gaps[name] > gaps[best] ? name : best), 'bottom'));
  const origin = `${round(x)}px ${round(y)}px`;
  const radius = computed(panel)?.borderRadius || '0px';
  const style = /** @type {HTMLElement} */ (panel).style;
  style.setProperty('--ds-motion-origin', origin);
  style.setProperty('--ds-clip-from', `inset(${CLIP_FROM[side]} round ${radius})`);
  return { origin, side };
}

/**
 * Makes `element` a .ds-swap slot and returns its current content: the
 * children that are not leaving. Loose text (a status line written as
 * plain text) is first wrapped in a span, so it can leave like a child.
 * @returns {HTMLElement[]}
 */
function swapSlot(element) {
  element.classList.add('ds-swap');
  const nodes = Array.from(element.childNodes ?? []);
  if (nodes.some((node) => node.nodeType === 3 && node.nodeValue.trim())) {
    const span = element.ownerDocument.createElement('span');
    for (const node of nodes) if (node.nodeType !== 1 || !node.hasAttribute('data-ds-leaving')) span.append(node);
    element.append(span);
  }
  return Array.from(element.children).filter((child) => !child.hasAttribute('data-ds-leaving'));
}

/** Sets properties through the CSSOM (CSP-safe, unlike a style attribute). */
function setStyles(element, styles) {
  for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value);
}

/** Children a swap marked as leaving (it takes the marks back if one returns). @type {WeakSet<Element>} */
const swappedOut = new WeakSet();

/**
 * Crosses `outgoing` (leaving, then removed) with `incoming` (entering) in
 * a .ds-swap slot. Both run through leave() and enter(), so a swap during
 * a swap continues from where each child is; only the last one stays.
 */
function swap(element, outgoing, incoming, enterHooks, leaveHooks) {
  // The slot stays a slot through a re-render of its parent while it runs.
  own(element, 'classes', 'ds-swap');
  const leaving = outgoing.map((child) => {
    child.setAttribute('data-ds-leaving', '');
    child.setAttribute('aria-hidden', 'true');
    swappedOut.add(child);
    setStyles(child, leaveHooks);
    return leave(child);
  });
  // A child that was leaving comes back (a crossfade back to the last node).
  if (swappedOut.delete(incoming)) {
    incoming.removeAttribute('data-ds-leaving');
    incoming.removeAttribute('aria-hidden');
    for (const name of ['--ds-leave-keyframes', '--ds-leave-duration', '--ds-leave-easing']) incoming.style.removeProperty(name);
  }
  setStyles(incoming, enterHooks);
  element.append(incoming);
  const entering = enter(incoming);
  const gen = stateOf(incoming).gen;
  return Promise.all([entering, ...leaving]).then(() => {
    disown(element, 'classes', 'ds-swap');
    if (stateOf(incoming).gen !== gen) return;
    for (const name of Object.keys(enterHooks)) incoming.style.removeProperty(name);
    // No empty attributes left behind by the swap.
    for (const name of ['style', 'class']) if (incoming.getAttribute(name) === '') incoming.removeAttribute(name);
  });
}

/**
 * The roll state of each slot with `hold`: when the current line went in
 * (Date.now()), the text waiting for its turn, the timer and the promise of
 * the roll that waits.
 * @type {WeakMap<Element, { shownAt: number, text: string|null, timer: any, waiting: Promise<void>|null, resolve: (() => void)|null }>}
 */
const rollHolds = new WeakMap();

/** The roll itself (see roll()). */
function rollNow(element, value) {
  const current = swapSlot(element);
  if (current.length === 1 && current[0].textContent === value) return Promise.resolve();
  const line = element.ownerDocument.createElement('span');
  line.textContent = value;
  return swap(element, current, line,
    { '--ds-enter-keyframes': 'ds-fade-in, ds-roll-in', '--ds-enter-delay': 'calc(var(--ds-dur-fast) / 2)' },
    { '--ds-leave-keyframes': 'ds-fade-out, ds-roll-out' });
}

/**
 * Rolls a status line inside `element` (which becomes a .ds-swap slot) to
 * `text`: the old line leaves upwards (ds-fade-out, ds-roll-out,
 * accelerating, --ds-dur-fast) and the new one comes up from below
 * (ds-fade-in, ds-roll-in on the spring, --ds-dur-medium) once the old one
 * is half out (--ds-enter-delay: half of --ds-dur-fast). The fast-starting
 * spring would otherwise catch up with the accelerating exit, and the two
 * lines would cover each other half a line apart. A roll during a roll
 * continues from where each line is; only the last text stays. The same
 * text again changes nothing.
 *
 * `hold: true` (2.0): every line stays readable. A new line waits until
 * the current one has shown for --ds-hold-status; a later text during the
 * wait replaces the waiting one, so only the latest rolls (a fast job's
 * "Syncing 3 of 40", "4 of 40" ... never flicker). The promise is the one
 * of the roll that ran.
 * @param {Element|null|undefined} element
 * @param {string} text
 * @param {{ hold?: boolean }} [options]
 * @returns {Promise<void>} resolves when the lines settled
 */
export function roll(element, text, options = {}) {
  if (!element) return Promise.resolve();
  const value = String(text ?? '');
  if (!options.hold) {
    const held = rollHolds.get(element);
    if (held) {
      clearTimeout(held.timer);
      held.resolve?.();
      rollHolds.delete(element);
    }
    return rollNow(element, value);
  }
  const state = rollHolds.get(element) ?? { shownAt: -Infinity, text: null, timer: 0, waiting: null, resolve: null };
  rollHolds.set(element, state);
  const hold = motionDuration(element, '--ds-hold-status');
  const run = () => {
    const next = /** @type {string} */ (state.text);
    const resolve = state.resolve;
    state.text = null;
    state.timer = 0;
    state.waiting = null;
    state.resolve = null;
    const shown = swapSlot(element);
    if (!(shown.length === 1 && shown[0].textContent === next)) state.shownAt = Date.now();
    const done = rollNow(element, next);
    done.then(() => resolve?.(), () => resolve?.());
    return done;
  };
  state.text = value;
  if (state.waiting) return state.waiting;
  const left = state.shownAt + hold - Date.now();
  if (left <= 0) return run();
  state.waiting = new Promise((resolve) => { state.resolve = resolve; });
  state.timer = setTimeout(run, left);
  return state.waiting;
}

/** Whether an icon swap shows b: its data-swap, else an aria-pressed="true" ancestor. */
function showsB(element) {
  const swap = element.getAttribute('data-swap');
  if (swap) return swap === 'b';
  return Boolean(element.parentElement?.closest('[aria-pressed="true"]'));
}

/** The face `which` ('a' or 'b') of an icon swap, created when missing. */
function iconFace(element, which) {
  const existing = Array.from(element.children).find((child) => child.classList.contains(`ds-icon-swap__${which}`));
  if (existing) return existing;
  const face = element.ownerDocument.createElement('span');
  face.className = `ds-icon-swap__${which}`;
  return face;
}

/** `next` as one node: an element as is, a string as icon markup (an icon() string). */
function iconNode(element, next) {
  if (next?.nodeType) return next;
  const template = element.ownerDocument.createElement('template');
  template.innerHTML = String(next ?? '').trim();
  const nodes = Array.from(template.content.childNodes);
  if (nodes.length === 1) return nodes[0];
  const span = element.ownerDocument.createElement('span');
  span.append(...nodes);
  return span;
}

/**
 * The icon kind of crossfade(): `element` becomes (or is) a .ds-icon-swap
 * with the faces .ds-icon-swap__a (its current content) and
 * .ds-icon-swap__b; `next` goes into the face that is not shown (unless
 * that face already holds the same icon, or `next` is a face) and
 * data-swap flips to it. The CSS transitions do the rest.
 */
function iconSwap(element, next) {
  // Until it settled, a re-render of its parent keeps the swap and its side.
  own(element, 'classes', 'ds-icon-swap');
  own(element, 'attrs', 'data-swap');
  element.classList.add('ds-icon-swap');
  const a = iconFace(element, 'a');
  const b = iconFace(element, 'b');
  const built = !a.parentNode || !b.parentNode;
  if (!a.parentNode) {
    for (const node of Array.from(element.childNodes)) if (node !== b) a.append(node);
    element.prepend(a);
  }
  if (!b.parentNode) element.append(b);
  const shown = showsB(element) ? b : a;
  const target = next === a || next === b ? next : shown === a ? b : a;
  if (next !== a && next !== b) {
    const node = iconNode(element, next);
    const same = target.childNodes.length === 1 && target.firstChild.isEqualNode?.(node);
    if (!same) {
      target.replaceChildren(node);
      flushStyle(target);
    }
  }
  // New faces and new content get their hidden style first, so the swap transitions from it.
  if (built) for (const face of [a, b]) flushStyle(face);
  element.setAttribute('data-swap', target === b ? 'b' : 'a');
  const release = () => {
    disown(element, 'classes', 'ds-icon-swap');
    disown(element, 'attrs', 'data-swap');
  };
  return settled(element, { transitions: true, subtree: true }).then(release, (error) => {
    release();
    throw error;
  });
}

/**
 * Crossfades the content of `element` to `next`.
 *
 * kind 'text' (the default): `element` becomes a .ds-swap slot and
 * `next` (a node or a string of text) fades in (--ds-dur-fast,
 * --ds-ease-in-out) while the current content fades out (--ds-dur-instant,
 * --ds-ease-in) and is removed. No movement and no width measuring: the
 * grid slot holds the width while both are there. Safe to call again
 * mid-swap; only the last content stays.
 *
 * kind 'icon' (1.1): `element` becomes a .ds-icon-swap (its current
 * content is face a) and `next` (an element, or icon markup from
 * DS.icons.icon()) goes into the face that is hidden; data-swap flips to
 * it. The incoming icon fades in and springs up from --ds-scale-small, a
 * pathLength="1" glyph draws itself; the outgoing one only fades. A rapid
 * toggle turns back from where the icons are. Pass an element (iconElement())
 * where a policy forbids parsing markup.
 * @param {Element|null|undefined} element
 * @param {Node|string} next
 * @param {{ kind?: 'text'|'icon' }} [options]
 * @returns {Promise<void>} resolves when the swap settled
 */
export function crossfade(element, next, options = {}) {
  const kind = options.kind ?? 'text';
  if (kind !== 'text' && kind !== 'icon') throw new TypeError(`crossfade(): unknown kind "${kind}"`);
  if (!element) return Promise.resolve();
  if (kind === 'icon') return iconSwap(element, next);
  const current = swapSlot(element);
  let incoming = /** @type {any} */ (next);
  if (incoming?.nodeType !== 1) {
    const span = element.ownerDocument.createElement('span');
    if (incoming?.nodeType) span.append(incoming);
    else span.textContent = String(incoming ?? '');
    incoming = span;
  }
  return swap(element, current.filter((child) => child !== incoming), incoming,
    { '--ds-enter-keyframes': 'ds-fade-in', '--ds-enter-duration': 'var(--ds-dur-fast)', '--ds-enter-easing': 'var(--ds-ease-in-out)' },
    { '--ds-leave-duration': 'var(--ds-dur-instant)' });
}

/* ── FLIP ───────────────────────────────────────────── */

/**
 * @typedef {object} FlipState
 * @property {string} pointer  the pointerType last over the container
 * @property {boolean} over  a pointer is over the container
 * @property {boolean} guarded  the live guard's listeners are attached
 * @property {string|undefined} items  the item selector of the last live call
 * @property {{ steps: { mutate: Function, aware: boolean }[], options: object }|null} queued  the held reorder: plain mutates in order, the latest that honours holdOrder
 * @property {any} timer  releases the held reorder after `hold`
 * @property {Array<(done: Promise<void>) => void>} waiters  calls whose reorder is held
 * @property {number} lifted  removed items still leaving out of flow
 * @property {string|null} position  the container's inline position before it was made relative
 * @property {string|null} minHeight  the container's inline min-height while its size is held (else null)
 * @property {Animation|null} sizeGlide  the container's block size gliding to its new height
 * @property {number} raised  items raised while they glide
 * @property {string|null} isolation  the container's inline isolation while items are raised (else null)
 * @property {boolean} backed  data-ds-glide and --ds-flip-backdrop set on the container while items are raised
 */

/** @type {WeakMap<Element, FlipState>} */
const flips = new WeakMap();

/** The running glide of an item (one per item). @type {WeakMap<Element, Animation>} */
const glides = new WeakMap();

/**
 * An item raised while it glides: its inline position and z-index before,
 * and its container.
 * @type {WeakMap<Element, { position: string, zIndex: string, container: Element }>}
 */
const raisedItems = new WeakMap();

/** @returns {FlipState} */
function flipState(container) {
  let state = flips.get(container);
  if (!state) {
    state = { pointer: '', over: false, guarded: false, items: undefined, queued: null, timer: 0, waiters: [], lifted: 0, position: null, minHeight: null, align: null, sizeGlide: null, raised: 0, isolation: null, backed: false };
    flips.set(container, state);
  }
  return state;
}

/** The items of a FLIP: `selector` matches, or the element children; never kept or leaving nodes. */
function flipItems(container, selector) {
  const list = selector ? Array.from(container.querySelectorAll(selector)) : Array.from(container.children ?? []);
  return list.filter((item) => !item.hasAttribute('data-ds-keep') && !item.hasAttribute('data-ds-leaving'));
}

function isFlipItem(container, node, selector) {
  if (node?.nodeType !== 1 || node.hasAttribute('data-ds-keep')) return false;
  return selector ? Boolean(node.matches?.(selector)) && container.contains(node) : node.parentElement === container;
}

/** Entirely outside the viewport (unknown viewport: inside). */
function offscreen(rect, view) {
  const width = view.innerWidth;
  const height = view.innerHeight;
  if (!(width > 0) || !(height > 0)) return false;
  const box = edges(rect);
  return box.bottom <= 0 || box.right <= 0 || box.top >= height || box.left >= width;
}

/**
 * Whether a removed item can leave out of flow (a table row cannot: it goes
 * at once). `display` is its computed display as measure() read it: read
 * again here, after a morph and the lifts before it wrote styles, it would
 * cost a style recalculation per removed item.
 */
function liftable(node, display) {
  if (node.tagName === 'TR') return false;
  return !(display ?? computed(node)?.display ?? '').startsWith('table');
}

/**
 * Takes a removed item out of flow where it was (position: absolute at its
 * measured rect, the container relative and held at its First height while
 * needed), so its neighbours close the gap while it fades inside the list.
 * Its size is the measured one, whatever its own limits say: a
 * `max-width: 100%` item of a shrink-wrapped container (the snackbar
 * region, once its last message leaves) would otherwise collapse.
 */
function lift(container, node, rect, frame, state, box = liftBox(container)) {
  if (!state.lifted) {
    state.position = null;
    if (box.position === 'static') {
      state.position = container.style.position;
      // Owned while items leave: a morph of an ancestor (a live re-render
      // of the card) keeps their containing block.
      own(container, 'props', 'position');
      container.style.position = 'relative';
    }
  }
  state.lifted += 1;
  const at = edges(rect);
  const left = at.left - frame.left - box.borderLeft + box.scrollLeft;
  const top = at.top - frame.top - box.borderTop + box.scrollTop;
  setStyles(node, {
    position: 'absolute',
    left: `${round(left)}px`,
    top: `${round(top)}px`,
    width: `${round(at.right - at.left)}px`,
    height: `${round(at.bottom - at.top)}px`,
    'min-width': '0',
    'max-width': 'none',
    'min-height': '0',
    'max-height': 'none',
    margin: '0',
    'box-sizing': 'border-box',
  });
}

/**
 * What lift() reads off the container: its position, its top and left
 * borders and its scroll offsets. A FLIP reads them once for all the items
 * it lifts (lazyLiftBox()), not once per item between the styles each lift
 * writes, which would recalculate style and layout every time.
 */
function liftBox(container) {
  const style = computed(container);
  return {
    position: style?.position ?? '',
    borderLeft: parseFloat(style?.borderLeftWidth) || 0,
    borderTop: parseFloat(style?.borderTopWidth) || 0,
    scrollLeft: container.scrollLeft || 0,
    scrollTop: container.scrollTop || 0,
  };
}

/** liftBox() read at the first lift of a FLIP and kept for the rest of it. */
function lazyLiftBox(container) {
  let box = null;
  return () => (box ??= liftBox(container));
}

/** Whether a computed colour paints anything (alpha above 0); ripple.js has the same for the chips. */
function paints(colour) {
  if (!colour || colour === 'transparent') return false;
  const inner = /\(([^)]*)\)/.exec(colour)?.[1] ?? '';
  const slash = inner.split('/');
  if (slash.length > 1) return parseFloat(slash[1]) > 0;
  const parts = inner.split(',');
  return parts.length === 4 ? parseFloat(parts[3]) > 0 : true;
}

/** The colour behind `element`: the background of the nearest ancestor (itself included) that paints one. */
function backdropOf(element) {
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    const colour = computed(node)?.backgroundColor;
    if (paints(colour)) return colour;
  }
  return '';
}

/**
 * Marks a container whose items glide: data-ds-glide and
 * --ds-flip-backdrop (the colour behind it), so items without a background
 * of their own (table rows) get an opaque backing for the glide
 * (table.css) and never show each other through. At rest the backing
 * matches what is behind, and it goes with the last raised item.
 */
function backContainer(container, state, known) {
  if (state.backed) return;
  state.backed = true;
  own(container, 'attrs', 'data-ds-glide');
  own(container, 'props', '--ds-flip-backdrop');
  const backdrop = known ?? backdropOf(container);
  if (backdrop) container.style.setProperty('--ds-flip-backdrop', backdrop);
  container.setAttribute('data-ds-glide', '');
}

function unbackContainer(container, state) {
  if (!state.backed) return;
  state.backed = false;
  container.removeAttribute('data-ds-glide');
  container.style.removeProperty('--ds-flip-backdrop');
  tidyStyle(container);
  disown(container, 'attrs', 'data-ds-glide');
  disown(container, 'props', '--ds-flip-backdrop');
}

/**
 * Paints a gliding item above the items it crosses: in DOM order an item
 * moving up would pass under every opaque item on its way and seem to
 * vanish. `rank` orders the moving items (the farthest travel on top) from
 * one above --ds-z-raised, so controls an item lifts to --ds-z-raised (the
 * checkbox and chevron of an interactive table row) stay under every
 * gliding item; the container is isolated meanwhile, so the ranks never
 * reach past it (a sticky bar or a menu over the list stays on top). The
 * glide's own translate already makes the item a stacking context and a
 * containing block, so `position: relative` (for a static item) changes
 * nothing else. Items without a background of their own get one from the
 * container's data-ds-glide (backContainer()).
 */
function raise(container, state, item, rank, layers, known = {}) {
  if (!raisedItems.has(item)) {
    raisedItems.set(item, { position: item.style.position, zIndex: item.style.zIndex, container });
    for (const name of ['position', 'z-index']) own(item, 'props', name);
    if ((known.position ?? computed(item)?.position) === 'static') item.style.position = 'relative';
    if (!state.raised) {
      state.isolation = container.style.isolation ?? '';
      own(container, 'props', 'isolation');
      container.style.isolation = 'isolate';
      backContainer(container, state, known.backdrop);
    }
    state.raised += 1;
  }
  item.style.zIndex = layers ? String(Math.max(layers.base + 1, Math.min(layers.base + 1 + rank, layers.sticky - 1))) : 'calc(var(--ds-z-raised) + 1)';
}

/**
 * The z range of gliding items, read once per flush: from one above
 * max(--ds-z-raised, --ds-z-pinned) (a pinned table column; fallback
 * raised + 1) up to one below --ds-z-sticky, so a mover never paints over
 * a sticky header or a pinned cell however many glide. Null without the
 * tokens (outside a theme).
 * @returns {{ base: number, sticky: number }|null}
 */
function glideLayers(container) {
  const style = computed(container);
  const read = (name) => parseInt(style?.getPropertyValue(name) ?? '', 10);
  const raised = read('--ds-z-raised');
  if (!Number.isFinite(raised)) return null;
  const pinned = read('--ds-z-pinned');
  const sticky = read('--ds-z-sticky');
  const base = Math.max(raised, Number.isFinite(pinned) ? pinned : raised + 1);
  return { base, sticky: Number.isFinite(sticky) ? sticky : Infinity };
}

/** Gives a raised item (and, after the last one, its container) its inline styles back. */
function lower(item) {
  const saved = raisedItems.get(item);
  if (!saved) return;
  raisedItems.delete(item);
  item.style.position = saved.position;
  item.style.zIndex = saved.zIndex;
  tidyStyle(item);
  for (const name of ['position', 'z-index']) disown(item, 'props', name);
  const state = flipState(saved.container);
  state.raised = Math.max(0, state.raised - 1);
  if (!state.raised && state.isolation !== null) {
    saved.container.style.isolation = state.isolation;
    tidyStyle(saved.container);
    state.isolation = null;
    disown(saved.container, 'props', 'isolation');
  }
  if (!state.raised) unbackContainer(saved.container, state);
}

/** The border-box height of an element. */
function heightOf(element) {
  const box = edges(element.getBoundingClientRect());
  return box.bottom - box.top;
}

/** The min-height (in the container's box-sizing) that makes it `height` px tall. */
function minHeightFor(container, height) {
  const style = computed(container);
  if (!style || style.boxSizing === 'border-box') return height;
  return height - ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
}

/**
 * Holds the container at `height` (its First size) while removed items
 * leave out of flow: they stay inside it, and what follows the list does
 * not jump up while they fade.
 */
function holdSize(container, state, height) {
  if (state.minHeight !== null) return;
  state.minHeight = container.style.minHeight ?? '';
  // Owned while held, like position, isolation and align-content: a morph
  // of an ancestor would otherwise drop it and what follows would jump.
  own(container, 'props', 'min-height');
  // Read before the write below, so that it costs no second recalculation.
  const style = computed(container);
  const display = style?.display ?? '';
  const alignContent = style?.alignContent ?? '';
  container.style.minHeight = `${round(Math.max(0, minHeightFor(container, height)))}px`;
  // A grid stretches its auto rows into a held height (align-content:
  // normal): the items that stay would grow and shrink back. They keep
  // their size until the held height has glided away.
  if (state.align === null && /grid/.test(display) && /^(normal|stretch)$/.test(alignContent)) {
    state.align = container.style.alignContent ?? '';
    own(container, 'props', 'align-content');
    container.style.alignContent = 'start';
  }
}

/** Gives a grid container its align-content back once nothing holds or glides its height. */
function releaseAlign(container, state) {
  if (state.align === null || state.minHeight !== null || state.sizeGlide) return;
  container.style.alignContent = state.align;
  tidyStyle(container);
  state.align = null;
  disown(container, 'props', 'align-content');
}

/**
 * Glides the container's block size from `from` (px) down to its natural
 * height on --ds-ease-out (a size that pushes layout never overshoots), so
 * what follows the list moves up smoothly. A growing list jumps, as before.
 * @returns {Promise<void>}
 */
function glideSize(container, state, from) {
  const to = heightOf(container);
  if (from - to < 0.5 || typeof container.animate !== 'function') {
    releaseAlign(container, state);
    return Promise.resolve();
  }
  const animation = animateSafe(container, [
    { minHeight: `${round(minHeightFor(container, from))}px` },
    { minHeight: `${round(minHeightFor(container, to))}px` },
  ], {
    id: 'ds-flip-size',
    duration: travelDuration(container, from - to),
    easing: motionEasing(container, '--ds-ease-out'),
  }, '--ds-ease-out');
  animation.id = 'ds-flip-size';
  state.sizeGlide = animation;
  return animation.finished.then(() => {
    if (state.sizeGlide === animation) state.sizeGlide = null;
    releaseAlign(container, state);
  }, () => {});
}

/**
 * A lifted item is gone. After the last one the container gets its
 * position back, and its held size glides to the new height (`glide`) or
 * goes at once.
 * @returns {Promise<void>}
 */
function landed(container, state, glide = true) {
  state.lifted = Math.max(0, state.lifted - 1);
  if (state.lifted) return Promise.resolve();
  if (state.position !== null) {
    container.style.position = state.position;
    tidyStyle(container);
    state.position = null;
    disown(container, 'props', 'position');
  }
  if (state.minHeight === null) return Promise.resolve();
  const from = heightOf(container);
  container.style.minHeight = state.minHeight;
  tidyStyle(container);
  state.minHeight = null;
  // The glide below runs above the inline value, which a morph may now set.
  disown(container, 'props', 'min-height');
  if (glide) return glideSize(container, state, from);
  releaseAlign(container, state);
  return Promise.resolve();
}

/**
 * The First of a FLIP: the rect of every item, the direct children among
 * them (only they can come back for an exit), the node after each child of
 * the container (a child `mutate` took out goes back where it was, so
 * :first-child and the like keep matching while it leaves) and the
 * container's edges.
 * @returns {{ before: Map<Element, DOMRect>, childrenOf: Set<Element>, nextOf: Map<Node, Node | null>, frame: { left: number, top: number, right: number, bottom: number } }}
 */
function measure(container, selector) {
  const before = new Map();
  for (const item of flipItems(container, selector)) before.set(item, item.getBoundingClientRect());
  // Read now, while the rects above left style clean: whether an item can
  // leave out of flow (liftable()) is asked only once the morph is writing.
  const displays = new Map();
  for (const item of before.keys()) if (item.tagName !== 'TR') displays.set(item, computed(item)?.display ?? '');
  const childrenOf = new Set(Array.from(before.keys()).filter((item) => item.parentElement === container));
  const nextOf = new Map(Array.from(container.childNodes, (node) => [node, node.nextSibling]));
  // Where focus is (refocus): the focused element and the item that holds it.
  const active = activeIn(container);
  const owner = active && container.contains?.(active) ? Array.from(before.keys()).find((item) => item.contains(active)) ?? null : null;
  return { before, displays, childrenOf, nextOf, frame: edges(container.getBoundingClientRect()), focus: owner ? { active, owner } : null };
}

/**
 * What takes focus and can hold it, as overlay.js counts it (test/js.test.js
 * keeps the two lists equal).
 */
const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]';

/** Whether `element` can take focus now: enabled, rendered, not inert and not leaving. */
function focusable(element) {
  if (!element || typeof element.focus !== 'function' || element.isConnected === false) return false;
  if (element.disabled || element.closest?.('[inert], [data-ds-leaving], [hidden]')) return false;
  if (typeof element.getClientRects === 'function' && !element.getClientRects().length) return false;
  return true;
}

/** Whether an item of a FLIP is gone (removed, a pending removal, or leaving). */
function itemGone(item, removed) {
  return item.isConnected === false || removed.some((entry) => entry.node === item) || Boolean(item.hasAttribute?.('data-ds-leaving'));
}

/**
 * Classes the system puts on an element for a moment: the press of
 * DS.ripple (ds-pressed), the done state of busy() (ds-btn--done) and the
 * classes of enter() / leave(). A twin is matched without them: the pressed
 * "Remove" still carries ds-pressed when its click removes the row.
 */
const TRANSIENT_CLASS = /^ds-(pressed|btn--done|enter|leave)(--|$)/;

/** The classes of `element` that say what it is, sorted ('' for none). */
function lastingClasses(element) {
  const value = typeof element?.getAttribute === 'function' ? element.getAttribute('class') ?? '' : '';
  return value.split(/\s+/).filter((name) => name && !TRANSIENT_CLASS.test(name)).sort().join(' ');
}

/** The focusable elements of `item`, the item itself first. */
function focusablesIn(item) {
  const own = item.matches?.(FOCUSABLE) ? [item] : [];
  return [...own, ...Array.from(item.querySelectorAll?.(FOCUSABLE) ?? [])].filter(focusable);
}

/** The element of `item` with the same classes as `old` (the next row's "Remove"), or null. */
function twinIn(item, old) {
  const classes = lastingClasses(old);
  if (!classes) return null;
  return focusablesIn(item).find((element) => lastingClasses(element) === classes) ?? null;
}

/** The item when it is focusable, else its first focusable element, or null. */
function firstIn(item) {
  return focusablesIn(item)[0] ?? null;
}

/**
 * refocus (flip()): when the item that held the focus went and focus is
 * lost (on <body>, nowhere, or still inside the item), it moves to the
 * element with the same classes as the old focus (state classes aside) in
 * the nearest item that stays and holds one, by distance in the old order
 * counted over the items with something to focus, the next item before the
 * previous one at the same distance; with no such twin, to the next item
 * that has something to focus, else the nearest such item before it, else
 * the fallback (`refocus` as an element or a
 * function); with none, leave() moves it out as usual. A page that moved
 * focus itself is left alone.
 */
function refocusAfter(container, focus, order, removed, refocus) {
  if (!focus || refocus === false) return;
  const { active, owner } = focus;
  if (!itemGone(owner, removed)) return;
  const now = activeIn(container);
  const doc = container.ownerDocument;
  const lost = !now || now === doc?.body || now === doc?.documentElement || owner.contains(now) || now === active && active.isConnected === false;
  if (!lost) return;
  const index = order.indexOf(owner);
  const alive = (item) => !itemGone(item, removed) && !item.hasAttribute?.('data-ds-keep');
  // Only items with something to focus count (a timeline's day heading is
  // passed over). The twin of the old focus by distance, the next item
  // before the previous one at each step: a chip row's previous chip wins
  // over the "Clear filters" after it, and a twin next door over one far
  // down the list (locked rows between without one). With no twin, the
  // next item, else the previous one.
  const bearing = (items) => items.filter((item) => alive(item) && firstIn(item));
  const later = bearing(order.slice(index + 1));
  const earlier = bearing(order.slice(0, index).reverse());
  let target = null;
  for (let step = 0; !target && step < Math.max(later.length, earlier.length); step += 1) {
    target = (later[step] && twinIn(later[step], active)) || (earlier[step] && twinIn(earlier[step], active)) || null;
  }
  const nearest = later[0] ?? earlier[0];
  if (!target && nearest) target = firstIn(nearest);
  if (!target && refocus !== true && refocus !== undefined) {
    const fallback = typeof refocus === 'function' ? refocus() : refocus;
    if (focusable(fallback)) target = fallback;
  }
  target?.focus({ preventScroll: true });
}

/**
 * One FLIP: measure, cancel the glides in flight (the rects include their
 * offsets, so each item continues from where it is), mutate, measure
 * again and glide every moved item from its old place. `first`: a
 * measure() taken before the DOM already changed (a held `mutate` that
 * ignored holdOrder).
 * @returns {Promise<void>}
 */
function runFlip(container, mutate, options, state, first) {
  const selector = options.items;
  const max = options.max ?? 50;
  const view = windowOf(container);
  // First.
  const { before, displays, childrenOf, nextOf, frame, focus } = first ?? measure(container, selector);
  const box = lazyLiftBox(container);
  const firstHeight = frame.bottom - frame.top;
  for (const item of before.keys()) {
    glides.get(item)?.cancel();
    glides.delete(item);
    // At once, so a removed item's lift is not undone later; a mover is raised again below.
    lower(item);
  }
  // The container's size in flight continues from the height just measured.
  const sizing = state.sizeGlide;
  sizing?.cancel();
  state.sizeGlide = null;
  const inserted = [];
  const removed = [];
  mutate({
    holdOrder: false,
    ...(typeof options.onKeep === 'function' ? { onKeep: options.onKeep } : {}),
    onInsert(node) {
      if (isFlipItem(container, node, selector)) inserted.push(node);
    },
    onRemove(node) {
      const rect = before.get(node);
      if (!rect || !liftable(node, displays?.get(node))) return undefined;
      holdSize(container, state, firstHeight);
      lift(container, node, rect, frame, state, box());
      return new Promise((resolve) => removed.push({ node, resolve }));
    },
  });
  // What `mutate` took out or put in by itself (not through the hooks): a
  // direct child that left the document fades out of flow where it was (it
  // goes back in, out of flow, for its exit); a new item fades in.
  const back = Array.from(before.keys()).filter((item) => !item.parentNode && childrenOf.has(item));
  // Back in for its exit only: data-ds-moving for one style flush keeps
  // their @starting-style entrances (a status icon) from playing
  // (motion.css). Each goes back before the node that followed it, never at
  // the end: structural selectors (:first-child, li + li) keep matching, so
  // its content and dividers do not jump while it fades. Last first, so a
  // removed neighbour it went before is already back.
  for (const item of back) item.setAttribute('data-ds-moving', '');
  for (const item of [...back].reverse()) {
    let next = nextOf.get(item) ?? null;
    while (next && next.parentNode !== container) next = nextOf.get(next) ?? null;
    container.insertBefore(item, next);
  }
  if (back.length) void computed(back[0])?.opacity;
  for (const item of back) item.removeAttribute('data-ds-moving');
  for (const item of back) {
    const rect = before.get(item);
    if (!liftable(item, displays?.get(item))) {
      item.remove();
      continue;
    }
    holdSize(container, state, firstHeight);
    lift(container, item, rect, frame, state, box());
    removed.push({ node: item, resolve() {} });
  }
  // The focused item went: its neighbour takes the focus (before leave() would drop it).
  refocusAfter(container, focus, Array.from(before.keys()), [...removed, ...back.filter((item) => !item.parentNode).map((node) => ({ node }))], options.refocus);
  for (const item of flipItems(container, selector)) {
    if (before.has(item) || inserted.includes(item) || removed.some((entry) => entry.node === item)) continue;
    // An item that brings its own entrance (a snackbar's keyframes) keeps it.
    if (item.getAnimations?.().some((animation) => animation.playState !== 'finished' && !scrollDriven(animation))) continue;
    inserted.push(item);
  }
  // Last.
  const moves = [];
  for (const item of flipItems(container, selector)) {
    const first = before.get(item);
    if (!first) continue;
    const last = item.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    // Out of sight before and after: it jumps and does not count.
    if (offscreen(first, view) && offscreen(last, view)) continue;
    moves.push({ item, dx, dy });
  }
  const gone = (entry, glide = true) => {
    entry.node.remove();
    entry.resolve();
    return landed(container, state, glide);
  };
  // Too much at once: the update lands without motion.
  if (moves.length > max) {
    removed.forEach((entry) => gone(entry, false));
    return Promise.resolve();
  }
  // A shrink in flight that this call does not hold continues to the new height.
  const resizing = sizing && state.minHeight === null ? glideSize(container, state, firstHeight) : Promise.resolve();
  const easing = motionEasing(container, '--ds-ease-spatial');
  // The farthest travel paints on top; at equal distance, the rising item.
  const layers = moves.length ? glideLayers(container) : null;
  // Everything the glides need is read before the first of them writes: a
  // read between two writes recalculates style (and with :has() rules, for
  // much of the page) once per moving item.
  const medium = moves.length ? motionDuration(container, '--ds-dur-medium') : 0;
  const slow = moves.length ? motionDuration(container, '--ds-dur-slow') : 0;
  const ranked = moves.map((move) => ({ move, distance: Math.hypot(move.dx, move.dy) }))
    .sort((a, b) => (a.distance - b.distance) || (a.move.dy - b.move.dy));
  const positions = ranked.map(({ move }) => computed(move.item)?.position);
  const backdrop = ranked.length && !state.raised && !state.backed ? backdropOf(container) : undefined;
  ranked.forEach(({ move }, rank) => raise(container, state, move.item, rank, layers, { position: positions[rank], backdrop }));
  const running = moves.map(({ item, dx, dy }) => {
    const animation = animateSafe(item, [{ translate: `${round(dx)}px ${round(dy)}px` }, { translate: '0px 0px' }], {
      id: 'ds-flip',
      duration: travelBetween(medium, slow, Math.hypot(dx, dy)),
      easing,
      composite: 'add',
    }, '--ds-ease-spatial');
    animation.id = 'ds-flip';
    glides.set(item, animation);
    // Finished or cancelled: lowered unless a newer glide of the item runs.
    const ended = () => {
      if (glides.get(item) === animation) glides.delete(item);
      if (!glides.has(item)) lower(item);
    };
    return animation.finished.then(ended, (error) => {
      ended();
      throw error;
    });
  });
  // Each as enter() and leave() would, in one batch of reads and writes.
  const entering = enterEach(inserted, 'fade');
  const leaving = leaveEach(removed.map((entry) => entry.node)).map((done, index) => done.then(() => gone(removed[index])));
  return Promise.allSettled([...running, ...entering, ...leaving, resizing]).then(() => {});
}

/** A held reorder may run: no mouse or pen over the container, no focus in an item. */
function held(container, state) {
  if (state.over && (state.pointer === 'mouse' || state.pointer === 'pen')) return true;
  const active = activeIn(container);
  if (!active || active === container || !container.contains(active)) return false;
  return flipItems(container, state.items).some((item) => item.contains(active));
}

/**
 * Runs `mutate` (if any) as a FLIP, together with the held reorder (its
 * steps first, in order). `first`: see runFlip().
 */
function flush(container, mutate, options, state, first) {
  const steps = (state.queued?.steps ?? []).map((step) => step.mutate);
  const waiters = state.waiters;
  clearTimeout(state.timer);
  state.timer = 0;
  state.queued = null;
  state.waiters = [];
  if (mutate && !steps.includes(mutate)) steps.push(mutate);
  const all = steps.length === 1 ? steps[0] : (/** @type {any} */ hooks) => {
    for (const step of steps) step(hooks);
  };
  const done = runFlip(container, all, options, state, first);
  for (const resolve of waiters) resolve(done);
  return done;
}

/** Runs the held reorder once nothing holds it any more (or `hold` ran out). */
function release(container, state, force = false) {
  if (!state.queued || (!force && held(container, state))) return;
  flush(container, null, state.queued.options, state);
}

/** Whether two lists of items hold the same elements in the same order. */
function sameItems(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * The live guard's listeners (once per container): the pointer type comes
 * from pointerover, because :hover sticks after a tap on touch screens and
 * touch never holds.
 */
function watchLive(container, state) {
  if (state.guarded) return;
  state.guarded = true;
  try {
    // A mouse already over the list when the first live update comes.
    if (container.matches(':hover') && windowOf(container).matchMedia('(hover: hover)').matches) {
      state.over = true;
      state.pointer = 'mouse';
    }
  } catch {
    // No :hover or matchMedia (no DOM): the events below tell.
  }
  container.addEventListener('pointerover', (/** @type {any} */ event) => {
    state.over = true;
    state.pointer = event.pointerType || 'mouse';
  });
  container.addEventListener('pointerleave', () => {
    state.over = false;
    release(container, state);
  });
  container.addEventListener('focusout', (/** @type {any} */ event) => {
    if (event.relatedTarget && container.contains(event.relatedTarget)) return;
    // Focus has left by the time the next task runs.
    setTimeout(() => release(container, state), 0);
  });
}

/**
 * Glides the items of `container` to their new places after `mutate`
 * changed them (FLIP): it measures the items, calls
 * `mutate({ holdOrder, onInsert, onRemove })` (pass the object straight to
 * DS.dom.morphHtml as its options), measures again and moves each item
 * from its old place to the new one on `translate` (composite: 'add', so
 * an item's own translate stays) on the spring, for travelDuration().
 * Meanwhile the moving items paint above the others, the farthest travel
 * on top (inline z-index from one above the higher of --ds-z-raised and
 * --ds-z-pinned, so the controls that interactive table rows lift to
 * --ds-z-raised and a pinned column stay under them, and below
 * --ds-z-sticky, so a sticky header stays above them all;
 * position: relative where
 * static, the container isolated and marked data-ds-glide with
 * --ds-flip-backdrop, the colour behind it, so table rows get an opaque
 * backing; all restored when the glide ends). A
 * call during a glide continues from where every item is, so a filter can
 * call it on every keystroke. Inserted items fade in; removed items fade
 * out of flow where they were while their neighbours close the gap (table
 * rows go at once). Both work through the hooks (DS.dom.morphHtml) and
 * for plain DOM calls in `mutate`: a direct child that `mutate` removed
 * goes back in where it was, out of flow, for its exit, and an item that is new after
 * `mutate` fades in (unless it runs an entrance of its own), so flip(stack, () => alert.remove()) and
 * flip(stack, () => stack.prepend(alert)) need nothing else. Meanwhile
 * the container keeps its height (min-height, restored afterwards; a grid
 * keeps its rows at their size with align-content: start), then its block
 * size glides down on --ds-ease-out,
 * so what follows the list never jumps and leaving items never paint over
 * it. Items outside the viewport before and after jump; with
 * more than `max` moving items the update lands without motion.
 *
 * `live: true` (data that changes by itself): while a mouse or pen is over
 * the container, or focus is in an item, a `mutate` that takes the options
 * runs at once with `holdOrder: true` (values update, nodes keep their
 * places) and the reorder waits until the pointer leaves, focus leaves or
 * `hold` ms after the first held call (the latest held `mutate` wins); if
 * it changed the items all the same, that change glides at once. A
 * `mutate` without parameters (a plain DOM call such as
 * `() => stack.prepend(alert)`) cannot honour holdOrder: it waits whole
 * (every such call, in order) and glides on release. A call without
 * `live` (a user's sort) runs the held reorder with its own, at once.
 *
 * `refocus` (default true): when the item that held the focus goes and
 * focus is lost, it moves to the next item that stays (the old order),
 * else the previous one: its element with the classes of the old focus,
 * else the item itself, else its first focusable element. An element or a
 * function returning one is the fallback without a neighbour; a page that
 * moved focus itself is left alone; false leaves it to leave().
 * @param {Element|null|undefined} container
 * @param {(options: { holdOrder: boolean, onInsert: (node: Node) => void, onRemove: (node: Node) => Promise<void>|undefined, onKeep?: (kept: Element, template: Element) => void }) => void} mutate
 * @param {{ items?: string, live?: boolean, max?: number, hold?: number, refocus?: boolean|Element|(() => Element|null), onKeep?: (kept: Element, template: Element) => void }} [options]
 *   items: a selector (default: the element children)
 * @returns {Promise<void>} resolves when the motion of this call (or its held reorder) finished
 */
export function flip(container, mutate, options = {}) {
  if (!container || typeof mutate !== 'function') return Promise.resolve();
  const state = flipState(container);
  if (options.live) {
    state.items = options.items;
    watchLive(container, state);
    if (held(container, state)) {
      const queued = state.queued ?? (state.queued = { steps: [], options });
      queued.options = options;
      if (mutate.length === 0) {
        // A mutate that takes no options cannot honour holdOrder (a plain
        // DOM change such as stack.prepend(alert)): it waits whole, in
        // order with the other plain ones, and glides on release.
        queued.steps.push({ mutate, aware: false });
      } else {
        const first = measure(container, state.items);
        mutate({ holdOrder: true, ...(typeof options.onKeep === 'function' ? { onKeep: options.onKeep } : {}), onInsert() {}, onRemove() { return undefined; } });
        // The latest mutate that honours holdOrder wins (it renders all the data).
        queued.steps = queued.steps.filter((step) => !step.aware);
        if (!sameItems(Array.from(first.before.keys()), flipItems(container, state.items))) {
          // It changed the items all the same (holdOrder ignored): too late
          // to hold, so that change glides now from where the items were.
          return flush(container, null, options, state, first);
        }
        queued.steps.push({ mutate, aware: true });
      }
      if (!state.timer) state.timer = setTimeout(() => release(container, state, true), options.hold ?? 2000);
      return new Promise((resolve) => state.waiters.push(resolve));
    }
  }
  return flush(container, mutate, options, state);
}


/* ── Sortable lists ─────────────────────────────────── */

/** The live sortable of each list. @type {WeakMap<Element, { handle: { destroy: () => void } }>} */
const sortables = new WeakMap();

/** The polite region each theme (or modal) speaks the positions through. @type {WeakMap<Element, HTMLElement>} */
const sortRegions = new WeakMap();

/** Speaks `text` through a private polite region in the list's modal, else its .ds-theme (never inert). */
function speakPosition(list, text) {
  const host = list.closest?.('dialog, .ds-dialog, .ds-sheet') ?? list.closest?.('.ds-theme') ?? list.ownerDocument?.body;
  if (!host || !text) return;
  let region = sortRegions.get(host);
  if (!region || !region.isConnected) {
    region = list.ownerDocument.createElement('div');
    region.className = 'ds-sr';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('data-ds-keep', '');
    host.append(region);
    sortRegions.set(host, region);
  }
  // The same position twice is still news: the region empties first.
  region.textContent = '';
  const target = region;
  setTimeout(() => { target.textContent = text; }, 0);
}

/**
 * Reorders a list by drag and keyboard. A pointer drag starts on an item's
 * `handle` (default '.ds-grip', a quiet icon button; pointer capture on
 * it), the item follows the pointer (its inline translate) and carries
 * data-ds-dragging (drag.css: a raised shadow and the dragged state
 * layer; nothing scales), and every time it crosses the middle of a
 * neighbour the others move through flip() (a move during a glide
 * continues from where each item is). On release it glides into its place
 * on the spring. On the handle ArrowUp, ArrowDown, Home and End move the
 * item one place, or to the start or the end, through flip(); the handle
 * keeps the focus. After each move `onChange(order, before)` gets the
 * items in their new and their old order, and the position is spoken
 * through a polite region in the list's modal, else its .ds-theme:
 * `announce(index, count)` (1-based) returns the text, default "Moved to
 * position 2 of 5". Pass `announce: () => ''` and speak it yourself (with
 * DS.overlay.announce()) where the page wants one announcer. `items`: a
 * selector (default: the list's element children). Once per list; destroy()
 * removes the listeners.
 * @param {Element|null|undefined} list
 * @param {{ items?: string, handle?: string, onChange?: (order: Element[], before: Element[]) => void, announce?: (index: number, count: number) => string }} [options]
 * @returns {{ destroy: () => void }}
 */
export function sortable(list, options = {}) {
  if (!list?.ownerDocument) return { destroy() {} };
  const existing = sortables.get(list);
  if (existing) return existing.handle;
  const handleSelector = options.handle ?? '.ds-grip';
  const selector = options.items;
  const items = () => flipItems(list, selector);
  // :is() keeps a selector list whole (`li, .row:not(...)` would leave the dragged li in).
  const others = selector ? `:is(${selector}):not([data-ds-dragging])` : ':scope > :not([data-ds-dragging])';
  const itemOf = (node) => items().find((item) => item.contains(node)) ?? null;
  const say = (item) => {
    const order = items();
    const text = (options.announce ?? ((index, count) => `Moved to position ${index} of ${count}`))(order.indexOf(item) + 1, order.length);
    speakPosition(list, text);
  };
  const changed = (before) => {
    const after = items();
    if (!sameItems(before, after)) options.onChange?.(after, before);
  };
  /** Puts `item` before `reference` (null: at the end of its parent), keeping the handle's focus. */
  const place = (item, reference) => {
    const parent = reference?.parentNode ?? item.parentNode;
    const focused = activeIn(item);
    const keep = focused && item.contains(focused) ? focused : null;
    if (typeof parent.moveBefore === 'function') {
      try {
        parent.moveBefore(item, reference);
      } catch {
        parent.insertBefore(item, reference);
      }
    } else parent.insertBefore(item, reference);
    if (keep && activeIn(item) !== keep) keep.focus({ preventScroll: true });
  };

  /* Keyboard: one place, or to an end. */
  const onKey = (/** @type {KeyboardEvent} */ event) => {
    const handle = event.target?.closest?.(handleSelector);
    if (!handle || !list.contains(handle) || event.altKey || event.ctrlKey || event.metaKey) return;
    const item = itemOf(handle);
    if (!item) return;
    const order = items();
    const index = order.indexOf(item);
    const to = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: order.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    if (to < 0 || to >= order.length || to === index) return;
    const before = order.slice();
    flip(list, () => place(item, to > index ? order[to].nextSibling : order[to]), { items: selector });
    changed(before);
    say(item);
  };

  /* Pointer: the item follows, the others make room. */
  let drag = null;
  /** Items whose raised look is still leaving after a drop: item → { timer, z }. */
  const ending = new Map();
  /** Ends a drop's leave at once: the z-index it had before the drag, nothing owned. */
  const finish = (item) => {
    const end = ending.get(item);
    if (!end) return;
    ending.delete(item);
    clearTimeout(end.timer);
    item.removeAttribute('data-ds-dragging');
    item.style.zIndex = end.z;
    tidyStyle(item);
    disown(item, 'attrs', 'data-ds-dragging');
    for (const name of ['translate', 'z-index']) disown(item, 'props', name);
  };
  // Layout places (offsetTop ignores translate): the rows that glide aside
  // are compared where they go, not where their glide shows them.
  const layoutTop = (item) => item.offsetTop ?? 0;
  const middle = (item) => layoutTop(item) + (item.offsetHeight ?? 0) / 2;
  const onDown = (/** @type {PointerEvent} */ event) => {
    if (drag || event.button !== 0) return;
    const handle = event.target?.closest?.(handleSelector);
    if (!handle || !list.contains(handle)) return;
    const item = itemOf(handle);
    if (!item) return;
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);
    for (const animation of item.getAnimations?.() ?? []) if (animation.id === 'ds-sort') animation.cancel();
    // Grabbed again while the last drop leaves: that drop ends first, so the
    // z-index kept is the one before any drag and nothing is owned twice.
    finish(item);
    drag = { item, handle, pointer: event.pointerId, startY: event.clientY, dy: 0, before: items(), z: item.style.zIndex };
    own(item, 'attrs', 'data-ds-dragging');
    for (const name of ['translate', 'z-index']) own(item, 'props', name);
    item.setAttribute('data-ds-dragging', '');
    const sticky = parseInt(computed(list)?.getPropertyValue('--ds-z-sticky') ?? '', 10);
    item.style.zIndex = Number.isFinite(sticky) ? String(sticky - 1) : 'calc(var(--ds-z-sticky) - 1)';
  };
  const onMove = (/** @type {PointerEvent} */ event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { item } = drag;
    drag.dy = event.clientY - drag.startY;
    item.style.translate = `0px ${round(drag.dy)}px`;
    const order = items();
    const index = order.indexOf(item);
    // A neighbour gives way once the dragged row's leading edge passes its middle.
    const top = layoutTop(item) + drag.dy;
    const bottom = top + (item.offsetHeight ?? 0);
    let target = index;
    while (target > 0 && top < middle(order[target - 1])) target -= 1;
    while (target < order.length - 1 && bottom > middle(order[target + 1])) target += 1;
    if (target === index) return;
    const from = layoutTop(item);
    flip(list, () => place(item, target > index ? order[target].nextSibling : order[target]), { items: others });
    // The item moved in the layout: its translate takes the step back, so it stays under the pointer.
    const shift = layoutTop(item) - from;
    drag.startY += shift;
    drag.dy -= shift;
    item.style.translate = `0px ${round(drag.dy)}px`;
    say(item);
  };
  const onUp = (/** @type {PointerEvent} */ event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { item, handle, dy, before, z } = drag;
    drag = null;
    handle.releasePointerCapture?.(event.pointerId);
    item.style.removeProperty('translate');
    // Into its place on the spring, from where the pointer let go.
    if (Math.abs(dy) >= 0.5 && typeof item.animate === 'function') {
      const glide = animateSafe(item, [{ translate: `0px ${round(dy)}px` }, { translate: '0px 0px' }], {
        id: 'ds-sort',
        duration: travelDuration(list, dy),
        easing: motionEasing(list, '--ds-ease-spatial'),
      }, '--ds-ease-spatial');
      glide.id = 'ds-sort';
    }
    // The raised look leaves in --ds-dur-instant (drag.css: data-ds-dragging="end").
    item.setAttribute('data-ds-dragging', 'end');
    const timer = setTimeout(() => finish(item), Math.max(motionDuration(item, '--ds-dur-instant'), motionDuration(list, '--ds-dur-medium')));
    ending.set(item, { timer, z });
    changed(before);
  };
  list.addEventListener('keydown', onKey);
  list.addEventListener('pointerdown', onDown);
  list.addEventListener('pointermove', onMove);
  list.addEventListener('pointerup', onUp);
  list.addEventListener('pointercancel', onUp);
  const handle = {
    destroy() {
      if (sortables.get(list)?.handle !== handle) return;
      sortables.delete(list);
      for (const item of Array.from(ending.keys())) finish(item);
      list.removeEventListener('keydown', onKey);
      list.removeEventListener('pointerdown', onDown);
      list.removeEventListener('pointermove', onMove);
      list.removeEventListener('pointerup', onUp);
      list.removeEventListener('pointercancel', onUp);
    },
  };
  sortables.set(list, { handle });
  return handle;
}
/* ── Views ──────────────────────────────────────────── */

/** The types of transition(), written as data-ds-vt on <html> while one runs. */
const VIEW_TYPES = Object.freeze(['fade-through', 'forward', 'back', 'container']);

/**
 * The latest transition() of each document on the View Transition path:
 * its ViewTransition, a promise that settles once its update has run, one
 * that settles once it has ended and cleaned up, and the inline
 * view-transition-names it wrote (element → the value before).
 * @typedef {{ transition: any, updated: Promise<void>, done: Promise<void>, names: Map<HTMLElement, string> }} ViewCall
 * @type {WeakMap<Document, ViewCall>}
 */
const viewCalls = new WeakMap();

const isElement = (value) => value?.nodeType === 1;

/**
 * The elements whose view-transition-name is lifted (inline `none`) while
 * a transition() runs in their document: element → its inline value
 * before ('' when the name came from a stylesheet).
 * @type {WeakMap<Document, Map<HTMLElement, string>>}
 */
const liftedNames = new WeakMap();

/**
 * An open dialog or side sheet: it covers the page frame. Opened by
 * DS.overlay (data-state), a native one shown by hand ([open]), or the div
 * fallback shown by hand by removing hidden (no data-state; a div sheet is
 * modal only with aria-modal, the selector sheet.css names its body by).
 * A contained dialog (.ds-dialog--contained) covers its container inside
 * the panel, not the frame, so it never counts. indicator.js keeps the
 * same list (test/js.test.js compares them).
 */
const MODAL_OPEN = [
  '.ds-dialog[data-state="open"]:not(.ds-dialog--contained)',
  '.ds-sheet[data-state="open"]',
  'dialog.ds-dialog[open]:not(.ds-dialog--contained)',
  'dialog.ds-sheet[open]',
  '.ds-dialog:not(dialog, [hidden], [data-state], .ds-dialog--contained, .ds-dialog--hidden, .ds-dialog--closing)',
  '.ds-sheet[aria-modal="true"]:not(dialog, [hidden], [data-state], .ds-sheet--closing)',
].join(', ');

/** The modal drawer exists only below this width (shell.css). */
const MODAL_DRAWER = '(max-width: 900px)';

/** The parts of the page frame that shell.css names while data-ds-vt is set. */
const FRAME_PARTS = '.ds-view, .ds-panel, .ds-drawer';

function liftName(doc, element) {
  let lifted = liftedNames.get(doc);
  if (lifted?.has(element)) return;
  if (!lifted) liftedNames.set(doc, (lifted = new Map()));
  lifted.set(element, element.style.getPropertyValue('view-transition-name'));
  element.style.setProperty('view-transition-name', 'none');
}

/**
 * Within a page an indicator glides better live than as a group of its
 * own (a group floats above its labels and outside its track's clip): the
 * drawer shows live (motion.css), so its pill glides as on a click. Its
 * name serves page loads; it is lifted until the transition ends.
 */
function liftIndicatorNames(doc) {
  for (const pill of Array.from(doc.querySelectorAll?.('.ds-indicator') ?? [])) {
    const name = pill.style.getPropertyValue('view-transition-name');
    if (name && name !== 'none') liftName(doc, pill);
  }
}

/**
 * A modal drawer that is open, or still leaving (its exit, a transition
 * on the drawer itself, runs while the view changes): it lies in the root
 * snapshot with its scrim.
 */
function modalDrawer(doc) {
  if (doc.defaultView?.matchMedia?.(MODAL_DRAWER)?.matches !== true) return false;
  if (doc.querySelector?.('.ds-app[data-drawer-open]')) return true;
  const drawer = doc.querySelector?.('.ds-app .ds-drawer');
  return Boolean(drawer?.getAnimations?.().some((animation) => animation.playState === 'running'));
}

/**
 * Under an open dialog or sheet (a record swap in a sheet), or the modal
 * drawer (a navigation from it), the page frame stays in the root
 * snapshot: named, its view, panel and drawer would paint above the
 * overlay or the drawer and its scrim (every group lies above the root)
 * and fade through although they did not change, or pop in front of the
 * drawer. Unnamed, the new view crossfades with the root under them.
 */
function liftFrameNames(doc) {
  if (!doc.querySelector?.(MODAL_OPEN) && !modalDrawer(doc)) return;
  for (const part of Array.from(doc.querySelectorAll?.(FRAME_PARTS) ?? [])) liftName(doc, part);
}

/**
 * toast.css names a snackbar region with messages ds-toasts while a
 * transition runs, so its messages stay above the page's groups. A name
 * must be unique, or the engine skips the whole transition: a further
 * region with messages keeps no name (it crossfades in the root).
 */
function liftExtraToasts(doc) {
  const regions = Array.from(doc.querySelectorAll?.('.ds-toasts') ?? []);
  const shown = regions.filter((region) => Array.from(region.children ?? []).some((child) => child.classList?.contains('ds-toast')));
  for (const region of shown.slice(1)) liftName(doc, region);
}

/** Clicks on <html> already forwarded (two listeners may see one). @type {WeakSet<Event>} */
const forwardedClicks = new WeakSet();

/**
 * Chromium and WebKit hit-test the document element while a View
 * Transition's pseudo tree is up, so a click meant for a button under the
 * pointer would reach <html> and be lost (Firefox delivers it). While
 * `call` is the latest, a press on <html> skips the running motion
 * instead, and its click goes to the element under the pointer once no
 * transition runs any more: stepping through records or navigating fast
 * never loses input. Both stray events stop at the window (capture), so
 * no outside-press logic of the page sees a press on <html>. Returns the
 * function that removes the listeners.
 */
function forwardPresses(doc, call) {
  const root = doc.documentElement;
  const target = doc.defaultView ?? doc;
  if (typeof target?.addEventListener !== 'function') return () => {};
  const land = (x, y) => {
    const running = viewCalls.get(doc);
    if (running) {
      running.transition?.skipTransition?.();
      running.done.then(() => land(x, y));
      return;
    }
    // The element under the pointer may be a button's icon: an SVG
    // element has no click(), so its nearest HTML ancestor takes it.
    let element = doc.elementFromPoint?.(x, y) ?? null;
    while (element && typeof element.click !== 'function') element = element.parentElement;
    if (element && element !== root) element.click();
  };
  const onClick = (/** @type {MouseEvent} */ event) => {
    if (event.target !== root || forwardedClicks.has(event)) return;
    forwardedClicks.add(event);
    event.stopPropagation();
    land(event.clientX, event.clientY);
  };
  const onPointerDown = (/** @type {PointerEvent} */ event) => {
    if (event.target !== root || event.button !== 0 || viewCalls.get(doc) !== call) return;
    event.stopPropagation();
    call.transition?.skipTransition?.();
    // The click of this press may come after the end, once (a press that
    // ends in no click, such as a drag, leaves it to the next click, which
    // is let through unless it is on <html> too).
    target.addEventListener('click', onClick, { capture: true, once: true });
  };
  // A press that reached its button just before the pseudo tree went up
  // releases on <html>, so its click goes to <html> too: forwarded the same.
  const onClickDuring = (/** @type {MouseEvent} */ event) => {
    if (viewCalls.get(doc) === call) onClick(event);
  };
  target.addEventListener('pointerdown', onPointerDown, true);
  target.addEventListener('click', onClickDuring, true);
  return () => {
    target.removeEventListener('pointerdown', onPointerDown, true);
    target.removeEventListener('click', onClickDuring, true);
  };
}

/** The panel's width, to tell a view that shows or hides the drawer (a morph) from a plain swap. */
function panelWidth(doc) {
  const panel = doc.querySelector?.('.ds-theme .ds-panel');
  return panel?.getBoundingClientRect?.().width ?? null;
}

/** The lifted names come back (an element renamed meanwhile keeps its new name). */
function restoreLiftedNames(doc) {
  const lifted = liftedNames.get(doc);
  if (!lifted) return;
  liftedNames.delete(doc);
  for (const [element, before] of lifted) {
    if (element.style.getPropertyValue('view-transition-name') !== 'none') continue;
    if (before) element.style.setProperty('view-transition-name', before);
    else element.style.removeProperty('view-transition-name');
  }
}

/**
 * Whether a clipping ancestor (the .ds-view scroller, a sheet body, a
 * table's scroll wrapper, the panel's rounded frame) hides a part of
 * `element` that lies inside the window. A View Transition group escapes
 * every clip and paints above the root, where the top bar is: a container
 * group from (or into) such an element would draw its hidden part over the
 * bar or the drawer, so the container transform becomes a fade-through.
 * A part outside the window (a long detail that runs past the bottom) does
 * not count; an element with nothing in the window does (its group would
 * fly in from off screen). Ancestors above a fixed element do not clip it.
 */
function clippedOnScreen(element) {
  const doc = element.ownerDocument;
  const view = doc?.defaultView;
  if (typeof element.getBoundingClientRect !== 'function' || typeof view?.getComputedStyle !== 'function' || !(view.innerWidth > 0)) return false;
  const rect = element.getBoundingClientRect();
  const shown = {
    left: Math.max(rect.left, 0),
    top: Math.max(rect.top, 0),
    right: Math.min(rect.right, view.innerWidth),
    bottom: Math.min(rect.bottom, view.innerHeight),
  };
  if (shown.right - shown.left < 1 || shown.bottom - shown.top < 1) return true;
  const stop = new Set([doc.documentElement, doc.body]);
  for (let node = element; node && !stop.has(node); node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (node !== element) {
      const box = node.getBoundingClientRect();
      // The padding box: what overflow clips to (without the scrollbar).
      const left = box.left + (node.clientLeft || 0);
      const top = box.top + (node.clientTop || 0);
      if (style.overflowX !== 'visible' && (shown.left < left - 1 || shown.right > left + node.clientWidth + 1)) return true;
      if (style.overflowY !== 'visible' && (shown.top < top - 1 || shown.bottom > top + node.clientHeight + 1)) return true;
    }
    if (style.position === 'fixed') break;
  }
  return false;
}

/** Names `element` ds-container for this call (the inline value before is kept). */
function nameContainer(call, element) {
  if (!call.names.has(element)) call.names.set(element, element.style.viewTransitionName ?? '');
  element.style.viewTransitionName = 'ds-container';
}

/** Gives `element` back the inline name it had before this call named it. */
function unnameContainer(call, element) {
  if (!call.names.has(element)) return;
  element.style.viewTransitionName = call.names.get(element);
  call.names.delete(element);
}

/** Every name this call wrote goes. */
function unnameAll(call) {
  for (const element of Array.from(call.names.keys())) unnameContainer(call, element);
}

/**
 * The element to enter after a swap without View Transitions: what the
 * update returned, else the first content child of the themed view (not a
 * kept or hidden helper, such as the 1px data-scrolled sentinel that
 * docs/components.md puts first).
 */
function swapTarget(doc, result) {
  if (isElement(result)) return result;
  // A view outside the app frame (a wizard, a sign-in page): its content.
  const view = doc?.querySelector?.('.ds-theme .ds-vt-view') ?? doc?.querySelector?.('.ds-theme .ds-view');
  for (const child of Array.from(view?.children ?? [])) {
    if (child.hasAttribute?.('data-ds-keep') || child.getAttribute?.('aria-hidden') === 'true') continue;
    return child;
  }
  return null;
}

/**
 * transition({ focus }): where focus goes once the update ran, if it was
 * lost: on <body>, in the content that left (no longer connected), or in a
 * modal drawer that the update closed. `option` true: the returned
 * element's first h1[tabindex="-1"], else the view (tabindex="-1"), else the
 * element itself; a function chooses from the incoming element.
 */
function moveViewFocus(doc, before, result, option) {
  if (!option || !doc) return;
  const now = doc.activeElement;
  const app = before?.closest?.('.ds-app');
  const fromDrawer = Boolean(before?.closest?.('.ds-drawer')) && Boolean(app) && !app.hasAttribute('data-drawer-open')
    && doc.defaultView?.matchMedia?.(MODAL_DRAWER)?.matches === true;
  const lost = !now || now === doc.body || now === doc.documentElement || (before && before.isConnected === false) || fromDrawer
    || Boolean(now.closest?.('[inert], [data-ds-leaving]'));
  if (!lost) return;
  const incoming = isElement(result) ? result : null;
  let target = null;
  if (typeof option === 'function') target = option(incoming);
  else {
    // Without a returned element: the view outside the frame, else the frame's view.
    const root = incoming ?? doc.querySelector?.('.ds-theme .ds-vt-view') ?? doc.querySelector?.('.ds-theme .ds-view');
    target = (root?.matches?.('h1[tabindex="-1"]') ? root : root?.querySelector?.('h1[tabindex="-1"]'))
      ?? root?.closest?.('.ds-view, .ds-vt-view') ?? root;
  }
  if (target && typeof target.focus === 'function' && target.isConnected !== false && !target.closest?.('[inert]')) target.focus({ preventScroll: true });
}

/**
 * D30: no View Transitions (or no html.ds-theme). The update runs at
 * once, nothing waits before it, and the new view fades through with
 * .ds-enter--swap; rapid calls land on the latest view through enter()'s
 * generation.
 */
function swapView(doc, update, focus) {
  const before = doc?.activeElement ?? null;
  let result;
  try {
    result = update();
  } catch (error) {
    return Promise.reject(error);
  }
  // A synchronous update enters in a microtask: before the next frame, so
  // the new view never shows at full opacity first.
  return Promise.resolve(result).then((value) => {
    // A view that scrolled and now fits keeps no tint or hairline.
    resyncScroll(doc);
    moveViewFocus(doc, before, value, focus);
    const target = swapTarget(doc, value);
    return target ? enter(target, 'swap') : undefined;
  });
}

/** The View Transition path of transition() (see there). */
function viewTransition(doc, update, type, from, focus) {
  const root = doc.documentElement;
  const before = doc.activeElement;
  const previous = viewCalls.get(doc);
  if (previous) {
    // A skipped transition still runs its update (in call order, below);
    // its names can only get in the way of this snapshot.
    previous.transition?.skipTransition?.();
    unnameAll(previous);
  }
  const container = type === 'container' && isElement(from) && from.isConnected && !clippedOnScreen(from) ? from : null;
  /** @type {ViewCall} */
  const call = { transition: null, updated: Promise.resolve(), done: Promise.resolve(), names: new Map() };
  const latest = () => viewCalls.get(doc) === call;
  viewCalls.set(doc, call);
  root.setAttribute('data-ds-vt', type === 'container' && !container ? 'fade-through' : type);
  root.removeAttribute('data-ds-vt-morph');
  if (container) nameContainer(call, container);
  liftIndicatorNames(doc);
  liftFrameNames(doc);
  liftExtraToasts(doc);

  let settleUpdate = () => {};
  call.updated = new Promise((resolve) => { settleUpdate = resolve; });
  let watchdog = 0;
  /** The update's error: kept here, not thrown into the View Transition (Firefox reports it as uncaught). */
  let failure = /** @type {{ error: unknown }|null} */ (null);
  const run = async () => {
    // A slow render never holds the frozen page for long: past
    // --ds-dur-long the motion is skipped and the page shows (and takes
    // input) while the update finishes.
    watchdog = /** @type {any} */ (setTimeout(() => call.transition?.skipTransition?.(), motionDuration(root, '--ds-dur-long')));
    try {
      if (container) unnameContainer(call, container);
      if (previous) await previous.updated;
      const widthBefore = panelWidth(doc);
      let result;
      try {
        result = await update();
      } catch (error) {
        failure = { error };
        call.transition?.skipTransition?.();
        return;
      }
      // An indicator the update created has its name lifted too.
      if (latest()) liftIndicatorNames(doc);
      if (latest()) moveViewFocus(doc, before, result, focus);
      // Only a panel that changes its width (the drawer shown or hidden)
      // morphs over --ds-dur-long; a plain swap keeps the short groups, so
      // the frozen page never holds input longer than it must.
      const widthAfter = latest() && widthBefore !== null ? panelWidth(doc) : null;
      if (widthAfter !== null && Math.abs(widthAfter - widthBefore) > 0.5) root.setAttribute('data-ds-vt-morph', '');
      if (type === 'container' && latest()) {
        if (container && isElement(result) && result.isConnected && !clippedOnScreen(result)) nameContainer(call, result);
        else root.setAttribute('data-ds-vt', 'fade-through');
      }
    } finally {
      clearTimeout(watchdog);
      settleUpdate();
    }
  };

  let started;
  try {
    started = doc.startViewTransition(run);
  } catch (error) {
    // An engine that refuses to start one: the update still runs, without motion.
    unnameAll(call);
    if (latest()) {
      root.removeAttribute('data-ds-vt');
      root.removeAttribute('data-ds-vt-morph');
      viewCalls.delete(doc);
      restoreLiftedNames(doc);
    }
    return swapView(doc, update, focus);
  }
  call.transition = started;
  // The new view may not overflow where the old one was scrolled: its
  // scroll-driven tint and hairline go (the new image is live).
  call.updated.then(() => resyncScroll(doc));
  // Skipped (by a newer call, the watchdog, a press, a hidden tab or a
  // duplicate name): ready rejects, which is no error here.
  started.ready?.catch?.(() => {});
  const unforward = forwardPresses(doc, call);
  const ended = Promise.allSettled([started.updateCallbackDone, started.finished]).then(([updated]) => {
    clearTimeout(watchdog);
    unforward();
    unnameAll(call);
    if (latest()) {
      root.removeAttribute('data-ds-vt');
      root.removeAttribute('data-ds-vt-morph');
      viewCalls.delete(doc);
      restoreLiftedNames(doc);
    }
    return updated;
  });
  call.done = ended.then(() => {});
  return ended.then((updated) => {
    if (failure) throw failure.error;
    if (updated.status === 'rejected') throw updated.reason;
  });
}

/**
 * Moves from one view to the next (D15), for navigation only: a top-level
 * destination, a drill-down, another record. Never for data: a refresh,
 * polling or typing changes values in place (DS.dom.morphHtml), and an
 * entrance never replays for them. No component calls it, except
 * DS.overlay.open with `container: true`.
 *
 *   type 'fade-through'  between top-level destinations (the default)
 *        'forward'       shared axis X: the next step, record or page
 *        'back'          shared axis X, mirrored
 *        'container'     `from` (a card, a row) grows into the element the
 *                        update returns (its detail); without either, or
 *                        when a scroller clips a part of one of them that
 *                        lies in the window (a group escapes every clip
 *                        and would paint over the top bar), it falls back
 *                        to a fade-through
 *
 * With View Transitions and .ds-theme on <html>, the document is
 * snapshotted: data-ds-vt="<type>" on <html> names .ds-view, .ds-panel,
 * the docked .ds-drawer and .ds-sheet__body while it runs, and motion.css
 * plays the type. The top bar stays in the root and never moves; the
 * docked drawer shows live, so its indicator glides to the new item as on
 * a click (the `name` of an indicator, which serves page loads, is lifted
 * meanwhile). A view that shows or hides the drawer (the panel changes
 * its width) also gets data-ds-vt-morph: only then do the panel and the
 * view move over --ds-dur-long. Under an open dialog or side sheet, or the
 * modal drawer (open or still leaving), the page frame keeps no names, so
 * a record swap in a sheet moves only its body and the page stays under
 * the scrim, and a navigation from the modal drawer crossfades under it
 * (close the drawer inside the update). A snackbar region with messages
 * is named too (ds-toasts), so its messages stay on top, still. The page
 * is frozen while it runs, so fetch first and call this with a quick
 * swap: an update still pending after --ds-dur-long has its motion
 * skipped. A press meanwhile (which Chromium and WebKit would deliver to
 * <html>) skips the motion, and its click goes to the element under the
 * pointer once the transition has ended. A call while one runs skips the
 * running one; every update runs, in call order. After the update,
 * resyncScroll() clears a scroll-driven tint or hairline that the old,
 * scrolled view would leave on a new one that does not scroll.
 *
 * Elsewhere (no View Transitions, or .ds-theme on a wrapper: an embedded
 * widget never snapshots its host page) the update runs at once and the
 * element it returns, else the first child of the themed .ds-vt-view (a
 * view outside the app frame) or .ds-view that is not data-ds-keep or
 * aria-hidden (a sentinel), enters with .ds-enter--swap.
 *
 * @param {() => (Element|null|undefined|void|Promise<Element|null|undefined|void>)} update
 *   swaps the content; may be async; may return the element that holds
 *   the new content (the container target, the fallback's entrance)
 * `focus` (2.0): true moves focus once the update ran, when it was lost
 * (on <body>, in the content that left, or in the modal drawer the update
 * closed): to the returned element's first h1[tabindex="-1"], else the
 * view, else the element (preventScroll); a function (incoming) =>
 * Element|null chooses. Default false: focus stays where the page put it.
 * @param {{ type?: 'fade-through'|'forward'|'back'|'container', from?: Element|null, focus?: boolean|((incoming: Element|null) => Element|null) }} [options]
 * @returns {Promise<void>} resolves once the update has run and the motion
 *   finished (also when it was skipped); rejects with the update's error,
 *   after cleaning up
 * @throws {TypeError} for an unknown type or an update that is not a function
 */
export function transition(update, options = {}) {
  const type = options?.type ?? 'fade-through';
  const from = options?.from ?? null;
  if (!VIEW_TYPES.includes(type)) throw new TypeError(`DS.motion.transition: unknown type "${type}" (${VIEW_TYPES.join(', ')})`);
  if (typeof update !== 'function') throw new TypeError('DS.motion.transition: update must be a function');
  const doc = from?.ownerDocument ?? globalThis.document;
  const root = doc?.documentElement;
  const focus = options?.focus ?? false;
  if (doc && typeof doc.startViewTransition === 'function' && root?.classList?.contains('ds-theme')) return viewTransition(doc, update, type, from, focus);
  return swapView(doc, update, focus);
}
