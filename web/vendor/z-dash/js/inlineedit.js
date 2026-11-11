/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Inline edit (DS.inlineedit): a value shown as text that turns into a field
 * in place, saved with Enter or Save and left with Escape or Cancel; busy
 * while the page saves, an error in words when that fails.
 *
 *   <div class="ds-inlineedit" data-ds-inlineedit>
 *     <div class="ds-inlineedit__view">
 *       <span class="ds-inlineedit__value">LAPTOP-0042</span>
 *       <button class="ds-btn ds-btn--quiet ds-btn--icon ds-sm ds-inlineedit__edit" type="button" aria-label="Edit device name">(pencil 18)</button>
 *     </div>
 *     <div class="ds-inlineedit__form">
 *       <input class="ds-input ds-inlineedit__input" aria-label="Device name" required>
 *       <span class="ds-inlineedit__actions">
 *         <button class="ds-btn ds-btn--tonal ds-sm ds-inlineedit__save" type="button">(faces: Save, busy)</button>
 *         <button class="ds-btn ds-btn--text ds-sm ds-inlineedit__cancel" type="button">Cancel</button>
 *       </span>
 *     </div>
 *     <small class="ds-field__hint ds-field__hint--error ds-inlineedit__error" hidden></small>
 *   </div>
 *
 *   root.addEventListener('ds:save', (event) => event.detail.wait(api.rename(id, event.detail.value)));
 *   const edit = DS.inlineedit.create(root);
 *   edit.edit();  edit.save();  edit.cancel();  edit.get();  edit.set('LAPTOP-0043');
 *
 * State: data-state="view" or "edit" on the root (written here); the
 * stylesheet shows the view or the form. aria-busy="true" while a save
 * runs. The value is the text of .ds-inlineedit__value, or
 * data-ds-value on the root when the shown text differs (a formatted
 * figure); the field gets it on edit. With data-ds-value a save writes the
 * new value there and the shown text only when given (a save's promise
 * resolving to { text }, set(value, { text })); otherwise the page
 * rewrites .ds-inlineedit__value.
 *
 * Keys: Enter or Space on the edit button (or a click on the value) opens
 * the field with its text selected; Enter in an input saves (in a textarea
 * Ctrl+Enter or Cmd+Enter); Escape cancels (and keeps a dialog around it
 * open). Focus goes back to the edit button after a save or a cancel.
 *
 * Save: an unchanged value just closes. A field that fails its own
 * constraints (required, pattern, maxlength ...) shows its validation
 * message as the error and stays. Otherwise ds:save goes out on the root,
 * cancelable, with { value, previous, wait(promise) }: a page that saves on
 * a server passes the promise to wait(); the save button is busy
 * (DS.motion.busy) and the field read-only until it settles. A resolved
 * promise (or none) shows the new value and says "Saved" (the string
 * saved); a rejection keeps the field open with the error (its message, or
 * the string actionFailed) and focuses it. preventDefault() on ds:save
 * keeps the field open without an error (the page shows its own).
 * ds:cancel ({ value }) and ds:edit ({ value }) go out too.
 *
 * Blur (data-ds-inlineedit-blur): "keep" (the default: the field stays open
 * until saved or cancelled), "save" or "cancel" when the focus leaves the
 * whole component. data-ds-inlineedit-trim compares and saves the value
 * without its outer spaces.
 *
 * Strings: edit (an edit button without a name), save (a save button
 * without text), cancel, saved, actionFailed (DS.core.config({ strings })).
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { own } from './dom.js';
import { busy } from './motion.js';
import { announce } from './a11y.js';
import { alertCircle, iconElement } from './icons.js';

/** Numbers the ids this module gives the value and the error. */
let seq = 0;

/**
 * What a save of `value` over `previous` does: 'close' when nothing
 * changed, 'save' otherwise. Text is compared as typed, so a space that was
 * added counts; `trim: true` compares and saves without the outer spaces.
 * @param {string|null|undefined} value
 * @param {string|null|undefined} previous
 * @param {{ trim?: boolean }} [options]
 * @returns {{ action: 'close'|'save', value: string }}
 */
export function decide(value, previous, options = {}) {
  const next = options.trim ? String(value ?? '').trim() : String(value ?? '');
  const before = options.trim ? String(previous ?? '').trim() : String(previous ?? '');
  return { action: next === before ? 'close' : 'save', value: next };
}

const idOf = (el, part) => {
  if (!el.id) {
    seq += 1;
    el.id = `ds-inlineedit-${part}-${seq}`;
  }
  return el.id;
};

function controller(root, signal) {
  const part = (name) => /** @type {HTMLElement|null} */ (root.querySelector(`.ds-inlineedit__${name}`));
  const shown = part('value');
  const editButton = /** @type {HTMLButtonElement|null} */ (part('edit'));
  const form = part('form');
  const input = /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (part('input') ?? form?.querySelector('input, textarea, select') ?? null);
  const saveButton = /** @type {HTMLButtonElement|null} */ (part('save'));
  const cancelButton = /** @type {HTMLButtonElement|null} */ (part('cancel'));
  const error = part('error');
  const listeners = { save: new Set(), cancel: new Set(), edit: new Set() };
  const on = (target, type, fn) => target?.addEventListener(type, fn, { signal });
  const trim = root.hasAttribute('data-ds-inlineedit-trim');
  let state = 'view';
  let saving = false;

  own(root, 'attrs', 'data-state');
  own(root, 'attrs', 'aria-busy');

  const value = () => root.getAttribute('data-ds-value') ?? shown?.textContent ?? '';

  // Names: the edit button says what it edits; the save button has words.
  if (editButton && !editButton.hasAttribute('aria-label') && !editButton.textContent.trim()) {
    editButton.setAttribute('aria-label', t('edit'));
    if (shown) editButton.setAttribute('aria-describedby', idOf(shown, 'value'));
  }
  if (saveButton && !saveButton.textContent.trim() && !saveButton.hasAttribute('aria-label')) saveButton.setAttribute('aria-label', t('save'));
  if (cancelButton && !cancelButton.textContent.trim() && !cancelButton.hasAttribute('aria-label')) cancelButton.setAttribute('aria-label', t('cancel'));

  const tell = (kind, detail) => listeners[kind].forEach((fn) => fn(detail));

  const showError = (text) => {
    if (!input) return;
    if (!text) {
      if (input.getAttribute('aria-invalid') === 'true') input.removeAttribute('aria-invalid');
      if (error) {
        error.hidden = true;
        error.textContent = '';
      }
      return;
    }
    input.setAttribute('aria-invalid', 'true');
    if (error) {
      // An icon and the words, as every field error.
      error.replaceChildren(iconElement(alertCircle, 16, '', error.ownerDocument), error.ownerDocument.createTextNode(text));
      error.hidden = false;
      const id = idOf(error, 'error');
      const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      if (!ids.includes(id)) input.setAttribute('aria-describedby', [...ids, id].join(' '));
    }
    announce(text, { assertive: true });
  };

  const paint = () => {
    if (root.getAttribute('data-state') !== state) root.setAttribute('data-state', state);
    if (saving) root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
    if (input) input.readOnly = saving;
  };

  const enter = () => {
    if (state === 'edit' || !input) return;
    state = 'edit';
    input.value = value();
    showError('');
    paint();
    input.focus();
    input.select?.();
    emit(root, 'edit', { value: value() });
    tell('edit', { value: value() });
  };

  const leave = (focus = true) => {
    state = 'view';
    showError('');
    paint();
    if (focus) editButton?.focus();
  };

  const cancel = (focus = true) => {
    if (state !== 'edit' || saving) return;
    leave(focus);
    emit(root, 'cancel', { value: value() });
    tell('cancel', { value: value() });
  };

  /**
   * Writes a new value: data-ds-value where the root has it, and the shown
   * text (the given display text; else the value, unless data-ds-value says
   * the shown text is formatted: then the page writes it).
   */
  const write = (next, text) => {
    const formatted = root.hasAttribute('data-ds-value');
    if (formatted) root.setAttribute('data-ds-value', next);
    if (shown && typeof text === 'string') shown.textContent = text;
    else if (shown && !formatted) shown.textContent = next;
  };

  const commit = (next, focus, text) => {
    write(next, text);
    leave(focus);
    announce(t('saved'));
  };

  const save = async (focus = true) => {
    if (state !== 'edit' || saving || !input) return;
    const previous = value();
    const decided = decide(input.value, previous, { trim });
    if (decided.action === 'close') {
      leave(focus);
      return;
    }
    if (typeof input.checkValidity === 'function' && !input.checkValidity()) {
      showError(input.validationMessage || t('actionFailed'));
      input.focus();
      return;
    }
    let pending = /** @type {unknown} */ (undefined);
    const detail = { value: decided.value, previous, wait(promise) { pending = promise; } };
    const go = emit(root, 'save', detail, { cancelable: true });
    for (const fn of listeners.save) {
      const result = fn(detail);
      if (result && typeof (/** @type {any} */ (result)).then === 'function') pending = result;
    }
    if (!go) return;
    if (pending === undefined) {
      commit(decided.value, focus);
      return;
    }
    saving = true;
    showError('');
    paint();
    try {
      const work = saveButton ? busy(saveButton, () => pending, { done: false, failed: false }) : Promise.resolve(pending);
      const result = /** @type {any} */ (await work);
      saving = false;
      if (signal?.aborted) return;
      // A save that resolves to { text } gives the shown text (a formatted figure).
      commit(decided.value, focus, result && typeof result === 'object' && typeof result.text === 'string' ? result.text : undefined);
    } catch (failure) {
      saving = false;
      if (signal?.aborted) return;
      paint();
      const text = failure && typeof (/** @type {any} */ (failure)).message === 'string' && (/** @type {any} */ (failure)).message ? (/** @type {any} */ (failure)).message : t('actionFailed');
      showError(text);
      input.focus();
    }
  };

  on(editButton, 'click', enter);
  on(shown, 'click', enter);
  on(saveButton, 'click', () => { save(); });
  on(cancelButton, 'click', () => cancel());
  on(input, 'input', () => { if (input?.getAttribute('aria-invalid') === 'true') showError(''); });
  on(input, 'keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.isComposing || state !== 'edit') return;
    if (event.key === 'Escape') {
      // Leaves the field; a dialog around it stays open.
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== 'Enter' || !input) return;
    const multiline = input.localName === 'textarea';
    if (multiline && !(event.ctrlKey || event.metaKey)) return;
    if (!multiline && (event.altKey || event.shiftKey)) return;
    event.preventDefault();
    save();
  });
  on(root, 'focusout', (/** @type {FocusEvent} */ event) => {
    const mode = root.getAttribute('data-ds-inlineedit-blur');
    if (state !== 'edit' || saving || (mode !== 'save' && mode !== 'cancel')) return;
    const next = /** @type {Node|null} */ (event.relatedTarget);
    if (next && root.contains(next)) return;
    if (mode === 'save') save(false);
    else cancel(false);
  });
  paint();

  return {
    get() { return { value: value(), editing: state === 'edit', busy: saving }; },
    set(next, options = {}) {
      const text = String(next ?? '');
      write(text, typeof options?.text === 'string' ? options.text : undefined);
      if (state === 'edit' && input && !saving) input.value = text;
    },
    edit: enter,
    save: () => save(),
    cancel: () => cancel(),
    on(type, fn) {
      const set = listeners[type];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    destroy() {
      listeners.save.clear();
      listeners.cancel.clear();
      listeners.edit.clear();
    },
  };
}

define('inlineedit', {
  attribute: 'data-ds-inlineedit',
  init(el, ctx) {
    return controller(el, ctx.signal);
  },
});

/**
 * An inline edit driven from the page; the same controller the attribute
 * path makes. A listener of on('save') may return the promise of the save
 * instead of calling wait().
 * @param {Element} el  the .ds-inlineedit
 */
export function create(el) {
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const made = controller(el, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
  };
  return made;
}
