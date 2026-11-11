/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Transcript (DS.transcript): the log of a conversation, a .ds-transcript.
 *
 *   <div class="ds-transcript" data-ds-transcript role="region" aria-label="Conversation" tabindex="0">
 *     <div class="ds-transcript__list" role="log" aria-label="Messages"> ... </div>
 *   </div>
 *   const log = DS.transcript.create(el);
 *   el.addEventListener('ds:earlier', async () => { prepend(await older()); log.loaded({ more: true }); });
 *   log.stick();                               // after the user sent: back to the end
 *
 * - Sticks to its end (DS.dom.followEnd()): it opens at the end, and while
 *   the reader is at the end (within 16px) new messages and a growing reply
 *   keep it there. Scrolled up, it stays put and the "Latest" pill shows
 *   (the .ds-jump the markup holds, else one the module writes: a tonal
 *   .ds-btn with an arrow, the string latest and a .ds-transcript__unread).
 *   Every message that arrives at the end meanwhile, not the user's own
 *   (.ds-message--user), counts: the unread count reads the string
 *   unreadCount ("3 new"). The pill, or stick(), goes back to the end;
 *   the count goes once the end is reached. A pill pressed by keyboard
 *   hands the focus to the transcript before it hides.
 * - Load earlier: a press on [data-ds-transcript-earlier] (or, with
 *   data-ds-transcript-earlier="auto", the button coming into view)
 *   dispatches ds:earlier once and holds the button busy (DS.motion.busy())
 *   until the page calls loaded({ more }); with "auto" a button still in
 *   view after loaded({ more: true }) loads again. What the page puts above the
 *   message on screen does not move it (the module keeps the first message
 *   in view where it was, in every engine), loaded() announces the string
 *   earlierLoaded, and more: false hides .ds-transcript__earlier.
 * - Announcements that do not spam: the log (.ds-transcript__list, else
 *   the transcript) gets aria-live="off" unless the markup set aria-live,
 *   and the module announces (DS.a11y.announce(), polite) each message that
 *   arrives at the end complete, and a streaming reply once it is complete
 *   (ds:change of DS.message), as its author and text; never the user's
 *   own, never what loads above. A reply that fails is announced with its
 *   note. data-ds-transcript-announce="live" leaves it to the log's own
 *   politeness (a streaming message is aria-busy), "off" says nothing.
 *
 * The controller: get() ({ atEnd, unread }), set({ more }), stick(),
 * loaded({ more }), on('earlier', fn), destroy(). day(value, { now,
 * locale }) is the label of a day separator.
 */
import { config, define, emit, t } from './core.js';
import { busy } from './motion.js';
import { followEnd } from './dom.js';
import { arrowDown, iconElement } from './icons.js';
import { announce } from './a11y.js';

/** How close to the end still counts as at the end (px, a distance). */
const END_SLOP_PX = 16;

/** A day of the calendar in ms, for day counts only (never a timing). */
const DAY_LENGTH = 864e5;

/** The events a controller's on() takes. */
const EVENTS = new Set(['earlier']);

/** A locale the engine takes, else undefined (its default). */
function usable(locale) {
  try {
    return locale ? Intl.DateTimeFormat.supportedLocalesOf(locale).length ? locale : undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The label of a day separator for `value` (a Date, timestamp or date
 * text), seen from `now`: "Today", "Yesterday" (Intl's words, the first
 * letter upper case), the weekday within the last week, else the date
 * (with the year when it is another year). Empty for what is no date.
 * @param {Date|number|string} value
 * @param {{ now?: Date|number|string, locale?: string }} [options]
 * @returns {string}
 */
export function day(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value ?? NaN);
  if (value == null || value === '' || Number.isNaN(date.getTime())) return '';
  const now = options.now != null ? new Date(options.now) : new Date();
  const locale = usable(options.locale ?? config().locale);
  const midnight = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((midnight(date) - midnight(now)) / DAY_LENGTH);
  if (days === 0 || days === -1) {
    const text = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day');
    return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
  }
  if (days < 0 && days > -7) return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date);
  const year = date.getFullYear() === now.getFullYear() ? undefined : 'numeric';
  return new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', year }).format(date);
}

/** What a reader hears for a message: its author and its text (and its note). */
function spoken(message) {
  const author = message.querySelector('.ds-message__author')?.textContent?.trim() ?? '';
  const parts = Array.from(message.querySelectorAll('.ds-message__content, .ds-message__note'))
    .filter((part) => part.closest('.ds-message') === message)
    .map((part) => (typeof part.innerText === 'string' ? part.innerText : part.textContent ?? '').trim())
    .filter(Boolean);
  return [author, parts.join(' ')].filter(Boolean).join(': ');
}

const isMessage = (node) => node?.nodeType === 1 && node.classList.contains('ds-message');
const isOwn = (message) => message.classList.contains('ds-message--user');
const streaming = (message) => message.getAttribute('data-state') === 'streaming' || message.getAttribute('data-ds-message') === 'streaming';

function controller(el) {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const abort = new AbortController();
  const signal = abort.signal;
  const listeners = new Map();
  const list = el.querySelector('.ds-transcript__list') ?? el;
  const mode = () => el.getAttribute('data-ds-transcript-announce') ?? 'done';
  const cleanups = [];

  /* ── The pill ── */

  let presence = /** @type {HTMLElement|null} */ (el.querySelector(':scope > .ds-jump > .ds-presence'));
  if (!presence) {
    const jump = doc.createElement('div');
    jump.className = 'ds-jump';
    presence = doc.createElement('div');
    presence.className = 'ds-presence';
    presence.hidden = true;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ds-btn ds-btn--tonal ds-transcript__latest';
    const label = doc.createElement('span');
    label.textContent = t('latest');
    button.append(iconElement(arrowDown, 20, undefined, doc), label);
    presence.append(button);
    jump.append(presence);
    el.append(jump);
    cleanups.push(() => jump.remove());
  }
  const latest = presence.querySelector('button');
  let counter = presence.querySelector('.ds-transcript__unread');
  if (!counter && latest) {
    counter = doc.createElement('span');
    counter.className = 'ds-transcript__unread';
    // A space, so the name reads "Latest 3 new".
    const space = doc.createTextNode(' ');
    latest.append(space, counter);
    cleanups.push(() => {
      space.remove();
      counter.remove();
    });
  }

  /* ── Live region politeness ── */

  if (mode() !== 'live' && !list.hasAttribute('aria-live')) {
    list.setAttribute('aria-live', 'off');
    cleanups.push(() => list.removeAttribute('aria-live'));
  }

  /* ── Sticking to the end ── */

  el.scrollTop = el.scrollHeight;
  const follow = followEnd(el, { pill: presence, threshold: END_SLOP_PX });
  const atEnd = () => presence.hidden;

  let unread = 0;
  const showUnread = () => {
    if (!counter) return;
    const text = unread ? t('unreadCount', { count: unread }) : '';
    if (counter.textContent !== text) counter.textContent = text;
  };

  /* ── Keeping what is on screen in place ── */

  let anchor = null;
  let anchorTop = 0;
  const topOf = (node) => node.getBoundingClientRect().top - el.getBoundingClientRect().top;
  /** The first rendered child at `from` or after it, before `to`; -1 when none. */
  function rendered(children, from, to) {
    for (let index = from; index < to; index += 1) if (children[index].getClientRects().length) return index;
    return -1;
  }

  /**
   * Remembers the first child on screen and where it sits. It runs on every
   * scroll frame and every change, so it halves its way there (the children
   * stack top to bottom) instead of measuring each one from the top: a long
   * conversation read at its end costs a few measurements, not thousands.
   */
  function record() {
    anchor = null;
    const top = el.getBoundingClientRect().top;
    const children = list.children;
    // Every rendered child before low ends above the top edge; every one at high or after does not.
    let low = 0;
    let high = children.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const at = rendered(children, middle, high);
      if (at < 0) high = middle;
      else if (children[at].getBoundingClientRect().bottom > top) high = at;
      else low = at + 1;
    }
    const found = rendered(children, low, children.length);
    if (found < 0) return;
    anchor = children[found];
    anchorTop = topOf(anchor);
  }
  function correct() {
    if (atEnd() || !anchor?.isConnected) {
      record();
      return;
    }
    const delta = topOf(anchor) - anchorTop;
    if (Math.abs(delta) >= 0.5) el.scrollTop += delta;
    record();
  }

  let frame = 0;
  const onScroll = () => {
    if (atEnd() && unread) {
      unread = 0;
      showUnread();
    }
    if (frame) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      record();
    });
  };
  el.addEventListener('scroll', onScroll, { passive: true, signal });

  /* ── New messages ── */

  const known = new WeakSet(Array.from(list.querySelectorAll('.ds-message')));
  let tail = Array.from(list.querySelectorAll('.ds-message')).at(-1) ?? null;

  function say(message) {
    if (mode() !== 'done' || isOwn(message)) return;
    const text = spoken(message);
    if (text) announce(text);
  }

  /**
   * Whether the reader was at the end before `records` added to it: at the
   * end by followEnd(), and the first node added after the last message
   * starts within a gap of the bottom edge. The second half matters when
   * the page moved scrollTop in the same task (its scroll event comes
   * later, so followEnd() has not seen it yet).
   */
  function endBefore(records) {
    if (!atEnd()) return false;
    let first = Infinity;
    for (const item of records) {
      for (const node of Array.from(item.addedNodes)) {
        if (node.nodeType !== 1 || !node.isConnected) continue;
        if (tail?.isConnected && !(tail.compareDocumentPosition(node) & 4)) continue;
        first = Math.min(first, /** @type {Element} */ (node).getBoundingClientRect().top);
      }
    }
    if (first === Infinity) return true;
    const gapPx = Number.parseFloat(view.getComputedStyle(list).rowGap) || 0;
    return first - el.getBoundingClientRect().top <= el.clientHeight + gapPx + END_SLOP_PX;
  }

  function arrived(records) {
    const wasAtEnd = endBefore(records);
    for (const item of records) {
      for (const node of Array.from(item.addedNodes)) {
        if (node.nodeType !== 1) continue;
        const found = isMessage(node) ? [node] : Array.from(/** @type {Element} */ (node).querySelectorAll('.ds-message'));
        for (const message of found) {
          if (known.has(message) || !message.isConnected) continue;
          known.add(message);
          // Above the last one: loaded earlier, neither counted nor said.
          if (tail?.isConnected && !(tail.compareDocumentPosition(message) & 4)) continue;
          tail = message;
          if (!wasAtEnd && !isOwn(message)) unread += 1;
          if (!streaming(message)) say(message);
        }
      }
    }
    tail = Array.from(list.querySelectorAll('.ds-message')).at(-1) ?? null;
    // At the end, what arrives keeps the reader there before the next scroll
    // event: WebKit clamps scrollTop silently when the content shrinks (a
    // font swap) and fires that event late, with the next change, which
    // followEnd() would read as the reader scrolling up.
    if (wasAtEnd) el.scrollTop = el.scrollHeight;
    showUnread();
    correct();
  }

  const mutations = new view.MutationObserver(arrived);
  mutations.observe(list, { childList: true, subtree: true });
  const sizes = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => correct()) : null;
  sizes?.observe(list);
  // The load row changes the scroll height too (its button turns busy, it hides).
  const row = el.querySelector(':scope > .ds-transcript__earlier');
  if (row && row !== list) sizes?.observe(row);

  const onChange = (event) => {
    const message = event.target;
    if (!isMessage(message) || !list.contains(message)) return;
    const { state, previous } = event.detail ?? {};
    if (previous === 'streaming' && (state === 'done' || state === 'error' || state === 'partial')) say(message);
    else if (state === 'error') say(message);
  };
  el.addEventListener('ds:change', onChange, { signal });

  /* ── Load earlier ── */

  const earlierButton = () => /** @type {HTMLElement|null} */ (el.querySelector('[data-ds-transcript-earlier]'));
  let pending = null;

  function loadEarlier() {
    const button = earlierButton();
    if (pending || !button || button.closest('[hidden]')) return;
    pending = Promise.withResolvers();
    record();
    busy(button, pending.promise, { done: false }).catch(() => {});
    const detail = {};
    emit(el, 'earlier', detail);
    for (const fn of listeners.get('earlier') ?? []) fn(detail);
  }

  function showMore(more) {
    const row = el.querySelector('.ds-transcript__earlier') ?? earlierButton();
    if (!row) return;
    if (!more && row.contains(doc.activeElement)) el.focus({ preventScroll: true });
    row.hidden = !more;
  }

  function loaded(options = {}) {
    const more = options.more !== false;
    correct();
    if (pending) {
      pending.resolve();
      pending = null;
      announce(t('earlierLoaded'));
    }
    showMore(more);
    // The observer tells only a change: when what loaded left the button in
    // view, it would never fire again until the reader scrolled it out and back.
    if (more && watcher) {
      view.requestAnimationFrame(() => {
        const button = earlierButton();
        if (signal.aborted || !button || button.closest('[hidden]')) return;
        const box = button.getBoundingClientRect();
        const port = el.getBoundingClientRect();
        if (box.bottom > port.top && box.top < port.bottom) loadEarlier();
      });
    }
  }

  const onClick = (event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest?.('[data-ds-transcript-earlier]')) {
      loadEarlier();
      return;
    }
    if (latest && latest.contains(target)) {
      unread = 0;
      showUnread();
      // The pill hides at the end: a keyboard user keeps the focus in the log.
      if (latest.contains(doc.activeElement) || doc.activeElement === doc.body) el.focus({ preventScroll: true });
    }
  };
  el.addEventListener('click', onClick, { signal });

  let watcher = null;
  const auto = earlierButton();
  if (auto?.getAttribute('data-ds-transcript-earlier') === 'auto' && typeof view.IntersectionObserver === 'function') {
    watcher = new view.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadEarlier();
    }, { root: el });
    watcher.observe(auto);
  }

  record();

  return {
    get() {
      return { atEnd: atEnd(), unread };
    },
    set(value = {}) {
      if ('more' in value) showMore(value.more !== false);
    },
    stick() {
      unread = 0;
      showUnread();
      follow.stick();
    },
    loaded,
    on(type, fn) {
      if (!EVENTS.has(type) || typeof fn !== 'function') return () => {};
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      listeners.clear();
      mutations.disconnect();
      sizes?.disconnect();
      watcher?.disconnect();
      if (frame) view.cancelAnimationFrame(frame);
      pending?.resolve();
      pending = null;
      follow.destroy();
      for (const step of cleanups.reverse()) step();
    },
  };
}

/** The controller of each transcript, so create() and the attribute path share one. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

function controllerOf(el) {
  const held = controllers.get(el);
  if (held) return held;
  const handle = controller(el);
  const destroy = handle.destroy;
  handle.destroy = () => {
    if (controllers.get(el) === handle) controllers.delete(el);
    destroy();
  };
  controllers.set(el, handle);
  return handle;
}

define('transcript', {
  attribute: 'data-ds-transcript',
  init(el) {
    return controllerOf(el);
  },
});

/**
 * The controller of a transcript driven from the page: the same one the
 * attribute path makes (one per element).
 * @param {Element} el
 */
export function create(el) {
  return controllerOf(el);
}
