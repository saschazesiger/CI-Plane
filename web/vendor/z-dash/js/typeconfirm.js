/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Type-to-confirm (DS.typeconfirm): a destructive action that waits until
 * the name of what goes has been typed. It lives in a confirm dialog, whose
 * confirm button is the filled error button of D10.
 *
 *   <dialog class="ds-dialog" id="del" role="alertdialog" aria-labelledby="del-t" aria-describedby="del-x">
 *     <div class="ds-dialog__backdrop" data-ds-close></div>
 *     <form class="ds-dialog__box ds-typeconfirm" data-ds-typeconfirm="LAPTOP-0042">
 *       <h2 class="ds-dialog__title" id="del-t">Delete LAPTOP-0042?</h2>
 *       <p class="ds-dialog__text" id="del-x">Its history and open tickets go with it. This cannot be undone.</p>
 *       <div class="ds-field">
 *         <label class="ds-field__label ds-typeconfirm__label" for="del-c"></label>   (empty: the system writes it)
 *         <input class="ds-input ds-typeconfirm__input" id="del-c" autocomplete="off" spellcheck="false" autocapitalize="off">
 *         <small class="ds-field__hint ds-field__hint--error ds-typeconfirm__error" hidden></small>
 *       </div>
 *       <div class="ds-dialog__actions">
 *         <button class="ds-btn ds-btn--text" type="button" data-ds-close>Cancel</button>
 *         <button class="ds-btn ds-btn--filled ds-tone-error ds-typeconfirm__confirm" type="submit">Delete device</button>
 *       </div>
 *     </form>
 *   </dialog>
 *
 *   root.addEventListener('ds:confirm', (event) => event.detail.wait(api.remove(id)));
 *   DS.typeconfirm.matches(' LAPTOP-0042 ', 'LAPTOP-0042');   // true
 *
 * The name is data-ds-typeconfirm (one changed later applies at once). An
 * empty .ds-typeconfirm__label gets "Type LAPTOP-0042 to confirm" (the
 * string typeToConfirm, the name in .ds-typeconfirm__name, which a pointer
 * selects whole). The match is exact but for the outer spaces;
 * data-ds-typeconfirm-case="insensitive" ignores case.
 *
 * The confirm button is aria-disabled="true" (written here) until the field
 * matches: it stays in the tab order and says why it waits, and the action
 * guard of DS.motion blocks it. A submit before that (Enter in the field)
 * marks the field invalid and keeps the focus there. Paste is allowed.
 *
 * Confirm: ds:confirm goes out on the root, cancelable, with
 * { name, wait(promise) }. Without a promise (or once it resolves) the
 * dialog around it closes (DS.overlay.close, reason "confirm"); with one,
 * the confirm button is busy (DS.motion.busy) until it settles. A rejection
 * keeps the dialog open and shows the error's message (else the string
 * actionFailed) in .ds-typeconfirm__error, announced at once. Each time the
 * dialog opens or closes the field empties and the button waits again.
 *
 * The controller: get() ({ name, typed, match }), set(name), on('change'
 * | 'confirm', fn), reset(), update(), destroy(). ds:change ({ match }) when
 * the match changes.
 *
 * Strings: typeToConfirm, actionFailed (DS.core.config({ strings })).
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { own } from './dom.js';
import { busy } from './motion.js';
import { close as closeOverlay } from './overlay.js';
import { announce } from './a11y.js';
import { alertCircle, iconElement } from './icons.js';

let seq = 0;

/**
 * Whether what was typed confirms the name: equal but for the outer spaces
 * (and, with `caseInsensitive`, the case). An empty name never matches.
 * @param {string|null|undefined} typed
 * @param {string|null|undefined} name
 * @param {{ caseInsensitive?: boolean }} [options]
 * @returns {boolean}
 */
export function matches(typed, name, options = {}) {
  const want = String(name ?? '').trim();
  if (!want) return false;
  const got = String(typed ?? '').trim();
  return options.caseInsensitive ? got.toLocaleLowerCase() === want.toLocaleLowerCase() : got === want;
}

function controller(root, signal) {
  const part = (name) => /** @type {HTMLElement|null} */ (root.querySelector(`.ds-typeconfirm__${name}`));
  const input = /** @type {HTMLInputElement|null} */ (part('input'));
  const label = part('label');
  const confirm = /** @type {HTMLButtonElement|null} */ (part('confirm'));
  const error = part('error');
  const form = /** @type {HTMLFormElement|null} */ (root.localName === 'form' ? root : root.querySelector('form') ?? input?.form ?? null);
  const dialog = root.closest('.ds-dialog');
  const doc = root.ownerDocument;
  const listeners = { change: new Set(), confirm: new Set() };
  const on = (target, type, fn, options) => target?.addEventListener(type, fn, { signal, ...options });
  let match = false;
  let working = false;
  let wroteLabel = false;

  const name = () => root.getAttribute('data-ds-typeconfirm') ?? '';
  const insensitive = () => root.getAttribute('data-ds-typeconfirm-case') === 'insensitive';

  if (confirm) own(confirm, 'attrs', 'aria-disabled');

  const writeLabel = () => {
    if (!label || !doc || (label.textContent.trim() && !wroteLabel)) return;
    // "Type {name} to confirm", the name as an element of its own.
    const [before, after = ''] = t('typeToConfirm', { name: '\u0000' }).split('\u0000');
    const strong = doc.createElement('strong');
    strong.className = 'ds-typeconfirm__name';
    strong.textContent = name();
    label.replaceChildren(doc.createTextNode(before), strong, doc.createTextNode(after));
    wroteLabel = true;
  };

  const showError = (text) => {
    if (!input) return;
    if (!text) {
      if (input.getAttribute('aria-invalid') === 'true') input.removeAttribute('aria-invalid');
      if (error && !error.hidden) {
        error.hidden = true;
        error.replaceChildren();
      }
      return;
    }
    if (error && doc) {
      if (!error.id) error.id = `ds-typeconfirm-error-${(seq += 1)}`;
      error.replaceChildren(iconElement(alertCircle, 16, '', doc), doc.createTextNode(text));
      error.hidden = false;
      const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      if (!ids.includes(error.id)) input.setAttribute('aria-describedby', [...ids, error.id].join(' '));
    }
    announce(text, { assertive: true });
  };

  const paint = () => {
    const now = matches(input?.value, name(), { caseInsensitive: insensitive() });
    if (confirm) {
      if (now) confirm.removeAttribute('aria-disabled');
      else confirm.setAttribute('aria-disabled', 'true');
    }
    if (now === match) return;
    match = now;
    emit(root, 'change', { match });
    listeners.change.forEach((fn) => fn({ match }));
  };

  const reset = () => {
    if (working) return;
    if (input) input.value = '';
    showError('');
    paint();
  };

  const run = async () => {
    if (working) return;
    let pending = /** @type {unknown} */ (undefined);
    const detail = { name: name(), wait(promise) { pending = promise; } };
    const go = emit(root, 'confirm', detail, { cancelable: true });
    for (const fn of listeners.confirm) {
      const result = fn(detail);
      if (result && typeof (/** @type {any} */ (result)).then === 'function') pending = result;
    }
    if (!go) return;
    if (pending !== undefined) {
      working = true;
      if (input) input.readOnly = true;
      try {
        await (confirm ? busy(confirm, () => pending, { done: false, failed: false }) : pending);
      } catch (failure) {
        working = false;
        if (input) input.readOnly = false;
        if (signal?.aborted) return;
        const message = /** @type {any} */ (failure)?.message;
        showError(typeof message === 'string' && message ? message : t('actionFailed'));
        confirm?.focus();
        return;
      }
      working = false;
      if (input) input.readOnly = false;
      if (signal?.aborted) return;
    }
    if (dialog) closeOverlay(dialog, { reason: 'confirm' });
  };

  on(input, 'input', () => {
    if (input?.getAttribute('aria-invalid') === 'true') showError('');
    paint();
  });
  // Capture: a submit that does not match never reaches the page's own handler.
  on(form, 'submit', (/** @type {SubmitEvent} */ event) => {
    event.preventDefault();
    paint();
    if (!match) {
      event.stopImmediatePropagation();
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
      return;
    }
    run();
  }, { capture: true });
  // Enter in the field: before the match it marks the field (the action guard would swallow the submit without a
  // word); after it, a form submits on its own and anything else runs here.
  on(input, 'keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return;
    paint();
    if (!match) {
      event.preventDefault();
      input?.setAttribute('aria-invalid', 'true');
      return;
    }
    if (!form) {
      event.preventDefault();
      run();
    }
  });
  if (!form) on(confirm, 'click', () => { if (match) run(); });
  on(dialog, 'ds:open', reset);
  on(dialog, 'ds:close', () => setTimeout(reset));
  on(doc, 'ds:config', writeLabel);
  writeLabel();
  paint();

  return {
    get() { return { name: name(), typed: input?.value ?? '', match }; },
    set(next) { root.setAttribute('data-ds-typeconfirm', String(next ?? '')); },
    reset,
    on(type, fn) {
      const set = listeners[type];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    update() {
      writeLabel();
      paint();
    },
    destroy() {
      listeners.change.clear();
      listeners.confirm.clear();
    },
  };
}

define('typeconfirm', {
  attribute: 'data-ds-typeconfirm',
  attributes: ['data-ds-typeconfirm-case'],
  init(el, ctx) {
    return controller(el, ctx.signal);
  },
});

/**
 * A type-to-confirm driven from the page; the same controller the
 * attribute path makes. A confirm listener may return the promise of the
 * action instead of calling wait().
 * @param {Element} el  the root with data-ds-typeconfirm (usually the dialog's box)
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
