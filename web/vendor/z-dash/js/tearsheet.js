/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The tearsheet (DS.tearsheet): a tall create or edit flow in a modal
 * dialog, with steps, its own head and foot, stacking over another
 * tearsheet, and unsaved changes guarded. DS.overlay opens and closes it
 * (the stack, the trap, focus return, Escape, the scroll lock, the exit).
 *
 *   <button data-ds-open="#add-device">Add a device</button>
 *   <dialog class="ds-dialog ds-tearsheet" id="add-device" aria-labelledby="t" data-ds-tearsheet>...</dialog>
 *
 *   DS.tearsheet.open(sheet, { opener });       // DS.overlay.open, at its first step
 *   DS.tearsheet.close(sheet);                  // asks first while it has unsaved changes
 *   const flow = DS.tearsheet.create(sheet);    // get(), set(), next(), back(), on(), destroy()
 *   sheet.addEventListener('ds:submit', (event) => event.detail.wait(api.save(event.detail.data)));
 *
 * Steps: the .ds-tearsheet__step sections of its body, one shown at a time
 * (`hidden` on the others, written by this module), the rail's .ds-steps
 * items in step (aria-current="step" on the current one, data-status
 * "done" on those before it, their marks a drawn check or the number),
 * the progress line (.ds-tearsheet__progress, the string stepOf) and the
 * foot's buttons: [data-ds-tearsheet-back] hidden on the first step,
 * [data-ds-tearsheet-next] hidden on the last, [data-ds-tearsheet-submit]
 * shown only there. Next checks the current step first: its controls'
 * constraint validation (the first invalid one reports and takes focus,
 * the rail marks the step "error" with its icon and word) and a cancelable
 * ds:step ({ from, to }) that the page may refuse. A step change enters
 * the new section (DS.motion.enter, 'swap'), scrolls the body to its top,
 * focuses the section's heading (tabindex="-1") and says "Step 2 of 4:
 * Network" politely. Enter in a field of a form box goes to the next step
 * until the last, where it submits.
 *
 * Submit: a cancelable ds:submit ({ form, data, wait(promise) }); a promise
 * given to wait() runs with DS.motion.busy() on the submit button and
 * data-ds-busy on the tearsheet (it refuses the user's closes meanwhile); a
 * rejection keeps it open with an error snackbar (actionFailed) and focus
 * on the button. Done, or without wait(), it closes with reason "submit".
 * preventDefault() keeps it open (the page shows its own message).
 *
 * Unsaved changes: an input or change event in it marks it dirty (the
 * controller's get().dirty; set({ dirty: false }) after the page saved a
 * draft). While dirty, the user's closes (Escape, the native cancel, a
 * [data-ds-close] in it) ask first with a destructive confirm dialog
 * (strings discardTitle, discardText, discard, keepEditing): Discard closes
 * it with reason "discard", Keep editing leaves it as it was. Leaving the
 * page asks the browser's own question (beforeunload). close() asks too;
 * close(el, { force: true }) and DS.overlay.close() do not. Each open starts
 * clean at the first step.
 *
 * Stacked: a tearsheet opened over another gets the lighter scrim
 * (.ds-dialog--nested, DS.overlay) and the ones below it data-stacked, so
 * they recede; it goes as soon as the upper one starts to close.
 *
 * Strings: stepOf, stepDone, stepError, discardTitle, discardText, discard,
 * keepEditing, actionFailed (DS.core.config({ strings })).
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { busy, enter } from './motion.js';
import { own } from './dom.js';
import { alertCircle, check, iconElement } from './icons.js';
import { internals, layerAt, open as openOverlay, close as closeOverlay } from './overlay.js';
import { announce, tabbables } from './a11y.js';
import { confirm } from './dialog.js';

const { overlays, stack, activeIn, canFocus, part } = internals;

/** What closes the overlay around it (DS.overlay's closers). */
const CLOSERS = '[data-ds-close=""]';

/** The state of each tearsheet. @type {WeakMap<Element, any>} */
const flows = new WeakMap();

/**
 * The step index a request leads to: `to` within 0 and `total - 1`.
 * @param {number} to
 * @param {number} total
 * @returns {number}
 */
export function stepIndex(to, total) {
  if (!(total > 0)) return 0;
  const index = Math.trunc(Number(to));
  if (!Number.isFinite(index)) return 0;
  return Math.min(total - 1, Math.max(0, index));
}

/**
 * The status of each step for the rail: "done" before the current one,
 * "current" at it, "upcoming" after it; a step in `errors` is "error"
 * wherever it is.
 * @param {number} total
 * @param {number} current
 * @param {Set<number>|number[]} [errors]
 * @returns {Array<'done'|'current'|'upcoming'|'error'>}
 */
export function statuses(total, current, errors = []) {
  const failed = new Set(errors);
  return Array.from({ length: Math.max(0, total) }, (_, index) => {
    if (failed.has(index)) return 'error';
    if (index < current) return 'done';
    return index === current ? 'current' : 'upcoming';
  });
}

const viewOf = (element) => element.ownerDocument?.defaultView ?? globalThis;
const isOpen = (element) => overlays.get(element)?.phase === 'open';

/** The parts of a tearsheet, its own (not those of a tearsheet inside it). */
function partsOf(element) {
  const own = (selector) => [...element.querySelectorAll(selector)].filter((node) => node.closest('.ds-tearsheet') === element);
  return {
    box: element.querySelector('.ds-dialog__box'),
    body: own('.ds-tearsheet__body')[0] ?? null,
    sections: own('.ds-tearsheet__step'),
    rail: own('.ds-tearsheet__steps .ds-steps__step'),
    progress: own('.ds-tearsheet__progress')[0] ?? null,
    back: own('[data-ds-tearsheet-back]'),
    next: own('[data-ds-tearsheet-next]'),
    submit: own('[data-ds-tearsheet-submit]'),
  };
}

/** The name of a step: its rail label, else the section's name or heading. */
function labelOf(element, index) {
  const { sections, rail } = partsOf(element);
  const label = rail[index]?.querySelector('.ds-steps__label');
  if (label) {
    const copy = /** @type {Element} */ (label.cloneNode(true));
    for (const hidden of copy.querySelectorAll('.ds-sr')) hidden.remove();
    const text = copy.textContent?.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  const section = sections[index];
  if (!section) return String(index + 1);
  const named = section.getAttribute('aria-label');
  if (named) return named;
  const by = section.getAttribute('aria-labelledby');
  const heading = (by && section.ownerDocument.getElementById(by)) || section.querySelector('h1, h2, h3, h4, h5, h6');
  return heading?.textContent?.replace(/\s+/g, ' ').trim() || String(index + 1);
}

/** Writes the rail's mark and screen-reader word of one step. */
function paintRailStep(item, status, index) {
  const doc = item.ownerDocument;
  if (status === 'current') item.setAttribute('aria-current', 'step');
  else item.removeAttribute('aria-current');
  const optional = item.getAttribute('data-status') === 'optional' || item.hasAttribute('data-ds-optional');
  if (optional) item.setAttribute('data-ds-optional', '');
  if (status === 'done' || status === 'error') item.setAttribute('data-status', status);
  else if (optional) item.setAttribute('data-status', 'optional');
  else item.removeAttribute('data-status');
  const mark = item.querySelector('.ds-steps__mark');
  if (mark) {
    const kind = status === 'done' ? 'done' : status === 'error' ? 'error' : String(index + 1);
    if (mark.getAttribute('data-ds-mark') !== kind) {
      mark.setAttribute('data-ds-mark', kind);
      if (kind === 'done') mark.replaceChildren(iconElement(check, 16, undefined, doc));
      else if (kind === 'error') mark.replaceChildren(iconElement(alertCircle, 16, undefined, doc));
      else mark.replaceChildren(doc.createTextNode(kind));
    }
  }
  const label = item.querySelector('.ds-steps__label');
  if (!label) return;
  let word = label.querySelector(':scope > .ds-sr[data-ds-step-word]');
  const text = status === 'done' ? t('stepDone') : status === 'error' ? t('stepError') : '';
  if (!text) {
    word?.remove();
    return;
  }
  if (!word) {
    word = doc.createElement('span');
    word.className = 'ds-sr';
    word.setAttribute('data-ds-step-word', '');
    label.append(word);
  }
  word.textContent = text;
}

/** Everything that shows the current step: sections, rail, progress line, foot buttons. */
function paint(element, state) {
  const { sections, rail, progress, back, next, submit } = partsOf(element);
  const total = sections.length;
  state.index = stepIndex(state.index, total);
  sections.forEach((section, index) => {
    const hidden = index !== state.index;
    if (/** @type {HTMLElement} */ (section).hidden !== hidden) /** @type {HTMLElement} */ (section).hidden = hidden;
  });
  const list = statuses(total, state.index, state.errors);
  rail.forEach((item, index) => paintRailStep(item, list[index] ?? 'upcoming', index));
  const label = labelOf(element, state.index);
  if (progress && total > 1) progress.textContent = t('stepOf', { step: state.index + 1, total, label });
  else if (progress) progress.textContent = '';
  const last = state.index >= total - 1;
  for (const button of back) /** @type {HTMLElement} */ (button).hidden = state.index === 0;
  for (const button of next) /** @type {HTMLElement} */ (button).hidden = last;
  for (const button of submit) /** @type {HTMLElement} */ (button).hidden = !last;
  return { total, label };
}

/** The controls of a section that take part in its validation. */
function controlsOf(section) {
  return [...section.querySelectorAll('input, select, textarea')].filter((control) => !control.disabled && typeof control.checkValidity === 'function' && control.type !== 'hidden');
}

/** Validates the current step; reports the first invalid control. */
function validStep(element, state) {
  const section = partsOf(element).sections[state.index];
  if (!section) return true;
  const invalid = controlsOf(section).find((control) => !control.checkValidity());
  if (!invalid) {
    state.errors.delete(state.index);
    return true;
  }
  state.errors.add(state.index);
  paint(element, state);
  invalid.reportValidity?.();
  if (activeIn(element) !== invalid && canFocus(invalid)) invalid.focus();
  return false;
}

/** Moves to step `to` (see the header); `check` validates the current step first. */
function go(element, state, to, check) {
  const { sections, body } = partsOf(element);
  const target = stepIndex(to, sections.length);
  if (target === state.index) return false;
  if (check && target > state.index && !validStep(element, state)) return false;
  if (!emit(element, 'step', { from: state.index, to: target }, { cancelable: true })) return false;
  state.errors.delete(state.index);
  state.index = target;
  const { total, label } = paint(element, state);
  const section = sections[target];
  if (body) body.scrollTop = 0;
  if (section) {
    enter(section, 'swap');
    const heading = section.querySelector('[tabindex="-1"], h1, h2, h3, h4, h5, h6');
    const focusable = heading ?? section;
    if (!focusable.hasAttribute('tabindex')) focusable.setAttribute('tabindex', '-1');
    /** @type {HTMLElement} */ (focusable).focus({ preventScroll: true });
  }
  announce(t('stepOf', { step: target + 1, total, label }));
  emit(element, 'change', { step: target, total });
  return true;
}

/** Keeps the browser's own question up while a tearsheet with changes is open. */
function holdUnload(element, state) {
  const view = viewOf(element);
  const wants = state.dirty && isOpen(element);
  if (wants && !state.unload) {
    state.unload = (/** @type {BeforeUnloadEvent} */ event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    view.addEventListener?.('beforeunload', state.unload);
  } else if (!wants && state.unload) {
    view.removeEventListener?.('beforeunload', state.unload);
    state.unload = null;
  }
}

function setDirty(element, state, dirty) {
  if (state.dirty === dirty) return;
  state.dirty = dirty;
  holdUnload(element, state);
  emit(element, 'dirty', { dirty });
}

/**
 * Asks before the changes go; closes with reason "discard" on yes.
 * Resolves whether it closed.
 */
async function ask(element, state) {
  if (state.asking) return state.asking;
  const opener = activeIn(element) ?? null;
  const texts = state.discard ?? {};
  state.asking = confirm({
    title: texts.title ?? t('discardTitle'),
    text: texts.text ?? t('discardText'),
    confirmLabel: texts.confirmLabel ?? t('discard'),
    cancelLabel: texts.cancelLabel ?? t('keepEditing'),
    destructive: true,
    opener: opener && element.contains(opener) ? opener : null,
  }).then((yes) => {
    state.asking = null;
    if (!yes || !isOpen(element)) return false;
    setDirty(element, state, false);
    closeOverlay(element, { reason: 'discard' });
    return true;
  });
  return state.asking;
}

/** Marks the open tearsheets under the top one data-stacked; the top one and closed ones lose it. */
function restack() {
  const open = stack.filter((element) => element.matches?.('.ds-tearsheet') && isOpen(element));
  const top = open.at(-1);
  for (const element of open) {
    if (element !== top) element.setAttribute('data-stacked', '');
    else element.removeAttribute('data-stacked');
  }
}

/** Runs the submit of the last step (see the header). */
async function submitFlow(element, state, submitter) {
  if (element.hasAttribute('data-ds-busy') || !isOpen(element)) return;
  if (!validStep(element, state)) return;
  const { box, submit } = partsOf(element);
  const form = box?.tagName === 'FORM' ? /** @type {HTMLFormElement} */ (box) : null;
  const data = form ? new FormData(form) : null;
  /** @type {PromiseLike<unknown>|null} */
  let pending = null;
  const detail = { form, data, wait: (/** @type {PromiseLike<unknown>} */ promise) => { pending = promise; } };
  if (!emit(element, 'submit', detail, { cancelable: true })) return;
  if (pending) {
    const button = submitter ?? submit.find((node) => !(/** @type {HTMLElement} */ (node)).hidden) ?? null;
    element.setAttribute('data-ds-busy', '');
    try {
      await busy(button, () => pending, { done: false });
    } catch {
      element.removeAttribute('data-ds-busy');
      if (!element.isConnected) return;
      const speaker = part('toast');
      const region = speaker?.regionOfTheme(element.ownerDocument, element.closest('.ds-theme'), element.parentNode);
      if (region) speaker.toast(region, state.errorText ?? t('actionFailed'), { kind: 'error' });
      if (button && canFocus(button)) /** @type {HTMLElement} */ (button).focus({ preventScroll: true });
      return;
    }
    element.removeAttribute('data-ds-busy');
  }
  setDirty(element, state, false);
  closeOverlay(element, { reason: 'submit' });
}

/** Wires one tearsheet; returns its state. */
function wire(element, settings, signal) {
  const state = {
    index: 0,
    errors: new Set(),
    dirty: false,
    asking: null,
    unload: null,
    discard: settings.discard ?? null,
    errorText: settings.errorText ?? null,
  };
  own(element, 'attrs', 'data-stacked');
  paint(element, state);

  const onOpen = (/** @type {Event} */ event) => {
    if (event.target !== element) return;
    // Each open starts clean, at the first step.
    state.index = 0;
    state.errors.clear();
    setDirty(element, state, false);
    paint(element, state);
    restack();
    // DS.overlay focused [autofocus] or the first control, the head's
    // close button: the first control of the step is where work starts.
    const active = activeIn(element);
    const section = partsOf(element).sections[0];
    if (section && !element.querySelector('[autofocus]') && !(active && section.contains(active))) {
      const first = tabbables(section)[0];
      if (first) /** @type {HTMLElement} */ (first).focus({ preventScroll: true });
    }
  };
  const onClose = (/** @type {Event} */ event) => {
    if (event.target !== element) return;
    holdUnload(element, state);
    element.removeAttribute('data-stacked');
    restack();
  };
  element.addEventListener('ds:open', onOpen, { signal });
  element.addEventListener('ds:close', onClose, { signal });

  // Changes the user made (not the system's own fields of a nested dialog).
  const onEdit = (/** @type {Event} */ event) => {
    const target = /** @type {Element} */ (event.target);
    if (!isOpen(element) || target?.closest?.('.ds-dialog') !== element) return;
    if (target.closest('[data-ds-tearsheet-ignore]')) return;
    setDirty(element, state, true);
  };
  element.addEventListener('input', onEdit, { signal });
  element.addEventListener('change', onEdit, { signal });

  // The guard: the user's closes ask while there are changes.
  element.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    if (!state.dirty || !isOpen(element) || element.hasAttribute('data-ds-busy')) return;
    const target = /** @type {Element} */ (event.target);
    if (layerAt(target) !== element) return;
    // A filled search clears first (DS.overlay).
    if (target.matches?.('input[type="search"]') && /** @type {HTMLInputElement} */ (target).value) return;
    event.preventDefault();
    ask(element, state);
  }, { signal });
  element.addEventListener('cancel', (event) => {
    if (event.target !== element || !state.dirty || !isOpen(element) || element.hasAttribute('data-ds-busy')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ask(element, state);
  }, { capture: true, signal });
  element.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const closer = /** @type {Element} */ (event.target)?.closest?.(CLOSERS);
    if (!closer || closer.closest('.ds-dialog') !== element || !isOpen(element)) return;
    if (!state.dirty || element.hasAttribute('data-ds-busy') || event.detail > 1) return;
    event.preventDefault();
    event.stopPropagation();
    ask(element, state);
  }, { capture: true, signal });

  // The steps and the submit.
  element.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    const target = /** @type {Element} */ (event.target);
    if (event.defaultPrevented || event.detail > 1 || !isOpen(element)) return;
    const button = target?.closest?.('[data-ds-tearsheet-next], [data-ds-tearsheet-back], [data-ds-tearsheet-submit]');
    if (!button || button.closest('.ds-tearsheet') !== element || button.getAttribute('aria-disabled') === 'true') return;
    // A submit button (also one a form's Enter clicked while hidden) never posts.
    if (button.matches('[type="submit"], button:not([type])')) event.preventDefault();
    const last = state.index >= partsOf(element).sections.length - 1;
    if (button.hasAttribute('data-ds-tearsheet-back')) go(element, state, state.index - 1, false);
    else if (button.hasAttribute('data-ds-tearsheet-next') || !last) go(element, state, state.index + 1, true);
    else submitFlow(element, state, button);
  }, { signal });
  element.addEventListener('submit', (/** @type {SubmitEvent} */ event) => {
    const form = /** @type {Element} */ (event.target);
    if (!form?.matches?.('form.ds-dialog__box') || form.closest('.ds-tearsheet') !== element) return;
    event.preventDefault();
    if (!isOpen(element)) return;
    // Enter in a field (no button took it): the next step until the last.
    if (state.index < partsOf(element).sections.length - 1) go(element, state, state.index + 1, true);
    else submitFlow(element, state, /** @type {any} */ (event).submitter ?? null);
  }, { signal });

  return state;
}

/**
 * The controller of a tearsheet, the one [data-ds-tearsheet] makes; once
 * per element (a second call returns the first). get() returns
 * { step, total, dirty, open }; set(n) goes to step n without checking
 * it, set({ step, dirty }) sets either; next() and back() move as the
 * foot's buttons do (next() checks the step; both resolve whether they
 * moved); close() closes, asking first while dirty (resolves whether it
 * closed); on(type, fn) hears ds:step, ds:change, ds:submit, ds:dirty,
 * ds:open and ds:close; destroy().
 * `discard` replaces the texts of the question; `errorText` the snackbar
 * of a failed submit.
 * @param {Element} element
 * @param {{ discard?: { title?: string, text?: string, confirmLabel?: string, cancelLabel?: string }, errorText?: string }} [options]
 */
export function create(element, options = {}) {
  const known = flows.get(element);
  if (known) return known.controller;
  const abort = new AbortController();
  const state = wire(element, options, abort.signal);
  const listeners = [];
  const controller = {
    element,
    get: () => ({ step: state.index, total: partsOf(element).sections.length, dirty: state.dirty, open: isOpen(element) }),
    set(/** @type {number|{ step?: number, dirty?: boolean }} */ value) {
      const next = typeof value === 'number' ? { step: value } : value ?? {};
      if (typeof next.dirty === 'boolean') setDirty(element, state, next.dirty);
      if (typeof next.step === 'number') {
        if (isOpen(element)) go(element, state, next.step, false);
        else {
          state.index = next.step;
          paint(element, state);
        }
      }
    },
    next: () => Promise.resolve(go(element, state, state.index + 1, true)),
    back: () => Promise.resolve(go(element, state, state.index - 1, false)),
    close: (/** @type {{ force?: boolean, reason?: string }} */ closing = {}) => close(element, closing),
    on(/** @type {string} */ type, /** @type {(event: Event) => void} */ fn) {
      const name = `ds:${type}`;
      element.addEventListener(name, fn);
      const off = () => element.removeEventListener(name, fn);
      listeners.push(off);
      return off;
    },
    destroy() {
      if (flows.get(element)?.controller !== controller) return;
      flows.delete(element);
      abort.abort();
      if (state.unload) viewOf(element).removeEventListener?.('beforeunload', state.unload);
      state.unload = null;
      for (const off of listeners.splice(0)) off();
    },
  };
  flows.set(element, { state, controller });
  return controller;
}

/**
 * Opens a tearsheet at its first step (`step`: another one): DS.overlay.open().
 * @param {Element} element
 * @param {{ opener?: Element|null, step?: number, returnTo?: () => Element|null|undefined }} [options]
 * @returns {Promise<void>}
 */
export function open(element, options = {}) {
  const controller = create(element);
  const opened = openOverlay(element, options);
  if (typeof options.step === 'number' && options.step > 0) controller.set(options.step);
  return opened;
}

/**
 * Closes a tearsheet; while it has unsaved changes it asks first (unless
 * `force`). Resolves whether it closed.
 * @param {Element} element
 * @param {{ force?: boolean, reason?: string }} [options]
 * @returns {Promise<boolean>}
 */
export function close(element, options = {}) {
  const flow = flows.get(element);
  if (!isOpen(element)) return Promise.resolve(false);
  if (flow?.state.dirty && !options.force) return ask(element, flow.state);
  if (flow) setDirty(element, flow.state, false);
  return closeOverlay(element, { reason: options.reason }).then(() => true);
}

define('tearsheet', {
  attribute: 'data-ds-tearsheet',
  init: (element) => create(element),
});
