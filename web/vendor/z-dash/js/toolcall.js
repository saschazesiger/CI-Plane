/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The tool call (DS.toolcall): the duration of a call, live while it runs,
 * its status mark, and one announcement when it ends.
 *
 *   <details class="ds-collapsible ds-disclosure ds-disclosure--row ds-toolcall" data-status="running"
 *            data-ds-toolcall data-ds-toolcall-since="2026-11-05T09:00:00Z"> ... </details>
 *   const call = DS.toolcall.create(row, { status: 'running', since: Date.now() });
 *   call.set({ status: 'done', label: 'Done', duration: 1240 });
 *
 * Attributes (DS.init(); a change of one is read again, so a page that
 * re-renders the row with DS.dom.morphHtml just writes them):
 * data-status (pending, running, done, failed, cancelled),
 * data-ds-toolcall-since (when it started: a date text or a timestamp in
 * ms), data-ds-toolcall-duration (the duration in ms, once known; it wins
 * over since), data-ds-toolcall-announce="off" (no announcement).
 *
 * The time (.ds-toolcall__time): the duration, or while it runs the time
 * since it started, ticking every second on DS.format.clock(); once it
 * ended without a duration, the time it ran until then. Whole seconds,
 * narrow ("12s"); under a second the milliseconds ("240ms").
 *
 * When a status turns from pending or running to done, failed or
 * cancelled, the call says so once through DS.a11y.announce(): the string
 * toolStatus with the name (.ds-toolcall__name) and the word
 * (.ds-toolcall__status), so the summary of a closed row needs no live
 * region of its own.
 *
 * set({ status, label, duration, since }) writes data-status, the mark
 * (.ds-toolcall__mark: the spinner, or the status glyph of DS.icons:
 * hourglass, checkCircle, alertCircle, ban) and the word
 * (.ds-toolcall__word): the label, or without one the status's own word
 * (strings toolPending, toolRunning, toolDone, toolFailed, toolCancelled).
 * A status changed through data-status alone gets its mark, and its word
 * unless the page wrote one with it. get() gives
 * { status, duration } (duration: the ms shown, or null), on('change', fn)
 * runs after a set() that changed the status, with ds:change on the row.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { clock, duration } from './format.js';
import { announce } from './a11y.js';
import { alertCircle, ban, checkCircle, hourglass, iconElement } from './icons.js';
import { elapsedText, isoDuration, sinceOf } from './thinking.js';

/** The statuses, and which of them have ended. */
export const STATUSES = Object.freeze(['pending', 'running', 'done', 'failed', 'cancelled']);
const ENDED = new Set(['done', 'failed', 'cancelled']);
const GLYPHS = { pending: hourglass, done: checkCircle, failed: alertCircle, cancelled: ban };
/** The word of each status, when the page gives none (strings of DS.core.config()). */
const WORDS = { pending: 'toolPending', running: 'toolRunning', done: 'toolDone', failed: 'toolFailed', cancelled: 'toolCancelled' };

/**
 * A duration as a tool call shows it: the milliseconds under a second
 * ("240ms"), else whole seconds, narrow ("12s", "1m 5s").
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function durationText(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms)) || Number(ms) < 0) return '';
  const value = Number(ms);
  return value < 1000 ? duration(Math.round(value), { style: 'narrow', smallest: 'millisecond' }) : elapsedText(value);
}

const statusOf = (value) => (STATUSES.includes(value) ? value : 'pending');

function controller(el, start, signal) {
  const doc = el.ownerDocument;
  const listeners = new Set();
  const summary = el.querySelector(':scope > summary');
  const timePart = summary?.querySelector('.ds-toolcall__time') ?? null;
  const state = { status: statusOf(start.status), since: start.since, duration: start.duration, ended: null };
  let stopClock = () => {};

  summary?.querySelectorAll('.ds-toolcall__icon, .ds-toolcall__mark, .ds-chevron').forEach((node) => node.setAttribute('aria-hidden', 'true'));

  const shown = (now = Date.now()) => {
    if (state.duration !== null) return state.duration;
    if (state.since === null) return null;
    return Math.max(0, (state.ended ?? now) - state.since);
  };

  const writeTime = (now) => {
    if (!timePart) return;
    const ms = shown(now);
    const text = durationText(ms);
    if (timePart.textContent !== text) timePart.textContent = text;
    if (timePart.localName === 'time') {
      if (ms === null) timePart.removeAttribute('datetime');
      else timePart.setAttribute('datetime', isoDuration(ms));
    }
  };

  const render = () => {
    stopClock();
    stopClock = () => {};
    if (ENDED.has(state.status) && state.ended === null) state.ended = Date.now();
    if (!ENDED.has(state.status)) state.ended = null;
    if (state.status === 'running' && state.duration === null && state.since !== null && timePart) {
      stopClock = clock((now) => {
        writeTime(now);
        return 1000 - (shown(now) % 1000);
      });
    } else writeTime();
  };

  const say = (before) => {
    if (signal?.aborted || el.getAttribute('data-ds-toolcall-announce') === 'off') return;
    if (!ENDED.has(state.status) || ENDED.has(before)) return;
    const name = summary?.querySelector('.ds-toolcall__name')?.textContent.trim() ?? '';
    const word = summary?.querySelector('.ds-toolcall__status')?.textContent.trim() ?? '';
    if (name || word) announce(t('toolStatus', { name, status: word }));
  };

  const wordPart = () => summary?.querySelector('.ds-toolcall__word') ?? null;
  /** The word as the status last left it: a page that changes the status alone leaves it so. */
  let lastWord = wordPart()?.textContent ?? null;

  const writeWord = (label) => {
    const word = wordPart();
    if (!word) return;
    const text = typeof label === 'string' ? label : t(WORDS[state.status]);
    if (word.textContent !== text) word.textContent = text;
    lastWord = text;
  };

  /** The mark of the status: the spinner, or its glyph; markup that already shows it stays. */
  const writeMark = () => {
    const mark = summary?.querySelector('.ds-toolcall__mark');
    if (!mark) return;
    if (state.status === 'running') {
      if (mark.children.length === 1 && mark.firstElementChild.classList.contains('ds-spinner')) return;
      const spinner = doc.createElement('span');
      spinner.className = 'ds-spinner';
      mark.replaceChildren(spinner);
      return;
    }
    const glyph = iconElement(GLYPHS[state.status], 16, undefined, doc);
    const shown = mark.children.length === 1 ? mark.firstElementChild : null;
    if (shown?.localName === 'svg' && shown.innerHTML === glyph.innerHTML) return;
    mark.replaceChildren(glyph);
  };

  render();

  return {
    get() {
      return { status: state.status, duration: shown() };
    },
    set(changes = {}) {
      const before = state.status;
      if ('since' in changes) state.since = sinceOf(changes.since);
      if ('duration' in changes) state.duration = changes.duration === null || changes.duration === undefined ? null : Number(changes.duration);
      if (changes.status !== undefined) state.status = statusOf(changes.status);
      if (state.status !== before) {
        el.setAttribute('data-status', state.status);
        writeMark();
      }
      // The word follows the status: the label given, or the status's own.
      if (typeof changes.label === 'string' || state.status !== before) writeWord(changes.label);
      render();
      if (state.status === before || signal?.aborted) return;
      say(before);
      const detail = { status: state.status, duration: shown() };
      emit(el, 'change', detail);
      listeners.forEach((fn) => fn(detail));
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update(names) {
      // Only what changed: set() writes data-status itself, and its own
      // since and duration stay.
      const changed = (name) => !names || names.includes(name);
      const before = state.status;
      if (changed('data-status')) state.status = statusOf(el.getAttribute('data-status'));
      if (changed('data-ds-toolcall-since')) state.since = sinceOf(el.getAttribute('data-ds-toolcall-since'));
      if (changed('data-ds-toolcall-duration')) {
        const total = el.getAttribute('data-ds-toolcall-duration');
        state.duration = total === null || total === '' ? null : Number(total);
      }
      if (state.status !== before) {
        writeMark();
        // A re-render that wrote its own word keeps it; a status changed alone gets its word.
        const word = wordPart();
        if (word && word.textContent === lastWord) writeWord();
        else lastWord = word?.textContent ?? null;
      }
      render();
      if (state.status !== before) say(before);
    },
    destroy() {
      stopClock();
      stopClock = () => {};
      listeners.clear();
    },
  };
}

function readStart(el) {
  const total = el.getAttribute('data-ds-toolcall-duration');
  return {
    status: el.getAttribute('data-status'),
    since: sinceOf(el.getAttribute('data-ds-toolcall-since')),
    duration: total === null || total === '' ? null : Number(total),
  };
}

define('toolcall', {
  attribute: 'data-ds-toolcall',
  attributes: ['data-status', 'data-ds-toolcall-since', 'data-ds-toolcall-duration'],
  init(el, ctx) {
    const handle = controller(el, readStart(el), ctx.signal);
    ctx.signal?.addEventListener('abort', () => handle.destroy(), { once: true });
    return handle;
  },
});

/**
 * A tool call driven from the page; the same controller the attribute path
 * makes. The markup's data-status and attributes are the start.
 * @param {Element} el
 * @param {{ status?: string, since?: Date|number|string, duration?: number|null }} [options]
 */
export function create(el, options = {}) {
  const start = readStart(el);
  return controller(el, {
    status: options.status ?? start.status,
    since: options.since === undefined ? start.since : sinceOf(options.since),
    duration: options.duration === undefined ? start.duration : options.duration,
  });
}
