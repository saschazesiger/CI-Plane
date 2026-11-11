/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Password (DS.password): a password field with a reveal button, a strength
 * meter and a caps-lock hint, each optional.
 *
 *   <div class="ds-field" data-ds-password>
 *     <label class="ds-field__label" for="pw">New password</label>
 *     <div class="ds-input-group">
 *       <input class="ds-input" id="pw" type="password" autocomplete="new-password" minlength="12"
 *              aria-describedby="pw-strength pw-caps">
 *       <span class="ds-input-group__trailing">
 *         <button class="ds-btn ds-btn--quiet ds-btn--icon ds-sm" type="button" aria-label="Show password" aria-pressed="false">
 *           <span class="ds-icon-swap"><span class="ds-icon-swap__a">(eye)</span><span class="ds-icon-swap__b">(eyeOff)</span></span></button>
 *       </span>
 *     </div>
 *     <div class="ds-password__meter" id="pw-strength">
 *       <span class="ds-password__bars" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
 *       <span class="ds-password__strength"></span>
 *     </div>
 *     <small class="ds-field__hint ds-field__hint--warning ds-password__caps" id="pw-caps" hidden>(alert)Caps Lock is on.</small>
 *   </div>
 *
 *   const pw = DS.password.create(field, { minLength: 12 });
 *   pw.get();                      // { revealed: false, strength: 2, capsLock: false }
 *   pw.set({ revealed: true });
 *   DS.password.strength('correct horse battery staple');   // 4
 *
 * Reveal: the button with aria-pressed in the field's group toggles the
 * input between password and text (its name stays "Show password", its
 * state is aria-pressed, the icon swap follows), keeps the caret and the
 * selection, turns spell checking and capitalisation off while the text
 * shows (a spell checker may send what it reads to a server), and hides
 * the password again when its form is submitted, so a password manager
 * sees a password field.
 *
 * Strength: strength(value, { minLength }) scores 0 (empty) to 4: shorter
 * than the minimum length (the input's minlength, else data-ds-password-min,
 * else create()'s minLength, else 8)
 * or a common password is 1; otherwise the length times the variety of
 * characters, less for repeats and runs ("aaaa", "1234", "qwerty"). The
 * meter fills that many of its four bars in the level's colour and writes
 * the level in words ("Password strength: Fair"); data-level on the meter
 * (0 to 4) is written here. A changed level is announced once the typing
 * pauses (--ds-delay-tooltip). `options.score(value)` replaces the scoring
 * (a dictionary-based estimator of the page's own).
 *
 * Caps lock: while the field has the focus and Caps Lock is on, the hint
 * shows (hidden goes) and is announced once; it hides on blur. Its text
 * defaults to the string capsLock.
 *
 * The controller: get(), set({ revealed }), on('change' | 'reveal', fn),
 * update() and destroy(). Events on the root: ds:change ({ strength, text })
 * when the level changes, ds:reveal ({ revealed }).
 *
 * Strings: showPassword, capsLock, passwordStrength and strengthWeak,
 * strengthFair, strengthGood, strengthStrong (DS.core.config({ strings })).
 *
 * ES2022. No Progressive: features (an engine that does not report Caps Lock
 * through getModifierState() never shows the hint).
 */
import { define, emit, t } from './core.js';
import { motionDuration } from './motion.js';
import { own } from './dom.js';
import { announce } from './a11y.js';

/** The level words, by score. */
const LEVELS = ['', 'strengthWeak', 'strengthFair', 'strengthGood', 'strengthStrong'];

/** Passwords everyone tries first (lower case, without the digits and marks people add to them). */
const COMMON = new Set(['password', 'passwort', 'qwerty', 'qwertz', 'azerty', 'letmein', 'welcome', 'admin', 'administrator',
  'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'master', 'login', 'abc', 'secret',
  'changeme', 'default', 'root', 'user', 'test', 'guest', 'hello', 'shadow', 'superman', 'trustno']);

/** Keyboard rows and the alphabet and digits in order: runs along them count as one. */
const RUNS = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'qwertzuiop', 'yxcvbnm', 'azertyuiop'];

/**
 * How strong a password is: 0 (empty) to 4 (strong). See the header.
 * @param {string|null|undefined} value
 * @param {{ minLength?: number }} [options]
 * @returns {0|1|2|3|4}
 */
export function strength(value, options = {}) {
  const text = String(value ?? '');
  if (!text) return 0;
  const chars = [...text];
  const minLength = options.minLength ?? 8;
  if (chars.length < minLength) return 1;
  const core = text.toLowerCase().replace(/[\d\W_]+$/u, '').replace(/^[\d\W_]+/u, '');
  if (COMMON.has(core) || COMMON.has(text.toLowerCase()) || /^(.)\1*$/u.test(text)) return 1;
  let pool = 0;
  if (/[a-z]/.test(text)) pool += 26;
  if (/[A-Z]/.test(text)) pool += 26;
  if (/\d/.test(text)) pool += 10;
  if (/[^\w\s]|_/.test(text)) pool += 33;
  if (/\s/.test(text)) pool += 1;
  if (/[^\p{ASCII}]/u.test(text)) pool += 40;
  // Every character after the first in a repeat or a run adds little: count it as a quarter.
  const lower = text.toLowerCase();
  let weight = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const previous = lower[index - 1];
    const char = lower[index];
    const repeat = previous === char;
    const run = previous !== undefined && RUNS.some((row) => {
      const at = row.indexOf(previous);
      return at >= 0 && (row[at + 1] === char || (at > 0 && row[at - 1] === char));
    });
    weight += repeat || run ? 0.25 : 1;
  }
  const bits = weight * Math.log2(Math.max(pool, 2));
  if (bits < 36) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}

/** Sets an attribute only when it changes. */
function write(el, name, value) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function controller(root, options, signal) {
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('input.ds-input, input[type="password"]'));
  if (!input) return { get: () => ({ revealed: false, strength: 0, capsLock: false }), set() {}, on: () => () => {}, update() {}, destroy() {} };
  const toggle = /** @type {HTMLButtonElement|null} */ (root.querySelector('button[aria-pressed]'));
  const meter = root.querySelector('.ds-password__meter');
  const word = root.querySelector('.ds-password__strength');
  const caps = /** @type {HTMLElement|null} */ (root.querySelector('.ds-password__caps'));
  const listeners = { change: new Set(), reveal: new Set() };
  let settings = { ...options };
  let revealed = false;
  let level = -1;
  let capsOn = false;
  let said = null;
  let spokeCaps = false;

  for (const name of ['type', 'spellcheck', 'autocapitalize', 'aria-describedby']) own(input, 'attrs', name);
  if (toggle) {
    own(toggle, 'attrs', 'aria-pressed');
    if (!toggle.hasAttribute('aria-label') && !toggle.textContent.trim()) toggle.setAttribute('aria-label', t('showPassword'));
    if (!input.id) input.id = `ds-password-${(seq += 1)}`;
    if (!toggle.hasAttribute('aria-controls')) toggle.setAttribute('aria-controls', input.id);
  }
  if (meter) own(meter, 'attrs', 'data-level');
  if (caps) {
    own(caps, 'attrs', 'hidden');
    if (!caps.textContent.trim()) caps.append(t('capsLock'));
  }

  const tell = (type, detail) => {
    if (signal?.aborted) return;
    emit(root, type, detail);
    listeners[type].forEach((fn) => fn(detail));
  };

  // The input's minlength first (the engine enforces it), then data-ds-password-min, then create()'s option.
  const minLength = () => {
    for (const raw of [input.getAttribute('minlength'), root.getAttribute('data-ds-password-min')]) {
      const n = Number.parseInt(raw ?? '', 10);
      if (Number.isInteger(n) && n > 0) return n;
    }
    return settings.minLength ?? 8;
  };

  const score = () => {
    const value = input.value;
    if (typeof settings.score === 'function') {
      const given = Math.round(Number(settings.score(value)));
      return value ? Math.max(1, Math.min(4, Number.isFinite(given) ? given : 1)) : 0;
    }
    return strength(value, { minLength: minLength() });
  };

  const measure = (speak) => {
    if (!meter) return;
    const next = score();
    if (next === level) return;
    level = next;
    const text = next ? t('passwordStrength', { level: t(LEVELS[next]) }) : '';
    write(meter, 'data-level', String(next));
    if (word) word.textContent = text;
    tell('change', { strength: next, text });
    clearTimeout(said);
    if (speak && text) said = setTimeout(() => { if (!signal?.aborted && level === next) announce(text); }, motionDuration(root, '--ds-delay-tooltip'));
  };

  const reveal = (on) => {
    const next = Boolean(on);
    if (next === revealed) return;
    revealed = next;
    const { selectionStart, selectionEnd, selectionDirection } = input;
    input.type = next ? 'text' : 'password';
    if (next) {
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('autocapitalize', 'off');
    } else {
      input.removeAttribute('spellcheck');
      input.removeAttribute('autocapitalize');
    }
    if (input.ownerDocument?.activeElement === input && selectionStart !== null) {
      input.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? 'none');
    }
    if (toggle) write(toggle, 'aria-pressed', String(next));
    tell('reveal', { revealed: next });
  };

  // A hidden element named by aria-describedby is still read: the field names the hint only while it shows.
  const describeCaps = (on) => {
    if (!caps?.id) return;
    const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== caps.id);
    if (on) ids.push(caps.id);
    write(input, 'aria-describedby', ids.length ? ids.join(' ') : null);
  };

  const showCaps = (on) => {
    if (!caps || on === capsOn) return;
    capsOn = on;
    caps.hidden = !on;
    describeCaps(on);
    if (on && !spokeCaps) {
      spokeCaps = true;
      announce(caps.textContent.trim(), { assertive: true });
    }
  };

  const readCaps = (/** @type {KeyboardEvent} */ event) => {
    if (typeof event.getModifierState !== 'function') return;
    showCaps(event.getModifierState('CapsLock'));
  };

  const on = (target, type, fn) => target?.addEventListener(type, fn, { signal });
  on(toggle, 'click', () => reveal(!revealed));
  on(input, 'input', () => measure(true));
  on(input, 'keydown', readCaps);
  on(input, 'keyup', readCaps);
  on(input, 'blur', () => {
    showCaps(false);
    spokeCaps = false;
  });
  on(input.form, 'submit', () => reveal(false));
  on(input.form, 'reset', () => setTimeout(() => measure(false)));
  if (caps) {
    caps.hidden = true;
    describeCaps(false);
  }
  reveal(toggle?.getAttribute('aria-pressed') === 'true');
  measure(false);

  return {
    get() { return { revealed, strength: Math.max(level, 0), capsLock: capsOn }; },
    set(next = {}) {
      if ('revealed' in next) reveal(next.revealed);
    },
    on(type, fn) {
      if (!listeners[type]) return () => {};
      listeners[type].add(fn);
      return () => listeners[type].delete(fn);
    },
    update() {
      level = -1;
      measure(false);
    },
    destroy() {
      clearTimeout(said);
      listeners.change.clear();
      listeners.reveal.clear();
    },
  };
}

/** Numbers the ids this module gives an input without one (aria-controls of the reveal button). */
let seq = 0;

define('password', {
  attribute: 'data-ds-password',
  attributes: ['data-ds-password-min'],
  init(el, ctx) {
    return controller(el, {}, ctx.signal);
  },
});

/**
 * A password field driven from the page; the same controller the attribute
 * path makes.
 * @param {Element} el  the field ([data-ds-password])
 * @param {{ minLength?: number, score?: (value: string) => number }} [options]
 */
export function create(el, options = {}) {
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const made = controller(el, options, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
  };
  return made;
}
