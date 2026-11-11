/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Load more and infinite scroll (DS.loadmore): the end of a list that grows
 * by pages. A "Load more" button, and with data-ds-loadmore-auto the element
 * is also the sentinel of an infinite scroll (an IntersectionObserver): when
 * it scrolls into view the next page loads by itself, up to the number of
 * times the attribute names (empty: no limit), then only the button does,
 * so a footer below the list stays reachable. loadmore.css has the markup.
 *
 *   <div class="ds-loadmore" data-ds-loadmore data-ds-loadmore-for="#devices"
 *        data-ds-loadmore-loaded="50" data-ds-loadmore-total="1234" data-ds-loadmore-auto="3"> ... </div>
 *
 *   el.addEventListener('ds:loadmore', (event) => event.detail.respond(
 *     api.next().then((rows) => { render(rows); return { loaded: shown.length, total }; })));
 *   const more = DS.loadmore.create(el, { load: ({ loaded }) => fetchPage(loaded) });   // the same, imperative
 *   more.reset({ loaded: 50, total: 80 });   // a new query: back to the start
 *
 * Options, as data-ds-loadmore-<option> or create()'s options: loaded and
 * total (the counts; total unknown: leave it out), auto (an infinite
 * scroll, at most that many automatic loads), for (a selector of the list:
 * aria-busy while it loads, and where focus goes with focus "new"), focus
 * ("new": after a load from the button, focus moves to the first new item;
 * default it stays on the button), root (a selector of the scroller the
 * sentinel watches; default the nearest scrolling ancestor, else the
 * viewport), margin (the observer's rootMargin, default "0px 0px 25% 0px":
 * a load starts a little before the end shows), load (create() only: a
 * function that loads the next page and returns, or resolves to,
 * { loaded, total, done } or the number of items it added) and status
 * (create() only: a function of { loaded, total, state } that returns the
 * status text).
 *
 * One load at a time. A load sends ds:loadmore ({ loaded, total, auto,
 * respond(promise) }) on .ds-loadmore, unless create() has `load`: the page
 * hands its promise to respond(), or calls set({ loaded, total, done }) when
 * the page arrived and set({ error: true }) when it failed. While it loads:
 * data-state="loading", the button's busy face (DS.motion.busy(), after
 * --ds-delay-loader) and aria-busy on the list. After it: the status
 * ("Showing 100 of 1,234"), an announcement ("Loaded 50 more. Showing 100 of
 * 1,234."), data-state="done" once everything shows (the button goes; its
 * focus goes to the status). A failure: data-state="error", the status says
 * so, the button says "Try again", and the infinite scroll waits for a
 * press. Strings: loadMoreStatus, loadMoreStatusOpen, loadMoreDone,
 * loadMoreLoaded, loadMoreLoading, loadMoreFailed and tryAgain of
 * DS.core.config().
 *
 * ES2022. No progressive feature (IntersectionObserver is at the floor);
 * without it the button loads.
 */
import { define, emit, get as controllerOf, t } from './core.js';
import { busy, setLabel } from './motion.js';
import { own, disown } from './dom.js';
import { announce, canTakeFocus } from './a11y.js';
import { number } from './format.js';

/** The option attributes (a change calls update()). */
const OPTIONS = ['loaded', 'total', 'auto', 'for', 'focus', 'root', 'margin'];

/** The controllers create() made, so the attribute path takes over the same one. */
const built = new WeakMap();

/** Per element, how create() hands its options (load, status) to a controller that exists already. */
const configurers = new WeakMap();

/** A count from an attribute or an option: a whole number, else null. */
function count(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function readOptions(el) {
  const attr = (name) => el.getAttribute(`data-ds-loadmore-${name}`);
  const auto = attr('auto');
  return {
    loaded: count(attr('loaded')),
    total: count(attr('total')),
    // Present and empty: no limit; absent: no infinite scroll.
    auto: auto == null ? 0 : auto === '' ? Infinity : count(auto) ?? Infinity,
    for: attr('for'),
    focus: attr('focus'),
    root: attr('root'),
    margin: attr('margin'),
  };
}

/** The nearest ancestor that scrolls on the block axis, else null (the viewport). */
function scrollerOf(el) {
  const view = el.ownerDocument?.defaultView;
  for (let node = el.parentElement; node && node !== el.ownerDocument.body && node !== el.ownerDocument.documentElement; node = node.parentElement) {
    const overflow = view?.getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return node;
  }
  return null;
}

/**
 * The status text of a state: "Showing 50 of 1,234", "Showing 50" without a
 * total, "All 1,234 shown" when done, the failure in words.
 * @param {{ loaded: number|null, total: number|null, state: string }} state
 * @returns {string}
 */
export function statusText(state) {
  if (state.state === 'error') return t('loadMoreFailed');
  if (state.loaded == null) return '';
  const loaded = number(state.loaded);
  if (state.state === 'done') return t('loadMoreDone', { total: number(state.total ?? state.loaded) });
  return state.total == null ? t('loadMoreStatusOpen', { loaded }) : t('loadMoreStatus', { loaded, total: number(state.total) });
}

function controller(el, given, signal) {
  const listeners = new Map();
  const doc = el.ownerDocument;
  let options = { ...readOptions(el), ...given };
  /** @type {{ loaded: number|null, total: number|null, state: 'idle'|'loading'|'error'|'done', autoLoads: number }} */
  const state = { loaded: options.loaded ?? null, total: options.total ?? null, state: 'idle', autoLoads: 0 };
  const button = /** @type {HTMLElement|null} */ (el.querySelector('.ds-loadmore__button'));
  const label = button ? (button.querySelector('.ds-btn__face:not(.ds-btn__face--busy, .ds-btn__face--done, .ds-btn__face--failed)') ?? button).textContent.replace(/\s+/g, ' ').trim() : '';
  /** The running load: its settle functions, and what started it. */
  let pending = null;
  /** Counts the loads and resets: a load whose number is no longer current (reset() came) leaves no trace. */
  let generation = 0;
  /** The button's busy face while it is held (it outlives a load that reset() ended), settled either way. */
  let face = null;
  let observer = null;

  const listOf = () => (options.for ? doc.querySelector(options.for) : null);
  const tell = (type, detail) => (listeners.get(type) ?? new Set()).forEach((fn) => fn(detail));
  const snapshot = () => ({ loaded: state.loaded, total: state.total, state: state.state });
  /** The status in the page's words when create() has `status`; the announcement says the same. */
  const words = () => (typeof options.status === 'function' ? String(options.status(snapshot()) ?? '') : statusText(snapshot()));

  const paint = () => {
    if (state.state === 'idle') el.removeAttribute('data-state');
    else el.setAttribute('data-state', state.state);
    const text = el.querySelector('.ds-loadmore__text') ?? el.querySelector('.ds-loadmore__status');
    if (text) {
      const said = words();
      if (text.textContent !== said) text.textContent = said;
    }
  };

  /** The button that went (done) leaves no focus on nothing: the status takes it. */
  const keepFocus = (had) => {
    if (!button || !(had || doc.activeElement === button)) return;
    const status = /** @type {HTMLElement|null} */ (el.querySelector('.ds-loadmore__status'));
    if (!status) return;
    if (!status.hasAttribute('tabindex')) {
      own(status, 'attrs', 'tabindex');
      status.setAttribute('tabindex', '-1');
    }
    status.focus({ preventScroll: true });
  };

  /** Focus to the first new item of the list (focus "new"). */
  const focusNew = (before) => {
    const list = listOf();
    const first = list?.children[before];
    if (!first) return;
    const target = /** @type {HTMLElement|null} */ ([first, ...first.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].find((node) => canTakeFocus(node) && node.getAttribute('tabindex') !== '-1' && (node !== first || node.tabIndex >= 0)) ?? null);
    if (target) {
      target.focus();
      return;
    }
    own(first, 'attrs', 'tabindex');
    first.setAttribute('tabindex', '-1');
    /** @type {HTMLElement} */ (first).focus();
  };

  const busyList = (on) => {
    const list = listOf();
    if (!list) return;
    if (on) {
      own(list, 'attrs', 'aria-busy');
      list.setAttribute('aria-busy', 'true');
    } else {
      list.removeAttribute('aria-busy');
      disown(list, 'attrs', 'aria-busy');
    }
  };

  /** Takes the result of a load: counts, done, or the number it added. */
  const settle = (result, previous) => {
    if (typeof result === 'number') state.loaded = (previous ?? 0) + result;
    else if (result && typeof result === 'object') {
      if (count(result.loaded) != null) state.loaded = count(result.loaded);
      else if (count(result.added) != null) state.loaded = (previous ?? 0) + count(result.added);
      if ('total' in result) state.total = count(result.total);
    }
    const done = Boolean(result?.done) || (state.total != null && state.loaded != null && state.loaded >= state.total);
    state.state = done ? 'done' : 'idle';
  };

  /** Starts a load (from the button, the sentinel or load()); one at a time. */
  const start = (from) => {
    if (signal?.aborted || state.state === 'loading' || state.state === 'done') return Promise.resolve(snapshot());
    if (from === 'auto' && (state.state === 'error' || state.autoLoads >= options.auto)) return Promise.resolve(snapshot());
    if (from === 'auto') state.autoLoads += 1;
    const mine = ++generation;
    const previous = state.loaded;
    const before = listOf()?.children.length ?? 0;
    const focusWasOnButton = button != null && doc.activeElement === button;
    state.state = 'loading';
    paint();
    busyList(true);
    if (from === 'auto') announce(t('loadMoreLoading'));
    let resolve;
    let reject;
    const work = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pending = { resolve, reject };
    const respond = (promise) => Promise.resolve(promise).then(resolve, reject);
    if (typeof options.load === 'function') {
      try {
        respond(options.load({ loaded: state.loaded, total: state.total, auto: from === 'auto' }));
      } catch (error) {
        reject(error);
      }
    } else {
      emit(el, 'loadmore', { loaded: previous, total: state.total, auto: from === 'auto', respond });
    }
    // The busy face is only the button's look: the result comes from `work`
    // itself. A face still held by a load that reset() ended (busy() would
    // hand back that run) finishes first, then this load takes the button.
    let look = work;
    if (button) {
      const held = face;
      const BUSY = { done: false, failed: false };
      look = held ? held.then(() => busy(button, work, BUSY)) : busy(button, work, BUSY);
      const settled = look.then(() => {}, () => {});
      face = settled;
      settled.then(() => {
        if (face === settled) face = null;
      });
    }
    const stale = () => mine !== generation;
    return look.then(() => work, () => work).then(
      (result) => {
        if (stale()) return snapshot();
        pending = null;
        busyList(false);
        if (signal?.aborted) return snapshot();
        settle(result, previous);
        if (button && state.state !== 'error') setLabel(button, label);
        paint();
        const added = (state.loaded ?? 0) - (previous ?? 0);
        announce([added > 0 ? t('loadMoreLoaded', { count: number(added) }) : '', words()].filter(Boolean).join(' '));
        if (state.state === 'done') keepFocus(focusWasOnButton);
        else if (focusWasOnButton && from !== 'auto' && options.focus === 'new') focusNew(before);
        const told = { ...snapshot(), added };
        emit(el, 'loaded', told);
        tell('change', told);
        if (state.state === 'idle') recheck();
        return snapshot();
      },
      (error) => {
        if (stale()) return snapshot();
        pending = null;
        busyList(false);
        if (signal?.aborted) return snapshot();
        state.state = 'error';
        if (button) setLabel(button, t('tryAgain'));
        paint();
        announce(t('loadMoreFailed'));
        tell('change', { ...snapshot(), error });
        return snapshot();
      },
    );
  };

  /** Watches the sentinel again: one that still shows after a load loads on. */
  const recheck = () => {
    if (!observer) return;
    observer.unobserve(el);
    observer.observe(el);
  };

  const watch = () => {
    observer?.disconnect();
    observer = null;
    const View = doc.defaultView;
    if (!options.auto || typeof View?.IntersectionObserver !== 'function') return;
    const root = options.root ? doc.querySelector(options.root) : scrollerOf(el);
    observer = new View.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) start('auto');
    }, { root, rootMargin: options.margin || '0px 0px 25% 0px' });
    observer.observe(el);
  };

  button?.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    start('button');
  }, { signal });
  doc.addEventListener('ds:config', paint, { signal });
  signal?.addEventListener('abort', () => observer?.disconnect());

  if (state.total != null && state.loaded != null && state.loaded >= state.total) state.state = 'done';
  paint();
  watch();
  configurers.set(el, (more) => {
    given = { ...given, ...more };
    options = { ...options, ...given };
    paint();
    watch();
  });

  return {
    get: snapshot,
    set(value = {}) {
      if (value.error) {
        if (pending) pending.reject(value.error);
        return;
      }
      if (pending) {
        pending.resolve(value);
        return;
      }
      settle(value, state.loaded);
      paint();
    },
    load() {
      return start('api');
    },
    reset(value = {}) {
      // The running load ends here: its answer, whenever it comes, is ignored.
      generation += 1;
      if (pending) {
        pending.resolve({});
        pending = null;
        busyList(false);
      }
      state.loaded = count(value.loaded) ?? null;
      state.total = 'total' in value ? count(value.total) : state.total;
      state.autoLoads = 0;
      state.state = state.total != null && state.loaded != null && state.loaded >= state.total ? 'done' : 'idle';
      if (button) setLabel(button, label);
      paint();
      recheck();
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    update() {
      options = { ...options, ...readOptions(el), ...given };
      paint();
      watch();
    },
    destroy() {
      observer?.disconnect();
      observer = null;
      listeners.clear();
      configurers.delete(el);
      if (pending) busyList(false);
    },
  };
}

define('loadmore', {
  attribute: 'data-ds-loadmore',
  attributes: OPTIONS.map((name) => `data-ds-loadmore-${name}`),
  init(el, ctx) {
    return built.get(el) ?? controller(el, {}, ctx.signal);
  },
});

/**
 * A load-more control driven from the page; the same controller
 * data-ds-loadmore makes (an element that has one returns it, without the
 * options).
 * @param {Element} el  the .ds-loadmore element
 * @param {object} [options]  as the attributes, plus load and status
 */
export function create(el, options = {}) {
  const existing = controllerOf(el, 'loadmore') ?? built.get(el);
  if (existing) {
    if (Object.keys(options).length) configurers.get(el)?.(options);
    return /** @type {any} */ (existing);
  }
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const made = controller(el, options, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
    built.delete(el);
  };
  built.set(el, made);
  return made;
}
