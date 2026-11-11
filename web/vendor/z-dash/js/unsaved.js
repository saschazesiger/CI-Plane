/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Unsaved-changes guard (DS.unsaved): knows when a form holds edits that
 * are not saved yet, shows them in a save bar, saves on Ctrl+S (Command+S
 * on Apple systems), warns before the page unloads and asks before an
 * in-app navigation throws them away.
 *
 *   <form class="ds-form" data-ds-unsaved data-ds-unsaved-savebar="#device-bar"> (fields) </form>
 *   <div class="ds-savebar" id="device-bar">
 *     <div class="ds-savebar__bar ds-presence" role="region" aria-label="Unsaved changes" hidden>
 *       <p class="ds-savebar__text ds-unsaved__count" data-ds-unsaved-count></p>
 *       <div class="ds-savebar__actions">
 *         <button class="ds-btn ds-btn--text" type="button" data-ds-unsaved-discard>Discard</button>
 *         <button class="ds-btn ds-btn--filled" type="button" data-ds-unsaved-save>(faces)</button></div></div></div>
 *
 *   form.addEventListener('ds:save', (event) => event.detail.waitUntil(api.put(new FormData(form))));
 *   DS.unsaved.navigate(() => router.go('/devices'));   // asks first while something is unsaved
 *
 * Dirty tracking: the values of the form's fields when the guard starts (or
 * after commit()) are the baseline; every input, change and ds:change
 * compares the fields with it. A field with data-ds-unsaved-ignore stays
 * out, and so do buttons. The number of changed fields (a radio group
 * counts once) goes into [data-ds-unsaved-count] ("2 unsaved changes"),
 * and the .ds-field of a changed control takes Form's .ds-field--changed
 * (a dot after the label, and the word "(changed)" in its name; the guard
 * adds the .ds-field__changed word where the label has none);
 * data-ds-unsaved-marks="off" leaves the fields alone.
 *
 * The save bar (data-ds-unsaved-savebar: a selector; else a .ds-savebar in
 * the form; else the one of the form's .ds-view) shows through
 * DS.overlay.savebar() while something is changed, and hides once nothing
 * is (also when the edits are undone by hand).
 *
 * Save: [data-ds-unsaved-save], Ctrl+S or save() send a cancelable ds:save
 * ({ changed, waitUntil(promise) }). With waitUntil() (or the option
 * onSave) the save button shows its busy face (DS.motion.busy); a promise
 * that resolves makes the values the new baseline and "Changes saved." is
 * spoken; one that rejects keeps everything and "Not saved." is spoken.
 * Without either, the form is submitted (requestSubmit) and the page calls
 * commit() when it saved. A native submit that goes through (not
 * prevented) lets the page unload without a warning.
 *
 * Discard: [data-ds-unsaved-discard] or discard() puts every field back to
 * the baseline, sends ds:discard ({ changed }) for what the page holds
 * itself, hides the bar and moves focus to the first field.
 *
 * Leaving: while something is unsaved the browser asks before the page
 * unloads (beforeunload, listened to only while dirty, so the page stays
 * in the back-forward cache otherwise). navigate(go) asks in a dialog first
 * (DS.overlay.confirm: "Discard changes" in the error tone, "Keep
 * editing") and runs go() when the person agrees or nothing is unsaved;
 * once go() resolved, the guards it asked for discard their changes
 * quietly (a route that keeps the form shows it clean, with no bar), and
 * the next edit warns again. A link inside [data-ds-unsaved-link] does the
 * same by itself. destroy() hides the bar it showed (one outside the form
 * outlives it) unless another guard that shares it holds changes.
 *
 * Strings: unsaved* keys of DS.core.config({ strings }).
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, runtime, t } from './core.js';
import { busy } from './motion.js';
import { savebar as savebarOf, confirm } from './overlay.js';
import { announce } from './a11y.js';
import { register } from './hotkeys.js';

/** The page's live guards, shared by every copy of the system. */
const shared = () => runtime.state('unsaved', () => ({ guards: new Set() }));

/** Controls that hold no value a person edits. */
const SKIP = new Set(['button', 'submit', 'reset', 'image', 'fieldset', 'output', 'object']);

/** Whether a form control counts. */
const counts = (field) => field && !SKIP.has(String(field.type ?? '').toLowerCase()) && !field.hasAttribute?.('data-ds-unsaved-ignore') && (field.name || field.id);

/** A control's value as text: checked state for a checkbox or radio, the chosen options of a select, file names. */
function stateOf(field) {
  const type = String(field.type ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') return field.checked ? 'on' : '';
  if (type === 'file') return [...(field.files ?? [])].map((file) => file.name).join('\n');
  if (field.tagName === 'SELECT' || type.startsWith('select')) return [...(field.options ?? [])].filter((option) => option.selected).map((option) => option.value).join('\n');
  return String(field.value ?? '');
}

/**
 * The state of a form's fields: one entry per control, keyed by its name
 * (or id) and its place among controls of the same name, with the group a
 * person counts it in (a radio group's name; every other control alone).
 * Buttons, fieldsets and controls with data-ds-unsaved-ignore stay out.
 * @param {{ elements: ArrayLike<any> }} form  a form (anything with `elements`)
 * @returns {Map<string, { group: string, value: string, field: any }>}
 */
export function snapshot(form) {
  const entries = new Map();
  const seen = new Map();
  for (const field of Array.from(form?.elements ?? [])) {
    if (!counts(field)) continue;
    const base = field.name || `#${field.id}`;
    const at = seen.get(base) ?? 0;
    seen.set(base, at + 1);
    const key = `${base}[${at}]`;
    const group = String(field.type ?? '').toLowerCase() === 'radio' && field.name ? field.name : key;
    entries.set(key, { group, value: stateOf(field), field });
  }
  return entries;
}

/**
 * What changed between two snapshots: the groups whose value differs, in
 * the order of `after` (then the ones that left), each once.
 * @param {Map<string, { group: string, value: string }>} before
 * @param {Map<string, { group: string, value: string }>} after
 * @returns {string[]}
 */
export function diff(before, after) {
  const changed = new Set();
  for (const [key, entry] of after) {
    if (before.get(key)?.value !== entry.value) changed.add(entry.group);
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) changed.add(entry.group);
  }
  return [...changed];
}

/** Puts a field back to a value of stateOf(). */
function restore(field, value) {
  const type = String(field.type ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') field.checked = value === 'on';
  else if (type === 'file') {
    if (!value) field.value = '';
  } else if (field.tagName === 'SELECT') {
    const chosen = new Set(value.split('\n'));
    for (const option of field.options) option.selected = chosen.has(option.value);
  } else field.value = value;
}

/** Whether an element is on screen as far as layout knows. */
const shown = (el) => el.isConnected && (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0);

/** The save bar a guard drives: the option, the attribute, one in the form, the one of its view. */
function barOf(form, option) {
  if (option !== undefined) return option;
  const selector = form.getAttribute('data-ds-unsaved-savebar');
  if (selector === 'off') return null;
  if (selector) {
    const scope = form.getRootNode?.() ?? form.ownerDocument;
    return scope.querySelector?.(selector) ?? null;
  }
  return form.querySelector('.ds-savebar') ?? form.closest('.ds-view')?.querySelector(':scope > .ds-savebar') ?? null;
}

function controller(form, options, signal) {
  const doc = form.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const listeners = new Map();
  const bar = barOf(form, options.savebar);
  const barApi = bar ? savebarOf(bar, { focusTarget: () => firstField() }) : null;
  const scopeOf = () => [form, bar].filter(Boolean);
  const inScope = (selector) => scopeOf().flatMap((root) => [...root.querySelectorAll(selector)]);
  let baseline = snapshot(form);
  let changed = [];
  let forced = false;
  let saving = null;
  let leaving = false;
  let unloadOn = false;
  /** The .ds-field__changed words this guard added to labels that had none. */
  const words = new Set();
  const marks = (options.marks ?? form.getAttribute('data-ds-unsaved-marks')) !== 'off' && options.marks !== false;

  const firstField = () => [...form.elements].find((field) => counts(field) && field.type !== 'hidden' && !field.disabled) ?? form;
  const dirty = () => forced || changed.length > 0;

  const notify = (type, detail, emitOptions) => {
    if (signal?.aborted) return true;
    const go = emit(form, type, detail, emitOptions);
    for (const fn of listeners.get(type) ?? []) fn(detail);
    return go;
  };

  const onUnload = (event) => {
    if (leaving || !dirty()) return;
    event.preventDefault();
    // Older engines ask only when returnValue is set.
    event.returnValue = '';
  };

  /** The page-wide warning, listened to only while something is unsaved. */
  const watchUnload = (on) => {
    if (on === unloadOn) return;
    unloadOn = on;
    if (on) view.addEventListener('beforeunload', onUnload, { signal });
    else view.removeEventListener('beforeunload', onUnload);
  };

  const render = () => {
    const count = changed.length || (forced ? 1 : 0);
    const text = count === 1 ? t('unsavedOne') : t('unsavedMany', { count });
    const write = () => {
      for (const node of inScope('[data-ds-unsaved-count]')) if (count && node.textContent !== text) node.textContent = text;
    };
    const holders = new Set();
    if (marks) {
      const groups = new Set(changed);
      for (const entry of snapshot(form).values()) {
        const holder = groups.has(entry.group) && entry.field.type !== 'hidden' ? entry.field.closest('.ds-field') : null;
        if (holder && form.contains(holder)) holders.add(holder);
      }
    }
    for (const node of form.querySelectorAll('.ds-field--changed[data-ds-unsaved-marked]')) {
      if (holders.has(node)) continue;
      node.classList.remove('ds-field--changed');
      node.removeAttribute('data-ds-unsaved-marked');
    }
    for (const holder of holders) {
      if (holder.classList.contains('ds-field--changed')) continue;
      holder.classList.add('ds-field--changed');
      holder.setAttribute('data-ds-unsaved-marked', '');
      // The word that joins the label's name while the dot shows (Form).
      const label = holder.querySelector(':scope > .ds-field__label');
      if (label && !label.querySelector('.ds-field__changed')) {
        const word = doc.createElement('span');
        word.className = 'ds-field__changed ds-sr';
        word.textContent = ` ${t('unsavedChangedWord')}`;
        label.append(word);
        words.add(word);
      }
    }
    if (barApi) {
      if (count) {
        barApi.update(write);
        barApi.show();
      } else barApi.hide();
    } else write();
    form.toggleAttribute('data-ds-dirty', count > 0);
    watchUnload(count > 0);
  };

  const check = () => {
    // An edit means the document is still here: a navigation or submit
    // that let it go did not unload it, so the warning counts again.
    leaving = false;
    const was = dirty();
    const before = changed.join('\n');
    changed = diff(baseline, snapshot(form));
    if (changed.join('\n') === before && was === dirty()) return;
    render();
    notify('change', { dirty: dirty(), count: changed.length, changed: [...changed] });
  };

  const commit = () => {
    baseline = snapshot(form);
    forced = false;
    changed = [];
    render();
    notify('change', { dirty: false, count: 0, changed: [] });
  };

  /** `quiet`: after navigate() went (the person chose to leave): no focus move, no announcement. */
  const discard = ({ quiet = false } = {}) => {
    const was = [...changed];
    for (const [key, entry] of snapshot(form)) {
      const before = baseline.get(key);
      if (before && before.value !== entry.value) restore(entry.field, before.value);
    }
    forced = false;
    changed = diff(baseline, snapshot(form));
    render();
    notify('discard', { changed: was });
    if (!quiet) {
      if (form.contains(doc.activeElement) || !doc.activeElement || doc.activeElement === doc.body) firstField().focus?.();
      announce(t('unsavedDiscarded'));
    }
    notify('change', { dirty: dirty(), count: changed.length, changed: [...changed] });
  };

  const save = () => {
    if (saving) return saving;
    if (!dirty()) return Promise.resolve(true);
    let work = null;
    const detail = { changed: [...changed], waitUntil: (promise) => { work = promise; } };
    if (!notify('save', detail, { cancelable: true })) return Promise.resolve(false);
    if (!work && typeof options.onSave === 'function') work = options.onSave([...changed]);
    if (!work) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      return Promise.resolve(true);
    }
    const button = inScope('[data-ds-unsaved-save]')[0] ?? null;
    saving = Promise.resolve(button ? busy(button, () => work) : work).then(() => {
      commit();
      announce(t('unsavedSaved'));
      notify('saved', { changed: detail.changed });
      return true;
    }, (error) => {
      announce(t('unsavedFailed'), { assertive: true });
      notify('error', { error });
      return false;
    }).finally(() => {
      saving = null;
    });
    return saving;
  };

  /* ── Events ────────────────────────────── */

  for (const type of ['input', 'change', 'ds:change']) {
    form.addEventListener(type, (event) => {
      // A ds:change of this guard itself is no edit.
      if (type === 'ds:change' && event.target === form) return;
      check();
    }, { signal });
  }
  form.addEventListener('reset', () => setTimeout(check), { signal });
  // A native submit that goes through leaves the page on purpose.
  form.addEventListener('submit', (event) => {
    queueMicrotask(() => {
      if (!event.defaultPrevented) leaving = true;
    });
  }, { signal });

  const onClick = (event) => {
    const target = event.target.closest?.('[data-ds-unsaved-save], [data-ds-unsaved-discard]');
    if (!target || event.defaultPrevented) return;
    event.preventDefault();
    if (target.hasAttribute('data-ds-unsaved-save')) save();
    else discard();
  };
  // Back from the back-forward cache: the page that let itself go is here again.
  view.addEventListener('pageshow', () => {
    leaving = false;
  }, { signal });
  for (const root of scopeOf()) root.addEventListener('click', onClick, { signal });

  const combo = options.hotkey ?? form.getAttribute('data-ds-unsaved-hotkey') ?? 'mod+s';
  const key = combo && combo !== 'off'
    ? register(combo, () => {
      save();
    }, {
      description: t('unsavedSaveKey'),
      owner: form,
      // The guard the focus is in, else the last one on screen.
      when: () => {
        if (!shown(form)) return false;
        const active = doc.activeElement;
        if (!active || form.contains(active) || bar?.contains(active)) return true;
        return ![...shared().guards].some((guard) => guard.form !== form && guard.form.contains(active));
      },
    })
    : null;

  const entry = {
    form,
    bar,
    dirty,
    leave: () => {
      leaving = true;
    },
    stay: () => {
      leaving = false;
    },
    /** navigate() went and the document is still here (an in-app route): what the person gave up is gone. */
    gone: () => {
      if (signal?.aborted) return;
      if (dirty()) discard({ quiet: true });
      leaving = false;
    },
  };
  shared().guards.add(entry);

  render();

  return {
    get() {
      return { dirty: dirty(), count: changed.length, changed: [...changed] };
    },
    /** false: what is there now is saved (commit); true: unsaved whatever the fields say. */
    set(value) {
      if (value) {
        forced = true;
        render();
        notify('change', { dirty: true, count: changed.length, changed: [...changed] });
      } else commit();
    },
    check,
    commit,
    discard: () => discard(),
    save,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    destroy() {
      key?.destroy();
      watchUnload(false);
      shared().guards.delete(entry);
      for (const node of form.querySelectorAll('[data-ds-unsaved-marked]')) {
        node.classList.remove('ds-field--changed');
        node.removeAttribute('data-ds-unsaved-marked');
      }
      for (const word of words) word.remove();
      words.clear();
      form.removeAttribute('data-ds-dirty');
      // A bar outside the form (one for the whole app) outlives it: it
      // hides, and its count goes once the exit is over, unless another
      // guard that shares it still holds changes.
      if (barApi && ![...shared().guards].some((guard) => guard.bar === bar && guard.dirty())) {
        barApi.hide();
        barApi.update(() => {
          for (const node of bar.querySelectorAll('[data-ds-unsaved-count]')) node.textContent = '';
        });
      }
      listeners.clear();
    },
  };
}

define('unsaved', {
  attribute: 'data-ds-unsaved',
  init(el, ctx) {
    return controller(el, {}, ctx.signal);
  },
  // Links inside [data-ds-unsaved-link] ask before they leave unsaved changes.
  global(root) {
    const onClick = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[href]');
      if (!link?.closest('[data-ds-unsaved-link]') || link.hasAttribute('download')) return;
      if (link.target && link.target !== '_self') return;
      if (!pending(link.ownerDocument).length) return;
      event.preventDefault();
      navigate(() => link.ownerDocument.defaultView.location.assign(link.href), { opener: link });
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  },
});

/** The guards of `root` that hold unsaved changes. */
function pending(root) {
  return [...shared().guards].filter((guard) => guard.dirty() && guard.form.isConnected && (!root || root === guard.form.ownerDocument || root.contains?.(guard.form)));
}

/**
 * Whether a guard in `root` (default: the page) holds unsaved changes.
 * @param {Document|Element} [root]
 * @returns {boolean}
 */
export function isDirty(root) {
  return pending(root ?? globalThis.document).length > 0;
}

/**
 * An in-app navigation that asks first while something is unsaved: a
 * dialog ("Leave without saving?", "Discard changes" in the error tone,
 * "Keep editing"). `go()` runs when nothing is unsaved or the person
 * agrees; the guards then let the page unload without the browser's own
 * question. Resolves whether it went.
 * @param {() => unknown} go
 * @param {{ root?: Document|Element, opener?: Element|null, title?: string, text?: string, confirmLabel?: string, cancelLabel?: string }} [options]
 * @returns {Promise<boolean>}
 */
export function navigate(go, options = {}) {
  const guards = pending(options.root ?? globalThis.document);
  const ask = guards.length
    ? confirm({
      title: options.title ?? t('unsavedLeaveTitle'),
      text: options.text ?? t('unsavedLeaveText'),
      confirmLabel: options.confirmLabel ?? t('unsavedLeave'),
      cancelLabel: options.cancelLabel ?? t('unsavedStay'),
      destructive: true,
      opener: options.opener ?? globalThis.document?.activeElement ?? null,
    })
    : Promise.resolve(true);
  return ask.then((agreed) => {
    if (!agreed) return false;
    for (const guard of guards) guard.leave();
    return Promise.resolve(typeof go === 'function' ? go() : undefined).then(() => {
      // The person chose to discard: a route that kept the page leaves
      // clean forms and no bar behind, and the warning counts again.
      for (const guard of guards) guard.gone();
      return true;
    }, (error) => {
      for (const guard of guards) guard.stay();
      throw error;
    });
  });
}

/**
 * A guard driven from the page; the same controller the attribute path
 * makes. `options` override the attributes.
 * @param {HTMLFormElement} form
 * @param {{ savebar?: Element|null, hotkey?: string, marks?: boolean, onSave?: (changed: string[]) => unknown }} [options]
 */
export function create(form, options = {}) {
  const handle = new AbortController();
  const api = controller(form, options, handle.signal);
  const destroy = api.destroy;
  api.destroy = () => {
    handle.abort();
    destroy();
  };
  return api;
}
