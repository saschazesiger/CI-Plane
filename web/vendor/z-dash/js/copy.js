/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Copy (DS.copy): a button that copies a value or the text of a target,
 * says "Copied" for a moment and announces it.
 *
 *   <span class="ds-copy ds-copy--field">
 *     <code class="ds-copy__value" id="api-key">ak_live_7f3a9c2e</code>
 *     <button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" aria-label="Copy the key" data-tip="Copy the key" data-ds-copy="#api-key">
 *       <span class="ds-icon-swap"><span class="ds-icon-swap__a">(copy 20)</span><span class="ds-icon-swap__b">(check 20)</span></span>
 *     </button>
 *   </span>
 *   <button class="ds-btn" type="button" data-ds-copy data-ds-copy-value="https://example.com/t/4127">
 *     <span class="ds-btn__faces"><span class="ds-btn__face">(copy 16) Copy link</span>
 *       <span class="ds-btn__face ds-btn__face--done" aria-hidden="true">(check 16)<span class="ds-copy__done"></span></span></span>
 *   </button>
 *
 *   await DS.copy.copy('text');                 { ok: true, method: 'clipboard' }
 *   const button = DS.copy.create(el, { text });  get(), set(text), copy(), done(), on('copy', fn)
 *
 * What it copies (textOf): data-ds-copy-value, else the target that
 * data-ds-copy names (a selector or an id: a field's value, else its text),
 * else the .ds-copy__value of the .ds-copy around the button; set() from
 * the page overrides all three.
 *
 * How (copy()): the Clipboard API (navigator.clipboard.writeText) where it
 * exists and is allowed; else the older copy command on a hidden, read-only
 * textarea (focus goes back where it was); else nothing is copied: the
 * text is selected and the announcer says how to copy it by hand (the
 * strings' copyManual, with the platform's keys). The selection is the
 * source's text where the source shows what is copied; else (a
 * data-ds-copy-value, a text from set()) a read-only .ds-copy__manual field
 * after the button shows the text, focused and selected, and goes away on
 * blur or Escape (focus back on the button).
 *
 * After a copy the button shows it for --ds-hold-status: data-state="copied",
 * an icon swap inside it shows its b icon (the check), a button with faces
 * shows its done face (.ds-btn--done, whose check draws itself; it is
 * blocked while it shows), and .ds-copy__done holds the strings' copied
 * ("Copied"). The announcer says it (polite). ds:copy ({ text, ok, method })
 * goes out on the button either way. A button without a name gets the
 * strings' copy as its aria-label. create() and the attribute share one
 * controller per button.
 *
 * Progressive:
 * - Clipboard API (navigator.clipboard.writeText, secure contexts): without
 *   it the copy command, then the selected text and a hint.
 *
 * ES2022.
 */
import { define, emit, t } from './core.js';
import { motionDuration } from './motion.js';
import { announce } from './a11y.js';
import { format as formatKeys } from './hotkeys.js';

const viewOf = (node) => node?.ownerDocument?.defaultView ?? globalThis;

/** A target a value names: a selector, else an id. */
function targetOf(button, value) {
  const named = String(value ?? '').trim();
  if (!named) return null;
  const root = button.getRootNode?.() ?? button.ownerDocument;
  let found = null;
  try {
    found = root.querySelector?.(named) ?? null;
  } catch {
    // No selector: an id.
  }
  return found ?? button.ownerDocument?.getElementById(named.replace(/^#/, '')) ?? null;
}

/** What the source element holds: a field's value, else its text. */
function textIn(element) {
  if (!element) return '';
  if ('value' in element && /^(INPUT|TEXTAREA|SELECT|OUTPUT)$/.test(element.tagName)) return String(element.value);
  return String(element.textContent ?? '').trim();
}

/** The element whose text a button copies (for the manual fallback's selection), or null. */
function sourceOf(button) {
  return targetOf(button, button.getAttribute('data-ds-copy')) ?? button.closest('.ds-copy')?.querySelector('.ds-copy__value') ?? null;
}

/**
 * The text a copy button copies: data-ds-copy-value, else the target its
 * data-ds-copy names, else the .ds-copy__value beside it.
 * @param {Element} button
 * @returns {string}
 */
export function textOf(button) {
  if (button.hasAttribute('data-ds-copy-value')) return button.getAttribute('data-ds-copy-value') ?? '';
  return textIn(sourceOf(button));
}

/** The copy command on a hidden, read-only textarea; focus goes back where it was. */
function command(text, doc) {
  if (typeof doc?.execCommand !== 'function' || !doc.body) return false;
  const before = doc.activeElement;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.tabIndex = -1;
  // Off screen and out of the layout, never zoomed in on (iOS zooms below 16px).
  area.style.cssText = 'position:fixed;inset-block-start:0;inset-inline-start:-9999px;inline-size:1px;block-size:1px;opacity:0;font-size:16px';
  doc.body.append(area);
  let ok = false;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    ok = doc.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (before && typeof before.focus === 'function' && before !== doc.body) before.focus({ preventScroll: true });
  return ok;
}

/**
 * Copies `text`: the Clipboard API, else the copy command; resolves with
 * whether it worked and how ('clipboard', 'command' or 'none'). Never
 * rejects. `doc`: the document of the copy command (default: the page's).
 * @param {string} text
 * @param {{ doc?: Document }} [options]
 * @returns {Promise<{ ok: boolean, method: 'clipboard'|'command'|'none' }>}
 */
export function copy(text, options = {}) {
  const doc = options.doc ?? globalThis.document;
  const value = String(text ?? '');
  const fallback = () => (command(value, doc) ? { ok: true, method: 'command' } : { ok: false, method: 'none' });
  const clipboard = viewOf(doc?.documentElement).navigator?.clipboard ?? globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== 'function') return Promise.resolve(fallback());
  // Called at once, inside the click (Safari wants the user's gesture). Not
  // allowed here (a frame without the permission, an insecure page): the command next.
  let writing;
  try {
    writing = Promise.resolve(clipboard.writeText(value));
  } catch {
    return Promise.resolve(fallback());
  }
  return writing.then(() => ({ ok: true, method: 'clipboard' }), fallback);
}

/**
 * A read-only field after the button with the text, focused and selected,
 * for a copy by hand when nothing on the page shows it. It goes on blur;
 * Escape takes focus back to the button (and keeps an overlay around open).
 */
function showManual(button, text, signal) {
  const doc = button.ownerDocument;
  const field = doc.createElement('input');
  field.className = 'ds-copy__value ds-copy__manual';
  field.type = 'text';
  field.readOnly = true;
  field.value = text;
  const name = button.getAttribute('aria-label') || (button.textContent ?? '').trim();
  if (name) field.setAttribute('aria-label', name);
  const gone = new AbortController();
  const remove = () => {
    gone.abort();
    field.remove();
  };
  signal.addEventListener('abort', remove, { once: true, signal: gone.signal });
  field.addEventListener('blur', remove, { signal: gone.signal });
  field.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    button.focus({ preventScroll: true });
  }, { signal: gone.signal });
  button.after(field);
  field.focus({ preventScroll: true });
  field.select();
  return remove;
}

/** Selects the source's text, for a copy by hand. */
function selectSource(source) {
  if (!source) return;
  if (typeof source.select === 'function') {
    source.focus?.({ preventScroll: true });
    source.select();
    return;
  }
  const doc = source.ownerDocument;
  const selection = viewOf(source).getSelection?.();
  if (!selection || !doc?.createRange) return;
  const range = doc.createRange();
  range.selectNodeContents(source);
  selection.removeAllRanges();
  selection.addRange(range);
}

function controller(button, start, signal) {
  const listeners = new Set();
  const local = new AbortController();
  signal?.addEventListener('abort', () => local.abort(), { once: true });
  let own = start.text ?? null;
  let timer = 0;
  let manual = null;

  // A button with no words and no name says what it does.
  const name = () => {
    if (button.hasAttribute('aria-label') || button.hasAttribute('aria-labelledby') || (button.textContent ?? '').trim()) return;
    button.setAttribute('aria-label', t('copy'));
  };
  const words = () => {
    for (const slot of button.querySelectorAll('.ds-copy__done')) if (slot.textContent !== t('copied')) slot.textContent = t('copied');
  };
  name();
  words();

  const rest = () => {
    timer = 0;
    button.removeAttribute('data-state');
    button.classList.remove('ds-btn--done');
    for (const swap of button.querySelectorAll('.ds-icon-swap')) swap.setAttribute('data-swap', 'a');
  };
  const done = () => {
    const view = viewOf(button);
    view.clearTimeout(timer);
    words();
    button.setAttribute('data-state', 'copied');
    if (button.querySelector('.ds-btn__face--done')) button.classList.add('ds-btn--done');
    for (const swap of button.querySelectorAll('.ds-icon-swap')) swap.setAttribute('data-swap', 'b');
    timer = view.setTimeout(rest, motionDuration(button, '--ds-hold-status'));
  };
  const run = () => {
    const text = own ?? textOf(button);
    return copy(text, { doc: button.ownerDocument }).then((result) => settle(text, result));
  };
  const settle = (text, result) => {
    if (local.signal.aborted) return result;
    if (result.ok) {
      done();
      announce(t('copied'));
    } else {
      manual?.();
      manual = null;
      // The source shows what was meant to be copied: select it there. Else
      // (a value of the button's own, a text from set()) a field shows it.
      const source = sourceOf(button);
      if (source && !button.hasAttribute('data-ds-copy-value') && textIn(source) === text) selectSource(source);
      else if (button.isConnected) manual = showManual(button, text, local.signal);
      announce(t('copyManual', { keys: formatKeys('mod+c').text }), { assertive: true });
    }
    const detail = { text, ...result };
    emit(button, 'copy', detail);
    for (const fn of [...listeners]) fn(detail);
    return result;
  };

  button.addEventListener('click', (/** @type {MouseEvent} */ event) => {
    if (event.defaultPrevented || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('data-state') === 'copied') return;
    run();
  }, { signal: local.signal });

  const api = {
    element: button,
    get: () => own ?? textOf(button),
    set(text) { own = text === null || text === undefined ? null : String(text); },
    copy: run,
    done,
    on(type, fn) {
      if (type !== 'copy' || typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      listeners.clear();
      local.abort();
      if (controllers.get(button) === api) controllers.delete(button);
      if (timer) {
        viewOf(button).clearTimeout(timer);
        rest();
      }
    },
  };
  return api;
}

/** One controller per button, whichever of create() and the attribute came first. @type {WeakMap<Element, ReturnType<typeof controller>>} */
const controllers = new WeakMap();

/**
 * A copy button driven from the page; the controller data-ds-copy makes
 * (the same one, `text` applied through set(), when the attribute set it
 * up). `text`: what it copies (else textOf(button)).
 * @param {Element} button
 * @param {{ text?: string|null }} [options]
 */
export function create(button, options = {}) {
  const existing = controllers.get(button);
  if (existing) {
    if (options.text !== undefined) existing.set(options.text);
    return existing;
  }
  const made = controller(button, { text: options.text ?? null }, null);
  controllers.set(button, made);
  return made;
}

define('copy', {
  attribute: 'data-ds-copy',
  init(button, ctx) {
    const existing = controllers.get(button);
    if (existing) return existing;
    const made = controller(button, {}, ctx.signal);
    controllers.set(button, made);
    return made;
  },
});
