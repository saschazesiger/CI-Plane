/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The wheel (DS.wheel): a live status line that rolls from one text to the
 * next, one line pushing the other out (plans/wheel-and-shimmer.md, whose
 * reference implementation this is).
 *
 *   DS.dom.morphHtml(container, markup, DS.wheel.hooks);   a line keyed by its text rolls in
 *   DS.wheel.roll(slot, 'Running npm test');                a line of its own, rolled in
 *   const status = DS.wheel.create(slot, { text: 'Thinking', shimmer: true });
 *   status.set('Writing');
 *   <span class="ds-wheel" data-ds-wheel="Thinking" data-ds-wheel-shimmer></span>
 *
 * Two ways to draw the lines, never both on one slot:
 * - The page renders them (a line keyed by its text, data-ds-key) with
 *   DS.dom.morphHtml() and `hooks`: a new key is inserted and the old one
 *   removed, and the hooks turn them. Merge them with flip()'s or a page's
 *   own hooks where both are needed.
 * - The module renders them: roll(), create() and the data-ds-wheel
 *   attribute (DS.init()). Its lines carry data-ds-keep, so a re-render
 *   around the slot keeps them: render the slot empty and change only the
 *   attribute.
 *
 * The turn: both lines glide together on --ds-dur-slow and --ds-ease-in-out,
 * one --ds-wheel-travel apart (the slot's --_travel, 100%: a line's own
 * height), the old one up and out, the new one up from below; each line's
 * opacity runs on its glide's curve. Every line shows for at least
 * --ds-hold-status from the start of its roll: a change during the hold
 * waits (its line hidden in the delay of its entrance, fill backwards; the
 * old line's exit waits as long), and a later change takes the waiting
 * line's place, which goes at once without ever showing. A line that has
 * not shown yet holds nothing: the line that replaces it takes its time. A
 * line removed during its entrance glides out from where it is. The line
 * that goes and the line that comes in one task share the turn's delay. A
 * slot that is new shows its line at once (roll() on an empty slot too).
 *
 * The leaving line is aria-hidden and inert (the morph's pending removal,
 * or this module's own). The slot is no live region.
 *
 * The controller (create(), data-ds-wheel): get() the text, set(text,
 * { shimmer }) rolls to it, on('change', fn), destroy(); ds:change with
 * { text } on the slot after a set() that changed the text.
 *
 * ES2022; el.animate() and getAnimations() are at the floor, so nothing
 * here is progressive.
 */
import { define, emit } from './core.js';
import { motionDuration, motionEasing } from './motion.js';

/** Per slot: when the current turn rests, the turn of this task, the last line that came in. @type {WeakMap<Element, { restAt: number, turn: { at: number }|null, last: Element|null }>} */
const wheels = new WeakMap();

const now = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());

/**
 * When the next turn of a slot starts: at once (`at` = now) for the first
 * turn; after the hold of the line that showed last (`restAt` + `hold`);
 * at its own time when that line never showed (it was waiting out a hold
 * itself), so a replaced waiting line costs no second hold. Pure.
 * @param {number} restAt  when the current line's turn started (-Infinity: none yet)
 * @param {number} at      now
 * @param {number} hold    --ds-hold-status in ms
 * @param {boolean} shown  whether the line that came in last has shown
 * @returns {number}
 */
export function turnAt(restAt, at, hold, shown) {
  return shown ? Math.max(at, restAt + hold) : Math.max(at, restAt);
}

function stateOf(slot) {
  let state = wheels.get(slot);
  if (!state) wheels.set(slot, (state = { restAt: -Infinity, turn: null, last: null }));
  return state;
}

/** A line still in the delay of its entrance has not shown. */
function unseen(line) {
  if (!line?.isConnected || typeof line.getAnimations !== 'function') return false;
  return line.getAnimations().some((animation) => animation.playState !== 'finished'
    && Number(animation.currentTime) <= Number(animation.effect?.getTiming().delay ?? 0));
}

/** The delay of the turn this task belongs to; the first call of a task decides it. */
function turnDelay(slot) {
  const state = stateOf(slot);
  if (!state.turn) {
    state.restAt = turnAt(state.restAt, now(), motionDuration(slot, '--ds-hold-status'), !unseen(state.last));
    state.turn = { at: state.restAt };
    queueMicrotask(() => { state.turn = null; });
  }
  return Math.max(0, state.turn.at - now());
}

const viewOf = (node) => node.ownerDocument?.defaultView ?? globalThis;

function travelOf(slot) {
  return viewOf(slot).getComputedStyle(slot).getPropertyValue('--_travel').trim() || '100%';
}

/**
 * One line's part of the turn: the same glide for both lines (one strip),
 * the opacity on the glide's own curve. Resolves once both finished or
 * were cancelled.
 */
function glide(line, slot, from, to, opacity, delay, fill) {
  const duration = motionDuration(slot, '--ds-dur-slow');
  const easing = motionEasing(slot, '--ds-ease-in-out');
  const timing = { duration, delay, easing, fill };
  const moves = line.animate([{ transform: from }, { transform: to }], timing);
  const fades = line.animate([{ opacity: opacity[0] }, { opacity: opacity[1] }], timing);
  return Promise.all([moves.finished, fades.finished]).then(() => {}, () => {});
}

function wheelIn(line, slot, delay) {
  stateOf(slot).last = line;
  return glide(line, slot, `translateY(${travelOf(slot)})`, 'translateY(0)', [0, 1], delay, 'backwards');
}

/** How long until an animation ends (0 when it has, or never runs on its own). */
function left(animation) {
  if (animation.playState === 'finished' || animation.playState === 'idle') return 0;
  const timing = animation.effect?.getTiming() ?? {};
  return Math.max(0, Number(timing.delay ?? 0) + Number(timing.duration ?? 0) - Number(animation.currentTime ?? 0));
}

/**
 * The exit of a line, from wherever it is; null when it never showed (it
 * goes at once). An entrance that ends before the exit starts (the exit
 * waits out a hold, which is longer than a glide) runs to its end, and the
 * exit leaves from the rest; one that the exit would cut is cancelled and
 * the exit starts from its computed transform and opacity, held there
 * through any delay (fill both), so the line never jumps.
 */
function wheelOut(line, slot, delay) {
  const running = typeof line.getAnimations === 'function' ? line.getAnimations() : [];
  if (unseen(line)) {
    running.forEach((animation) => animation.cancel());
    return null;
  }
  const to = `translateY(calc(-1 * ${travelOf(slot)}))`;
  if (running.every((animation) => left(animation) <= delay)) {
    return glide(line, slot, 'translateY(0)', to, [1, 0], delay, 'forwards');
  }
  const style = viewOf(line).getComputedStyle(line);
  const from = style.transform === 'none' ? 'translateY(0)' : style.transform;
  const opacity = Number(style.opacity);
  running.forEach((animation) => animation.cancel());
  return glide(line, slot, from, to, [opacity, 0], delay, 'both');
}

const wheelOf = (line) => (line?.parentElement?.classList?.contains('ds-wheel') ? line.parentElement : null);

/**
 * The hooks of DS.dom.morphHtml() for wheel slots: a line inserted into a
 * .ds-wheel rolls in, a line removed from one rolls out (the morph keeps it
 * as a pending removal until then). Lines elsewhere are left to the morph.
 */
export const hooks = Object.freeze({
  onInsert(node) {
    const slot = wheelOf(node);
    if (slot) wheelIn(node, slot, turnDelay(slot));
  },
  onRemove(node) {
    const slot = wheelOf(node);
    return (slot && wheelOut(node, slot, turnDelay(slot))) || undefined;
  },
});

/** The lines of a slot that still count: not leaving. */
const linesOf = (slot) => [...slot.children].filter((line) => line.classList.contains('ds-wheel__line') && !line.hasAttribute('data-ds-leaving'));

function shimmerOn(line, on, text) {
  line.classList.toggle('ds-shimmer', on);
  if (on) line.setAttribute('data-shimmer', text);
  else line.removeAttribute('data-shimmer');
}

/**
 * Rolls `slot` (a .ds-wheel) to a line of its own with `text`: the new line
 * comes up, the lines before it go (aria-hidden and inert, removed once
 * out). An empty slot shows its line at once. The same text again changes
 * nothing (`shimmer` only switches the current line's shimmer).
 * `shimmer: true` makes the line a .ds-shimmer with its data-shimmer.
 * @param {Element|null|undefined} slot
 * @param {string} text
 * @param {{ shimmer?: boolean }} [options]
 * @returns {Promise<void>} resolves when the new line rests
 */
export function roll(slot, text, options = {}) {
  if (!slot?.ownerDocument) return Promise.resolve();
  const value = String(text ?? '');
  const shimmer = Boolean(options.shimmer);
  const before = linesOf(slot);
  const current = before.at(-1);
  if (current && current.textContent === value && before.length === 1) {
    shimmerOn(current, shimmer, value);
    return Promise.resolve();
  }
  const line = slot.ownerDocument.createElement('span');
  line.className = 'ds-wheel__line';
  line.setAttribute('data-ds-keep', '');
  line.textContent = value;
  shimmerOn(line, shimmer, value);
  slot.append(line);
  const state = stateOf(slot);
  if (!before.length) {
    // A slot with nothing to push out shows its line at once, and the hold counts from now.
    state.restAt = now();
    state.last = line;
    return Promise.resolve();
  }
  const delay = turnDelay(slot);
  for (const old of before) {
    old.setAttribute('data-ds-leaving', '');
    old.setAttribute('aria-hidden', 'true');
    /** @type {HTMLElement} */ (old).inert = true;
    const out = wheelOut(old, slot, delay);
    if (out) out.then(() => old.remove());
    else old.remove();
  }
  return wheelIn(line, slot, delay);
}

function controller(slot, start, signal) {
  let text = start.text;
  const listeners = new Set();
  roll(slot, text, { shimmer: start.shimmer });
  return {
    get() { return text; },
    set(next, options = {}) {
      const value = String(next ?? '');
      const changed = value !== text;
      text = value;
      roll(slot, value, { shimmer: options.shimmer ?? start.shimmer });
      if (changed && !signal?.aborted) {
        emit(slot, 'change', { text });
        listeners.forEach((fn) => fn({ text }));
      }
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      start.shimmer = slot.hasAttribute('data-ds-wheel-shimmer');
      this.set(slot.getAttribute('data-ds-wheel') ?? '', { shimmer: start.shimmer });
    },
    destroy() { listeners.clear(); },
  };
}

define('wheel', {
  attribute: 'data-ds-wheel',
  attributes: ['data-ds-wheel-shimmer'],
  init(el, ctx) {
    return controller(el, { text: el.getAttribute('data-ds-wheel') ?? '', shimmer: el.hasAttribute('data-ds-wheel-shimmer') }, ctx.signal);
  },
});

/**
 * A wheel driven from the page; the same controller the attribute path
 * makes. Its first text shows at once.
 * @param {Element} slot
 * @param {{ text?: string, shimmer?: boolean }} [options]
 */
export function create(slot, options = {}) {
  return controller(slot, { text: String(options.text ?? ''), shimmer: Boolean(options.shimmer) });
}
