/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The tag input (DS.taginput): free values typed into one field box, each
 * an input chip before the typing field.
 *
 *   <div class="ds-taginput" data-ds-taginput data-ds-taginput-max="8">
 *     <input class="ds-input ds-taginput__input" id="labels">
 *   </div>
 *
 *   const tags = DS.taginput.create(el, { validate: (text) => /^[a-z0-9-]+$/.test(text) });
 *   tags.get();  tags.set(['printer']);  tags.on('change', ({ value }) => ...);
 *
 * Adding: Enter or a separator (a comma by default, `separators`) turns
 * the typed text into a tag; a pasted text with line breaks, commas,
 * semicolons or tabs becomes several at once; leaving the field adds what
 * is typed (`addOnBlur`, default on). Each tag is trimmed and checked:
 * empty ones are dropped, a repeat (case aside, `unique`) is refused, so is
 * one that `validate(text)` turns down (false, or a message) or that does
 * not match `data-ds-taginput-pattern`, and every tag past `max`. A refused
 * text stays typed, the field takes aria-invalid and the message under the
 * box says why, until the text changes. ds:add ({ text }, cancelable)
 * comes before each tag; ds:change ({ value, added, removed }) after.
 *
 * Removing: a press on a chip (or Enter and Space on it), Backspace in an
 * empty field (the last tag), Backspace and Delete on a focused chip. The
 * arrows walk the chips from the start of the field (ArrowLeft) and back
 * (ArrowRight past the last one), Home and End go to the ends; the chips are
 * no tab stops of their own. Each change is announced ("Added printer").
 * The chips glide through DS.motion.flip().
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { flip } from './motion.js';
import { announce } from './a11y.js';
import { iconElement, close as closeGlyph, alertCircle } from './icons.js';

/** The live controllers. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

let sequence = 0;

/** What separates the tags of a pasted text. */
const PASTE_SPLIT = /[\n\r\t,;]+/;

/**
 * The tags of a typed or pasted text: split on `separators` (and on line
 * breaks, tabs and semicolons for a paste), trimmed, the empty ones gone.
 * @param {string} text
 * @param {string[]} [separators]
 * @returns {string[]}
 */
export function split(text, separators = [',']) {
  const chars = separators.filter((each) => each.length === 1).map((each) => each.replace(/[\\\]^-]/g, '\\$&')).join('');
  const pattern = new RegExp(`[\\n\\r\\t;${chars}]+`);
  return String(text ?? '').split(chars ? pattern : PASTE_SPLIT).map((part) => part.trim()).filter(Boolean);
}

/**
 * Whether `text` may join `value`: `{ ok: true }`, or `{ ok: false, reason,
 * message }` with reason 'empty', 'duplicate', 'invalid' or 'max'.
 * Options: `unique` (default true, case aside), `max`, `pattern` (a RegExp
 * or its source, the whole text must match), `validate(text, value)`
 * (false or a message refuse it).
 * @param {string} text
 * @param {string[]} value
 * @param {{ unique?: boolean, max?: number, pattern?: RegExp|string|null, validate?: (text: string, value: string[]) => boolean|string|void }} [options]
 * @returns {{ ok: boolean, reason?: string, message?: string }}
 */
export function check(text, value, options = {}) {
  const tag = String(text ?? '').trim();
  if (!tag) return { ok: false, reason: 'empty', message: '' };
  if (Number.isFinite(options.max) && value.length >= /** @type {number} */ (options.max)) return { ok: false, reason: 'max', message: t('tagMax', { max: options.max }) };
  if ((options.unique ?? true) && value.some((each) => each.toLowerCase() === tag.toLowerCase())) return { ok: false, reason: 'duplicate', message: t('tagDuplicate', { label: tag }) };
  const pattern = typeof options.pattern === 'string' && options.pattern ? new RegExp(`^(?:${options.pattern})$`, 'u') : options.pattern instanceof RegExp ? options.pattern : null;
  if (pattern && !pattern.test(tag)) return { ok: false, reason: 'invalid', message: t('tagInvalid', { label: tag }) };
  const verdict = typeof options.validate === 'function' ? options.validate(tag, value) : true;
  if (verdict === false) return { ok: false, reason: 'invalid', message: t('tagInvalid', { label: tag }) };
  if (typeof verdict === 'string' && verdict) return { ok: false, reason: 'invalid', message: verdict };
  return { ok: true };
}

/** A value of data-ds-value: a JSON list, else comma-separated. */
function parseValue(text) {
  if (text === null || text === undefined) return [];
  try {
    const list = JSON.parse(text);
    if (Array.isArray(list)) return list.map(String);
  } catch {
    // Comma-separated.
  }
  return split(text);
}

/**
 * The controller of a tag input, the one [data-ds-taginput] makes; once per
 * element. Options: `value` (default data-ds-value), `max`
 * (data-ds-taginput-max), `separators` (characters that end a tag; default
 * [','], data-ds-taginput-separators), `unique` (default true), `pattern`
 * (data-ds-taginput-pattern), `validate(text, value)`, `addOnBlur` (default
 * true), `name` (hidden inputs of that name carry the value in a form;
 * data-ds-taginput-name).
 * @param {Element} element
 * @param {object} [options]
 * @returns {any}
 */
export function create(element, options = {}) {
  const existing = controllers.get(element);
  if (existing) return existing;
  const input = /** @type {HTMLInputElement|null} */ (element?.querySelector?.('.ds-taginput__input'));
  if (!input) return null;
  const doc = element.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  const attr = (name) => element.getAttribute(`data-ds-taginput-${name}`);
  const maxAttr = Number(attr('max'));
  const max = options.max ?? (attr('max') !== null && Number.isFinite(maxAttr) && maxAttr > 0 ? maxAttr : undefined);
  const separators = options.separators ?? (attr('separators') !== null ? [...String(attr('separators'))] : [',']);
  const rules = { unique: options.unique ?? true, max, pattern: options.pattern ?? attr('pattern'), validate: options.validate };
  const addOnBlur = options.addOnBlur ?? true;
  const name = options.name ?? attr('name');
  const id = input.id || `ds-taginput-${(sequence += 1)}`;
  if (!input.id) input.id = id;
  input.setAttribute('autocomplete', 'off');
  if (!input.hasAttribute('enterkeyhint')) input.setAttribute('enterkeyhint', 'enter');

  /** @type {string[]} */
  let value = (options.value ?? parseValue(element.getAttribute('data-ds-value'))).map(String).filter(Boolean);
  if (Number.isFinite(max)) value = value.slice(0, max);
  let destroyed = false;

  /* The message under the box: the system's own part. */
  const message = doc.createElement('p');
  message.className = 'ds-taginput__message';
  message.id = `${id}-message`;
  message.setAttribute('role', 'status');
  element.after(message);
  const described = input.getAttribute('aria-describedby');
  input.setAttribute('aria-describedby', [described, message.id].filter(Boolean).join(' '));

  let invalidByUs = false;
  const disabled = () => input.disabled || input.readOnly || input.getAttribute('aria-disabled') === 'true';
  // A chip that is leaving (DS.motion.flip keeps it for its exit) counts no more.
  const chips = () => /** @type {HTMLButtonElement[]} */ ([...element.querySelectorAll(':scope > .ds-chip[data-ds-taginput-tag]:not([data-ds-leaving])')]);

  function say(text) {
    if (!text) {
      message.replaceChildren();
      if (input.getAttribute('aria-invalid') === 'true' && invalidByUs) input.removeAttribute('aria-invalid');
      invalidByUs = false;
      return;
    }
    message.replaceChildren(iconElement(alertCircle, 16, '', doc), doc.createTextNode(text));
    if (!input.hasAttribute('aria-invalid') || invalidByUs) {
      input.setAttribute('aria-invalid', 'true');
      invalidByUs = true;
    }
  }

  function chipFor(tag) {
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = 'ds-chip ds-chip--input';
    chip.setAttribute('data-ds-taginput-tag', '');
    chip.setAttribute('data-value', tag);
    chip.tabIndex = -1;
    chip.disabled = input.disabled;
    const body = doc.createElement('span');
    body.className = 'ds-chip__body';
    const label = doc.createElement('span');
    label.className = 'ds-chip__label';
    // A read-only box shows its tags: no "Remove", no cross.
    if (input.readOnly) label.append(doc.createTextNode(tag));
    else {
      const sr = doc.createElement('span');
      sr.className = 'ds-sr';
      sr.textContent = `${t('remove')} `;
      label.append(sr, doc.createTextNode(tag));
    }
    body.append(label);
    if (!input.readOnly) body.append(iconElement(closeGlyph, 18, 'ds-chip__trailing', doc));
    chip.append(body);
    return chip;
  }

  /** The chips as the value says, in its order (new ones fade in, gone ones leave). */
  function renderChips() {
    const have = new Map(chips().map((chip) => [chip.getAttribute('data-value'), chip]));
    for (const [tag, chip] of have) if (!value.includes(tag)) chip.remove();
    let before = /** @type {Element} */ (input);
    for (let i = value.length - 1; i >= 0; i -= 1) {
      const chip = have.get(value[i]) ?? chipFor(value[i]);
      chip.disabled = input.disabled;
      if (chip.nextElementSibling !== before) before.before(chip);
      before = chip;
    }
  }

  function sync() {
    element.classList.toggle('ds-taginput--full', Number.isFinite(max) && value.length >= /** @type {number} */ (max));
    if (!name) return;
    let holder = element.querySelector(':scope > [data-ds-taginput-values]');
    if (!holder) {
      holder = doc.createElement('span');
      holder.hidden = true;
      holder.setAttribute('data-ds-taginput-values', '');
      element.append(holder);
    }
    holder.replaceChildren(...value.map((each) => {
      const field = doc.createElement('input');
      field.type = 'hidden';
      field.name = name;
      field.value = each;
      return field;
    }));
  }

  /** Changes the value with the chips' glide; `focus` is where the focus goes when a focused chip left. */
  function update(next, change, focus) {
    value = next;
    const done = flip(element, () => renderChips(), { items: '.ds-chip', refocus: focus ?? input });
    sync();
    emit(element, 'change', { value: [...value], ...change });
    return done;
  }

  /**
   * Adds the tags of `text`; returns what stayed (refused text). Each is
   * checked against the value as it grows, so a pasted list stops at the
   * maximum with the rest kept typed.
   */
  function addText(text, pasted = false) {
    const parts = pasted ? split(text, separators) : [String(text).trim()].filter(Boolean);
    const added = [];
    const kept = [];
    let why = '';
    let next = [...value];
    for (const part of parts) {
      const verdict = check(part, next, rules);
      if (!verdict.ok) {
        kept.push(part);
        why ||= verdict.message ?? '';
        continue;
      }
      if (!emit(element, 'add', { text: part }, { cancelable: true })) {
        kept.push(part);
        continue;
      }
      next = [...next, part];
      added.push(part);
    }
    if (added.length) {
      update(next, { added, removed: [] });
      announce(added.map((label) => t('added', { label })).join('. '));
    }
    say(why);
    return kept.join(pasted ? ', ' : '');
  }

  function remove(tag, focus) {
    if (!value.includes(tag) || disabled()) return;
    say('');
    update(value.filter((each) => each !== tag), { added: [], removed: [tag] }, focus);
    announce(t('removed', { label: tag }));
  }

  /* The field. */
  input.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.isComposing || disabled()) return;
    const k = event.key;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    if (k === 'Enter' || (separators.includes(k) && !event.ctrlKey && !event.metaKey)) {
      if (!input.value.trim()) {
        // An empty Enter submits the form as a field would; a lone separator types nothing.
        if (k !== 'Enter') event.preventDefault();
        return;
      }
      event.preventDefault();
      input.value = addText(input.value);
      return;
    }
    if (k === 'Backspace' && !input.value && value.length) {
      event.preventDefault();
      remove(value[value.length - 1], input);
      return;
    }
    if ((k === 'ArrowLeft' || k === 'Home') && atStart && value.length && !event.shiftKey) {
      if (k === 'Home' && !input.value) return focusChip(0, event);
      if (k === 'ArrowLeft') return focusChip(value.length - 1, event);
    }
  }, { signal });

  function focusChip(index, event) {
    const list = chips();
    const chip = list[Math.max(0, Math.min(list.length - 1, index))];
    if (!chip) return;
    event?.preventDefault();
    chip.focus();
  }

  input.addEventListener('input', () => {
    if (message.firstChild) say('');
    // A separator that came another way (a phone keyboard's suggestion, a drop).
    if (separators.some((each) => input.value.includes(each))) {
      const last = input.value.slice(-1);
      const done = separators.includes(last);
      const parts = split(input.value, separators);
      const rest = done ? '' : parts.pop() ?? '';
      const kept = parts.length ? addText(parts.join('\n'), true) : '';
      input.value = [kept, rest].filter(Boolean).join(', ');
    }
  }, { signal });

  input.addEventListener('paste', (/** @type {ClipboardEvent} */ event) => {
    if (disabled()) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!PASTE_SPLIT.test(text) && !separators.some((each) => text.includes(each))) return;
    event.preventDefault();
    const typed = input.value.slice(0, input.selectionStart ?? input.value.length) + text + input.value.slice(input.selectionEnd ?? input.value.length);
    input.value = addText(typed, true);
  }, { signal });

  input.addEventListener('blur', (/** @type {FocusEvent} */ event) => {
    if (!addOnBlur || disabled() || !input.value.trim()) return;
    // Walking into the chips with the keys is no leaving: the half-typed text waits.
    const next = /** @type {Element|null} */ (event.relatedTarget);
    if (next?.closest?.('.ds-chip[data-ds-taginput-tag]')?.parentElement === element) return;
    input.value = addText(input.value);
  }, { signal });

  /* The chips: one press removes; keys walk and remove. */
  element.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const chip = /** @type {Element} */ (event.target)?.closest?.('.ds-chip[data-ds-taginput-tag]');
    if (!chip || chip.parentElement !== element || disabled()) return;
    const list = chips();
    const at = list.indexOf(/** @type {HTMLButtonElement} */ (chip));
    // A chip that held the focus hands it on (the next, else the one before, else the field); a press keeps it in the field.
    const fromKeys = doc.activeElement === chip && event.detail === 0;
    remove(chip.getAttribute('data-value'), fromKeys ? (list[at + 1] ?? list[at - 1] ?? input) : input);
    if (!fromKeys) input.focus({ preventScroll: true });
  }, { signal });

  element.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    const chip = /** @type {Element} */ (event.target)?.closest?.('.ds-chip[data-ds-taginput-tag]');
    if (!chip || event.defaultPrevented) return;
    const list = chips();
    const at = list.indexOf(/** @type {HTMLButtonElement} */ (chip));
    const k = event.key;
    if (k === 'ArrowLeft') focusChip(at - 1, event);
    else if (k === 'ArrowRight') {
      event.preventDefault();
      if (at + 1 < list.length) list[at + 1].focus();
      else input.focus();
    } else if (k === 'Home') focusChip(0, event);
    else if (k === 'End') {
      event.preventDefault();
      input.focus();
    } else if (k === 'Backspace' || k === 'Delete') {
      event.preventDefault();
      const next = k === 'Backspace' ? list[at - 1] ?? list[at + 1] ?? input : list[at + 1] ?? input;
      remove(chip.getAttribute('data-value'), next);
    }
  }, { signal });

  // The box looks like one field: a press on an empty part of it goes to the field.
  element.addEventListener('mousedown', (event) => {
    if (event.target !== element) return;
    event.preventDefault();
    input.focus();
  }, { signal });

  renderChips();
  sync();

  const controller = {
    element,
    /** The tags, in their order. */
    get: () => [...value],
    /** Sets the tags from the page (no event; no check). */
    set(next) {
      value = [...new Set([].concat(next ?? []).map(String).filter(Boolean))];
      if (Number.isFinite(max)) value = value.slice(0, max);
      say('');
      renderChips();
      sync();
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === element) fn(event.detail);
      };
      element.addEventListener(`ds:${type}`, listener);
      return () => element.removeEventListener(`ds:${type}`, listener);
    },
    /** Adds tags as the user would (checked, announced, with ds:add and ds:change); returns the refused text. */
    add: (text) => addText(Array.isArray(text) ? text.join('\n') : String(text ?? ''), true),
    /** Removes a tag as the user would. */
    remove: (tag) => remove(String(tag), input),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      message.remove();
      if (described) input.setAttribute('aria-describedby', described);
      else input.removeAttribute('aria-describedby');
      if (invalidByUs) input.removeAttribute('aria-invalid');
      controllers.delete(element);
    },
  };
  controllers.set(element, controller);
  return controller;
}

define('taginput', {
  attribute: 'data-ds-taginput',
  init: (element) => create(element),
});
