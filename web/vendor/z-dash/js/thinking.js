/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The thinking indicator (DS.thinking): the step an assistant or agent is
 * on, rolled by a wheel with the shimmer, the time since it started (on the
 * page's one clock), the tokens it used and the current thought.
 *
 *   <div class="ds-thinking" data-ds-thinking="Reading the device list" data-ds-thinking-since="2026-11-05T09:00:00Z"
 *        data-ds-thinking-tokens="1240"> ... </div>
 *   const status = DS.thinking.create(el, { step: 'Thinking', since: Date.now() });
 *   status.set({ step: 'Running npm test', tokens: 2048, thought: 'Comparing versions' });
 *   status.set({ done: true });
 *
 * Attributes (DS.init(); a change of one is read again): data-ds-thinking
 * (the step), data-ds-thinking-since (a date text or a timestamp in ms;
 * default: when it starts), data-ds-thinking-tokens (a count),
 * data-ds-thinking-done (present: it ended; a value in ms is the total
 * time). set() drives it from the page and never writes those attributes.
 *
 * What it writes: the wheel in .ds-thinking__step (made when missing, its
 * line a .ds-shimmer while it works), the text of .ds-thinking__time (a
 * <time> also gets an ISO 8601 duration in datetime) and of
 * .ds-thinking__tokens (compact, "1.2K tokens", the strings tokensOne and
 * tokensOther), the thought on set({ thought }), aria-hidden on the icon
 * and data-state="done" at the end. The time ticks every second on
 * DS.format.clock() and stops at the end.
 *
 * The controller: get() ({ step, thought, tokens, elapsed, done }),
 * set(changes), on('change', fn), destroy(); ds:change with the state
 * after a set() that changed something.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { clock, duration, number, plural } from './format.js';
import { roll } from './wheel.js';

/**
 * A moment in ms: a timestamp, a numeric text or a date text; null when it
 * is none.
 * @param {Date|number|string|null|undefined} value
 * @returns {number|null}
 */
export function sinceOf(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const text = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A length of time as it shows: whole seconds, narrow ("12s", "1m 5s",
 * "1h 2m"), in the page's locale.
 * @param {number} ms
 * @returns {string}
 */
export function elapsedText(ms) {
  const value = Math.max(0, Math.floor(Number(ms) / 1000) * 1000);
  return Number.isFinite(value) ? duration(value, { style: 'narrow', smallest: 'second' }) : '';
}

/**
 * A length of time as an ISO 8601 duration ("PT1M5S"), for datetime.
 * @param {number} ms
 * @returns {string}
 */
export function isoDuration(ms) {
  let left = Math.max(0, Math.floor(Number(ms) / 1000)) || 0;
  const hours = Math.floor(left / 3600);
  left -= hours * 3600;
  const minutes = Math.floor(left / 60);
  const seconds = left - minutes * 60;
  return `PT${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${seconds || (!hours && !minutes) ? `${seconds}S` : ''}`;
}

/**
 * A token count as it shows: compact ("1.2K tokens"), through the strings
 * tokensOne and tokensOther; '' for what is no count.
 * @param {number|string|null|undefined} count
 * @returns {string}
 */
export function tokensText(count) {
  if (count === null || count === undefined || count === '') return '';
  const value = Number(count);
  if (!Number.isFinite(value) || value < 0) return '';
  const formatted = number(value, { notation: 'compact', maximumFractionDigits: 1 });
  return plural(value, {
    one: () => t('tokensOne', { count: formatted }),
    other: () => t('tokensOther', { count: formatted }),
  });
}

function readAttributes(el) {
  const done = el.getAttribute('data-ds-thinking-done');
  return {
    step: el.getAttribute('data-ds-thinking') ?? '',
    since: sinceOf(el.getAttribute('data-ds-thinking-since')),
    tokens: el.getAttribute('data-ds-thinking-tokens'),
    done: done !== null,
    total: done ? sinceOf(done) : null,
  };
}

function controller(el, start, signal) {
  const doc = el.ownerDocument;
  const listeners = new Set();
  const state = {
    step: start.step ?? '',
    thought: null,
    tokens: start.tokens ?? null,
    since: start.since ?? Date.now(),
    done: Boolean(start.done),
    total: start.total ?? null,
  };
  let stopClock = () => {};

  el.querySelector(':scope > .ds-thinking__icon')?.setAttribute('aria-hidden', 'true');
  const stepPart = el.querySelector(':scope > .ds-thinking__step');
  let slot = stepPart?.querySelector('.ds-wheel') ?? null;
  if (stepPart && !slot) {
    slot = doc.createElement('span');
    slot.className = 'ds-wheel';
    stepPart.append(slot);
  }
  const timePart = el.querySelector('.ds-thinking__time');
  const tokensPart = el.querySelector('.ds-thinking__tokens');
  const thoughtPart = el.querySelector('.ds-thinking__thought');

  const elapsed = (now = Date.now()) => (state.done && state.total !== null ? state.total : Math.max(0, now - state.since));

  const writeTime = (now) => {
    if (!timePart) return;
    const ms = elapsed(now);
    const text = elapsedText(ms);
    if (timePart.textContent !== text) timePart.textContent = text;
    if (timePart.localName === 'time') timePart.setAttribute('datetime', isoDuration(ms));
  };

  const tick = (now) => {
    writeTime(now);
    // The next whole second of the elapsed time.
    return 1000 - (elapsed(now) % 1000);
  };

  const render = () => {
    stopClock();
    stopClock = () => {};
    if (state.done) {
      if (state.total === null) state.total = elapsed();
      writeTime();
      el.setAttribute('data-state', 'done');
    } else {
      el.removeAttribute('data-state');
      if (timePart) stopClock = clock(tick);
    }
    if (tokensPart) {
      const text = tokensText(state.tokens);
      if (tokensPart.textContent !== text) tokensPart.textContent = text;
    }
    if (thoughtPart && state.thought !== null && thoughtPart.textContent !== state.thought) thoughtPart.textContent = state.thought;
    // roll() rather than a wheel controller: the slot tells nobody, so a page hears one ds:change per set().
    if (slot) roll(slot, state.step, { shimmer: !state.done });
  };

  const snapshot = () => ({ step: state.step, thought: state.thought ?? thoughtPart?.textContent ?? '', tokens: state.tokens === null ? null : Number(state.tokens), elapsed: elapsed(), done: state.done });

  render();

  return {
    get: snapshot,
    set(changes = {}) {
      let changed = false;
      for (const key of ['step', 'thought', 'tokens', 'since']) {
        if (!(key in changes)) continue;
        const value = key === 'since' ? sinceOf(changes.since) ?? state.since : key === 'tokens' ? changes.tokens : String(changes[key] ?? '');
        if (value !== state[key]) {
          state[key] = value;
          changed = true;
        }
      }
      if ('done' in changes && Boolean(changes.done) !== state.done) {
        state.done = Boolean(changes.done);
        state.total = state.done ? (sinceOf(changes.total) ?? null) : null;
        changed = true;
      }
      if (!changed) return;
      render();
      if (signal?.aborted) return;
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
      state.step = read.step;
      if (read.since !== null) state.since = read.since;
      state.tokens = read.tokens;
      state.done = read.done;
      state.total = read.done ? read.total : null;
      render();
    },
    destroy() {
      stopClock();
      stopClock = () => {};
      listeners.clear();
    },
  };
}

define('thinking', {
  attribute: 'data-ds-thinking',
  attributes: ['data-ds-thinking-since', 'data-ds-thinking-tokens', 'data-ds-thinking-done'],
  init(el, ctx) {
    const read = readAttributes(el);
    const handle = controller(el, { ...read, since: read.since ?? Date.now() }, ctx.signal);
    ctx.signal?.addEventListener('abort', () => handle.destroy(), { once: true });
    return handle;
  },
});

/**
 * A thinking indicator driven from the page; the same controller the
 * attribute path makes.
 * @param {Element} el
 * @param {{ step?: string, since?: Date|number|string, tokens?: number|null, done?: boolean }} [options]
 */
export function create(el, options = {}) {
  return controller(el, {
    step: String(options.step ?? ''),
    since: sinceOf(options.since) ?? Date.now(),
    tokens: options.tokens ?? null,
    done: Boolean(options.done),
  });
}
