/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The lightbox (DS.lightbox): the images of a gallery one at a time over the
 * whole window, with thumbnails, keys, zoom and pan, a caption and swipe on
 * touch. The viewer is a modal dialog that DS.overlay opens and closes (the
 * trap, inert page, scroll lock, Escape and focus return are the core's).
 *
 *   <ul class="ds-lightbox__gallery" aria-label="Photos" data-ds-lightbox>
 *     <li><a class="ds-lightbox__item" href="lid.jpg" data-caption="The lid"><img src="lid-s.jpg" alt="The lid"></a></li>
 *   </ul>
 *
 *   const box = DS.lightbox.create(gallery);    // get(), set(), open(), close(), next(), prev(), on(), destroy()
 *   DS.lightbox.open(gallery, { index: 2, opener });
 *   DS.lightbox.show([{ src, alt, caption, thumb }], { label, opener });   // without a gallery in the page
 *
 * The images: every .ds-lightbox__item (or [data-ds-lightbox-item]) of the
 * gallery, read when it opens: its href or data-src (the full image), its
 * data-caption, the alt of its <img> (else its aria-label) and that <img>'s
 * src as the thumbnail. A click on an item opens the viewer there, with the
 * item as the opener.
 *
 * Keys in the viewer: ArrowLeft and ArrowRight the previous and the next
 * image (wrapping; zoomed, they pan), ArrowUp and ArrowDown pan a zoomed
 * image, Home and End the first and the last, + (or =) and - zoom, 0 back to
 * the fit, Escape first back to the fit, then closed (DS.overlay). In the
 * row of thumbnails the arrow keys move between them (DS.a11y.roving) and
 * show the image at once. A change says "Image 3 of 6" and the caption
 * (else the alt) politely.
 *
 * Pointer: a double click (a double tap) zooms to 2 at that point and back;
 * Ctrl and the wheel (a trackpad pinch) and two fingers zoom; a zoomed
 * image pans with a drag (it follows the pointer); unzoomed, a horizontal
 * swipe of a finger follows it and goes to the next or the previous image
 * past a fifth of the frame (else it glides back).
 *
 * Zoom: 1 (the fit), 2 and 4 by the buttons and keys, up to MAX_ZOOM by a
 * pinch. The pan is clamped so the image always covers the frame
 * (clampPan()). --ds-lightbox-zoom, --ds-lightbox-x and --ds-lightbox-y are
 * runtime properties on the frame.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { enter, motionDuration } from './motion.js';
import { chevronLeft, chevronRight, close as closeIcon, alertCircle, minimize, plus, iconElement } from './icons.js';
import { open as openOverlay, close as closeOverlay, internals } from './overlay.js';
import { announce, roving } from './a11y.js';

const { overlays } = internals;

/** The largest zoom (a pinch); the buttons and keys step 1, 2, 4. */
export const MAX_ZOOM = 4;

/** The items of a gallery. */
const ITEMS = '.ds-lightbox__item, [data-ds-lightbox-item]';

/**
 * The zoom after a step: `direction` 1 doubles (at most MAX_ZOOM), -1
 * halves (at least 1), 0 is the fit.
 * @param {number} zoom
 * @param {number} direction
 * @returns {number}
 */
export function nextZoom(zoom, direction) {
  if (direction === 0) return 1;
  const next = direction > 0 ? zoom * 2 : zoom / 2;
  return Math.min(MAX_ZOOM, Math.max(1, Math.round(next * 100) / 100));
}

/**
 * The pan within reach: an image of `size` (its fitted width and height,
 * px) scaled by `zoom` in a frame of `frame` moves at most so far that it
 * still covers the frame on that axis, and not at all where it is smaller.
 * @param {number} x
 * @param {number} y
 * @param {{ width: number, height: number }} size
 * @param {{ width: number, height: number }} frame
 * @param {number} zoom
 * @returns {{ x: number, y: number }}
 */
export function clampPan(x, y, size, frame, zoom) {
  const reach = (length, room) => Math.max(0, (length * zoom - room) / 2);
  const rx = reach(size.width, frame.width);
  const ry = reach(size.height, frame.height);
  const clamp = (value, limit) => (limit === 0 ? 0 : Math.round(Math.min(limit, Math.max(-limit, value))));
  return { x: clamp(x, rx), y: clamp(y, ry) };
}

/** The images of a gallery, as the viewer shows them. */
function imagesOf(gallery) {
  return [...gallery.querySelectorAll(ITEMS)].map((item) => {
    const thumb = item.querySelector('img');
    return {
      src: item.getAttribute('data-src') ?? item.getAttribute('href') ?? thumb?.getAttribute('src') ?? '',
      alt: thumb?.getAttribute('alt') || item.getAttribute('aria-label') || '',
      caption: item.getAttribute('data-caption') ?? '',
      thumb: thumb?.getAttribute('src') ?? '',
      item,
    };
  });
}

/** Builds the viewer with DOM APIs inside the theme of `home`. */
function buildViewer(home, label) {
  const doc = home.ownerDocument;
  const make = (tag, className) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  };
  const button = (className, name, glyph) => {
    const node = make('button', `ds-btn ds-btn--ghost ds-btn--icon${className ? ` ${className}` : ''}`);
    node.type = 'button';
    node.setAttribute('aria-label', name);
    node.append(iconElement(glyph, 20, undefined, doc));
    return node;
  };
  const native = typeof make('dialog').showModal === 'function';
  const dialog = make(native ? 'dialog' : 'div', 'ds-dialog ds-lightbox');
  const box = make('div', 'ds-dialog__box ds-lightbox__box');
  if (native) dialog.setAttribute('aria-label', label);
  else {
    dialog.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', label);
  }
  const backdrop = make('div', 'ds-dialog__backdrop');
  backdrop.setAttribute('data-ds-close', '');
  const bar = make('div', 'ds-lightbox__bar');
  const count = make('p', 'ds-lightbox__count');
  const zoomOut = button('', t('zoomOut'), minimize);
  const zoomIn = button('', t('zoomIn'), plus);
  const closer = button('', t('close'), closeIcon);
  closer.setAttribute('data-ds-close', '');
  bar.append(count, zoomOut, zoomIn, closer);
  const stage = make('div', 'ds-lightbox__stage');
  const prev = button('ds-lightbox__nav ds-lightbox__nav--prev', t('previous'), chevronLeft);
  const next = button('ds-lightbox__nav ds-lightbox__nav--next', t('next'), chevronRight);
  // The first focus: Next (where the keys lead on); with one image Close (show() moves it).
  const figure = make('figure', 'ds-lightbox__figure');
  const frame = make('div', 'ds-lightbox__frame');
  const image = /** @type {HTMLImageElement} */ (make('img', 'ds-lightbox__image'));
  image.draggable = false;
  image.decoding = 'async';
  const spinner = make('span', 'ds-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const error = make('p', 'ds-lightbox__error');
  error.append(iconElement(alertCircle, 20, undefined, doc), doc.createTextNode(t('imageFailed')));
  frame.append(image, spinner, error);
  const caption = make('figcaption', 'ds-lightbox__caption');
  figure.append(frame, caption);
  stage.append(prev, figure, next);
  const thumbs = make('div', 'ds-lightbox__thumbs');
  thumbs.setAttribute('role', 'group');
  thumbs.setAttribute('aria-label', t('images'));
  box.append(bar, stage, thumbs);
  dialog.append(backdrop, box);
  const theme = home.closest('.ds-theme');
  const parent = !theme || theme === doc.documentElement ? doc.body : theme;
  parent.append(dialog);
  return { dialog, box, count, zoomIn, zoomOut, closer, prev, next, figure, frame, image, caption, thumbs };
}

/** The properties of the option classes the viewer takes from the gallery's region; it has no tone. */
const OPTIONS = ['--ds-size-step', '--ds-size-font', '--ds-density', '--ds-shape', '--ds-target-min'];

/**
 * The viewer sits at the .ds-theme, outside the containers of the gallery,
 * so an option class on one of them (.ds-touch, .ds-density-*, .ds-sm ...)
 * would not reach it: at each open it takes the values `home` has where
 * they differ from those it inherits.
 */
function carryOptions(home, dialog) {
  const view = dialog.ownerDocument.defaultView;
  if (!view?.getComputedStyle || !home?.isConnected || !dialog.style) return;
  for (const name of OPTIONS) dialog.style.removeProperty(name);
  const there = view.getComputedStyle(dialog);
  const inherited = OPTIONS.map((name) => there.getPropertyValue(name).trim());
  const here = view.getComputedStyle(home);
  OPTIONS.forEach((name, index) => {
    const value = here.getPropertyValue(name).trim();
    if (value && value !== inherited[index]) dialog.style.setProperty(name, value);
  });
}

/** The controller of each gallery (or show() list). @type {WeakMap<object, any>} */
const controllers = new WeakMap();

/**
 * The controller of a gallery, the one [data-ds-lightbox] makes; once per
 * gallery. get() returns { open, index, total, zoom }; set(index) or
 * set({ index, zoom }); open(index, opener) and close(); next() and prev();
 * on(type, fn) hears ds:open, ds:close, ds:change ({ index, total }) and
 * ds:zoom ({ zoom }); destroy() removes the viewer.
 * `images` (a function returning the list) replaces the gallery's items;
 * `label` names the viewer (else the gallery's aria-label, else the string
 * `images`).
 * @param {Element} gallery
 * `home` is where the viewer finds its theme (else the gallery).
 * @param {{ images?: () => Array<{ src: string, alt?: string, caption?: string, thumb?: string }>, label?: string, home?: Element }} [options]
 */
export function create(gallery, options = {}) {
  const known = controllers.get(gallery);
  if (known) return known;
  const abort = new AbortController();
  const signal = abort.signal;
  const listeners = [];
  const list = () => (typeof options.images === 'function' ? options.images() : imagesOf(gallery));
  const state = { index: 0, zoom: 1, x: 0, y: 0, images: /** @type {any[]} */ ([]), viewer: /** @type {any} */ (null), rover: /** @type {any} */ (null), pointers: new Map(), gesture: /** @type {any} */ (null), lastTap: 0 };

  const homeOf = () => options.home ?? (gallery.isConnected ? gallery : gallery.ownerDocument?.body ?? globalThis.document.body);
  const viewer = () => {
    if (state.viewer?.dialog.isConnected) return state.viewer;
    const label = options.label ?? gallery.getAttribute?.('aria-label') ?? t('images');
    state.viewer = buildViewer(homeOf(), label);
    wireViewer(state.viewer);
    return state.viewer;
  };

  const isOpen = () => Boolean(state.viewer) && overlays.get(state.viewer.dialog)?.phase === 'open';

  /** The frame's size and the image's fitted size. */
  const measure = () => {
    const { frame, image } = state.viewer;
    const box = frame.getBoundingClientRect();
    // The fitted size: the layout box, which the zoom's scale does not change.
    return { frame: { width: box.width, height: box.height }, size: { width: image.offsetWidth, height: image.offsetHeight } };
  };

  const paintTransform = () => {
    const { frame } = state.viewer;
    frame.style.setProperty('--ds-lightbox-zoom', String(state.zoom));
    frame.style.setProperty('--ds-lightbox-x', `${state.x}px`);
    frame.style.setProperty('--ds-lightbox-y', `${state.y}px`);
    if (state.zoom > 1) frame.setAttribute('data-zoomed', '');
    else frame.removeAttribute('data-zoomed');
    // aria-disabled, not disabled: a button that took the last step keeps its focus (and the keys).
    state.viewer.zoomOut.setAttribute('aria-disabled', String(state.zoom <= 1));
    state.viewer.zoomIn.setAttribute('aria-disabled', String(state.zoom >= MAX_ZOOM));
  };

  /** Zooms to `zoom`, keeping the point (px from the frame's centre) where it is. */
  const zoomTo = (zoom, point = { x: 0, y: 0 }) => {
    if (!state.viewer) return;
    const next = Math.min(MAX_ZOOM, Math.max(1, zoom));
    const ratio = next / state.zoom;
    const x = point.x - (point.x - state.x) * ratio;
    const y = point.y - (point.y - state.y) * ratio;
    const before = state.zoom;
    state.zoom = next;
    const { frame, size } = measure();
    const pan = clampPan(x, y, size, frame, next);
    state.x = pan.x;
    state.y = pan.y;
    paintTransform();
    if (before !== next) emit(gallery, 'zoom', { zoom: next });
  };

  const panBy = (dx, dy) => {
    const { frame, size } = measure();
    const pan = clampPan(state.x + dx, state.y + dy, size, frame, state.zoom);
    state.x = pan.x;
    state.y = pan.y;
    paintTransform();
  };

  const paintThumbs = () => {
    const { thumbs } = state.viewer;
    const doc = thumbs.ownerDocument;
    const total = state.images.length;
    if (total < 2) {
      thumbs.replaceChildren();
      return;
    }
    if (thumbs.children.length !== total) {
      thumbs.replaceChildren(...state.images.map((image, index) => {
        const node = doc.createElement('button');
        node.type = 'button';
        node.className = 'ds-lightbox__thumb';
        node.setAttribute('aria-label', image.alt ? `${t('imageOf', { index: index + 1, total })}: ${image.alt}` : t('imageOf', { index: index + 1, total }));
        const img = doc.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = image.thumb || image.src;
        node.append(img);
        return node;
      }));
    }
    [...thumbs.children].forEach((node, index) => {
      if (index === state.index) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    });
    const current = /** @type {HTMLElement} */ (thumbs.children[state.index]);
    current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  /** Shows image `index`; `say` announces it. */
  const show = (index, say = true) => {
    const v = viewer();
    const total = state.images.length;
    if (!total) return;
    state.index = ((index % total) + total) % total;
    const image = state.images[state.index];
    state.zoom = 1;
    state.x = 0;
    state.y = 0;
    paintTransform();
    v.frame.removeAttribute('data-failed');
    v.frame.setAttribute('data-loading', '');
    v.image.alt = image.alt ?? '';
    const done = () => v.frame.removeAttribute('data-loading');
    v.image.onload = done;
    v.image.onerror = () => {
      done();
      v.frame.setAttribute('data-failed', '');
    };
    if (v.image.getAttribute('src') !== image.src) v.image.src = image.src;
    else if (v.image.complete) done();
    v.caption.textContent = image.caption ?? '';
    v.count.textContent = t('imageOf', { index: state.index + 1, total });
    v.prev.hidden = total < 2;
    v.next.hidden = total < 2;
    // The first focus (DS.overlay takes [autofocus]): Next, else Close, never the Zoom out a fit image disables.
    v.next.toggleAttribute('autofocus', total >= 2);
    v.closer.toggleAttribute('autofocus', total < 2);
    paintThumbs();
    if (say) {
      enter(v.figure, 'swap');
      announce(`${t('imageOf', { index: state.index + 1, total })}. ${image.caption || image.alt || ''}`.trim());
      emit(gallery, 'change', { index: state.index, total });
    }
  };

  /** The viewer's own keys and pointers (once per viewer). */
  function wireViewer(v) {
    v.zoomIn.addEventListener('click', () => {
      if (v.zoomIn.getAttribute('aria-disabled') !== 'true') zoomTo(nextZoom(state.zoom, 1));
    }, { signal });
    v.zoomOut.addEventListener('click', () => {
      if (v.zoomOut.getAttribute('aria-disabled') !== 'true') zoomTo(nextZoom(state.zoom, -1));
    }, { signal });
    v.prev.addEventListener('click', () => show(state.index - 1), { signal });
    v.next.addEventListener('click', () => show(state.index + 1), { signal });
    v.thumbs.addEventListener('click', (event) => {
      const node = /** @type {Element} */ (event.target)?.closest?.('.ds-lightbox__thumb');
      if (node) show([...v.thumbs.children].indexOf(node));
    }, { signal });
    state.rover = roving(v.thumbs, { items: '.ds-lightbox__thumb', orientation: 'horizontal', wrap: true, onActivate: (node) => {
      const index = [...v.thumbs.children].indexOf(node);
      if (index >= 0 && index !== state.index) show(index);
    } });
    v.dialog.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (/** @type {Element} */ (event.target)?.closest?.('.ds-lightbox__thumbs')) return;
      const step = Math.round(v.frame.getBoundingClientRect().width / 10);
      const zoomed = state.zoom > 1;
      const keys = {
        ArrowLeft: () => (zoomed ? panBy(step, 0) : show(state.index - 1)),
        ArrowRight: () => (zoomed ? panBy(-step, 0) : show(state.index + 1)),
        ArrowUp: () => zoomed && panBy(0, step),
        ArrowDown: () => zoomed && panBy(0, -step),
        Home: () => show(0),
        End: () => show(state.images.length - 1),
        '+': () => zoomTo(nextZoom(state.zoom, 1)),
        '=': () => zoomTo(nextZoom(state.zoom, 1)),
        '-': () => zoomTo(nextZoom(state.zoom, -1)),
        0: () => zoomTo(1),
        Escape: () => zoomTo(1),
      };
      const run = keys[event.key];
      if (!run) return;
      // Escape closes (DS.overlay) unless it first takes the zoom back.
      if (event.key === 'Escape' && !zoomed) return;
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !zoomed) return;
      // A button keeps its own Space and Enter; the arrows are the viewer's.
      event.preventDefault();
      run();
    }, { signal });

    // Pointers: double tap or click zooms, a drag pans, a swipe changes, two fingers pinch.
    const frame = v.frame;
    const centre = (event) => {
      const box = frame.getBoundingClientRect();
      return { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 };
    };
    frame.addEventListener('dblclick', (event) => zoomTo(state.zoom > 1 ? 1 : 2, centre(event)), { signal });
    frame.addEventListener('wheel', (/** @type {WheelEvent} */ event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoomTo(state.zoom * Math.exp(-event.deltaY / 200), centre(event));
    }, { signal, passive: false });
    frame.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
      if (event.button !== 0 || state.images.length === 0) return;
      try {
        frame.setPointerCapture?.(event.pointerId);
      } catch {
        // A pointer the engine no longer tracks: the gesture runs without capture.
      }
      state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      // A third finger joins the pinch of the first two without a gesture of its own.
      if (state.pointers.size > 2) return;
      if (state.pointers.size === 2) {
        const [a, b] = [...state.pointers.values()];
        state.gesture = { kind: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: state.zoom };
        return;
      }
      state.gesture = { kind: state.zoom > 1 ? 'pan' : 'swipe', start: { x: event.clientX, y: event.clientY }, from: { x: state.x, y: state.y }, touch: event.pointerType !== 'mouse', moved: false };
    }, { signal });
    frame.addEventListener('pointermove', (/** @type {PointerEvent} */ event) => {
      if (!state.pointers.has(event.pointerId) || !state.gesture) return;
      state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const gesture = state.gesture;
      if (gesture.kind === 'pinch') {
        if (state.pointers.size !== 2) return;
        const [a, b] = [...state.pointers.values()];
        frame.setAttribute('data-dragging', '');
        zoomTo(gesture.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance));
        return;
      }
      const dx = event.clientX - gesture.start.x;
      const dy = event.clientY - gesture.start.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
      gesture.moved = true;
      frame.setAttribute('data-dragging', '');
      if (gesture.kind === 'pan') {
        const { frame: room, size } = measure();
        const pan = clampPan(gesture.from.x + dx, gesture.from.y + dy, size, room, state.zoom);
        state.x = pan.x;
        state.y = pan.y;
        paintTransform();
      } else if (gesture.touch && state.images.length > 1) {
        // The finger leads the image sideways (direct manipulation).
        state.x = Math.round(dx);
        paintTransform();
      }
    }, { signal });
    const end = (/** @type {PointerEvent} */ event) => {
      if (!state.pointers.delete(event.pointerId)) return;
      const gesture = state.gesture;
      if (state.pointers.size > 0) {
        // A pinch that lost a finger: the finger left pans (zoomed) or swipes from where it is.
        if (gesture?.kind === 'pinch' && state.pointers.size === 1) {
          const [rest] = [...state.pointers.values()];
          state.gesture = { kind: state.zoom > 1 ? 'pan' : 'swipe', start: { x: rest.x, y: rest.y }, from: { x: state.x, y: state.y }, touch: true, moved: true };
        } else if (gesture?.kind === 'pinch' && state.pointers.size === 2) {
          // Two of three fingers left: the pinch goes on from these two.
          const [a, b] = [...state.pointers.values()];
          state.gesture = { kind: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: state.zoom };
        }
        return;
      }
      state.gesture = null;
      frame.removeAttribute('data-dragging');
      if (!gesture) return;
      if (gesture.kind === 'swipe' && gesture.touch) {
        const dx = event.clientX - gesture.start.x;
        const width = frame.getBoundingClientRect().width;
        if (gesture.moved && Math.abs(dx) > width / 5 && state.images.length > 1) show(state.index + (dx < 0 ? 1 : -1));
        else if (gesture.moved) {
          state.x = 0;
          paintTransform();
        } else {
          // A double tap zooms (a touch has no dblclick in every engine).
          const now = event.timeStamp;
          // Two taps within --ds-delay-dismiss are one double tap.
          if (now - state.lastTap < motionDuration(frame, '--ds-delay-dismiss')) zoomTo(state.zoom > 1 ? 1 : 2, centre(event));
          state.lastTap = now;
        }
      }
    };
    frame.addEventListener('pointerup', end, { signal });
    frame.addEventListener('pointercancel', end, { signal });

    v.dialog.addEventListener('ds:close', (event) => {
      if (event.target !== v.dialog) return;
      emit(gallery, 'close', { index: state.index });
    }, { signal });
  }

  // The gallery's items open it.
  if (typeof gallery.addEventListener === 'function') {
    gallery.addEventListener('click', (/** @type {MouseEvent} */ event) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const item = /** @type {Element} */ (event.target)?.closest?.(ITEMS);
      if (!item || !gallery.contains(item)) return;
      event.preventDefault();
      const index = [...gallery.querySelectorAll(ITEMS)].indexOf(item);
      controller.open(index, item);
    }, { signal });
  }

  const controller = {
    element: gallery,
    get: () => ({ open: isOpen(), index: state.index, total: state.images.length, zoom: state.zoom }),
    set(/** @type {number|{ index?: number, zoom?: number }} */ value) {
      const next = typeof value === 'number' ? { index: value } : value ?? {};
      if (typeof next.index === 'number') {
        if (!state.images.length) state.images = list();
        show(next.index, isOpen());
      }
      if (typeof next.zoom === 'number' && state.viewer) zoomTo(next.zoom);
    },
    open(/** @type {number} */ index = 0, /** @type {Element|null} */ opener = null) {
      state.images = list();
      if (!state.images.length) return Promise.resolve();
      const v = viewer();
      carryOptions(homeOf(), v.dialog);
      show(index, false);
      const opened = openOverlay(v.dialog, { opener });
      announce(`${t('imageOf', { index: state.index + 1, total: state.images.length })}. ${state.images[state.index].caption || state.images[state.index].alt || ''}`.trim());
      emit(gallery, 'open', { index: state.index });
      return opened;
    },
    close: () => (state.viewer ? closeOverlay(state.viewer.dialog) : Promise.resolve()),
    next: () => show(state.index + 1),
    prev: () => show(state.index - 1),
    on(/** @type {string} */ type, /** @type {(event: Event) => void} */ fn) {
      if (typeof gallery.addEventListener !== 'function') return () => {};
      const name = `ds:${type}`;
      gallery.addEventListener(name, fn);
      const off = () => gallery.removeEventListener(name, fn);
      listeners.push(off);
      return off;
    },
    destroy() {
      if (controllers.get(gallery) !== controller) return;
      controllers.delete(gallery);
      abort.abort();
      state.rover?.destroy?.();
      for (const off of listeners.splice(0)) off();
      const dialog = state.viewer?.dialog;
      state.viewer = null;
      if (!dialog) return;
      const phase = overlays.get(dialog);
      if (phase?.phase === 'open') closeOverlay(dialog).then(() => dialog.remove());
      else if (phase?.phase === 'closing') Promise.resolve(phase.closing).then(() => dialog.remove());
      else dialog.remove();
    },
  };
  controllers.set(gallery, controller);
  return controller;
}

/**
 * Opens the viewer of a gallery at `index` (default 0); `opener` gets focus
 * back. Resolves once its entrance settled.
 * @param {Element} gallery
 * @param {{ index?: number, opener?: Element|null }} [options]
 * @returns {Promise<void>}
 */
export function open(gallery, options = {}) {
  return create(gallery).open(options.index ?? 0, options.opener ?? null);
}

/**
 * Closes the viewer of a gallery.
 * @param {Element} gallery
 * @returns {Promise<void>}
 */
export function close(gallery) {
  return controllers.get(gallery)?.close() ?? Promise.resolve();
}

/**
 * Shows a list of images without a gallery in the page: [{ src, alt,
 * caption, thumb }], at `index`, named `label`; the viewer is removed once
 * it closed. Returns its controller.
 * @param {Array<{ src: string, alt?: string, caption?: string, thumb?: string }>} images
 * @param {{ index?: number, opener?: Element|null, label?: string }} [options]
 */
export function show(images, options = {}) {
  const doc = options.opener?.ownerDocument ?? globalThis.document;
  const home = options.opener ?? doc.querySelector('.ds-theme') ?? doc.body;
  // A detached element stands for the gallery: it hears the events.
  const key = doc.createElement('div');
  if (options.label) key.setAttribute('aria-label', options.label);
  const controller = create(key, { images: () => images.slice(), label: options.label, home });
  key.addEventListener('ds:close', () => controller.destroy(), { once: true });
  controller.open(options.index ?? 0, options.opener ?? null);
  return controller;
}

define('lightbox', {
  attribute: 'data-ds-lightbox',
  init: (element) => create(element),
});
