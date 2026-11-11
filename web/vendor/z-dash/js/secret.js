/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Secret field (DS.secret): a value the server keeps and never sends back
 * (an API key, a token, a password of a service). The field says that one
 * is set, without the value, and offers to replace or clear it.
 *
 *   <div class="ds-field ds-secret" data-ds-secret="set">          ("set": one is stored; empty: none)
 *     <label class="ds-field__label" for="key">API key</label>
 *     <div class="ds-secret__stored">
 *       <span class="ds-secret__mask" aria-hidden="true">••••••••</span>
 *       <span class="ds-secret__status"></span>
 *       <span class="ds-secret__actions">
 *         <button class="ds-btn ds-btn--text ds-secret__replace" type="button">Replace</button>
 *         <button class="ds-btn ds-btn--text ds-secret__clear" type="button">Clear</button>
 *         <button class="ds-btn ds-btn--text ds-secret__undo" type="button">Undo</button>
 *       </span>
 *     </div>
 *     <div class="ds-secret__entry">
 *       <div class="ds-input-group"><input class="ds-input" id="key" name="api_key" type="password" autocomplete="off"></div>
 *       <button class="ds-btn ds-btn--text ds-secret__cancel" type="button">Cancel</button>
 *     </div>
 *     <input type="hidden" name="api_key_action" data-ds-secret-action>
 *   </div>
 *
 *   const key = DS.secret.create(field);
 *   key.get();             // { state: 'set', stored: true, action: 'keep' }
 *   key.set('replace');    // empty, set, replace or clear
 *
 * States (data-state on the root, written here; the stylesheet shows the
 * parts of each):
 *   empty    nothing is stored: the entry, without Cancel
 *   set      one is stored: the mask, "Set", Replace and Clear
 *   replace  the entry, empty, with Cancel (Escape cancels too)
 *   clear    the mask struck through, "Removed when you save", Undo
 * Focus follows: Replace to the field, Cancel and Undo back to Replace,
 * Clear to Undo; a change from set() or a reset that hides the part with
 * the focus moves it the same way (to Replace, Undo or the field); a change
 * of state is announced through the status words.
 *
 * The hidden input [data-ds-secret-action] tells the server what to do on
 * save: "keep" (leave the stored value), "set" (store what the field holds:
 * a value typed while empty or replacing) or "clear" (remove it). The field
 * itself never holds the stored value. After a save the page sets the
 * attribute again (data-ds-secret="set" or "") or calls set('set').
 *
 * The status words are the strings secretSet, secretNotSet and
 * secretCleared (DS.core.config({ strings })). The buttons' names are the
 * page's ("Replace"); the system describes them by the label and the status
 * (aria-describedby), so "Replace" says which secret.
 *
 * Events: ds:change ({ state, action }) on the root.
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { own } from './dom.js';
import { announce } from './a11y.js';

const STATES = ['empty', 'set', 'replace', 'clear'];

/** Numbers the ids this module gives the label and the status. */
let seq = 0;

/** What the server should do in a state with this field value. */
export function action(state, value) {
  if (state === 'clear') return 'clear';
  if ((state === 'replace' || state === 'empty') && String(value ?? '') !== '') return 'set';
  return 'keep';
}

function idOf(el, prefix) {
  if (!el.id) el.id = `ds-secret-${prefix}-${(seq += 1)}`;
  return el.id;
}

function controller(root, start, signal) {
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('.ds-secret__entry input, input.ds-input'));
  const hidden = /** @type {HTMLInputElement|null} */ (root.querySelector('input[data-ds-secret-action]'));
  const status = root.querySelector('.ds-secret__status');
  const label = root.querySelector('.ds-field__label');
  const part = (name) => /** @type {HTMLButtonElement|null} */ (root.querySelector(`.ds-secret__${name}`));
  const buttons = { replace: part('replace'), clear: part('clear'), undo: part('undo'), cancel: part('cancel') };
  const listeners = new Set();
  let state = start;

  own(root, 'attrs', 'data-state');
  if (status) {
    own(status, 'attrs', 'id');
    const describedBy = [label ? idOf(label, 'label') : '', idOf(status, 'status')].filter(Boolean).join(' ');
    for (const button of [buttons.replace, buttons.clear, buttons.undo]) {
      if (button && !button.hasAttribute('aria-describedby')) button.setAttribute('aria-describedby', describedBy);
    }
  }

  const words = () => (state === 'clear' ? t('secretCleared') : state === 'empty' ? t('secretNotSet') : t('secretSet'));

  const paint = () => {
    if (root.getAttribute('data-state') !== state) root.setAttribute('data-state', state);
    if (status) status.textContent = words();
    if (hidden) hidden.value = action(state, input?.value);
    if (input) input.disabled = state === 'set' || state === 'clear';
  };

  const go = (next, { focus = null, speak = false } = {}) => {
    if (!STATES.includes(next)) return;
    const changed = next !== state;
    if (next === 'set' || next === 'clear' || (next === 'replace' && state !== 'replace')) {
      if (input) input.value = '';
    }
    state = next;
    const active = root.ownerDocument?.activeElement;
    paint();
    if (focus) {
      focus.focus();
    } else if (active && active !== root && root.contains(active) && (active.disabled || !active.getClientRects?.().length)) {
      // The part that held the focus is gone (set() from a submit while typing a new one): its counterpart takes it.
      (next === 'set' ? buttons.replace : next === 'clear' ? buttons.undo : input)?.focus();
    }
    if (speak && next !== 'replace') announce(words());
    if (!changed || signal?.aborted) return;
    const detail = { state, action: hidden?.value ?? action(state, input?.value) };
    emit(root, 'change', detail);
    listeners.forEach((fn) => fn(detail));
  };

  const on = (target, type, fn) => target?.addEventListener(type, fn, { signal });
  on(buttons.replace, 'click', () => go('replace', { focus: input }));
  on(buttons.cancel, 'click', () => go('set', { focus: buttons.replace, speak: true }));
  on(buttons.clear, 'click', () => go('clear', { focus: buttons.undo, speak: true }));
  on(buttons.undo, 'click', () => go('set', { focus: buttons.replace, speak: true }));
  on(input, 'input', () => { if (hidden) hidden.value = action(state, input.value); });
  on(input, 'keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Escape' || state !== 'replace' || event.defaultPrevented || event.isComposing) return;
    // Cancels the replace; a dialog around it stays open.
    event.preventDefault();
    go('set', { focus: buttons.replace, speak: true });
  });
  on(input?.form, 'reset', () => setTimeout(() => go(start)));
  paint();

  return {
    get() { return { state, stored: state === 'set' || state === 'clear' || state === 'replace', action: action(state, input?.value) }; },
    set(next) { go(next); },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      start = stateOf(root);
      go(start);
    },
    destroy() { listeners.clear(); },
  };
}

/** The state the markup says: "set" (or "true") on data-ds-secret means one is stored. */
function stateOf(root) {
  const value = (root.getAttribute('data-ds-secret') ?? '').trim();
  return value === 'set' || value === 'true' ? 'set' : 'empty';
}

define('secret', {
  attribute: 'data-ds-secret',
  init(el, ctx) {
    return controller(el, stateOf(el), ctx.signal);
  },
});

/**
 * A secret field driven from the page; the same controller the attribute
 * path makes.
 * @param {Element} el  the field (.ds-secret)
 * @param {{ stored?: boolean }} [options]  whether a value is stored (default: data-ds-secret)
 */
export function create(el, options = {}) {
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const start = options.stored === undefined ? stateOf(el) : options.stored ? 'set' : 'empty';
  const made = controller(el, start, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
  };
  return made;
}
