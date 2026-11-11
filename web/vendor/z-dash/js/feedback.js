/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Feedback (DS.feedback): thumbs up and down on a reply, .ds-feedback,
 * with an optional dialog that asks why.
 *
 *   <div class="ds-feedback" role="group" aria-label="Rate this answer" data-ds-feedback
 *     data-ds-feedback-reason="reason-dialog"> (two buttons with data-ds-feedback-value) </div>
 *   el.addEventListener('ds:feedback', ({ detail }) => save(detail.value, detail.reasons, detail.comment));
 *
 * - The buttons with data-ds-feedback-value ("up", "down", or any value)
 *   are toggles: a press turns its aria-pressed on and the others off; a
 *   press on the one that is on turns it off. Each change dispatches
 *   ds:change ({ value, previous }), value null when none is on. It
 *   bubbles through a message, whose own ds:change has { state, previous }:
 *   a listener above both checks event.target.
 * - A value that is on is feedback: ds:feedback ({ value, reasons,
 *   comment }) follows, the string feedbackThanks is announced and written
 *   into .ds-feedback__status when there is one. With
 *   data-ds-feedback-lock both buttons turn aria-disabled once it is given.
 * - The reason dialog: data-ds-feedback-reason="<id>" names a .ds-dialog
 *   (any markup DS.overlay opens) holding a form; it opens for "down"
 *   (data-ds-feedback-reason-for="up", "down" or "both"), its form reset,
 *   with the pressed button as its opener. Its submit is taken here (no
 *   data-ds-dialog-form needed): the checked "reason" fields and the
 *   "comment" field go into ds:feedback, and it closes. Closed without a
 *   submit (Cancel, Escape), ds:feedback goes with no reasons: the thumb
 *   still counts.
 *
 * The controller: get() ({ value }), set(value) (null for none; no
 * ds:feedback), on(type, fn) for change and feedback, destroy().
 */
import { define, emit, t } from './core.js';
import { open as openOverlay, close as closeOverlay } from './overlay.js';
import { announce } from './a11y.js';

/** The events a controller's on() takes. */
const EVENTS = new Set(['change', 'feedback']);

/**
 * The value after a press: `pressed` turns on, or off when it is `current`.
 * @param {string|null} current
 * @param {string} pressed
 * @returns {string|null}
 */
export function toggle(current, pressed) {
  return current === pressed ? null : pressed;
}

/**
 * Whether the reason dialog opens for `value`, as `when` ("up", "down",
 * "both"; default "down") says.
 * @param {string|null} value
 * @param {string|null} [when]
 * @returns {boolean}
 */
export function asks(value, when) {
  if (!value) return false;
  const rule = when || 'down';
  return rule === 'both' || rule === value;
}

function controller(el) {
  const doc = el.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  const listeners = new Map();
  const buttons = () => Array.from(el.querySelectorAll('[data-ds-feedback-value]')).filter((button) => button.closest('.ds-feedback, [data-ds-feedback]') === el);
  const pressedValue = () => buttons().find((button) => button.getAttribute('aria-pressed') === 'true')?.getAttribute('data-ds-feedback-value') ?? null;
  let value = pressedValue();
  let asking = null;

  const fire = (type, detail) => {
    emit(el, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  };

  function show(next) {
    for (const button of buttons()) button.setAttribute('aria-pressed', String(button.getAttribute('data-ds-feedback-value') === next));
  }

  function change(next) {
    const previous = value;
    value = next;
    show(value);
    if (previous !== value) fire('change', { value, previous });
  }

  function given(detail) {
    fire('feedback', detail);
    const thanks = t('feedbackThanks');
    const status = el.querySelector('.ds-feedback__status');
    if (status) status.textContent = thanks;
    announce(thanks);
    if (el.hasAttribute('data-ds-feedback-lock')) for (const button of buttons()) button.setAttribute('aria-disabled', 'true');
  }

  function ask(dialog, opener, chosen) {
    const form = dialog.querySelector('form');
    form?.reset();
    const record = { value: chosen, data: null };
    asking = record;
    const onSubmit = (event) => {
      if (event.target !== form) return;
      event.preventDefault();
      event.stopPropagation();
      record.data = new FormData(form, /** @type {any} */ (event).submitter ?? undefined);
      closeOverlay(dialog, { reason: 'submit' });
    };
    const onClose = () => {
      form?.removeEventListener('submit', onSubmit, true);
      dialog.removeEventListener('submit', onSubmit, true);
      if (asking === record) asking = null;
      if (signal.aborted) return;
      const reasons = record.data ? record.data.getAll('reason').map(String) : [];
      const comment = record.data ? String(record.data.get('comment') ?? '').trim() : '';
      given({ value: record.value, reasons, comment });
    };
    dialog.addEventListener('submit', onSubmit, { capture: true });
    dialog.addEventListener('ds:close', onClose, { once: true });
    openOverlay(dialog, { opener });
  }

  const onClick = (event) => {
    const button = /** @type {Element} */ (event.target).closest?.('[data-ds-feedback-value]');
    if (!button || !buttons().includes(button)) return;
    if (button.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]')) return;
    const next = toggle(value, button.getAttribute('data-ds-feedback-value'));
    change(next);
    if (!next) {
      const status = el.querySelector('.ds-feedback__status');
      if (status) status.textContent = '';
      return;
    }
    const id = el.getAttribute('data-ds-feedback-reason');
    const dialog = id ? doc.getElementById(id) : null;
    if (dialog && asks(next, el.getAttribute('data-ds-feedback-reason-for'))) ask(dialog, button, next);
    else given({ value: next, reasons: [], comment: '' });
  };
  el.addEventListener('click', onClick, { signal });

  show(value);

  return {
    get() {
      return { value };
    },
    set(next) {
      change(next == null || next === '' ? null : String(next));
    },
    on(type, fn) {
      if (!EVENTS.has(type) || typeof fn !== 'function') return () => {};
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      listeners.clear();
      asking = null;
    },
  };
}

/** The controller of each pair, so create() and the attribute path share one. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

function controllerOf(el) {
  const held = controllers.get(el);
  if (held) return held;
  const handle = controller(el);
  const destroy = handle.destroy;
  handle.destroy = () => {
    if (controllers.get(el) === handle) controllers.delete(el);
    destroy();
  };
  controllers.set(el, handle);
  return handle;
}

define('feedback', {
  attribute: 'data-ds-feedback',
  init(el) {
    return controllerOf(el);
  },
});

/**
 * The controller of a feedback pair driven from the page: the same one
 * the attribute path makes (one per element).
 * @param {Element} el
 */
export function create(el) {
  return controllerOf(el);
}
