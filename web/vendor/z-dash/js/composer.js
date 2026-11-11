/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Composer (DS.composer): the behaviour of a .ds-composer, the message
 * field of a conversation.
 *
 *   <form class="ds-composer" data-ds-composer data-ds-composer-draft="ticket-42"> ... </form>
 *   const composer = DS.composer.create(form, { draft: 'ticket-42' });
 *   composer.on('send', ({ text, attachments, mentions, command }) => post(text));
 *   composer.set({ busy: true });               // the reply runs: Send turns into Stop
 *   composer.on('stop', () => abort());
 *
 * - Enter sends (also Ctrl/Cmd+Enter); Shift+Enter breaks the line. With
 *   data-ds-composer-enter="newline" (the default on a device without a
 *   fine pointer, whose on-screen keyboard has no Shift+Enter) Enter breaks
 *   the line and only Ctrl/Cmd+Enter and the button send. Nothing is sent
 *   while an input method composes, while the text and the attachments are
 *   empty, or while busy.
 * - A send dispatches the cancelable ds:send ({ text, attachments,
 *   mentions, command }) on the composer; unless a listener calls
 *   preventDefault() the field, the attachments and the draft are cleared
 *   and the focus stays in the field. The submit button is aria-disabled
 *   while there is nothing to send (the action guard blocks it).
 * - Busy (set({ busy }), or data-ds-composer-busy on the composer): the
 *   submit button becomes Stop (data-state="busy" on the composer, the
 *   button's .ds-icon-swap shows b, its name and tooltip the string stop);
 *   pressing it dispatches ds:stop. Enter keeps the text meanwhile.
 * - Drafts: with data-ds-composer-draft="<key>" the text is remembered
 *   through DS.store (namespace "composer") while typing, given back on the
 *   next visit when the field is empty, and dropped on send. A new key (one
 *   composer for several conversations) keeps the text under the old one,
 *   clears the field, the attachments and the chosen mentions, and gives
 *   back the new key's draft.
 * - Attachments: the attach button ([data-ds-composer-attach]) opens the
 *   .ds-composer__picker file input; files dropped on the composer or
 *   pasted into it count too (DS.dom.dropzone()). Each becomes a chip in
 *   .ds-composer__attachments with its size (DS.format.bytes) and a remove
 *   button; arriving and leaving chips pop (DS.motion.enter / leave), and
 *   both are announced. ds:attach ({ files }) and ds:remove ({ attachment })
 *   tell the page.
 * - The palettes: a .ds-composer__palette (role="listbox") per trigger
 *   character (data-ds-composer-trigger). "/" counts at the start of the
 *   message, any other trigger ("@") at the start or after a space. Typing
 *   it opens the palette at the caret through DS.overlay (a popover in the
 *   top layer, placed by the script with DS.position's geometry above the
 *   caret, below it without room, and placed again while it is open as the
 *   page scrolls, the window or the on-screen keyboard resizes and
 *   filtering changes its height); the text after it filters the options
 *   by their label (data-ds-composer-filter="off": the page renders them
 *   on ds:query, { trigger, query }). Focus stays in the field (a textarea
 *   cannot be a combobox: aria-autocomplete, aria-controls and
 *   aria-activedescendant, and the count of matches is announced, the
 *   string resultCount, or noResults): the arrow keys move the active option
 *   (aria-activedescendant, aria-selected), Enter or Tab inserts it
 *   (data-value, else its label) with a space, Escape closes it (DS.overlay)
 *   and it stays closed for that word; a click on an option inserts it, a
 *   press outside, a blur or a caret outside the word closes it. "/"
 *   dispatches ds:command, any other trigger ds:mention ({ value, id,
 *   option }); the send's detail lists the mentions still in the text.
 *
 * The controller: get() ({ text, attachments, busy }), set({ text, busy,
 * attachments }), on(type, fn) for send, stop, attach, remove, command,
 * mention and query, send(), add(files), remove(id), focus(), destroy().
 *
 * Progressive:
 * - field-sizing (the CSS): without it DS.dom.autosize() grows the field.
 */
import { define, emit, t } from './core.js';
import { leave, enter } from './motion.js';
import { autosize, dropzone } from './dom.js';
import { close as closeGlyph, file as fileGlyph, fileImage, iconElement } from './icons.js';
import { computePlacement, pxOf, viewportBounds } from './position.js';
import { open as openOverlay, close as closeOverlay } from './overlay.js';
import { announce } from './a11y.js';
import { bytes, list, number } from './format.js';
import { open as openStore } from './store.js';

/** The store namespace of the drafts. */
const DRAFTS = 'composer';

/** The events a controller's on() takes. */
const EVENTS = new Set(['send', 'stop', 'attach', 'remove', 'command', 'mention', 'query']);

/** The computed styles a caret mirror copies from its textarea. */
const MIRRORED = ['box-sizing', 'width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-style', 'font-variant', 'font-weight', 'font-stretch',
  'font-size', 'font-size-adjust', 'line-height', 'font-family', 'text-align', 'text-transform', 'text-indent',
  'letter-spacing', 'word-spacing', 'tab-size', 'direction'];

let sequence = 0;

/**
 * The word a palette serves, as the caret stands: the trigger right before
 * the text typed up to the caret, with no white space in between. "/"
 * counts only at the start of the message (after white space alone), any
 * other trigger at the start or after white space. Null when the caret is
 * in no such word.
 * @param {string} text
 * @param {number} caret
 * @param {string[]} [triggers]
 * @returns {{ trigger: string, query: string, start: number, end: number } | null}
 */
export function query(text, caret, triggers = ['/', '@']) {
  const value = String(text ?? '');
  const end = Math.max(0, Math.min(Number(caret) || 0, value.length));
  let start = end;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  const word = value.slice(start, end);
  const trigger = triggers.find((item) => item && word.startsWith(item));
  if (!trigger) return null;
  const rest = word.slice(trigger.length);
  if (triggers.some((item) => item && rest.includes(item))) return null;
  if (trigger === '/' && value.slice(0, start).trim() !== '') return null;
  return { trigger, query: rest, start, end };
}

/**
 * The viewport point of the caret at `index` in a textarea (its top and the
 * height of its line), measured on a hidden mirror with the textarea's
 * type and box.
 * @param {HTMLTextAreaElement} textarea
 * @param {number} index
 * @returns {{ x: number, y: number, height: number }}
 */
function caretAt(textarea, index) {
  const doc = textarea.ownerDocument;
  const view = doc.defaultView;
  const style = view.getComputedStyle(textarea);
  const mirror = doc.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  mirror.setAttribute('data-ds-keep', '');
  for (const name of MIRRORED) mirror.style.setProperty(name, style.getPropertyValue(name));
  mirror.style.setProperty('position', 'absolute');
  mirror.style.setProperty('visibility', 'hidden');
  mirror.style.setProperty('top', '0');
  mirror.style.setProperty('left', '0');
  mirror.style.setProperty('overflow', 'hidden');
  mirror.style.setProperty('white-space', 'pre-wrap');
  mirror.style.setProperty('overflow-wrap', 'break-word');
  mirror.textContent = textarea.value.slice(0, index);
  const mark = doc.createElement('span');
  mark.textContent = textarea.value.slice(index) || '.';
  mirror.append(mark);
  (textarea.parentNode ?? doc.body).append(mirror);
  const line = parseFloat(style.lineHeight);
  const box = textarea.getBoundingClientRect();
  const point = {
    x: box.left + mark.offsetLeft - textarea.scrollLeft,
    y: box.top + mark.offsetTop - textarea.scrollTop,
    height: Number.isFinite(line) ? line : mark.offsetHeight,
  };
  mirror.remove();
  return point;
}

/** The label an option is filtered and announced by. */
function labelOf(option) {
  return (option.getAttribute('data-label') ?? option.querySelector('.ds-composer__option-label')?.textContent ?? option.textContent ?? '').trim();
}

/** What an option inserts: data-value, else its label. */
function valueOf(option) {
  return option.getAttribute('data-value') ?? labelOf(option);
}

/** Enter sends unless the page asks for a new line, or the device has no fine pointer. */
function enterSends(el, mode) {
  const choice = mode ?? el.getAttribute('data-ds-composer-enter');
  if (choice === 'send') return true;
  if (choice === 'newline') return false;
  const view = el.ownerDocument?.defaultView;
  return !view?.matchMedia || view.matchMedia('(any-pointer: fine)').matches;
}

function controller(el, options, ctx) {
  const doc = el.ownerDocument;
  const signal = ctx.signal;
  const textarea = /** @type {HTMLTextAreaElement|null} */ (el.querySelector('.ds-composer__input, textarea'));
  const listeners = new Map();
  const attachments = [];
  const chosen = [];
  let busy = Boolean(options.busy);
  let draftKey = options.draft ?? null;
  let enterMode = options.enter ?? null;
  let store = null;
  let active = null;
  let token = null;
  let dismissed = -1;
  let watching = null;
  let heard = -1;
  const sizing = textarea ? autosize(textarea) : null;

  const fire = (type, detail, cancelable = false) => {
    const go = emit(el, type, detail, { cancelable });
    for (const fn of listeners.get(type) ?? []) fn(detail);
    return go;
  };

  const submit = () => el.querySelector('button[type="submit"], .ds-btn[type="submit"]') ?? el.querySelector('button:not([type]):not([data-ds-composer-attach])');
  const picker = () => /** @type {HTMLInputElement|null} */ (el.querySelector('.ds-composer__picker, input[type="file"]'));
  const tray = () => el.querySelector('.ds-composer__attachments');
  const palettes = () => /** @type {HTMLElement[]} */ (Array.from(el.querySelectorAll('.ds-composer__palette')));
  const triggers = () => palettes().map((palette) => palette.getAttribute('data-ds-composer-trigger') ?? '').filter(Boolean);
  const paletteFor = (trigger) => palettes().find((palette) => palette.getAttribute('data-ds-composer-trigger') === trigger) ?? null;
  const isOpen = (palette) => Boolean(palette && !palette.hidden && palette.getAttribute('data-state') === 'open');

  /* ── The submit button: Send, Stop, blocked ── */

  const submitLabel = { name: null, tip: null };
  function syncButton() {
    const button = submit();
    if (!button) return;
    if (submitLabel.name === null) {
      submitLabel.name = button.getAttribute('aria-label') ?? t('send');
      submitLabel.tip = button.getAttribute('data-tip');
    }
    const name = busy ? t('stop') : submitLabel.name;
    if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
    if (submitLabel.tip !== null) button.setAttribute('data-tip', busy ? t('stop') : submitLabel.tip);
    const swap = button.querySelector('.ds-icon-swap');
    if (swap) swap.setAttribute('data-swap', busy ? 'b' : 'a');
    const empty = !busy && !(textarea?.value.trim()) && attachments.length === 0;
    if (empty) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
    if (busy) el.setAttribute('data-state', 'busy');
    else el.removeAttribute('data-state');
  }

  /* ── Drafts ── */

  function draftStore() {
    if (!draftKey) return null;
    store ??= openStore(DRAFTS);
    return store;
  }

  function saveDraft() {
    const drafts = draftStore();
    if (!drafts || !textarea) return;
    if (textarea.value) drafts.set(draftKey, textarea.value);
    else drafts.remove(draftKey);
  }

  /**
   * Another conversation in the same composer: what is in the field stays
   * with the old key, the field, the attachments and the chosen mentions are
   * cleared, and the new key's draft comes back.
   */
  function switchDraft(next) {
    saveDraft();
    draftKey = next;
    for (const palette of palettes()) closePalette(palette);
    token = null;
    dismissed = -1;
    chosen.length = 0;
    clearAttachments();
    if (textarea) {
      textarea.value = '';
      restoreDraft();
      sizing?.update();
    }
  }

  function restoreDraft() {
    const drafts = draftStore();
    if (!drafts || !textarea || textarea.value) return;
    const text = drafts.get(draftKey, '');
    if (typeof text === 'string' && text) {
      textarea.value = text;
      sizing?.update();
    }
  }

  /* ── The palettes ── */

  function optionsIn(palette) {
    return /** @type {HTMLElement[]} */ (Array.from(palette.querySelectorAll('.ds-composer__option, [role="option"]')));
  }

  const usable = (option) => !option.hidden && option.getAttribute('aria-disabled') !== 'true';

  function activate(option) {
    if (active && active !== option) active.setAttribute('aria-selected', 'false');
    active = option;
    if (!textarea) return;
    if (option) {
      if (!option.id) option.id = `ds-composer-option-${sequence += 1}`;
      option.setAttribute('aria-selected', 'true');
      textarea.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView?.({ block: 'nearest' });
    } else textarea.removeAttribute('aria-activedescendant');
  }

  function filter(palette, text) {
    const needle = text.toLowerCase();
    const own = palette.getAttribute('data-ds-composer-filter') !== 'off';
    let first = null;
    let current = null;
    let count = 0;
    for (const option of optionsIn(palette)) {
      option.setAttribute('aria-selected', 'false');
      if (own) option.hidden = !labelOf(option).toLowerCase().replace(/^[/@#:]/, '').includes(needle.replace(/^[/@#:]/, ''));
      if (!usable(option)) continue;
      count += 1;
      first ??= option;
      if (option === active) current = option;
    }
    let none = palette.querySelector('.ds-composer__empty');
    if (!first && !none) {
      none = doc.createElement('div');
      none.className = 'ds-composer__empty';
      none.textContent = t('noResults');
      palette.append(none);
    }
    if (none) /** @type {HTMLElement} */ (none).hidden = Boolean(first);
    activate(current ?? first);
    return count;
  }

  /**
   * Says how many options match, when that changed: the textarea cannot
   * carry role="combobox", so nothing else tells a screen reader that the
   * list opened or what filtering left.
   */
  function sayCount(count) {
    if (count === heard) return;
    heard = count;
    // Keyed: typing faster than a frame says the last count only.
    announce(count ? t('resultCount', { count: number(count) }) : t('noResults'), { key: 'composer-count' });
  }

  /**
   * While a palette is open: a press outside closes it, and scrolling, a
   * resize, the on-screen keyboard and a change of its size (filtering,
   * options the page renders) place it again, once per frame.
   */
  function watch(palette) {
    watching?.abort();
    const current = new AbortController();
    watching = current;
    const view = doc.defaultView;
    const signal = current.signal;
    doc.addEventListener('pointerdown', onDocDown, { capture: true, signal });
    let frame = 0;
    const again = () => {
      if (frame) return;
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        if (watching === current && isOpen(palette)) place(palette);
      });
    };
    const onScroll = (event) => {
      if (event.target?.nodeType === 1 && palette.contains(event.target)) return;
      again();
    };
    view.addEventListener('scroll', onScroll, { signal, capture: true, passive: true });
    view.addEventListener('resize', again, { signal });
    view.visualViewport?.addEventListener('resize', again, { signal });
    view.visualViewport?.addEventListener('scroll', again, { signal });
    const sizes = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(again) : null;
    sizes?.observe(palette);
    signal.addEventListener('abort', () => {
      sizes?.disconnect();
      if (frame) view.cancelAnimationFrame(frame);
    }, { once: true });
  }

  function unwatch() {
    watching?.abort();
    watching = null;
  }

  /** Places the palette above the caret at the trigger (below it without room), in the viewport's terms. */
  function place(palette) {
    if (!textarea || !token) return;
    const caret = caretAt(textarea, token.start);
    const style = palette.style;
    style.removeProperty('max-height');
    const size = { width: palette.offsetWidth, height: palette.offsetHeight };
    const rect = { left: caret.x, right: caret.x, top: caret.y, bottom: caret.y + caret.height };
    const result = computePlacement(rect, size, viewportBounds(palette), {
      side: 'top', align: 'start', offset: pxOf(palette, '--ds-space-1', 4), padding: pxOf(palette, '--ds-space-2', 8), flip: 'room',
    });
    if (result.length < size.height) style.setProperty('max-height', `${Math.round(result.length)}px`);
    style.setProperty('--ds-composer-palette-x', `${Math.round(result.x)}px`);
    style.setProperty('--ds-composer-palette-y', `${Math.round(result.y)}px`);
    if (result.side === 'bottom') palette.setAttribute('data-placement', 'bottom');
    else palette.removeAttribute('data-placement');
    return { x: caret.x, y: result.side === 'bottom' ? caret.y + caret.height : caret.y };
  }

  function openPalette(palette) {
    if (!textarea) return;
    if (!palette.id) palette.id = `ds-composer-palette-${sequence += 1}`;
    textarea.setAttribute('aria-controls', palette.id);
    const open = isOpen(palette);
    if (!open) heard = -1;
    sayCount(filter(palette, token?.query ?? ''));
    // Filtering changes its height: above the caret its top edge moves.
    if (open) {
      place(palette);
      return;
    }
    for (const other of palettes()) if (other !== palette && isOpen(other)) closePalette(other);
    palette.hidden = false;
    if (palette.hasAttribute('popover')) {
      try {
        if (!palette.matches(':popover-open')) palette.showPopover();
      } catch {
        // Not in the document, or no popover: it stays fixed in place.
      }
    }
    place(palette);
    openOverlay(palette, { opener: textarea });
    watch(palette);
  }

  function closePalette(palette, reason) {
    if (!palette || palette.hidden) return;
    if (reason === 'escape' && token) dismissed = token.start;
    activate(null);
    unwatch();
    textarea?.removeAttribute('aria-controls');
    if (palette.getAttribute('data-state') === 'closed') return;
    closeOverlay(palette).then(() => {
      if (palette.getAttribute('data-state') === 'open' || !palette.hidden) return;
      try {
        if (palette.matches(':popover-open')) palette.hidePopover();
      } catch {
        // Already hidden.
      }
    });
  }

  function openPaletteNow() {
    return palettes().find(isOpen) ?? null;
  }

  /** Reads the word at the caret and opens, filters or closes the palettes. */
  function review() {
    if (!textarea) return;
    const caret = textarea.selectionStart === textarea.selectionEnd ? textarea.selectionEnd : -1;
    const found = caret < 0 || doc.activeElement !== textarea ? null : query(textarea.value, caret, triggers());
    // Escape closed the palette for this word: it stays closed until the word goes.
    if (!found) dismissed = -1;
    token = found && found.start !== dismissed ? found : null;
    const palette = token ? paletteFor(token.trigger) : null;
    for (const other of palettes()) if (other !== palette && isOpen(other)) closePalette(other);
    if (!palette) return;
    const before = palette.getAttribute('data-ds-query');
    if (before !== token.query) {
      palette.setAttribute('data-ds-query', token.query);
      fire('query', { trigger: token.trigger, query: token.query });
    }
    openPalette(palette);
  }

  function choose(option) {
    if (!textarea || !token || !option || !usable(option)) return;
    const palette = option.closest('.ds-composer__palette');
    const value = valueOf(option);
    const trigger = token.trigger;
    const insert = `${value} `;
    textarea.setRangeText(insert, token.start, token.end, 'end');
    const detail = { value, id: option.getAttribute('data-id') ?? value, option };
    chosen.push({ trigger, ...detail });
    token = null;
    closePalette(palette);
    textarea.dispatchEvent(new (doc.defaultView?.Event ?? Event)('input', { bubbles: true }));
    fire(trigger === '/' ? 'command' : 'mention', detail);
  }

  function move(step) {
    const palette = openPaletteNow();
    if (!palette) return;
    const items = optionsIn(palette).filter(usable);
    if (!items.length) return;
    const index = items.indexOf(active);
    const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
    activate(items[next]);
  }

  /* ── Attachments ── */

  function chipOf(item) {
    const chip = doc.createElement('li');
    chip.className = 'ds-composer__attachment';
    chip.setAttribute('data-ds-key', item.id);
    chip.append(iconElement(/^image\//.test(item.type) ? fileImage : fileGlyph, 18, undefined, doc));
    const name = doc.createElement('span');
    name.className = 'ds-composer__attachment-name';
    name.textContent = item.name;
    name.title = item.name;
    const size = doc.createElement('span');
    size.className = 'ds-composer__attachment-size';
    size.textContent = bytes(item.size);
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-xs';
    remove.setAttribute('aria-label', t('removeNamed', { name: item.name }));
    remove.setAttribute('data-ds-composer-remove', item.id);
    remove.append(iconElement(closeGlyph, 16, undefined, doc));
    chip.append(name, size, remove);
    return chip;
  }

  function add(files) {
    const list = Array.from(files ?? []).filter((item) => item && typeof item.name === 'string');
    if (!list.length) return [];
    const holder = tray();
    const added = list.map((file) => ({ id: `ds-attachment-${sequence += 1}`, name: file.name, size: Number(file.size) || 0, type: file.type ?? '', file }));
    attachments.push(...added);
    if (holder) {
      for (const item of added) {
        const chip = chipOf(item);
        holder.append(chip);
        enter(chip, 'pop');
      }
    }
    syncButton();
    announce(t('filesAttached', { names: listNames(added) }));
    fire('attach', { files: added.map((item) => item.file), attachments: added.map(copyOf) });
    return added.map(copyOf);
  }

  /** The chip of an attachment, by its key. */
  const chipFor = (id) => Array.from(tray()?.children ?? []).find((chip) => chip.getAttribute('data-ds-key') === id) ?? null;

  function remove(id) {
    const index = attachments.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = attachments.splice(index, 1);
    const chip = chipFor(id);
    if (chip) {
      const chips = Array.from(chip.parentElement.children).filter((other) => other !== chip && !other.hasAttribute('data-ds-leaving'));
      const after = chips.find((other) => chip.compareDocumentPosition(other) & 4) ?? chips.at(-1);
      const focusNext = () => after?.querySelector('button') ?? textarea;
      leave(chip, 'pop', { focus: focusNext });
    }
    syncButton();
    announce(t('fileRemoved', { name: item.name }));
    fire('remove', { attachment: copyOf(item) });
  }

  function clearAttachments() {
    for (const item of attachments.splice(0)) {
      const chip = chipFor(item.id);
      if (chip) leave(chip, 'pop', { focus: textarea });
    }
  }

  const copyOf = (item) => ({ id: item.id, name: item.name, size: item.size, type: item.type, file: item.file });
  const listNames = (items) => list(items.map((item) => item.name));

  /* ── Sending ── */

  function send() {
    if (!textarea || busy) return null;
    const text = textarea.value;
    if (!text.trim() && !attachments.length) return null;
    const mentions = chosen.filter((item) => item.trigger !== '/' && text.includes(item.value)).map(({ value, id }) => ({ value, id }));
    const command = chosen.find((item) => item.trigger === '/' && text.trimStart().startsWith(item.value))?.value ?? null;
    const detail = { text, attachments: attachments.map(copyOf), mentions, command };
    if (!fire('send', detail, true)) return null;
    textarea.value = '';
    chosen.length = 0;
    clearAttachments();
    sizing?.update();
    saveDraft();
    syncButton();
    for (const palette of palettes()) closePalette(palette);
    if (doc.activeElement !== textarea && el.contains(doc.activeElement)) textarea.focus({ preventScroll: true });
    return detail;
  }

  /* ── Listeners ── */

  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (event.target !== textarea || event.defaultPrevented) return;
    if (event.isComposing || event.keyCode === 229) return;
    const palette = openPaletteNow();
    if (palette) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.altKey && active) {
        event.preventDefault();
        choose(active);
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    const mod = event.ctrlKey || event.metaKey;
    if (!mod && !enterSends(el, enterMode)) return;
    event.preventDefault();
    send();
  };

  const onInput = (event) => {
    if (event.target !== textarea) return;
    saveDraft();
    syncButton();
    review();
  };

  const onSubmit = (event) => {
    event.preventDefault();
    if (busy) {
      fire('stop', {});
      return;
    }
    send();
  };

  const onClick = (event) => {
    const target = /** @type {Element} */ (event.target);
    const attach = target.closest?.('[data-ds-composer-attach]');
    if (attach && el.contains(attach)) {
      picker()?.click();
      return;
    }
    const removing = target.closest?.('[data-ds-composer-remove]');
    if (removing && el.contains(removing)) {
      remove(removing.getAttribute('data-ds-composer-remove'));
      return;
    }
    // A submit button outside a form (a div composer) acts as in a form.
    const button = target.closest?.('button[type="submit"]');
    if (button && el.contains(button) && el.localName !== 'form') {
      onSubmit(event);
      return;
    }
    const option = target.closest?.('.ds-composer__option, [role="option"]');
    if (option && option.closest('.ds-composer__palette')?.parentElement && el.contains(option)) {
      choose(option);
      textarea?.focus({ preventScroll: true });
      return;
    }
    if (target === textarea) review();
  };

  // A press on an option keeps the focus in the field.
  const onDown = (event) => {
    if (event.target.closest?.('.ds-composer__palette')) event.preventDefault();
  };

  const onDocDown = (event) => {
    const palette = openPaletteNow();
    if (!palette) return;
    const target = event.target;
    if (palette.contains(target) || target === textarea) return;
    closePalette(palette);
  };

  const onCaret = (event) => {
    if (event.target !== textarea) return;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) || (/^Arrow/.test(event.key ?? '') && !openPaletteNow())) review();
  };

  const onBlur = (event) => {
    if (event.target !== textarea) return;
    for (const palette of palettes()) if (isOpen(palette)) closePalette(palette);
  };

  const onClose = (event) => {
    const palette = event.target;
    if (!palette?.classList?.contains('ds-composer__palette')) return;
    if (event.detail?.reason === 'escape' && token) dismissed = token.start;
    activate(null);
    unwatch();
    textarea?.removeAttribute('aria-controls');
  };

  el.addEventListener('keydown', onKey, { signal });
  el.addEventListener('keyup', onCaret, { signal });
  el.addEventListener('input', onInput, { signal });
  el.addEventListener('submit', onSubmit, { signal });
  el.addEventListener('click', onClick, { signal });
  el.addEventListener('mousedown', onDown, { signal });
  el.addEventListener('focusout', onBlur, { signal });
  el.addEventListener('ds:close', onClose, { signal });
  const drops = dropzone(el, { onFiles: (files) => add(files), paste: true, input: picker() });

  if (textarea) textarea.setAttribute('aria-autocomplete', palettes().length ? 'list' : 'none');
  for (const palette of palettes()) {
    if (!palette.hasAttribute('popover')) palette.setAttribute('popover', 'manual');
    for (const option of optionsIn(palette)) option.setAttribute('aria-selected', 'false');
  }
  restoreDraft();
  syncButton();

  const handle = {
    get() {
      return { text: textarea?.value ?? '', attachments: attachments.map(copyOf), busy };
    },
    set(value = {}) {
      if (typeof value === 'string') value = { text: value };
      if ('busy' in value) busy = Boolean(value.busy);
      if ('text' in value && textarea) {
        textarea.value = String(value.text ?? '');
        sizing?.update();
        saveDraft();
      }
      if (Array.isArray(value.attachments)) {
        clearAttachments();
        add(value.attachments);
      }
      syncButton();
    },
    on(type, fn) {
      if (!EVENTS.has(type) || typeof fn !== 'function') return () => {};
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    send,
    add,
    remove,
    focus() {
      textarea?.focus();
    },
    update(names = ['data-ds-composer-busy', 'data-ds-composer-draft', 'data-ds-composer-enter']) {
      const changed = new Set(names);
      // Only what changed: a busy state set through set() outlives a new draft key.
      if (changed.has('data-ds-composer-busy')) busy = el.hasAttribute('data-ds-composer-busy');
      if (changed.has('data-ds-composer-enter')) enterMode = el.getAttribute('data-ds-composer-enter');
      if (changed.has('data-ds-composer-draft')) {
        const next = el.getAttribute('data-ds-composer-draft') || null;
        if (next !== draftKey) switchDraft(next);
      }
      syncButton();
    },
    destroy() {
      listeners.clear();
      for (const palette of palettes()) closePalette(palette);
      unwatch();
      drops.destroy();
      sizing?.destroy();
      store?.destroy();
      store = null;
    },
  };
  return handle;
}

/** The controller of each composer, so create() and the attribute path share one. @type {WeakMap<Element, any>} */
const controllers = new WeakMap();

/** The controller of `el`, made once with its own lifetime. */
function controllerOf(el, options) {
  const held = controllers.get(el);
  if (held) return held;
  const abort = new AbortController();
  const handle = controller(el, options, { signal: abort.signal });
  const destroy = handle.destroy;
  handle.destroy = () => {
    if (controllers.get(el) !== handle) return;
    controllers.delete(el);
    destroy();
    abort.abort();
  };
  controllers.set(el, handle);
  return handle;
}

define('composer', {
  attribute: 'data-ds-composer',
  attributes: ['data-ds-composer-busy', 'data-ds-composer-draft', 'data-ds-composer-enter'],
  init(el) {
    return controllerOf(el, {
      busy: el.hasAttribute('data-ds-composer-busy'),
      draft: el.getAttribute('data-ds-composer-draft') || null,
      enter: el.getAttribute('data-ds-composer-enter'),
    });
  },
});

/**
 * The controller of a composer driven from the page: the same one the
 * attribute path makes (one per element; options apply when it is made).
 * @param {Element} el
 * @param {{ draft?: string|null, enter?: 'send'|'newline'|null, busy?: boolean }} [options]
 */
export function create(el, options = {}) {
  return controllerOf(el, {
    busy: options.busy ?? el.hasAttribute('data-ds-composer-busy'),
    draft: options.draft ?? (el.getAttribute('data-ds-composer-draft') || null),
    enter: options.enter ?? el.getAttribute('data-ds-composer-enter'),
  });
}
