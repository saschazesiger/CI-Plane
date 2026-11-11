/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The loading overlay (DS.loadingoverlay): blocks one region of the page
 * while work on it runs, with a spinner and a message.
 *
 *   <div class="ds-loadingoverlay" hidden data-ds-loadingoverlay> ... </div>   (inside the region)
 *
 *   const veil = DS.loadingoverlay.show(card, { message: 'Saving ...' });   // builds it when the region has none
 *   await DS.loadingoverlay.wait(card, api.save(), { message: 'Saving ...', done: 'Saved' });
 *   DS.loadingoverlay.hide(card);
 *   DS.loadingoverlay.create(overlay)   // get(), set(), wait(), on(), destroy()
 *
 * While it shows: the region's other children are inert (DS.a11y.inert),
 * the region carries aria-busy="true", focus that was inside the region
 * moves to the overlay's cancel button (else its box), and the message is
 * said politely once the overlay became visible (after --ds-delay-loader,
 * the CSS delay). Hiding waits until it has been visible for
 * --ds-hold-loader (DS.motion.loaderHoldMs), so it never flashes, then
 * plays the exit, sets `hidden`, gives everything back and returns focus
 * to where it was (when it is still there and focus is in the overlay).
 * `done` says a last word as it goes ("Saved").
 *
 * A [data-ds-loadingoverlay-cancel] button (or Escape while focus is in the
 * overlay and it has one) sends a cancelable ds:cancel on the overlay; not
 * cancelled, the overlay hides. ds:show and ds:hide follow each change.
 *
 * What it writes (data-state, hidden, the region's aria-busy and the
 * position it may need) is owned (DS.dom.own), so a re-render keeps it.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { loaderHoldMs, motionDuration, settled } from './motion.js';
import { own, disown } from './dom.js';
import { announce, inert } from './a11y.js';

/** The controller of each overlay element. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

const viewOf = (element) => element.ownerDocument?.defaultView ?? globalThis;
const clock = () => Date.now();

/**
 * How long a hide waits so a visible overlay stays for --ds-hold-loader:
 * DS.motion.loaderHoldMs() with this overlay's tokens.
 * @param {number} shownAt  when show() ran (Date.now())
 * @param {number} now
 * @param {{ delay: number, minVisible: number }} timing
 * @returns {number} ms
 */
export function holdMs(shownAt, now, timing) {
  return loaderHoldMs(shownAt, now, { delay: timing.delay, minVisible: timing.minVisible });
}

/** The overlay of a region: its own child .ds-loadingoverlay, or null. */
function overlayIn(region) {
  return [...region.children].find((child) => child.matches('.ds-loadingoverlay')) ?? null;
}

/** Builds an overlay in `region` with DOM APIs (no HTML strings). */
function build(region, options) {
  const doc = region.ownerDocument;
  const overlay = doc.createElement('div');
  overlay.className = 'ds-loadingoverlay';
  overlay.hidden = true;
  const box = doc.createElement('div');
  box.className = 'ds-loadingoverlay__box';
  box.setAttribute('role', 'status');
  const spinner = doc.createElement('span');
  spinner.className = 'ds-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const message = doc.createElement('p');
  message.className = 'ds-loadingoverlay__message';
  const detail = doc.createElement('p');
  detail.className = 'ds-loadingoverlay__detail';
  box.append(spinner, message, detail);
  if (options.cancel) {
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ds-btn ds-btn--text';
    cancel.setAttribute('data-ds-loadingoverlay-cancel', '');
    cancel.textContent = typeof options.cancel === 'string' ? options.cancel : t('cancel');
    box.append(cancel);
  }
  overlay.append(box);
  region.append(overlay);
  return overlay;
}

/**
 * The controller of an overlay element (the one [data-ds-loadingoverlay]
 * makes; once per element): get() returns { shown, message, detail };
 * set(true|false) shows or hides it, set({ shown, message, detail,
 * progress, done }) changes any of them (a new message while it shows is
 * said again); wait(promise, options) shows it until the promise settles
 * and returns the promise; on('show'|'hide'|'cancel', fn); destroy().
 * @param {Element} element  the .ds-loadingoverlay
 */
export function create(element) {
  const known = controllers.get(element);
  if (known) return known;
  const region = element.parentElement;
  const abort = new AbortController();
  const signal = abort.signal;
  const listeners = [];
  const state = {
    shown: false,
    shownAt: 0,
    gen: 0,
    hold: /** @type {{ destroy(): void }|null} */ (null),
    returnTo: /** @type {HTMLElement|null} */ (null),
    timer: 0,
    positioned: false,
  };
  const box = element.querySelector('.ds-loadingoverlay__box') ?? element;
  const messageOf = () => element.querySelector('.ds-loadingoverlay__message');
  const detailOf = () => element.querySelector('.ds-loadingoverlay__detail');
  for (const [kind, name] of [['attrs', 'data-state'], ['attrs', 'hidden']]) own(element, kind, name);

  const say = () => {
    const text = [messageOf()?.textContent, detailOf()?.textContent].map((part) => part?.trim()).filter(Boolean).join(' ');
    announce(text || t('loading'));
  };

  const write = (/** @type {{ message?: string, detail?: string, progress?: number }} */ options) => {
    if (typeof options.message === 'string') {
      const node = messageOf();
      if (node) node.textContent = options.message;
    }
    if (typeof options.detail === 'string') {
      const node = detailOf();
      if (node) node.textContent = options.detail;
    }
    if (typeof options.progress === 'number') {
      const ring = element.querySelector('.ds-spinner--determinate');
      const share = Math.min(1, Math.max(0, options.progress));
      if (ring) {
        /** @type {HTMLElement} */ (ring).style.setProperty('--ds-progress', String(share));
        ring.setAttribute('aria-valuenow', String(Math.round(share * 100)));
      }
    }
  };

  const show = (/** @type {{ message?: string, detail?: string, progress?: number }} */ options = {}) => {
    write(options);
    if (state.shown) {
      if (typeof options.message === 'string' && element.getAttribute('data-state') === 'open') say();
      return;
    }
    state.shown = true;
    state.gen += 1;
    state.shownAt = clock();
    if (region) {
      own(region, 'attrs', 'aria-busy');
      region.setAttribute('aria-busy', 'true');
      const view = viewOf(region);
      if (view.getComputedStyle?.(region).position === 'static') {
        own(region, 'props', 'position');
        /** @type {HTMLElement} */ (region).style.setProperty('position', 'relative');
        state.positioned = true;
      }
      state.hold?.destroy();
      state.hold = inert([...region.children].filter((child) => child !== element));
    }
    /** @type {HTMLElement} */ (element).hidden = false;
    element.setAttribute('data-state', 'closed');
    void viewOf(element).getComputedStyle?.(element).opacity;
    element.setAttribute('data-state', 'open');
    // Focus that was in the region would sit on an inert element now.
    const active = /** @type {HTMLElement|null} */ (element.ownerDocument.activeElement);
    if (region && active && region.contains(active) && !element.contains(active)) {
      state.returnTo = active;
      const cancel = /** @type {HTMLElement|null} */ (element.querySelector('[data-ds-loadingoverlay-cancel]'));
      const target = cancel ?? /** @type {HTMLElement} */ (box);
      if (target === box && !box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
    // Said once it can be seen: a fast load says nothing.
    const gen = state.gen;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (state.gen === gen && state.shown) say();
    }, motionDuration(element, '--ds-delay-loader'));
    emit(element, 'show', { region });
  };

  const hide = (/** @type {{ done?: string }} */ options = {}) => {
    if (!state.shown) return Promise.resolve();
    state.shown = false;
    const gen = ++state.gen;
    clearTimeout(state.timer);
    const wait = holdMs(state.shownAt, clock(), {
      delay: motionDuration(element, '--ds-delay-loader'),
      minVisible: motionDuration(element, '--ds-hold-loader'),
    });
    return new Promise((resolve) => setTimeout(resolve, wait)).then(() => {
      if (state.gen !== gen) return undefined;
      element.setAttribute('data-state', 'closed');
      // The region takes input again at once; the veil fades on its own.
      state.hold?.destroy();
      state.hold = null;
      if (region) {
        region.removeAttribute('aria-busy');
        disown(region, 'attrs', 'aria-busy');
      }
      const active = element.ownerDocument.activeElement;
      const back = state.returnTo;
      state.returnTo = null;
      if (back?.isConnected && (!active || active === element.ownerDocument.body || element.contains(active))) back.focus({ preventScroll: true });
      if (options.done) announce(options.done);
      emit(element, 'hide', { region });
      return settled(element, { transitions: true }).then(() => {
        if (state.gen !== gen) return;
        /** @type {HTMLElement} */ (element).hidden = true;
        element.removeAttribute('data-state');
        if (state.positioned && region) {
          /** @type {HTMLElement} */ (region).style.removeProperty('position');
          disown(region, 'props', 'position');
          state.positioned = false;
        }
      });
    });
  };

  const cancel = () => {
    if (!state.shown) return;
    if (emit(element, 'cancel', { region }, { cancelable: true })) hide();
  };
  element.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    if (/** @type {Element} */ (event.target)?.closest?.('[data-ds-loadingoverlay-cancel]')) cancel();
  }, { signal });
  element.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !element.querySelector('[data-ds-loadingoverlay-cancel]')) return;
    event.preventDefault();
    cancel();
  }, { signal });

  const controller = {
    element,
    get: () => ({
      shown: state.shown,
      message: messageOf()?.textContent ?? '',
      detail: detailOf()?.textContent ?? '',
    }),
    set(/** @type {boolean|{ shown?: boolean, message?: string, detail?: string, progress?: number, done?: string }} */ value) {
      const next = typeof value === 'boolean' ? { shown: value } : value ?? {};
      if (next.shown === false) return hide({ done: next.done });
      if (next.shown === true) show(next);
      else write(next);
      if (next.shown !== true && typeof next.message === 'string' && state.shown && element.getAttribute('data-state') === 'open') say();
      return Promise.resolve();
    },
    wait(/** @type {PromiseLike<any>} */ promise, /** @type {{ message?: string, detail?: string, done?: string }} */ options = {}) {
      show(options);
      return Promise.resolve(promise).then(
        (value) => hide({ done: options.done }).then(() => value),
        (error) => hide().then(() => { throw error; }),
      );
    },
    on(/** @type {string} */ type, /** @type {(event: Event) => void} */ fn) {
      const name = `ds:${type}`;
      element.addEventListener(name, fn);
      const off = () => element.removeEventListener(name, fn);
      listeners.push(off);
      return off;
    },
    destroy() {
      if (controllers.get(element) !== controller) return;
      controllers.delete(element);
      abort.abort();
      clearTimeout(state.timer);
      // A pending hide() resolves without acting.
      state.gen += 1;
      state.hold?.destroy();
      state.hold = null;
      // Showing, or held before a pending hide: give the region back as a hide would, at once.
      if ((state.shown || element.getAttribute('data-state') === 'open') && region) {
        region.removeAttribute('aria-busy');
        disown(region, 'attrs', 'aria-busy');
      }
      if (state.shown || element.hasAttribute('data-state')) {
        /** @type {HTMLElement} */ (element).hidden = true;
        element.removeAttribute('data-state');
      }
      state.shown = false;
      state.returnTo = null;
      if (state.positioned && region) {
        /** @type {HTMLElement} */ (region).style.removeProperty('position');
        disown(region, 'props', 'position');
        state.positioned = false;
      }
      for (const [kind, name] of [['attrs', 'data-state'], ['attrs', 'hidden']]) disown(element, kind, name);
      for (const off of listeners.splice(0)) off();
    },
  };
  controllers.set(element, controller);
  return controller;
}

/**
 * Shows the overlay of `region` (built as its last child when it has
 * none; `cancel`: a cancel button, its label or true for the string
 * `cancel`) with `message`, `detail` or `progress`; returns its controller.
 * @param {Element} region
 * @param {{ message?: string, detail?: string, progress?: number, cancel?: boolean|string }} [options]
 */
export function show(region, options = {}) {
  const element = overlayIn(region) ?? build(region, options);
  const controller = create(element);
  controller.set({ ...options, shown: true });
  return controller;
}

/**
 * Hides the overlay of `region` (after --ds-hold-loader when it showed;
 * `done` is said as it goes). Resolves once it is hidden.
 * @param {Element} region
 * @param {{ done?: string }} [options]
 * @returns {Promise<void>}
 */
export function hide(region, options = {}) {
  const element = overlayIn(region);
  if (!element) return Promise.resolve();
  return create(element).set({ shown: false, done: options.done });
}

/**
 * Shows the overlay of `region` until `promise` settles; resolves or
 * rejects with it, once the overlay is hidden.
 * @template T
 * @param {Element} region
 * @param {PromiseLike<T>|T} promise
 * @param {{ message?: string, detail?: string, done?: string, cancel?: boolean|string }} [options]
 * @returns {Promise<T>}
 */
export function wait(region, promise, options = {}) {
  const element = overlayIn(region) ?? build(region, options);
  return create(element).wait(promise, options);
}

define('loadingoverlay', {
  attribute: 'data-ds-loadingoverlay',
  init: (element) => create(element),
});
