/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Message (DS.message): the states and the footer actions of a
 * .ds-message, one turn of a conversation.
 *
 *   <article class="ds-message ds-message--assistant" data-ds-message="streaming"> ... </article>
 *   const message = DS.message.create(article);
 *   message.append('The battery ');            // plain text streams in at the end
 *   message.set({ state: 'done' });            // or 'partial', 'error' (with { error: 'text' })
 *   message.on('retry', () => ask(again));
 *
 * - States: the value of data-ds-message (read again when it changes) or
 *   set({ state }): 'streaming', 'partial', 'error', or 'done' (also an
 *   empty value). The module writes data-state (none when done) and
 *   aria-busy="true" while streaming, so a screen reader waits for the
 *   whole reply. Partial and error write a .ds-message__note (marked
 *   data-ds-message-note) under the content, with an icon and a word: the
 *   string messageStopped, or the error text (set({ error })) else the
 *   string messageFailed; a note of the page's own stays as it is. A
 *   change dispatches ds:change ({ state, previous }) on the message.
 * - Text: append(text) adds plain text at the end of the content (to its
 *   last paragraph when it ends in one); set({ text }) replaces it. Rich
 *   content is the page's: DS.dom.morphHtml(content, html) keeps the
 *   cursor and the state.
 * - Actions, buttons in the message with data-ds-message-action:
 *   copy     writes the text (the copy option, a function or text, else the
 *            content's rendered text) to the clipboard, swaps the button's
 *            .ds-icon-swap to its face b and its name and tooltip to the
 *            string copied for --ds-hold-status, announces it and
 *            dispatches ds:copy ({ text })
 *   retry    dispatches ds:retry
 *   edit     dispatches ds:edit ({ text })
 *   any other value dispatches ds:action ({ action }).
 *
 * The controller: get() ({ state, text }), set(state | { state, text,
 * error, copy }), append(text), copy(), on(type, fn) for change, copy,
 * retry, edit and action, destroy().
 *
 * Progressive:
 * - the asynchronous clipboard (navigator.clipboard.writeText): without it,
 *   or refused, copy() resolves false and nothing changes on screen.
 */
import { define, emit, t } from './core.js';
import { motionDuration } from './motion.js';
import { alertCircle, iconElement, stopCircle } from './icons.js';
import { announce } from './a11y.js';

/** The states a message knows. */
const STATES = new Set(['streaming', 'partial', 'error', 'done']);

/** The events a controller's on() takes. */
const EVENTS = new Set(['change', 'copy', 'retry', 'edit', 'action']);

/**
 * The state a value names: one of 'streaming', 'partial', 'error' or
 * 'done' ('done' for an empty, unknown or missing value).
 * @param {unknown} value
 * @returns {'streaming'|'partial'|'error'|'done'}
 */
export function state(value) {
  const name = String(value ?? '').trim().toLowerCase();
  return /** @type {any} */ (STATES.has(name) ? name : 'done');
}

/** The text of the content as a reader sees it (innerText where it lays out, else textContent). */
function textOf(content) {
  if (!content) return '';
  const rendered = typeof content.innerText === 'string' && content.isConnected ? content.innerText : content.textContent;
  return String(rendered ?? '').trim();
}

function controller(el, options) {
  const doc = el.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  const listeners = new Map();
  const restores = new Map();
  const content = () => Array.from(el.querySelectorAll('.ds-message__content')).find((node) => node.closest('.ds-message') === el) ?? null;
  const notes = () => Array.from(el.querySelectorAll('.ds-message__note')).filter((note) => note.closest('.ds-message') === el);
  let current = state(options.state);
  let error = options.error ? String(options.error) : null;
  let copyText = options.copy ?? null;

  const fire = (type, detail) => {
    emit(el, type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  };

  function writeNote() {
    let note = notes().find((item) => item.hasAttribute('data-ds-message-note')) ?? null;
    // A note of the page's own says it already.
    const pages = notes().some((item) => !item.hasAttribute('data-ds-message-note'));
    if ((current !== 'partial' && current !== 'error') || pages) {
      note?.remove();
      return;
    }
    const text = current === 'error' ? (error || t('messageFailed')) : t('messageStopped');
    if (!note) {
      note = doc.createElement('p');
      note.className = 'ds-message__note';
      const place = content();
      if (place) place.after(note);
      else (el.querySelector('.ds-message__main') ?? el).append(note);
    }
    note.setAttribute('data-ds-message-note', current);
    note.replaceChildren(iconElement(current === 'error' ? alertCircle : stopCircle, 16, undefined, doc), doc.createTextNode(text));
  }

  function apply() {
    if (current === 'done') el.removeAttribute('data-state');
    else if (el.getAttribute('data-state') !== current) el.setAttribute('data-state', current);
    if (current === 'streaming') el.setAttribute('aria-busy', 'true');
    else if (el.hasAttribute('aria-busy')) el.removeAttribute('aria-busy');
    writeNote();
  }

  function setState(next, detail = {}) {
    const previous = current;
    current = state(next);
    if ('error' in detail) error = detail.error ? String(detail.error) : null;
    apply();
    if (previous !== current && !signal.aborted) fire('change', { state: current, previous });
  }

  function append(text) {
    const place = content();
    if (!place || text == null || text === '') return;
    const last = place.lastElementChild;
    // Into the last paragraph when the content ends in one, so the cursor stays at the end of the text.
    const target = last && last.localName === 'p' && last === place.lastChild ? last : place;
    const tail = target.lastChild;
    if (tail && tail.nodeType === 3) /** @type {Text} */ (tail).appendData(String(text));
    else target.append(doc.createTextNode(String(text)));
  }

  function text() {
    if (typeof copyText === 'function') return String(copyText(el) ?? '');
    if (typeof copyText === 'string') return copyText;
    return textOf(content());
  }

  function restore(button, was) {
    clearTimeout(was.timer);
    restores.delete(button);
    button.querySelector('.ds-icon-swap')?.setAttribute('data-swap', 'a');
    if (was.name !== null) button.setAttribute('aria-label', was.name);
    if (was.tip !== null) button.setAttribute('data-tip', was.tip);
  }

  /** The button's copied face for --ds-hold-status, then back. */
  function confirmCopy(button) {
    if (!button) return;
    const was = restores.get(button) ?? { name: button.getAttribute('aria-label'), tip: button.getAttribute('data-tip'), timer: 0 };
    clearTimeout(was.timer);
    button.querySelector('.ds-icon-swap')?.setAttribute('data-swap', 'b');
    if (was.name !== null) button.setAttribute('aria-label', t('copied'));
    if (was.tip !== null) button.setAttribute('data-tip', t('copied'));
    was.timer = setTimeout(() => restore(button, was), motionDuration(button, '--ds-hold-status'));
    restores.set(button, was);
  }

  async function copy(button) {
    const value = text();
    const clipboard = doc.defaultView?.navigator?.clipboard;
    if (typeof clipboard?.writeText !== 'function') return false;
    try {
      await clipboard.writeText(value);
    } catch {
      return false;
    }
    if (signal.aborted) return true;
    confirmCopy(button);
    announce(t('copied'));
    fire('copy', { text: value });
    return true;
  }

  const onClick = (event) => {
    const button = /** @type {Element} */ (event.target).closest?.('[data-ds-message-action]');
    if (!button || button.closest('.ds-message') !== el) return;
    if (button.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]')) return;
    const action = button.getAttribute('data-ds-message-action');
    if (action === 'copy') copy(button);
    else if (action === 'retry') fire('retry', {});
    else if (action === 'edit') fire('edit', { text: text() });
    else fire('action', { action });
  };
  el.addEventListener('click', onClick, { signal });

  apply();

  return {
    get() {
      return { state: current, text: textOf(content()) };
    },
    set(value) {
      if (typeof value === 'string') {
        setState(value);
        return;
      }
      const next = value ?? {};
      if ('copy' in next) copyText = next.copy ?? null;
      if ('text' in next) {
        const place = content();
        if (place) place.textContent = String(next.text ?? '');
      }
      setState('state' in next ? next.state : current, next);
    },
    append,
    copy() {
      return copy(null);
    },
    on(type, fn) {
      if (!EVENTS.has(type) || typeof fn !== 'function') return () => {};
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    update() {
      setState(el.getAttribute('data-ds-message'));
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      listeners.clear();
      for (const [button, was] of Array.from(restores)) restore(button, was);
    },
  };
}

/** The controller of each message, so create() and the attribute path share one. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

function controllerOf(el, options) {
  const held = controllers.get(el);
  if (held) return held;
  const handle = controller(el, options);
  const destroy = handle.destroy;
  handle.destroy = () => {
    if (controllers.get(el) === handle) controllers.delete(el);
    destroy();
  };
  controllers.set(el, handle);
  return handle;
}

define('message', {
  attribute: 'data-ds-message',
  init(el) {
    return controllerOf(el, { state: el.getAttribute('data-ds-message') });
  },
});

/**
 * The controller of a message driven from the page: the same one the
 * attribute path makes (one per element; options apply when it is made).
 * @param {Element} el
 * @param {{ state?: 'streaming'|'partial'|'error'|'done', error?: string|null, copy?: string|((el: Element) => string)|null }} [options]
 */
export function create(el, options = {}) {
  return controllerOf(el, { state: options.state ?? el.getAttribute('data-ds-message'), error: options.error, copy: options.copy });
}
