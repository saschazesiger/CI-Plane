/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The question card (DS.question): a question an assistant or agent asks
 * while it works, with options to choose (one or several), an optional
 * answer of one's own, and Answer and Skip.
 *
 *   <form class="ds-question" data-ds-question aria-labelledby="q-title"> ...
 *     <div class="ds-radios ds-question__options" role="radiogroup" aria-labelledby="q-title"> radio cards </div>
 *     <div class="ds-field ds-question__other"> a text field </div>
 *     <p class="ds-field__hint ds-field__hint--error ds-question__error" id="q-error" hidden></p>
 *     <div class="ds-question__actions"><button class="ds-btn ds-btn--filled" type="submit">Answer</button>
 *       <button class="ds-btn ds-btn--text" type="button" data-ds-question-skip>Skip</button></div>
 *     <p class="ds-question__answer" hidden></p>
 *   </form>
 *   const question = DS.question.create(form);
 *   form.addEventListener('ds:answer', (event) => send(event.detail));
 *
 * data-ds-question-state="answered" or "skipped" renders a question from
 * history decided at once: no motion, no announcement, no events.
 *
 * The options are the radios or checkboxes in .ds-question__options; a
 * text field in .ds-question__other is an answer of one's own (typing into
 * it picks a radio whose value is "other", when there is one). Keys: with
 * focus in the card and outside a text field, 1 to 9 pick the option of
 * that number (and focus it); the arrows move within radios as ever.
 *
 * Answer (the form's submit, which never leaves the page): without a
 * choice and without text the .ds-question__error shows the message
 * (string questionRequired, with an icon), the options get aria-invalid
 * and aria-describedby, and focus goes to the first option. With one, the
 * card emits ds:answer (cancelable) with { values, labels, other,
 * skipped: false }; a page that calls preventDefault() keeps it open and
 * settles later with set({ state: 'answered' }). Otherwise it takes
 * data-state="answered": the controls are disabled (the choice stays in
 * view), the actions go (DS.motion.leave()), .ds-question__answer says
 * "Answered: <labels>" (string questionAnswered, with a check) and takes
 * the focus (tabindex="-1") when the focus was in the card, which reads
 * it; otherwise it is announced. ds:change follows with { state }. Skip ([data-ds-question-skip]) does the same with
 * skipped: true and "Skipped" (questionSkipped). set({ state: 'waiting' })
 * opens it again.
 *
 * The controller: get() ({ state, values, labels, other }), set(changes)
 * ({ value } or { values } to pick, { other }, { state }), on('change' |
 * 'answer', fn), destroy().
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { enter, leave } from './motion.js';
import { announce } from './a11y.js';
import { list } from './format.js';
import { alertCircle, ban, checkCircle, iconElement } from './icons.js';

/** The states of a question. */
export const QUESTION_STATES = Object.freeze(['waiting', 'answered', 'skipped']);

/**
 * The line of a decided question: "Answered: A and B" (strings
 * questionAnswered, through DS.format.list()) or "Skipped"; '' while it
 * waits.
 * @param {'waiting'|'answered'|'skipped'} state
 * @param {string[]} [labels]
 * @returns {string}
 */
export function answerText(state, labels = []) {
  if (state === 'skipped') return t('questionSkipped');
  if (state !== 'answered') return '';
  return t('questionAnswered', { answer: list(labels.map((label) => String(label).trim()).filter(Boolean)) });
}

/**
 * The digit key that picks an option: 1 to 9 give 0 to 8, anything else
 * -1 (and any key with a modifier).
 * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean }} event
 * @returns {number}
 */
export function optionIndex(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey) return -1;
  return /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
}

/** Ids for error messages without one. */
let serial = 0;

const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password', '']);
const isTextField = (node) => node?.localName === 'textarea' || node?.isContentEditable || (node?.localName === 'input' && TEXT_TYPES.has(node.type));

/** The label text of an option: its <strong>, else its label's text. */
function labelOf(input) {
  const label = input.closest('label') ?? (input.id ? input.ownerDocument.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null);
  const strong = label?.querySelector('strong');
  return (strong ?? label)?.textContent.trim().replace(/\s+/g, ' ') || input.value;
}

function controller(form, given) {
  // Without the signal of DS.init() (create()), destroy() ends its own.
  const own = given ? null : new AbortController();
  const signal = given ?? own.signal;

  const doc = form.ownerDocument;
  const listeners = { change: new Set(), answer: new Set() };
  let state = 'waiting';
  const disabledByUs = new Set();

  form.querySelector('.ds-question__icon')?.setAttribute('aria-hidden', 'true');
  form.setAttribute('data-state', state);
  form.setAttribute('novalidate', '');

  const part = (name) => form.querySelector(`.ds-question__${name}`);
  const inputs = () => [...(part('options')?.querySelectorAll('input[type="radio"], input[type="checkbox"]') ?? [])];
  const otherField = () => part('other')?.querySelector('input, textarea') ?? null;

  const snapshot = () => {
    const chosen = inputs().filter((input) => input.checked);
    const other = otherField()?.value.trim() ?? '';
    const labels = chosen.filter((input) => !(input.value === 'other' && other)).map(labelOf);
    if (other) labels.push(other);
    return { state, values: chosen.map((input) => input.value), labels, other };
  };

  const tell = (type, detail) => {
    if (signal.aborted) return;
    listeners[type].forEach((fn) => fn(detail));
  };

  const showError = (on) => {
    const error = part('error');
    const group = part('options');
    if (error) {
      if (on) {
        const word = doc.createElement('span');
        word.textContent = t('questionRequired');
        error.replaceChildren(iconElement(alertCircle, 16, undefined, doc), word);
        if (!error.id) error.id = `ds-question-error-${++serial}`;
      }
      error.hidden = !on;
    }
    if (!group) return;
    if (on) {
      group.setAttribute('aria-invalid', 'true');
      if (error) {
        const ids = new Set((group.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
        ids.add(error.id);
        group.setAttribute('aria-describedby', [...ids].join(' '));
      }
    } else {
      group.removeAttribute('aria-invalid');
      if (error?.id) {
        const ids = (group.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== error.id);
        if (ids.length) group.setAttribute('aria-describedby', ids.join(' '));
        else group.removeAttribute('aria-describedby');
      }
    }
  };

  const lock = (on) => {
    const controls = [...inputs(), otherField()].filter(Boolean);
    for (const control of controls) {
      if (on && !control.disabled) {
        control.disabled = true;
        disabledByUs.add(control);
      }
      if (!on && disabledByUs.has(control)) control.disabled = false;
    }
    if (!on) disabledByUs.clear();
  };

  const settle = (next, labels, quiet = false) => {
    if (next === state) return;
    state = next;
    form.setAttribute('data-state', state);
    const actions = part('actions');
    const line = part('answer');
    if (state === 'waiting') {
      lock(false);
      if (line) {
        line.hidden = true;
        line.replaceChildren();
      }
      if (actions) enter(actions);
    } else {
      showError(false);
      if (line) {
        const word = doc.createElement('span');
        word.textContent = answerText(state, labels ?? snapshot().labels);
        line.replaceChildren(iconElement(state === 'answered' ? checkCircle : ban, 16, 'ds-question__glyph', doc), word);
        line.hidden = false;
        if (!line.hasAttribute('tabindex')) line.setAttribute('tabindex', '-1');
      }
      const hadFocus = form.contains(doc.activeElement);
      if (actions && quiet) actions.hidden = true;
      else if (actions) leave(actions, '', { then: 'hide', focus: line });
      lock(true);
      if (hadFocus && line && !line.contains(doc.activeElement)) line.focus();
      // Focus on the line reads it; announced too it would be said twice.
      if (line && !quiet && !hadFocus && !signal.aborted) announce(line.textContent);
    }
    if (signal.aborted || quiet) return;
    const detail = { state };
    emit(form, 'change', detail);
    tell('change', detail);
  };

  const answer = (skipped) => {
    if (state !== 'waiting') return;
    const now = snapshot();
    if (!skipped && !now.values.length && !now.other) {
      showError(true);
      (inputs().find((input) => !input.disabled) ?? otherField())?.focus();
      return;
    }
    const detail = { values: skipped ? [] : now.values, labels: skipped ? [] : now.labels, other: skipped ? '' : now.other, skipped };
    if (!emit(form, 'answer', detail, { cancelable: true })) return;
    tell('answer', detail);
    settle(skipped ? 'skipped' : 'answered', detail.labels);
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    answer(false);
  }, { signal });

  form.addEventListener('click', (event) => {
    const skip = /** @type {Element} */ (event.target)?.closest?.('[data-ds-question-skip]');
    if (skip && form.contains(skip)) answer(true);
  }, { signal });

  form.addEventListener('change', (event) => {
    if (inputs().includes(/** @type {any} */ (event.target)) && part('error') && !part('error').hidden) showError(false);
  }, { signal });

  form.addEventListener('input', (event) => {
    const field = otherField();
    if (event.target !== field) return;
    if (field.value.trim()) {
      const other = inputs().find((input) => input.type === 'radio' && input.value === 'other');
      if (other && !other.checked) other.checked = true;
      if (part('error') && !part('error').hidden) showError(false);
    }
  }, { signal });

  form.addEventListener('keydown', (event) => {
    if (state !== 'waiting' || event.defaultPrevented || isTextField(event.target)) return;
    // Enter on an option answers, as Enter in a text field does.
    if (event.key === 'Enter' && inputs().includes(/** @type {any} */ (event.target))) {
      event.preventDefault();
      answer(false);
      return;
    }
    const index = optionIndex(event);
    const option = index >= 0 ? inputs()[index] : null;
    if (!option || option.disabled) return;
    event.preventDefault();
    option.focus();
    if (option.type === 'radio') {
      if (!option.checked) option.click();
    } else option.click();
  }, { signal });

  const pick = (values) => {
    const wanted = new Set(values.map(String));
    // Radios too: no value clears the group (null), one checks its own.
    for (const input of inputs()) input.checked = wanted.has(input.value);
  };

  const first = form.getAttribute('data-ds-question-state');
  if (first === 'answered' || first === 'skipped') settle(first, undefined, true);

  return {
    get: snapshot,
    set(changes = {}) {
      if ('values' in changes) pick([...(changes.values ?? [])]);
      else if ('value' in changes) pick(changes.value === null || changes.value === undefined ? [] : [changes.value]);
      if ('other' in changes && otherField()) otherField().value = String(changes.other ?? '');
      if (changes.state && QUESTION_STATES.includes(changes.state)) settle(changes.state);
    },
    on(type, fn) {
      if (!(type in listeners)) return () => {};
      listeners[type].add(fn);
      return () => listeners[type].delete(fn);
    },
    destroy() {
      listeners.change.clear();
      listeners.answer.clear();
      own?.abort();
    },
  };
}

define('question', {
  attribute: 'data-ds-question',
  init(el, ctx) {
    const handle = controller(el, ctx.signal);
    ctx.signal?.addEventListener('abort', () => handle.destroy(), { once: true });
    return handle;
  },
});

/**
 * A question card driven from the page; the same controller the attribute
 * path makes; destroy() removes its listeners.
 * @param {Element} form
 */
export function create(form) {
  return controller(form);
}
