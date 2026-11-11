/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Image (DS.image): the state of a picture in its frame, a second source
 * and the fallback where it fails.
 *
 *   <span class="ds-image__frame" data-ds-image data-ds-image-fallback="placeholder.svg"><img src="..." alt="..."></span>
 *   const image = DS.image.create(frame);   image.set('printer-8.jpg');
 *
 * data-state on the frame: "loading" until the picture is there, then
 * "loaded"; "error" once it failed. A picture complete at the start (from
 * the cache) is "loaded" at once, so it never fades in again. A failed
 * picture tries data-ds-image-fallback (another source) once, then the
 * frame shows .ds-image__fallback: the page's own, else one written here,
 * with the image glyph and the alt text (only the glyph, hidden, for a
 * decorative picture with alt=""). A new src or srcset (set(), a re-render
 * with DS.dom.morphHtml) starts again from "loading".
 *
 * The controller: get() gives { state, src }, set(src) loads another
 * picture, on('change', fn) runs with { state, src } on every state,
 * update() reads the picture again, destroy() takes data-state and the
 * written fallback away. Events: ds:change ({ state, src }) when it is
 * loaded or failed.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit } from './core.js';
import { own, disown } from './dom.js';
import { image as glyph, iconElement } from './icons.js';

function controller(el, given) {
  const doc = el.ownerDocument;
  const view = doc?.defaultView ?? globalThis;
  const listeners = new Set();
  let live = true;
  let state = '';
  let triedFallback = false;
  /** The fallback this module wrote, if any. */
  let written = null;
  own(el, 'attrs', 'data-state');

  const img = () => el.querySelector(':scope > img');
  const source = () => img()?.currentSrc || img()?.getAttribute('src') || '';

  const fallback = () => {
    let part = el.querySelector(':scope > .ds-image__fallback');
    const alt = img()?.getAttribute('alt') ?? '';
    if (!part) {
      part = doc.createElement('span');
      part.className = 'ds-image__fallback';
      part.append(iconElement(glyph, 24, undefined, doc));
      const words = doc.createElement('span');
      part.append(words);
      written = part;
      el.append(part);
    }
    if (part === written) {
      part.lastElementChild.textContent = alt;
      if (alt) part.removeAttribute('aria-hidden');
      else part.setAttribute('aria-hidden', 'true');
    }
  };

  const to = (next) => {
    if (next === state) return;
    state = next;
    el.setAttribute('data-state', state);
    if (state === 'error') fallback();
    const detail = { state, src: source() };
    if (state !== 'loading') emit(el, 'change', detail);
    for (const fn of [...listeners]) fn(detail);
  };

  const check = () => {
    const picture = img();
    if (!picture) return;
    if (!picture.complete) to('loading');
    else if (picture.naturalWidth > 0) to('loaded');
    else if (picture.getAttribute('src') || picture.getAttribute('srcset')) failed();
  };

  const failed = () => {
    const other = given.fallback ?? el.getAttribute('data-ds-image-fallback');
    const picture = img();
    if (other && !triedFallback && picture) {
      triedFallback = true;
      to('loading');
      picture.removeAttribute('srcset');
      picture.setAttribute('src', other);
      // Our own change: not a new picture.
      watcher?.takeRecords();
      return;
    }
    to('error');
  };

  const onLoad = (event) => {
    if (event.target === img()) to('loaded');
  };
  const onError = (event) => {
    if (event.target === img()) failed();
  };
  // Load and error do not bubble: caught on their way down.
  el.addEventListener('load', onLoad, true);
  el.addEventListener('error', onError, true);

  const watcher = typeof view.MutationObserver === 'function' ? new view.MutationObserver((records) => {
    if (!live) return;
    // A new picture (src, srcset or the <img> itself): from the start.
    const picture = img();
    if (records.some((record) => record.target === picture || [...record.addedNodes].includes(picture))) {
      triedFallback = false;
      state = '';
      check();
    }
  }) : null;
  watcher?.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });

  if (given.src) img()?.setAttribute('src', given.src);
  check();
  watcher?.takeRecords();

  return {
    get() {
      return { state, src: source() };
    },
    set(src) {
      const picture = img();
      if (!picture || !live) return;
      triedFallback = false;
      picture.removeAttribute('srcset');
      picture.setAttribute('src', String(src ?? ''));
      watcher?.takeRecords();
      state = '';
      check();
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      state = '';
      check();
    },
    destroy() {
      if (!live) return;
      live = false;
      watcher?.disconnect();
      el.removeEventListener('load', onLoad, true);
      el.removeEventListener('error', onError, true);
      listeners.clear();
      el.removeAttribute('data-state');
      disown(el, 'attrs', 'data-state');
      written?.remove();
    },
  };
}

define('image', {
  attribute: 'data-ds-image',
  init(el) {
    return controller(el, {});
  },
});

/**
 * A picture driven from the page; the same controller the attribute path makes.
 * @param {Element} el the .ds-image__frame
 * @param {{ src?: string, fallback?: string }} [options]
 */
export function create(el, options = {}) {
  return controller(el, options);
}
