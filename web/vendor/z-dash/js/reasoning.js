/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The reasoning disclosure (DS.reasoning): the summary line of an
 * assistant's thinking, the time it took, and the thoughts that stay at
 * their end while they stream in.
 *
 *   <details class="ds-collapsible ds-disclosure ds-reasoning" data-ds-reasoning
 *            data-ds-reasoning-since="2026-11-05T09:00:00Z" data-ds-reasoning-auto> ... </details>
 *   const thinking = DS.reasoning.create(details, { since: Date.now(), auto: true });
 *   thinking.set({ done: true });                       // "Thought for 12s"
 *   thinking.set({ done: true, summary: 'Compared the warranty of 40 laptops' });
 *
 * Attributes (DS.init(); a change of one is read again):
 * data-ds-reasoning-since (when it started; default: when it was found),
 * data-ds-reasoning-done (present: it ended; a value in ms is the total),
 * data-ds-reasoning-auto (open while it runs, close at the end, unless the
 * reader toggled it).
 *
 * What it writes: data-state ("running", "done"); the text of
 * .ds-reasoning__summary when the page left it empty: the string
 * reasoningRunning ("Thinking") with the shimmer while it runs, and
 * reasoningDone ("Thought for {time}") at the end; a summary of the page's
 * own stays, with the shimmer while it runs. .ds-reasoning__time: the time
 * while it runs, ticking on DS.format.clock(); at the end the total, but
 * only beside a summary of the page's own (the written one says it).
 * aria-hidden on the icon and the chevron. While it runs,
 * .ds-reasoning__text stays at its end as thoughts come in
 * (DS.dom.followEnd(); scrolling up lets go).
 *
 * The controller: get() ({ done, elapsed, open }), set({ done, total,
 * summary }), on('change', fn), destroy(); ds:change with the state after
 * a set() that changed something.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { followEnd } from './dom.js';
import { clock } from './format.js';
import { elapsedText, isoDuration, sinceOf } from './thinking.js';

/**
 * The summary line the module writes: the string reasoningRunning
 * ("Thinking") while it runs, reasoningDone ("Thought for {time}", the time
 * narrow) once it is done.
 * @param {number} ms  the total, once done
 * @param {boolean} done
 * @returns {string}
 */
export function summaryText(ms, done) {
  return done ? t('reasoningDone', { time: elapsedText(ms) }) : t('reasoningRunning');
}

function readAttributes(el) {
  const done = el.getAttribute('data-ds-reasoning-done');
  return {
    since: sinceOf(el.getAttribute('data-ds-reasoning-since')),
    done: done !== null,
    total: done ? sinceOf(done) : null,
    auto: el.hasAttribute('data-ds-reasoning-auto'),
  };
}

function controller(el, start, given) {
  // Without the signal of DS.init() (create()), destroy() ends its own.
  const own = given ? null : new AbortController();
  const signal = given ?? own.signal;

  const listeners = new Set();
  const summary = el.querySelector(':scope > summary');
  const line = summary?.querySelector('.ds-reasoning__summary') ?? null;
  const timePart = summary?.querySelector('.ds-reasoning__time') ?? null;
  const text = el.querySelector('.ds-reasoning__text');
  // The page's own summary stays; an empty one is the module's to write.
  let written = !line || !line.textContent.trim();
  const state = { since: start.since ?? Date.now(), done: Boolean(start.done), total: start.total ?? null, auto: Boolean(start.auto), touched: false };
  let stopClock = () => {};
  let follower = null;

  summary?.querySelectorAll('.ds-reasoning__icon, .ds-chevron').forEach((node) => node.setAttribute('aria-hidden', 'true'));

  const elapsed = (now = Date.now()) => (state.done && state.total !== null ? state.total : Math.max(0, now - state.since));

  const writeTime = (now) => {
    if (!timePart) return;
    const ms = elapsed(now);
    const show = !state.done || !written;
    const value = show ? elapsedText(ms) : '';
    if (timePart.textContent !== value) timePart.textContent = value;
    if (timePart.localName === 'time') {
      if (show) timePart.setAttribute('datetime', isoDuration(ms));
      else timePart.removeAttribute('datetime');
    }
  };

  const writeLine = () => {
    if (!line) return;
    if (written) {
      const value = summaryText(elapsed(), state.done);
      if (line.textContent !== value) line.textContent = value;
    }
    const words = line.textContent.trim();
    line.classList.toggle('ds-shimmer', !state.done);
    if (state.done) line.removeAttribute('data-shimmer');
    else line.setAttribute('data-shimmer', words);
  };

  // A toggle by the reader (not by the auto open or close) keeps it as they left it. The toggle event comes in a task
  // of its own and coalesces, so it is judged by the state it leaves, not by the order of events: the module's own
  // open state (what it set, or found at a new run) is no toggle of the reader's, whenever its event arrives (a
  // reader's event that lands after set({ done: false }) once kept the new run from closing).
  let claimed = /** @type {HTMLDetailsElement} */ (el).open;
  el.addEventListener('toggle', () => {
    const now = /** @type {HTMLDetailsElement} */ (el).open;
    if (now !== claimed) state.touched = true;
    claimed = now;
  }, { signal });
  const openTo = (value) => {
    if (!state.auto || state.touched || /** @type {HTMLDetailsElement} */ (el).open === value) return;
    claimed = value;
    /** @type {HTMLDetailsElement} */ (el).open = value;
  };

  const render = () => {
    stopClock();
    stopClock = () => {};
    if (state.done && state.total === null) state.total = elapsed();
    el.setAttribute('data-state', state.done ? 'done' : 'running');
    writeLine();
    if (state.done) {
      writeTime();
      follower?.destroy();
      follower = null;
    } else {
      if (timePart) {
        stopClock = clock((now) => {
          writeTime(now);
          return 1000 - (elapsed(now) % 1000);
        });
      }
      if (text && !follower) follower = followEnd(text);
    }
    openTo(!state.done);
  };

  const snapshot = () => ({ done: state.done, elapsed: elapsed(), open: Boolean(/** @type {HTMLDetailsElement} */ (el).open) });

  render();

  return {
    get: snapshot,
    set(changes = {}) {
      let changed = false;
      if (typeof changes.summary === 'string' && line) {
        written = !changes.summary.trim();
        if (!written) line.textContent = changes.summary;
        changed = true;
      }
      if ('since' in changes) {
        state.since = sinceOf(changes.since) ?? state.since;
        changed = true;
      }
      if ('done' in changes && Boolean(changes.done) !== state.done) {
        state.done = Boolean(changes.done);
        state.total = state.done ? sinceOf(changes.total) : null;
        if (!state.done) {
          state.touched = false;
          claimed = /** @type {HTMLDetailsElement} */ (el).open;
        }
        changed = true;
      }
      if (!changed) return;
      render();
      if (signal.aborted) return;
      const detail = snapshot();
      emit(el, 'change', detail);
      listeners.forEach((fn) => fn(detail));
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      const read = readAttributes(el);
      if (read.since !== null) state.since = read.since;
      if (read.done !== state.done && !read.done) {
        state.touched = false;
        claimed = /** @type {HTMLDetailsElement} */ (el).open;
      }
      state.done = read.done;
      state.total = read.done ? read.total : null;
      state.auto = read.auto;
      render();
    },
    destroy() {
      stopClock();
      stopClock = () => {};
      follower?.destroy();
      follower = null;
      listeners.clear();
      own?.abort();
    },
  };
}

define('reasoning', {
  attribute: 'data-ds-reasoning',
  attributes: ['data-ds-reasoning-since', 'data-ds-reasoning-done', 'data-ds-reasoning-auto'],
  init(el, ctx) {
    const handle = controller(el, readAttributes(el), ctx.signal);
    ctx.signal?.addEventListener('abort', () => handle.destroy(), { once: true });
    return handle;
  },
});

/**
 * A reasoning disclosure driven from the page; the same controller the
 * attribute path makes; destroy() removes its listeners.
 * @param {Element} el
 * @param {{ since?: Date|number|string, done?: boolean, total?: number, auto?: boolean }} [options]
 */
export function create(el, options = {}) {
  return controller(el, { since: sinceOf(options.since), done: Boolean(options.done), total: sinceOf(options.total), auto: Boolean(options.auto) });
}
