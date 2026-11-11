/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Form (DS.form): the two behaviours of a text field that need a script,
 * a growing textarea and a character counter.
 *
 *   <textarea class="ds-input ds-input--grow" rows="1" aria-label="Note"></textarea>
 *     Grows with its text: where field-sizing exists (form.css) the engine
 *     does it; elsewhere DS.dom.autosize() sets the height, for every
 *     textarea.ds-input--grow DS.init() finds (the behaviour "autosize").
 *
 *   <div class="ds-field">
 *     <label class="ds-field__label" for="note">Note</label>
 *     <textarea class="ds-input" id="note" maxlength="200" data-ds-counter aria-describedby="note-hint"></textarea>
 *     <div class="ds-field__foot">
 *       <small class="ds-field__hint" id="note-hint">Shown to the next person.</small>
 *       <span class="ds-field__counter" aria-hidden="true"></span>
 *     </div>
 *   </div>
 *
 *   DS.form.count('Dock in room B', 200);   // { length: 14, max: 200, remaining: 186, over: false }
 *   const counter = DS.form.counter(textarea);
 *   counter.get();                          // the same, for the field's value
 *
 * Counter (data-ds-counter on the input or textarea): the limit is
 * maxlength, else data-ds-counter-max (a soft limit: typing past it is
 * allowed and shows). The counter is the .ds-field__counter of the field,
 * or the element whose id data-ds-counter names. It reads "14 / 200" in the
 * locale's digits, takes .ds-field__counter--over past the limit (the class
 * is the system's while it runs) and stays aria-hidden: what a reader needs
 * is said once, when the text comes near the limit (at most
 * data-ds-counter-warn characters left, default a tenth of the limit, at
 * least 5) and when it goes past it, never on each key. Without a limit it
 * counts characters ("14").
 *
 * Length: what maxlength counts, UTF-16 code units, so the figure and the
 * engine's own limit agree.
 *
 * Events: ds:change ({ length, max, remaining, over }) on the field after
 * each input that changed the length.
 *
 * Strings: charactersLeft ("{count} characters left"), charactersLeftOne,
 * charactersOver ("{count} characters too many"), charactersOverOne
 * (DS.core.config({ strings })).
 *
 * ES2022. Progressive: field-sizing (CSS; DS.dom.autosize() is the fallback
 * and steps aside where it exists).
 */
import { define, emit, t } from './core.js';
import { autosize, own, disown } from './dom.js';
import { announce } from './a11y.js';
import { number, plural } from './format.js';

/**
 * The length of a value against a limit.
 * @param {string|null|undefined} value
 * @param {number|null|undefined} max  the limit; none counts only
 * @returns {{ length: number, max: number|null, remaining: number|null, over: boolean }}
 */
export function count(value, max) {
  const length = String(value ?? '').length;
  const limit = Number.isFinite(Number(max)) && Number(max) >= 0 && max !== null && max !== '' ? Math.floor(Number(max)) : null;
  if (limit === null) return { length, max: null, remaining: null, over: false };
  return { length, max: limit, remaining: limit - length, over: length > limit };
}

/** The limit a field states: maxlength, else data-ds-counter-max. */
function limitOf(field) {
  const hard = field.getAttribute?.('maxlength');
  if (hard !== null && hard !== undefined && hard !== '' && Number(hard) >= 0) return Number(hard);
  const soft = field.getAttribute?.('data-ds-counter-max');
  return soft !== null && soft !== undefined && soft !== '' && Number(soft) >= 0 ? Number(soft) : null;
}

/** How close to the limit a field warns: data-ds-counter-warn, else a tenth of it, at least 5. */
function warnOf(field, max) {
  const given = Number(field.getAttribute?.('data-ds-counter-warn'));
  if (Number.isFinite(given) && given >= 0 && field.hasAttribute?.('data-ds-counter-warn')) return given;
  return Math.max(5, Math.round(max / 10));
}

function counterController(field, signal) {
  const doc = field.ownerDocument;
  const named = field.getAttribute?.('data-ds-counter');
  const output = /** @type {HTMLElement|null} */ ((named && doc?.getElementById?.(named)) || field.closest?.('.ds-field')?.querySelector('.ds-field__counter') || null);
  const listeners = new Set();
  let last = /** @type {ReturnType<typeof count>|null} */ (null);
  let zone = 'calm';
  if (output) own(output, 'classes', 'ds-field__counter--over');

  const state = () => count(field.value, limitOf(field));

  const paint = (speak) => {
    const now = state();
    if (output) {
      const text = now.max === null ? number(now.length) : `${number(now.length)} / ${number(now.max)}`;
      if (output.textContent !== text) output.textContent = text;
      output.classList.toggle('ds-field__counter--over', now.over);
    }
    // One announcement per crossing: near the limit, then past it; back under it says nothing.
    const next = now.max === null ? 'calm' : now.over ? 'over' : now.remaining <= warnOf(field, now.max) ? 'near' : 'calm';
    if (speak && next !== zone && next !== 'calm') {
      const amount = next === 'over' ? now.length - /** @type {number} */ (now.max) : /** @type {number} */ (now.remaining);
      announce(next === 'over'
        ? plural(amount, { one: t('charactersOverOne'), other: t('charactersOver') })
        : plural(amount, { one: t('charactersLeftOne'), other: t('charactersLeft') }));
    }
    zone = next;
    if (last && last.length === now.length && last.max === now.max) return;
    const changed = last !== null;
    last = now;
    if (!changed) return;
    emit(field, 'change', now);
    listeners.forEach((fn) => fn(now));
  };

  field.addEventListener?.('input', () => paint(true), { signal });
  field.form?.addEventListener('reset', () => setTimeout(() => paint(false)), { signal });
  doc?.addEventListener?.('ds:config', () => paint(false), { signal });
  paint(false);

  return {
    get() { return state(); },
    set(value) {
      field.value = String(value ?? '');
      paint(false);
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() { paint(false); },
    destroy() {
      listeners.clear();
      if (output) disown(output, 'classes', 'ds-field__counter--over');
    },
  };
}

define('autosize', {
  selector: 'textarea.ds-input--grow',
  init(el) {
    const handle = autosize(/** @type {HTMLTextAreaElement} */ (el));
    return { update: () => handle.update(), destroy: () => handle.destroy() };
  },
});

define('counter', {
  attribute: 'data-ds-counter',
  attributes: ['maxlength', 'data-ds-counter-max', 'data-ds-counter-warn'],
  init(el, ctx) {
    return counterController(el, ctx.signal);
  },
});

/**
 * A character counter driven from the page; the same controller the
 * attribute path makes.
 * @param {Element} el  the input or textarea
 */
export function counter(el) {
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const made = counterController(el, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
  };
  return made;
}
