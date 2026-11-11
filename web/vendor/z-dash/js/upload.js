/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * File upload (DS.upload): a drop zone, the chosen files with their progress,
 * retry and remove, a grid of previews, paste, limits on type, size and
 * count with errors in words, and images made smaller in the browser before
 * they go.
 *
 *   <div class="ds-upload" data-ds-upload data-ds-upload-max-size="10 MB" data-ds-upload-max-files="5">
 *     <label class="ds-dropzone"> ... <input class="ds-dropzone__input" type="file" accept="image/*,.pdf" multiple> ... </label>
 *     <p class="ds-upload__error" hidden></p>
 *     <ul class="ds-list ds-upload__list" aria-label="Files"></ul>     (or ul.ds-upload__grid: previews)
 *   </div>
 *
 *   const upload = DS.get(el, 'upload');            // or DS.upload.create(el, options)
 *   el.addEventListener('ds:files', ({ detail }) => detail.entries.forEach(send));
 *   upload.progress(id, 0.4);  upload.done(id);  upload.fail(id, 'The server refused it.');
 *
 * The page uploads: ds:files hands it every accepted entry ({ id, file, name,
 * size, type }), and it reports back through progress(), done() and fail().
 * Retry sets the entry back to waiting and sends ds:retry; Remove takes the
 * row out (DS.motion.flip) and sends ds:remove, so the page aborts its
 * request. set(entries) shows files that are already stored.
 *
 * Limits (attributes or options): accept (default the input's), maxSize,
 * maxFiles (with the files shown). A file over a limit is not added; the
 * zone takes aria-invalid and the error line says why, in words, and a
 * screen reader hears it. The next pick clears it.
 *
 * Resize: `resize` (`1600` or `1600x1200`, or { maxWidth, maxHeight,
 * quality, type }) draws a larger JPEG, PNG or WebP on a canvas at most that
 * size before the size limit applies; a result that would be larger keeps
 * the original. Drawn through createImageBitmap with the picture's own
 * orientation.
 *
 * Strings: upload* keys of DS.core.config({ strings }) and remove, retry.
 *
 * ES2022. Progressive: OffscreenCanvas (resize() draws on a detached
 * <canvas> without it); createImageBitmap's imageOrientation (older engines
 * read the orientation by themselves). Without createImageBitmap at all the
 * file goes as it is.
 */
import { define, emit, t } from './core.js';
import { flip } from './motion.js';
import { dropzone, progress as share } from './dom.js';
import { announce } from './a11y.js';
import { bytes } from './format.js';
import { iconElement, alertCircle, checkCircle, close, refresh, file as fileGlyph, fileImage, fileText } from './icons.js';

/** The pictures resize() may draw: no GIF (it may move), no SVG (it scales by itself). */
const RESIZABLE = /^image\/(?:jpeg|png|webp)$/;

/** Units of parseSize(), in bytes. */
const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };

/** Every entry gets a page-wide id. */
let serial = 0;

/**
 * Whether `file` matches an accept list as the file input reads it:
 * extensions (.csv), MIME types (text/csv) and families (image/*), comma
 * separated, case-insensitive; an empty list takes everything.
 * @param {{ name?: string, type?: string }} file
 * @param {string} [accept]
 * @returns {boolean}
 */
export function accepts(file, accept) {
  const rules = String(accept ?? '').split(',').map((rule) => rule.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;
  const name = String(file?.name ?? '').toLowerCase();
  const type = String(file?.type ?? '').toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

/**
 * A size as people write it, in bytes: `10485760`, `10 MB`, `500kB`, `2 MiB`
 * (kB, MB, GB at 1000; KiB, MiB, GiB at 1024); null for anything else.
 * @param {string|number|null|undefined} text
 * @returns {number|null}
 */
export function parseSize(text) {
  if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? text : null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]i?b|b)?\s*$/i.exec(String(text ?? ''));
  if (!match) return null;
  return Math.round(Number(match[1]) * UNITS[(match[2] ?? 'b').toLowerCase()]);
}

/**
 * Sorts files into those a field takes and those it refuses, in order:
 * the type (`accept`), the room left (`maxFiles` minus `count` already
 * shown), then the size (`maxSize`, `minSize`). Each refused one comes with
 * its reason, 'type', 'count', 'size' or 'empty', and the limit.
 * @param {Iterable<File|{ name: string, size: number, type?: string }>} files
 * @param {{ accept?: string, maxSize?: number|null, minSize?: number|null, maxFiles?: number|null, count?: number }} [limits]
 * @returns {{ accepted: any[], rejected: { file: any, reason: 'type'|'count'|'size'|'empty', limit: number|string|null }[] }}
 */
export function validate(files, limits = {}) {
  const accepted = [];
  const rejected = [];
  let room = Number.isFinite(limits.maxFiles) && limits.maxFiles > 0 ? limits.maxFiles - (limits.count ?? 0) : Infinity;
  for (const file of files ?? []) {
    if (!accepts(file, limits.accept)) rejected.push({ file, reason: 'type', limit: limits.accept ?? '' });
    else if (room <= 0) rejected.push({ file, reason: 'count', limit: limits.maxFiles });
    else if (Number.isFinite(limits.maxSize) && file.size > limits.maxSize) rejected.push({ file, reason: 'size', limit: limits.maxSize });
    else if (Number.isFinite(limits.minSize) && file.size < limits.minSize) rejected.push({ file, reason: 'empty', limit: limits.minSize });
    else {
      accepted.push(file);
      room -= 1;
    }
  }
  return { accepted, rejected };
}

/**
 * The size a picture of `width` x `height` takes inside `maxWidth` x
 * `maxHeight` (either may be absent), its proportions kept, never larger
 * than it is; whole pixels, at least 1.
 * @param {number} width
 * @param {number} height
 * @param {{ maxWidth?: number, maxHeight?: number }} [options]
 * @returns {{ width: number, height: number, scale: number }}
 */
export function fitSize(width, height, options = {}) {
  const limits = [options.maxWidth ? options.maxWidth / width : Infinity, options.maxHeight ? options.maxHeight / height : Infinity];
  const scale = Math.min(1, ...limits);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** `1600`, `1600x1200` or an object, as resize options; null for none. */
function resizeOptions(value, quality, type) {
  if (!value) return null;
  if (typeof value === 'object') return { ...value };
  const match = /^\s*(\d+)\s*(?:[x×]\s*(\d+))?\s*$/i.exec(String(value));
  if (!match) return null;
  const maxWidth = Number(match[1]);
  const options = { maxWidth, maxHeight: match[2] ? Number(match[2]) : maxWidth };
  if (quality) options.quality = Number(quality);
  if (type) options.type = type;
  return options;
}

/** A file name for another picture type: report.png as report.webp. */
function renamed(name, type) {
  const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[type];
  if (!extension) return name;
  const stem = name.replace(/\.[^.]+$/, '');
  return `${stem}${extension}`;
}

/**
 * A JPEG, PNG or WebP made at most `maxWidth` x `maxHeight` on a canvas,
 * as a File of `type` (default its own) at `quality` (0 to 1, default
 * 0.9). Resolves with the file itself when it is no such picture, already
 * fits (and keeps its type), cannot be read, or would come out larger.
 * @param {File} file
 * @param {{ maxWidth?: number, maxHeight?: number, quality?: number, type?: string }} [options]
 * @returns {Promise<File>}
 */
export function resizeImage(file, options = {}) {
  return draw(file, options);
}

/** resizeImage() itself. */
async function draw(file, options) {
  const view = globalThis;
  if (!file || !RESIZABLE.test(file.type ?? '') || typeof view.createImageBitmap !== 'function') return file;
  const type = RESIZABLE.test(options.type ?? '') ? options.type : file.type;
  const quality = Number.isFinite(options.quality) ? Math.min(1, Math.max(0, options.quality)) : 0.9;
  let bitmap;
  try {
    bitmap = await view.createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const size = fitSize(bitmap.width, bitmap.height, options);
    if (size.scale >= 1 && type === file.type) return file;
    let blob = null;
    if (typeof view.OffscreenCanvas === 'function') {
      const canvas = new view.OffscreenCanvas(size.width, size.height);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
      blob = await canvas.convertToBlob({ type, quality });
    } else if (view.document) {
      const canvas = view.document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    }
    if (!blob || blob.type !== type || (blob.size >= file.size && type === file.type)) return file;
    return new view.File([blob], renamed(file.name, type), { type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}

/** The words for a refused file. */
function refusal(item) {
  const name = item.file?.name ?? '';
  if (item.reason === 'type') return t('uploadWrongType', { name });
  if (item.reason === 'count') return t('uploadTooMany', { name, max: item.limit });
  if (item.reason === 'empty') return t('uploadEmpty', { name });
  return t('uploadTooLarge', { name, max: bytes(item.limit) });
}

/** A number from an attribute, or null. */
const count = (text) => {
  const value = Number.parseInt(text ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/** An element with a class and attributes. */
function make(doc, tag, className, attributes = {}) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/** The options of the attribute path. */
function readOptions(el) {
  const attr = (name) => el.getAttribute(`data-ds-upload-${name}`);
  return {
    accept: attr('accept') ?? undefined,
    maxSize: parseSize(attr('max-size')),
    maxFiles: count(attr('max-files')),
    resize: resizeOptions(attr('resize'), attr('quality'), attr('resize-type')),
    paste: attr('paste') !== 'off',
  };
}

const OPTION_ATTRIBUTES = ['accept', 'max-size', 'max-files', 'resize', 'quality', 'resize-type', 'paste'].map((name) => `data-ds-upload-${name}`);

function controller(el, initial, signal) {
  const doc = el.ownerDocument;
  let options = { ...initial };
  const listeners = new Map();
  /** @type {Map<string, any>} */
  const entries = new Map();
  const input = el.querySelector('.ds-dropzone__input') ?? el.querySelector('input[type="file"]');
  const zone = el.querySelector('.ds-dropzone') ?? el;
  let list = el.querySelector('.ds-upload__list, .ds-upload__grid');
  if (!list) {
    list = make(doc, 'ul', 'ds-list ds-upload__list');
    el.append(list);
  }
  const grid = list.classList.contains('ds-upload__grid');
  let errorLine = el.querySelector('.ds-upload__error');
  if (!errorLine) {
    errorLine = make(doc, 'p', 'ds-upload__error');
    errorLine.hidden = true;
    const before = zone === el ? null : zone;
    if (before) before.after(errorLine);
    else el.prepend(errorLine);
  }
  if (!errorLine.id) errorLine.id = `ds-upload-error-${++serial}`;
  let errorText = errorLine.querySelector('.ds-upload__error-text');
  if (!errorText) {
    errorLine.replaceChildren(iconElement(alertCircle, 16, '', doc), make(doc, 'span', 'ds-upload__error-text'));
    errorText = errorLine.querySelector('.ds-upload__error-text');
  }
  const describedBefore = input?.getAttribute('aria-describedby') ?? null;

  const notify = (type, detail) => {
    if (signal?.aborted) return;
    emit(el, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  };
  const snapshot = (entry) => ({ id: entry.id, file: entry.file, name: entry.name, size: entry.size, type: entry.type, status: entry.status, progress: entry.progress, error: entry.error, url: entry.url });
  const all = () => [...entries.values()].map(snapshot);
  const changed = () => notify('change', { entries: all() });

  /* ── Errors ─────────────────────────────── */

  const showErrors = (messages) => {
    if (!messages.length) return clearErrors();
    errorText.textContent = messages.join(' ');
    errorLine.hidden = false;
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      const ids = new Set((input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
      ids.add(errorLine.id);
      input.setAttribute('aria-describedby', [...ids].join(' '));
    }
    announce(messages.join(' '), { assertive: true });
  };
  function clearErrors() {
    if (errorLine.hidden) return;
    errorLine.hidden = true;
    errorText.textContent = '';
    if (input) {
      input.removeAttribute('aria-invalid');
      if (describedBefore === null) input.removeAttribute('aria-describedby');
      else input.setAttribute('aria-describedby', describedBefore);
    }
  }

  /* ── Rows ───────────────────────────────── */

  const button = (kind, entry) => {
    const label = t(kind === 'retry' ? 'uploadRetry' : 'uploadRemove', { name: entry.name });
    const node = make(doc, 'button', `ds-btn ${grid ? 'ds-btn--tonal' : 'ds-btn--quiet'} ds-btn--icon ds-sm ds-upload__${kind}`, {
      type: 'button', 'aria-label': label, 'data-tip': t(kind),
    });
    node.append(iconElement(kind === 'retry' ? refresh : close, 18, '', doc));
    return node;
  };

  const glyphOf = (entry) => (/^image\//.test(entry.type) ? fileImage : /^text\/|pdf$/.test(entry.type) ? fileText : fileGlyph);

  const media = (entry) => {
    if (entry.url) {
      const frame = make(doc, 'span', grid ? 'ds-upload__preview' : 'ds-list__media ds-upload__thumb');
      frame.append(make(doc, 'img', '', { src: entry.url, alt: '', decoding: 'async' }));
      return frame;
    }
    if (grid) {
      const frame = make(doc, 'span', 'ds-upload__preview');
      frame.append(iconElement(glyphOf(entry), 32, 'ds-upload__glyph', doc));
      return frame;
    }
    return iconElement(glyphOf(entry), 20, 'ds-list__icon', doc);
  };

  const build = (entry) => {
    const row = make(doc, 'li', grid ? 'ds-upload__tile' : 'ds-list__item ds-upload__item', { 'data-ds-key': entry.id });
    const text = make(doc, 'span', grid ? 'ds-upload__caption' : 'ds-list__text');
    const name = make(doc, 'span', grid ? 'ds-upload__name' : 'ds-list__title ds-upload__name');
    name.textContent = entry.name;
    const meta = make(doc, 'span', grid ? 'ds-upload__meta' : 'ds-list__meta ds-upload__meta');
    text.append(name, meta);
    const bar = make(doc, 'div', 'ds-progress ds-progress--flat ds-upload__bar');
    const track = make(doc, 'div', 'ds-progress__track', {
      role: 'progressbar', 'aria-label': t('uploadProgress', { name: entry.name }), 'aria-valuemin': '0', 'aria-valuemax': '100',
    });
    track.append(make(doc, 'div', 'ds-progress__bar'));
    bar.append(track);
    const actions = make(doc, 'span', grid ? 'ds-upload__actions' : 'ds-list__actions ds-upload__actions');
    actions.append(button('retry', entry), button('remove', entry));
    // In a row the bar goes under the words, so the actions keep the first line at any width.
    if (grid) row.append(media(entry), text, bar, actions);
    else {
      text.append(bar);
      row.append(media(entry), text, actions);
    }
    entry.row = row;
    paint(entry);
    return row;
  };

  /** Writes an entry's state into its row: status, words, bar and buttons. */
  function paint(entry) {
    const row = entry.row;
    if (!row) return;
    row.setAttribute('data-status', entry.status);
    const meta = row.querySelector('.ds-upload__meta');
    const parts = [];
    if (Number.isFinite(entry.size)) parts.push(bytes(entry.size));
    let glyph = null;
    if (entry.status === 'queued') parts.push(t('uploadWaiting'));
    else if (entry.status === 'uploading') parts.push(`${Math.round((entry.progress ?? 0) * 100)}%`);
    else if (entry.status === 'done') {
      glyph = checkCircle;
      parts.push(t('uploadDone'));
    } else if (entry.status === 'error') {
      glyph = alertCircle;
      parts.push(entry.error || t('uploadFailed'));
    }
    const words = make(doc, 'span', 'ds-upload__status');
    words.textContent = parts.join(' · ');
    meta.replaceChildren(...(glyph ? [iconElement(glyph, 16, 'ds-upload__status-icon', doc)] : []), words);
    const bar = row.querySelector('.ds-upload__bar');
    const busy = entry.status === 'queued' || entry.status === 'uploading';
    // Waiting says so in words; the bar comes with the first share.
    bar.hidden = entry.status !== 'uploading';
    if (entry.status === 'uploading') share(bar, entry.progress ?? 0);
    row.querySelector('.ds-upload__retry').hidden = entry.status !== 'error';
    if (busy) row.setAttribute('aria-busy', 'true');
    else row.removeAttribute('aria-busy');
  }

  const revoke = (entry) => {
    if (entry.ownUrl && entry.url) globalThis.URL?.revokeObjectURL?.(entry.url);
    entry.ownUrl = false;
  };

  const entryFrom = (source, status) => {
    const file = typeof globalThis.File === 'function' && source instanceof globalThis.File ? source : source.file ?? null;
    const entry = {
      id: source.id != null ? String(source.id) : `upload-${++serial}`,
      file,
      name: String(source.name ?? file?.name ?? ''),
      size: Number.isFinite(source.size) ? source.size : file?.size ?? null,
      type: String(source.type ?? file?.type ?? ''),
      status: source.status ?? status,
      progress: Number.isFinite(source.progress) ? source.progress : null,
      error: source.error ?? '',
      url: source.url ?? '',
      ownUrl: false,
      row: null,
    };
    if (!entry.url && file && /^image\//.test(entry.type) && typeof globalThis.URL?.createObjectURL === 'function') {
      entry.url = globalThis.URL.createObjectURL(file);
      entry.ownUrl = true;
    }
    return entry;
  };

  const insert = (fresh) => flip(list, () => {
    for (const entry of fresh) list.append(build(entry));
  });

  const take = (entry, refocus = true) => {
    entries.delete(entry.id);
    revoke(entry);
    const row = entry.row;
    entry.row = null;
    if (!row?.isConnected) return Promise.resolve();
    return flip(list, () => row.remove(), { refocus: refocus ? () => (input?.disabled ? null : input) : false });
  };

  /* ── Adding ─────────────────────────────── */

  let adding = Promise.resolve();
  const add = (files) => {
    const run = adding.then(async () => {
      if (signal?.aborted) return [];
      const picked = Array.from(files ?? []);
      if (!picked.length) return [];
      const accept = options.accept ?? input?.accept ?? '';
      // The type first; the size counts after a resize; the room goes only to files that pass.
      const first = validate(picked, { accept });
      const resized = [];
      for (const file of first.accepted) resized.push(options.resize ? await resizeImage(file, options.resize) : file);
      const second = validate(resized, { maxSize: options.maxSize, minSize: 1, maxFiles: options.maxFiles, count: entries.size });
      const rejected = [...first.rejected, ...second.rejected];
      showErrors(rejected.map(refusal));
      if (rejected.length) notify('reject', { rejected });
      if (signal?.aborted || !second.accepted.length) return [];
      const fresh = second.accepted.map((file) => entryFrom(file, 'queued'));
      for (const entry of fresh) entries.set(entry.id, entry);
      insert(fresh);
      announce(fresh.length === 1 ? t('uploadAdded', { name: fresh[0].name }) : t('uploadAddedCount', { count: fresh.length }));
      const detail = { entries: fresh.map(snapshot) };
      notify('files', detail);
      changed();
      return detail.entries;
    });
    adding = run.catch(() => []);
    return run;
  };

  const zoneHandle = dropzone(zone, {
    onFiles: (files) => { add(files); },
    target: el,
    input,
    accept: '',
    multiple: input ? input.multiple : true,
    paste: options.paste !== false,
  });

  /* ── The rows' buttons ──────────────────── */

  list.addEventListener('click', (event) => {
    const action = event.target.closest?.('.ds-upload__retry, .ds-upload__remove');
    if (!action || !list.contains(action)) return;
    const id = action.closest('[data-ds-key]')?.getAttribute('data-ds-key');
    if (!id) return;
    if (action.classList.contains('ds-upload__retry')) api.retry(id);
    else api.remove(id);
  }, { signal });

  const api = {
    get: all,
    set(next) {
      for (const entry of [...entries.values()]) {
        revoke(entry);
        entry.row?.remove();
      }
      entries.clear();
      clearErrors();
      const fresh = Array.from(next ?? []).map((source) => entryFrom(source, 'done'));
      for (const entry of fresh) entries.set(entry.id, entry);
      list.replaceChildren(...fresh.map(build));
      changed();
    },
    add,
    progress(id, value) {
      const entry = entries.get(String(id));
      if (!entry) return;
      entry.status = 'uploading';
      entry.progress = Math.min(1, Math.max(0, Number(value) || 0));
      paint(entry);
    },
    done(id, result = {}) {
      const entry = entries.get(String(id));
      if (!entry) return;
      entry.status = 'done';
      entry.progress = 1;
      entry.error = '';
      if (result.url && !entry.url) {
        entry.url = result.url;
        // Only the media turns into the preview: the row stays, and so does
        // a focus on its buttons.
        entry.row?.firstElementChild?.replaceWith(media(entry));
      }
      paint(entry);
      announce(t('uploadDoneAnnounce', { name: entry.name }));
      changed();
    },
    fail(id, message) {
      const entry = entries.get(String(id));
      if (!entry) return;
      entry.status = 'error';
      entry.error = message ? String(message) : '';
      paint(entry);
      announce(t('uploadFailedAnnounce', { name: entry.name }), { assertive: true });
      changed();
    },
    retry(id) {
      const entry = entries.get(String(id));
      if (!entry || entry.status !== 'error') return;
      const focusWasOnRetry = entry.row?.contains(doc.activeElement);
      entry.status = 'queued';
      entry.progress = null;
      entry.error = '';
      paint(entry);
      if (focusWasOnRetry) entry.row?.querySelector('.ds-upload__remove')?.focus();
      notify('retry', { entry: snapshot(entry) });
      changed();
    },
    remove(id) {
      const entry = entries.get(String(id));
      if (!entry) return Promise.resolve();
      const detail = { entry: snapshot(entry) };
      const gone = take(entry);
      announce(t('uploadRemoved', { name: entry.name }));
      clearErrors();
      notify('remove', detail);
      changed();
      return gone;
    },
    clear() {
      for (const entry of entries.values()) revoke(entry);
      entries.clear();
      clearErrors();
      flip(list, () => list.replaceChildren(), { refocus: () => input });
      changed();
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    update() {
      options = { ...options, ...readOptions(el) };
    },
    destroy() {
      zoneHandle.destroy();
      for (const entry of entries.values()) revoke(entry);
      listeners.clear();
    },
  };
  return api;
}

define('upload', {
  attribute: 'data-ds-upload',
  attributes: OPTION_ATTRIBUTES,
  init(el, ctx) {
    return controller(el, readOptions(el), ctx.signal);
  },
});

/**
 * A file upload driven from the page; the same controller the attribute
 * path makes. `options` override the attributes.
 * @param {Element} el
 * @param {{ accept?: string, maxSize?: number|string, maxFiles?: number, resize?: number|string|{ maxWidth?: number, maxHeight?: number, quality?: number, type?: string }, paste?: boolean }} [options]
 */
export function create(el, options = {}) {
  const base = readOptions(el);
  const given = { ...options };
  if (given.maxSize !== undefined) given.maxSize = parseSize(given.maxSize);
  if (given.resize !== undefined) given.resize = resizeOptions(given.resize);
  const handle = new AbortController();
  const api = controller(el, { ...base, ...given }, handle.signal);
  const destroy = api.destroy;
  api.destroy = () => {
    handle.abort();
    destroy();
  };
  return api;
}
