/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * One-time code and PIN (DS.otp): n cells of one character each, with
 * auto-advance, paste and the browser's one-time-code autofill.
 *
 *   <div class="ds-field">
 *     <span class="ds-field__label" id="code-l">Verification code</span>
 *     <div class="ds-otp" role="group" aria-labelledby="code-l" aria-describedby="code-hint" data-ds-otp>
 *       <input class="ds-input ds-otp__cell" inputmode="numeric" autocomplete="one-time-code">
 *       <input class="ds-input ds-otp__cell" inputmode="numeric" autocomplete="off"> ... (6 in all)
 *       <span class="ds-otp__sep" aria-hidden="true"></span>   (optional, between two groups)
 *       <input type="hidden" name="code">
 *     </div>
 *     <small class="ds-field__hint" id="code-hint">Sent to the phone ending in 42.</small>
 *   </div>
 *
 *   const code = DS.otp.create(group);
 *   code.get();            // '1234' (what the cells hold, in order)
 *   code.set('123456');    // fills the cells
 *   DS.otp.clean('12 34-56', { type: 'numeric', length: 6 });   // '123456'
 *
 * Options: data-ds-otp-type ("numeric", the default; "alphanumeric", which
 * also upper-cases), data-ds-otp-mask (a PIN: the cells become password
 * fields), data-ds-otp-submit (the form is submitted once every cell is
 * full). aria-invalid on the group is copied to every cell. The cells
 * are the page's markup; this module numbers them (each gets "Digit 3 of
 * 6" as its name unless it has one), keeps the hidden input's value and,
 * on a mask, the type.
 *
 * Keys (the APG has no pattern for split fields: each cell is a text field
 * of one character in a named group, so a reader hears "Verification code,
 * group, Digit 1 of 6, edit text"): a character the type allows fills the cell and moves
 * to the next; any other is ignored. Backspace in an empty cell clears the
 * one before and moves there; Delete clears the cell and keeps it;
 * Left and Right move by one, Home and End to the first and the last. A
 * cell selects its character on focus, so typing replaces it.
 *
 * Paste and autofill: several characters arriving in one cell (a paste, the
 * SMS code iOS and Android offer for autocomplete="one-time-code") are
 * cleaned (spaces and dashes go, characters the type does not allow too) and
 * spread from that cell on, or from the first when they fill every cell.
 *
 * Events on the group: ds:change ({ value, complete }) after each change,
 * ds:complete ({ value }) when the last empty cell is filled.
 *
 * Strings: otpDigit ("Digit {index} of {count}") and otpCharacter
 * ("Character {index} of {count}") name the cells (DS.core.config({ strings })).
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { own } from './dom.js';

/** What each type lets through, one character at a time. */
const ALLOWED = {
  numeric: /^[0-9]$/,
  alphanumeric: /^[0-9A-Za-z]$/,
};

/**
 * A pasted or typed text as the cells take it: separators and characters the
 * type does not allow go, letters are upper-cased on alphanumeric, cut to
 * `length` when it is given.
 * @param {string|null|undefined} text
 * @param {{ type?: 'numeric'|'alphanumeric', length?: number }} [options]
 * @returns {string}
 */
export function clean(text, options = {}) {
  const allowed = ALLOWED[options.type ?? 'numeric'] ?? ALLOWED.numeric;
  // Digits of other scripts (Arabic-Indic, Devanagari ...) arrive from some keyboards: each script's ten digits are
  // consecutive, so a digit's value is how many digits precede it in its run (NFKC already made full-width ones ASCII).
  const ascii = String(text ?? '').normalize('NFKC').replace(/\p{Nd}/gu, (d) => {
    const code = d.codePointAt(0) ?? 48;
    let steps = 0;
    while (steps < 9 && /\p{Nd}/u.test(String.fromCodePoint(code - steps - 1))) steps += 1;
    return String(steps);
  });
  let out = '';
  for (const char of ascii) {
    const c = options.type === 'alphanumeric' ? char.toUpperCase() : char;
    if (allowed.test(c)) out += c;
  }
  return options.length ? out.slice(0, options.length) : out;
}

function typeOf(root) {
  return root.getAttribute('data-ds-otp-type') === 'alphanumeric' ? 'alphanumeric' : 'numeric';
}

function controller(root, signal) {
  const cells = /** @type {HTMLInputElement[]} */ ([...root.querySelectorAll('input.ds-otp__cell')]);
  const hidden = /** @type {HTMLInputElement|null} */ (root.querySelector('input[type="hidden"]'));
  const listeners = { change: new Set(), complete: new Set() };
  const count = cells.length;
  let type = typeOf(root);
  let last = '';

  const value = () => cells.map((cell) => cell.value).join('');
  const full = () => cells.every((cell) => cell.value !== '');

  const name = () => {
    const key = type === 'alphanumeric' ? 'otpCharacter' : 'otpDigit';
    cells.forEach((cell, index) => {
      if (cell.hasAttribute('aria-label') && !cell.hasAttribute('data-ds-otp-named')) return;
      cell.setAttribute('aria-label', t(key, { index: index + 1, count }));
      cell.setAttribute('data-ds-otp-named', '');
    });
  };

  const setup = () => {
    type = typeOf(root);
    const mask = root.hasAttribute('data-ds-otp-mask');
    const invalid = root.getAttribute('aria-invalid') === 'true';
    cells.forEach((cell, index) => {
      own(cell, 'attrs', 'type');
      cell.type = mask ? 'password' : 'text';
      if (!cell.hasAttribute('inputmode')) cell.setAttribute('inputmode', type === 'numeric' ? 'numeric' : 'text');
      if (!cell.hasAttribute('autocomplete')) cell.setAttribute('autocomplete', index === 0 ? 'one-time-code' : 'off');
      cell.setAttribute('autocapitalize', type === 'alphanumeric' ? 'characters' : 'off');
      cell.spellcheck = false;
      cell.setAttribute('autocorrect', 'off');
      // The group's aria-invalid reaches every cell: each is a field a reader lands in.
      if (invalid) {
        cell.setAttribute('aria-invalid', 'true');
        cell.setAttribute('data-ds-otp-invalid', '');
      } else if (cell.hasAttribute('data-ds-otp-invalid')) {
        cell.removeAttribute('aria-invalid');
        cell.removeAttribute('data-ds-otp-invalid');
      }
    });
    name();
  };

  const tell = () => {
    const now = value();
    if (hidden) hidden.value = now;
    if (now === last) return;
    const complete = full();
    const wasComplete = last.length === count && count > 0;
    last = now;
    const detail = { value: now, complete };
    emit(root, 'change', detail);
    listeners.change.forEach((fn) => fn(detail));
    if (complete && !wasComplete) {
      emit(root, 'complete', { value: now });
      listeners.complete.forEach((fn) => fn({ value: now }));
      if (root.hasAttribute('data-ds-otp-submit')) {
        const form = cells[0]?.form;
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      }
    }
  };

  const focusCell = (index) => {
    const cell = cells[Math.max(0, Math.min(count - 1, index))];
    if (!cell) return;
    cell.focus();
    cell.select?.();
  };

  /** Spreads characters from a cell on; a whole code always starts at the first. */
  const spread = (from, text) => {
    const chars = clean(text, { type });
    if (!chars) return;
    const start = chars.length >= count ? 0 : from;
    [...chars.slice(0, count - start)].forEach((char, offset) => { cells[start + offset].value = char; });
    const next = cells.findIndex((cell, index) => index >= start && cell.value === '');
    focusCell(next === -1 ? Math.min(count - 1, start + chars.length - 1) : next);
    tell();
  };

  const on = (target, kind, fn) => target?.addEventListener(kind, fn, { signal });
  cells.forEach((cell, index) => {
    on(cell, 'focus', () => cell.select?.());
    on(cell, 'beforeinput', (/** @type {InputEvent} */ event) => {
      if (event.inputType !== 'insertText' || event.data == null || event.isComposing) return;
      // One character typed: it replaces the cell's whole content and moves on; others never land.
      event.preventDefault();
      const char = clean(event.data, { type });
      if (char.length > 1) {
        spread(index, char);
        return;
      }
      if (!char) return;
      cell.value = char;
      if (index < count - 1) focusCell(index + 1);
      else cell.select?.();
      tell();
    });
    on(cell, 'input', () => {
      // A paste, an autofill or an engine without beforeinput: several characters, or one not allowed.
      const raw = cell.value;
      if (raw.length > 1 || (raw && !clean(raw, { type }))) {
        cell.value = '';
        spread(index, raw);
        tell();
        return;
      }
      if (raw && clean(raw, { type }) !== raw) cell.value = clean(raw, { type });
      if (cell.value && index < count - 1) focusCell(index + 1);
      tell();
    });
    on(cell, 'paste', (/** @type {ClipboardEvent} */ event) => {
      const text = event.clipboardData?.getData('text') ?? '';
      if (!text) return;
      event.preventDefault();
      spread(index, text);
    });
    on(cell, 'keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const go = (to) => { event.preventDefault(); focusCell(to); };
      switch (event.key) {
        case 'Backspace':
          if (cell.value) {
            event.preventDefault();
            cell.value = '';
            tell();
          } else if (index > 0) {
            event.preventDefault();
            cells[index - 1].value = '';
            focusCell(index - 1);
            tell();
          }
          break;
        case 'Delete':
          event.preventDefault();
          cell.value = '';
          tell();
          break;
        case 'ArrowLeft': go(index - 1); break;
        case 'ArrowRight': go(index + 1); break;
        case 'Home': go(0); break;
        case 'End': go(count - 1); break;
        default: break;
      }
    });
  });
  on(cells[0]?.form, 'reset', () => setTimeout(() => {
    // The cells are back at their markup values: no change to report, the hidden value follows.
    last = value();
    if (hidden) hidden.value = last;
  }));
  // Another language: the cells' names follow.
  on(root.ownerDocument, 'ds:config', () => name());

  setup();
  last = value();
  if (hidden) hidden.value = last;

  return {
    get() { return value(); },
    set(next) {
      const chars = clean(next, { type, length: count });
      cells.forEach((cell, index) => { cell.value = chars[index] ?? ''; });
      tell();
    },
    clear() {
      cells.forEach((cell) => { cell.value = ''; });
      tell();
      focusCell(0);
    },
    focus() {
      const empty = cells.findIndex((cell) => cell.value === '');
      focusCell(empty === -1 ? count - 1 : empty);
    },
    on(kind, fn) {
      const set = listeners[kind];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    update() { setup(); },
    destroy() {
      listeners.change.clear();
      listeners.complete.clear();
    },
  };
}

define('otp', {
  attribute: 'data-ds-otp',
  attributes: ['data-ds-otp-type', 'data-ds-otp-mask', 'aria-invalid'],
  init(el, ctx) {
    return controller(el, ctx.signal);
  },
});

/**
 * A code field driven from the page; the same controller the attribute path
 * makes.
 * @param {Element} el  the group (.ds-otp) with its cells
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
