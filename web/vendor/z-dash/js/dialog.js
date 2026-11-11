/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The behaviour of a dialog (DS.dialog): what only a dialog does once
 * DS.overlay opened it (the stack, the trap, focus return, Escape, dismiss
 * and the exit stay in the core, js/overlay.js).
 *
 *   <button data-ds-open="#delete-dialog">Delete</button>
 *   <dialog class="ds-dialog" id="delete-dialog" aria-labelledby="t">...</dialog>
 *
 *   DS.dialog.open(dialog, { opener });  DS.dialog.close(dialog);   // DS.overlay.open and close
 *   DS.dialog.create(dialog)             // get(), set(), on(), destroy()
 *   await DS.dialog.confirm({ title, text, destructive: true });   // also DS.overlay.confirm
 *   DS.dialog.form(dialog, { onSubmit });   // a form dialog: busy while it runs
 *
 * Strings: the labels and messages below are options, whose defaults are
 * the system's strings ok, cancel, confirm, actionFailed and valueRequired
 * (DS.core.config({ strings })).
 *
 * Promise dialogs: confirm(), alert() and prompt() build a dialog.ds-dialog
 * with DOM APIs inside the opener's .ds-theme, open it through open() and
 * remove it after its exit; the promise resolves with the answer when the
 * close starts. onConfirm runs with busy() on the confirm button and
 * data-ds-busy on the dialog; a rejection keeps it open with an error
 * snackbar (errorText) and focus back on the confirm button.
 *
 * What a question is about: `lines` (a list, .ds-dialog__lines) and
 * `facts` (term and value pairs, .ds-dialog__facts) of confirm(),
 * alert() and prompt() go under the text.
 *
 * An action sheet's list (.ds-dialog__list): ArrowUp, ArrowDown, Home and End
 * move focus among its .ds-menu__item rows.
 *
 * Non-modal (.ds-dialog__box--modeless, 3.0): DS.overlay opens it as a
 * non-modal layer (no trap, no inert, no scroll lock; Escape closes it
 * while it is the top layer). This module moves focus into it once it
 * opened (autofocus, else its first focusable control, else the box) and
 * watches its body's scroll, as DS.overlay does for a modal dialog.
 *
 * Form dialog (opt-in, so a 2.x form that posts or has its own handler stays
 * the page's): when the box is a <form class="ds-dialog__box"
 * data-ds-dialog-form>, or after form(dialog), a submit (the constraint
 * validation has passed by then) sends a cancelable ds:submit
 * ({ form, data }) and closes it with reason "submit", unless the page called
 * preventDefault(), on the submit or on ds:submit. form(dialog, { onSubmit,
 * errorText }) runs onSubmit(data, form) like onConfirm(): busy() on the
 * submit button, data-ds-busy on the dialog, its closers aria-disabled, its
 * fields read-only (other controls inert), a rejection keeps it open with an
 * error snackbar and gives all of that back.
 *
 * ES2022; no progressive feature of its own.
 */
import { define, emit, t } from './core.js';
import { busy } from './motion.js';
import { alertCircle, iconElement } from './icons.js';
import { watchScrolled } from './dom.js';
import { tabbables } from './a11y.js';
import { internals, open as openOverlay, close as closeOverlay } from './overlay.js';

const { overlays, activeIn, sharedOf, canFocus, arrowTarget, controllerOf, part } = internals;

/**
 * Opens a dialog: DS.overlay.open().
 * @param {Element} element
 * @param {{ opener?: Element|null, container?: boolean, returnTo?: () => Element|null|undefined }} [options]
 * @returns {Promise<void>}
 */
export function open(element, options = {}) {
  return openOverlay(element, options);
}

/**
 * Closes a dialog: DS.overlay.close().
 * @param {Element} element
 * @param {{ reason?: string }} [options]
 * @returns {Promise<void>}
 */
export function close(element, options = {}) {
  return closeOverlay(element, options);
}

/**
 * Asks with a built dialog: Cancel and a confirm button. `destructive`
 * makes it an alertdialog whose first focus is Cancel, and its confirm
 * button filled in the error tone (D10: the one place a button is red); the
 * label names the consequence. `onConfirm` (async)
 * runs with busy() on the confirm button and data-ds-busy on the dialog: a
 * rejection keeps it open, shows `errorText` as an error snackbar above it
 * (in the theme's .ds-toasts region, made when the page has none, inside
 * the open dialog) and focuses the confirm button again.
 * Resolves true when it closed through the confirm button, else false.
 * `lines` (strings) and `facts` ([term, value] pairs) show what it is
 * about under the text.
 * @param {{ title?: string, text?: string, lines?: string[], facts?: Array<[string, string]>, confirmLabel?: string,
 *   cancelLabel?: string, destructive?: boolean, opener?: Element|null, onConfirm?: () => unknown, errorText?: string }} [options]
 * @returns {Promise<boolean>}
 */
export function confirm(options = {}) {
  return /** @type {Promise<boolean>} */ (ask('confirm', options));
}

/**
 * Tells something with a built alertdialog and one button (`closeLabel`,
 * default the string `ok`); resolves once it closes.
 * @param {{ title?: string, text?: string, lines?: string[], facts?: Array<[string, string]>, closeLabel?: string,
 *   opener?: Element|null }} [options]
 * @returns {Promise<void>}
 */
export function alert(options = {}) {
  return /** @type {Promise<void>} */ (ask('alert', options));
}

/**
 * Asks for one value with a built dialog: a field (`label`, `value`;
 * `input` sets its type, autocomplete, inputmode, required, spellcheck,
 * autocapitalize, autocorrect and enterkeyhint), Cancel and a confirm
 * button; Enter in the field confirms. A required field left
 * empty stays open with the field error `requiredText` (default the string
 * `valueRequired`; aria-invalid, a .ds-field__hint--error linked by
 * aria-describedby, announced assertively) until the next input.
 * `onConfirm(value)` runs as in confirm(). Resolves the value when it
 * closed through the confirm button, else null.
 * @param {{ title?: string, text?: string, lines?: string[], facts?: Array<[string, string]>, label?: string,
 *   value?: string, confirmLabel?: string,
 *   cancelLabel?: string, opener?: Element|null, onConfirm?: (value: string) => unknown, errorText?: string,
 *   requiredText?: string,
 *   input?: { type?: string, autocomplete?: string, inputmode?: string, required?: boolean,
 *     spellcheck?: boolean, autocapitalize?: string, autocorrect?: string, enterkeyhint?: string } }} [options]
 * @returns {Promise<string|null>}
 */
export function prompt(options = {}) {
  return /** @type {Promise<string|null>} */ (ask('prompt', options));
}

/** The answer of a promise dialog that closed without its confirm button. */
const declined = (kind) => (kind === 'confirm' ? false : kind === 'prompt' ? null : undefined);

/**
 * Builds, opens and answers a promise dialog (confirm(), alert(),
 * prompt()): native <dialog> markup inside the opener's .ds-theme (else
 * the first one), DOM APIs only (no HTML strings, CSP-safe), removed once
 * its exit settled.
 */
function ask(kind, options) {
  const opener = options.opener ?? null;
  const doc = opener?.ownerDocument ?? globalThis.document;
  if (!doc?.createElement || !doc.body) return Promise.resolve(declined(kind));
  const theme = opener?.closest?.('.ds-theme') ?? activeIn(doc.body)?.closest?.('.ds-theme') ?? doc.querySelector('.ds-theme');
  const home = !theme || theme === doc.documentElement ? doc.body : theme;
  const id = `ds-ask-${sharedOf(doc).seq += 1}`;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  };
  const native = typeof make('dialog').showModal === 'function';
  const dialog = make(native ? 'dialog' : 'div', 'ds-dialog');
  const box = make('div', 'ds-dialog__box');
  // The modal semantics: a native dialog has them; the div markup's box takes the role.
  const labelled = native ? dialog : box;
  const role = kind === 'alert' || options.destructive ? 'alertdialog' : 'dialog';
  if (native) {
    if (role === 'alertdialog') dialog.setAttribute('role', role);
  } else {
    dialog.hidden = true;
    box.setAttribute('role', role);
    box.setAttribute('aria-modal', 'true');
  }
  const backdrop = make('div', 'ds-dialog__backdrop');
  backdrop.setAttribute('data-ds-close', '');
  const title = make('h2', 'ds-dialog__title', options.title ?? '');
  title.id = `${id}-title`;
  labelled.setAttribute('aria-labelledby', title.id);
  box.append(title);
  if (options.text) {
    const text = make('p', 'ds-dialog__text', options.text);
    text.id = `${id}-text`;
    labelled.setAttribute('aria-describedby', text.id);
    box.append(text);
  }
  // What the question is about: the items it takes, the facts of a record.
  const lines = Array.isArray(options.lines) ? options.lines.filter((line) => line != null && String(line) !== '') : [];
  if (lines.length) {
    const list = make('ul', 'ds-dialog__lines');
    for (const line of lines) list.append(make('li', '', line));
    box.append(list);
  }
  const facts = Array.isArray(options.facts) ? options.facts.filter((fact) => Array.isArray(fact) && fact.length >= 2) : [];
  if (facts.length) {
    const list = make('dl', 'ds-dialog__facts');
    for (const [term, value] of facts) {
      const row = make('div', '');
      row.append(make('dt', '', term), make('dd', '', value));
      list.append(row);
    }
    box.append(list);
  }
  /** @type {HTMLInputElement|null} */
  let field = null;
  if (kind === 'prompt') {
    const wrap = make('div', 'ds-field');
    const label = make('label', 'ds-field__label', options.label ?? '');
    field = /** @type {HTMLInputElement} */ (make('input', 'ds-input'));
    field.id = `${id}-field`;
    label.htmlFor = field.id;
    const input = options.input ?? {};
    field.type = input.type ?? 'text';
    if (input.autocomplete) field.setAttribute('autocomplete', input.autocomplete);
    if (input.inputmode) field.setAttribute('inputmode', input.inputmode);
    if (input.required) field.required = true;
    // Typing hints for a path or a code: written only when given, so the browser's defaults stay otherwise.
    if (typeof input.spellcheck === 'boolean') field.setAttribute('spellcheck', String(input.spellcheck));
    for (const name of ['autocapitalize', 'autocorrect', 'enterkeyhint']) {
      if (input[name]) field.setAttribute(name, input[name]);
    }
    field.value = options.value ?? '';
    field.setAttribute('autofocus', '');
    wrap.append(label, field);
    box.append(wrap);
  }
  const actions = make('div', 'ds-dialog__actions');
  const button = (className, text) => {
    const node = /** @type {HTMLButtonElement} */ (make('button', className, text));
    node.type = 'button';
    return node;
  };
  /** @type {HTMLButtonElement|null} */
  let cancel = null;
  let confirmButton;
  if (kind === 'alert') {
    confirmButton = button('ds-btn ds-btn--filled', options.closeLabel ?? t('ok'));
    confirmButton.setAttribute('data-ds-close', '');
    confirmButton.setAttribute('autofocus', '');
    actions.append(confirmButton);
  } else {
    cancel = button('ds-btn ds-btn--text', options.cancelLabel ?? t('cancel'));
    cancel.setAttribute('data-ds-close', '');
    // The faces of busy(): the label, and the spinner with it while onConfirm runs.
    const label = options.confirmLabel ?? t('confirm');
    confirmButton = button(options.destructive ? 'ds-btn ds-btn--filled ds-tone-error' : 'ds-btn ds-btn--filled');
    const faces = make('span', 'ds-btn__faces');
    const rest = make('span', 'ds-btn__face', label);
    const working = make('span', 'ds-btn__face ds-btn__face--busy');
    working.setAttribute('aria-hidden', 'true');
    working.append(make('span', 'ds-spinner ds-spinner--ink ds-sm'), doc.createTextNode(label));
    faces.append(rest, working);
    confirmButton.append(faces);
    // The safe choice first in a destructive question; else the answer, or the field.
    if (options.destructive) cancel.setAttribute('autofocus', '');
    else if (!field) confirmButton.setAttribute('autofocus', '');
    actions.append(cancel, confirmButton);
  }
  box.append(actions);
  dialog.append(backdrop, box);

  return new Promise((resolve) => {
    dialog.addEventListener('ds:close', (event) => {
      if (event.target !== dialog) return;
      const reason = /** @type {CustomEvent} */ (event).detail?.reason;
      resolve(reason === 'confirm' ? (kind === 'confirm' ? true : kind === 'prompt' ? field?.value ?? '' : undefined) : declined(kind));
      // Gone once its exit settled (unless it opened again meanwhile).
      Promise.resolve(overlays.get(dialog)?.closing).then(() => {
        if (overlays.get(dialog)?.phase !== 'open') dialog.remove();
      });
    });
    if (kind === 'alert') {
      home.append(dialog);
      open(dialog, { opener });
      return;
    }
    // A required field left empty: the documented field error (an
    // aria-invalid field described by a .ds-field__hint--error with its
    // icon, so never colour alone), said at once since focus is already
    // there and the description is only read on the next focus.
    /** @type {HTMLElement|null} */
    let hint = null;
    const invalid = (/** @type {HTMLInputElement} */ input) => {
      const text = String(options.requiredText ?? t('valueRequired'));
      if (!hint) {
        hint = make('small', 'ds-field__hint ds-field__hint--error');
        hint.id = `${id}-error`;
        hint.append(iconElement(alertCircle, 16, undefined, doc), doc.createTextNode(text));
        input.parentElement?.append(hint);
      }
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', hint.id);
      input.focus();
      const speaker = part('toast');
      speaker?.announce(text, { assertive: true, region: speaker.regionOfTheme(doc, theme, home) });
    };
    // Typing takes the error away at once (the documented instant removal).
    const valid = () => {
      if (!field) return;
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
      hint?.remove();
      hint = null;
    };
    const attempt = async () => {
      if (dialog.hasAttribute('data-ds-busy') || overlays.get(dialog)?.phase !== 'open') return;
      if (field?.required && !field.value.trim()) {
        invalid(field);
        return;
      }
      valid();
      if (typeof options.onConfirm !== 'function') {
        close(dialog, { reason: 'confirm' });
        return;
      }
      // Busy: the dialog refuses the user's closes, Cancel says it is blocked, the value stays.
      dialog.setAttribute('data-ds-busy', '');
      cancel?.setAttribute('aria-disabled', 'true');
      if (field) field.readOnly = true;
      const settle = () => {
        dialog.removeAttribute('data-ds-busy');
        cancel?.removeAttribute('aria-disabled');
        if (field) field.readOnly = false;
      };
      try {
        await busy(confirmButton, () => options.onConfirm(field?.value ?? undefined), { done: false });
      } catch {
        settle();
        if (!dialog.isConnected) return;
        // Above the dialog: the theme's region (made when the page has
        // none) moves into it on first use.
        const speaker = part('toast');
        const region = speaker?.regionOfTheme(doc, theme, home);
        if (region) speaker.toast(region, options.errorText ?? t('actionFailed'), { kind: 'error' });
        confirmButton.focus({ preventScroll: true });
        return;
      }
      settle();
      close(dialog, { reason: 'confirm' });
    };
    confirmButton.addEventListener('click', (/** @type {MouseEvent} */ event) => {
      if (event.detail > 1) return;
      attempt();
    });
    field?.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      attempt();
    });
    field?.addEventListener('input', valid);
    home.append(dialog);
    open(dialog, { opener });
  });
}

/**
 * An action sheet's list (.ds-dialog__list): ArrowUp, ArrowDown, Home and
 * End move focus among its .ds-menu__item rows (wrapping), as in a menu.
 */
function wireDialogList(dialog) {
  dialog.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const list = /** @type {Element} */ (event.target)?.closest?.('.ds-dialog__list');
    if (!list || !dialog.contains(list)) return;
    const next = arrowTarget([...list.querySelectorAll('.ds-menu__item')].filter(canFocus), event);
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
}

/** The form dialogs that form() took over: its options, per dialog. @type {WeakMap<Element, { onSubmit?: (data: FormData, form: HTMLFormElement) => unknown, errorText?: string }>} */
const forms = new WeakMap();

/**
 * Makes `element`'s box form run `onSubmit` before it closes (see the
 * header); returns its controller.
 * @param {Element} element
 * @param {{ onSubmit?: (data: FormData, form: HTMLFormElement) => unknown, errorText?: string }} [options]
 * @returns {ReturnType<typeof controllerOf>}
 */
export function form(element, options = {}) {
  forms.set(element, { onSubmit: options.onSubmit, errorText: options.errorText });
  return controllerOf(element);
}

/** Controls a user types in: the ones `readOnly` holds. The others have no read-only state, so they go inert while it runs. */
const TYPED = 'textarea, input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="button"], [type="reset"], [type="submit"], [type="image"], [type="hidden"])';

/**
 * While onSubmit runs, as confirm() while onConfirm runs: the dialog refuses
 * the user's closes (data-ds-busy) and its closers say so (aria-disabled),
 * and what was sent stays on screen (typed fields read-only, other controls
 * inert). Focus on a control that goes inert moves to the submit button.
 * Returns what undoes exactly this, so what the page had set stays.
 */
function holdForm(dialog, box, submit) {
  const undo = [() => dialog.removeAttribute('data-ds-busy')];
  dialog.setAttribute('data-ds-busy', '');
  for (const closer of box.querySelectorAll('[data-ds-close]')) {
    if (closer.getAttribute('aria-disabled') === 'true') continue;
    closer.setAttribute('aria-disabled', 'true');
    undo.push(() => closer.removeAttribute('aria-disabled'));
  }
  for (const control of box.elements) {
    if (control === submit || control.disabled || control.type === 'submit' || control.matches('fieldset, output, input[type="hidden"], [data-ds-close]')) continue;
    if (control.matches(TYPED)) {
      if (control.readOnly) continue;
      control.readOnly = true;
      undo.push(() => { control.readOnly = false; });
    } else if (!control.inert) {
      if (activeIn(control) === control && canFocus(submit)) submit.focus({ preventScroll: true });
      control.inert = true;
      undo.push(() => { control.inert = false; });
    }
  }
  return () => {
    for (const step of undo) step();
  };
}

/** A submit of the dialog's box form: ds:submit, then onSubmit (busy, a failure keeps it open), then the close. */
function wireForm(dialog) {
  dialog.addEventListener('submit', async (/** @type {SubmitEvent} */ event) => {
    const box = /** @type {HTMLFormElement} */ (event.target);
    if (!box?.matches?.('form.ds-dialog__box') || box.closest('.ds-dialog') !== dialog || event.defaultPrevented) return;
    const setup = forms.get(dialog);
    if (!setup && !box.hasAttribute('data-ds-dialog-form')) return;
    event.preventDefault();
    if (dialog.hasAttribute('data-ds-busy') || overlays.get(dialog)?.phase !== 'open') return;
    const data = new FormData(box, /** @type {any} */ (event).submitter);
    if (!emit(dialog, 'submit', { form: box, data }, { cancelable: true })) return;
    if (typeof setup?.onSubmit === 'function') {
      const submit = /** @type {any} */ (event).submitter ?? box.querySelector('[type="submit"]');
      const release = holdForm(dialog, box, submit);
      try {
        // A form submitted without a button of its own (requestSubmit() on one field) has nothing to mark busy.
        await (submit ? busy(submit, () => setup.onSubmit(data, box), { done: false }) : setup.onSubmit(data, box));
      } catch {
        release();
        if (!dialog.isConnected) return;
        const speaker = part('toast');
        const region = speaker?.regionOfTheme(dialog.ownerDocument, dialog.closest('.ds-theme'), dialog.parentNode);
        if (region) speaker.toast(region, setup.errorText ?? t('actionFailed'), { kind: 'error' });
        if (canFocus(submit)) submit.focus({ preventScroll: true });
        return;
      }
      release();
    }
    close(dialog, { reason: 'submit' });
  });
}

/**
 * The controller of a dialog, the one [data-ds-dialog] makes.
 * @param {Element} element
 * @returns {ReturnType<typeof controllerOf>}
 */
export function create(element) {
  return controllerOf(element);
}

/** The non-modal box. */
const MODELESS = '.ds-dialog__box--modeless';

/**
 * A non-modal box that DS.overlay opened: focus moves in (DS.overlay
 * honoured autofocus already; a non-modal layer gets nothing else from it),
 * and its body's scroll is watched for the hairline.
 */
function modelessOpened(box) {
  for (const body of box.querySelectorAll(':scope > .ds-dialog__body')) {
    const handle = watchScrolled(body);
    if (!body.querySelector(':scope > [data-ds-sentinel]')) handle.update();
  }
  const active = activeIn(box);
  if (active && box.contains(active)) return;
  const target = tabbables(box)[0];
  if (target) target.focus({ preventScroll: true });
  else {
    if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
    box.focus({ preventScroll: true });
  }
}

define('dialog', {
  attribute: 'data-ds-dialog',
  init: (element) => create(element),
  global(root) {
    const onOpen = (/** @type {Event} */ event) => {
      const box = /** @type {Element} */ (event.target);
      if (box?.matches?.(MODELESS)) modelessOpened(box);
    };
    root.addEventListener('ds:open', onOpen);
    return () => root.removeEventListener('ds:open', onOpen);
  },
});

internals.use('dialog', {
  confirm,
  alert,
  prompt,
  wire(dialog) {
    wireDialogList(dialog);
    wireForm(dialog);
  },
});
