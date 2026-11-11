/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Terminal frame (DS.terminal): the chrome around a terminal emulator the
 * page brings (xterm.js or its own): a head with the title, the connection
 * status and the page's actions, the screen the emulator mounts into, and
 * a key bar with the keys a soft keyboard lacks (Esc, Tab, Ctrl, Alt, the
 * arrows), on phones by default. The emulator, the connection and what the
 * keys do stay the page's: the frame says which bytes a key sends.
 *
 *   <div class="ds-terminal" data-ds-terminal aria-label="Shell on device 42">
 *     <div class="ds-terminal__head">
 *       <span class="ds-terminal__title">ada@device-42: ~</span>
 *       <span class="ds-terminal__actions"> the page's quiet icon buttons </span>
 *     </div>
 *     <div class="ds-terminal__screen"> the emulator mounts here </div>
 *   </div>
 *   const frame = DS.terminal.create(el, { send: (data) => socket.send(data) });
 *   frame.set({ status: 'connected', title: 'ada@device-42: ~' });
 *   el.addEventListener('ds:key', (event) => console.log(event.detail.data));
 *   new Terminal({ theme: DS.terminal.theme(el) });   the emulator's colours from the theme's roles
 *   DS.terminal.sequence('up', { ctrl: true });        the bytes of a key: '\x1b[1;5A'
 *
 * The attribute path reads data-ds-terminal-keys (the keys of the bar, by
 * name, separated by spaces: esc, tab, ctrl, alt, up, down, left, right,
 * home, end, pgup, pgdn, or a single character; default "esc tab ctrl alt
 * left up down right"), data-ds-terminal-bar ("auto": on a coarse pointer
 * only, the default; "always"; "off") and data-ds-terminal-status (the
 * status: connecting, connected, disconnected, or none).
 *
 * The status is a .ds-status chip in the head (.ds-terminal__status, a
 * polite live region): a spinner and "Connecting", a plug and "Connected",
 * a broken link and "Disconnected"; the chip stays when the status
 * changes, so its colour glides.
 *
 * The key bar (.ds-terminal__keys, rendered by the script, a toolbar with
 * one tab stop and the arrow keys) never takes the focus from the screen:
 * a press on a key keeps the soft keyboard up. A key sends its sequence
 * through `send(data)` and the bubbling ds:key on the element. Ctrl and
 * Alt are held for the next key (aria-pressed, announced): a key of the
 * bar, or a character typed into the screen, which the frame then takes
 * (the emulator never sees it) and sends with the modifier: Ctrl+C sends
 * \x03. A second press lets the modifier go.
 *
 * A page that re-renders around the frame with DS.dom.morphHtml keeps it:
 * the key bar and the status chip carry data-ds-keep, and what the frame
 * writes on the element (role, aria-label, data-bar, data-status) is owned
 * state. The frame gives the page's title and screen no id (a generated id
 * would key them, and a morph would replace them): without an aria-label
 * of the page's, the frame's aria-label is the title's text, kept in step.
 * A change of data-ds-terminal-keys, -bar or -status applies that option
 * alone; the key bar is rebuilt only when its keys changed, and keeps the
 * focus and the tab stop on the same key.
 *
 * Events on the element: ds:key { key, data, ctrl, alt } for every key
 * the frame sends, ds:change { status, title } after set().
 *
 * ES2022. Progressive: none.
 */
import { define, emit, get, t } from './core.js';
import { announce, roving } from './a11y.js';
import { own, disown } from './dom.js';
import { iconElement, arrowUp, arrowDown, arrowLeft, arrowRight, plug, unlink } from './icons.js';

const CSI = '\u001b[';

/** The keys a bar can hold: the bytes they send and how they show. */
const KEYS = {
  esc: { data: '\u001b', label: 'keyEscape' },
  tab: { data: '\t', label: 'keyTab' },
  ctrl: { modifier: true, label: 'keyCtrl' },
  alt: { modifier: true, label: 'keyAlt' },
  up: { final: 'A', glyph: arrowUp, name: 'terminalUp' },
  down: { final: 'B', glyph: arrowDown, name: 'terminalDown' },
  right: { final: 'C', glyph: arrowRight, name: 'terminalRight' },
  left: { final: 'D', glyph: arrowLeft, name: 'terminalLeft' },
  home: { final: 'H', label: 'keyHome' },
  end: { final: 'F', label: 'keyEnd' },
  pgup: { tilde: 5, label: 'keyPageUp' },
  pgdn: { tilde: 6, label: 'keyPageDown' },
};

const DEFAULT_KEYS = ['esc', 'tab', 'ctrl', 'alt', 'left', 'up', 'down', 'right'];

/** The statuses: the chip's tone class, its glyph (none: the spinner) and its word. */
const STATUS = {
  connecting: { tone: 'ds-status--running', glyph: null, word: 'terminalConnecting' },
  connected: { tone: 'ds-tone-success', glyph: plug, word: 'terminalConnected' },
  disconnected: { tone: '', glyph: unlink, word: 'terminalDisconnected' },
};

/** The ANSI colours of an emulator's theme, in its order. */
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/** The keys of a bar a list names: known names in lower case, single characters as they are. */
function keyList(list) {
  return (Array.isArray(list) ? list : []).map(String).filter((key) => KEYS[key.toLowerCase()] || [...key].length === 1).map((key) => (KEYS[key.toLowerCase()] ? key.toLowerCase() : key));
}

/** A character with Ctrl held, as a terminal sends it (C0 controls), or null. */
function control(char) {
  if (char === ' ' || char === '@' || char === '2') return '\u0000';
  if (char === '?' || char === '8') return '\u007f';
  const code = char.toUpperCase().charCodeAt(0);
  // @ A-Z [ \ ] ^ _ map to 0-31.
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (char === '3') return '\u001b';
  if (char === '4') return '\u001c';
  if (char === '5') return '\u001d';
  if (char === '6') return '\u001e';
  if (char === '7') return '\u001f';
  return null;
}

/**
 * The bytes a key sends to a terminal (xterm's sequences, normal cursor
 * mode): `key` is a key name (esc, tab, up, down, left, right, home, end,
 * pgup, pgdn) or one character; `ctrl` and `alt` add the modifiers (a
 * cursor key takes them as its parameter, CSI 1;5A; a character becomes
 * its control code; Alt puts ESC before). Null for what cannot be sent
 * (Ctrl with a character that has no control code, a modifier alone).
 * @param {string} key
 * @param {{ ctrl?: boolean, alt?: boolean }} [modifiers]
 * @returns {string|null}
 */
export function sequence(key, modifiers = {}) {
  const name = String(key ?? '');
  const spec = KEYS[name.toLowerCase()];
  const ctrl = Boolean(modifiers.ctrl);
  const alt = Boolean(modifiers.alt);
  if (spec?.modifier) return null;
  if (spec && (spec.final || spec.tilde)) {
    const mod = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
    if (spec.tilde) return `${CSI}${spec.tilde}${mod > 1 ? `;${mod}` : ''}~`;
    return mod > 1 ? `${CSI}1;${mod}${spec.final}` : `${CSI}${spec.final}`;
  }
  let data = spec ? spec.data : [...name].length === 1 ? name : null;
  if (data === null) return null;
  if (ctrl) {
    if (name.toLowerCase() === 'tab') data = '\t';
    else if (spec) data = spec.data;
    else data = control(data);
    if (data === null) return null;
  }
  return alt ? `\u001b${data}` : data;
}

/**
 * The colours of the theme for an emulator, read from the computed roles
 * inside `el` (so the scheme, the theme and the hooks of that place apply):
 * an object in xterm.js's ITheme shape, `{ background, foreground, cursor,
 * cursorAccent, selectionBackground, selectionForeground, black, red,
 * green, yellow, blue, magenta, cyan, white, brightBlack, ... brightWhite }`,
 * each an rgb() text (the bright colours are the same roles). Read it
 * again after the scheme or the theme changes. Empty outside a document.
 * @param {Element} el
 * @returns {Record<string, string>}
 */
export function theme(el) {
  const doc = el?.ownerDocument;
  const view = doc?.defaultView;
  if (!view) return {};
  const host = el.querySelector?.(':scope > .ds-terminal__screen') ?? el;
  const probe = doc.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.className = 'ds-terminal__probe';
  host.append(probe);
  // The private colours of .ds-terminal (terminal.css): the hooks over their roles, in one place.
  const read = (name) => {
    probe.style.setProperty('color', `var(--_${name})`);
    return view.getComputedStyle(probe).color;
  };
  const colours = {
    background: read('bg'),
    foreground: read('fg'),
    cursor: read('cursor'),
    cursorAccent: read('bg'),
    selectionBackground: read('selection'),
    selectionForeground: read('on-selection'),
  };
  for (const name of ANSI) colours[name] = read(name);
  for (const name of ANSI) colours[`bright${name[0].toUpperCase()}${name.slice(1)}`] = colours[name];
  probe.remove();
  return colours;
}

function readOptions(el) {
  const keys = el.getAttribute('data-ds-terminal-keys');
  const bar = el.getAttribute('data-ds-terminal-bar');
  return {
    keys: keys ? keys.trim().split(/\s+/) : undefined,
    bar: bar === 'always' || bar === 'off' ? bar : 'auto',
    status: el.getAttribute('data-ds-terminal-status') || undefined,
  };
}

function controller(el, start, outer) {
  const doc = el.ownerDocument;
  const life = new AbortController();
  outer?.addEventListener('abort', () => life.abort(), { once: true });
  const { signal } = life;
  const listeners = { key: new Set(), change: new Set() };
  const state = {
    keys: keyList(start.keys ?? DEFAULT_KEYS),
    bar: start.bar === 'always' || start.bar === 'off' ? start.bar : 'auto',
    status: STATUS[start.status] ? start.status : null,
    send: typeof start.send === 'function' ? start.send : null,
    ctrl: false,
    alt: false,
  };
  let destroyed = false;

  const head = el.querySelector(':scope > .ds-terminal__head');
  const screen = el.querySelector(':scope > .ds-terminal__screen');
  const title = head?.querySelector('.ds-terminal__title') ?? null;
  if (title && start.title !== undefined) title.textContent = String(start.title);

  /* The name: the page's aria-label, else the title's text (an aria-label of the frame's, kept in step). */
  const ownRole = !el.hasAttribute('role');
  if (ownRole) {
    el.setAttribute('role', 'group');
    own(el, 'attrs', 'role');
  }
  /** The aria-label the frame wrote, or null while the name is the page's. */
  let ownLabel = null;
  const syncLabel = () => {
    if (ownLabel === null || !title) return;
    const current = el.getAttribute('aria-label');
    if (current !== null && current !== ownLabel) {
      // The page named the frame: its name from now on.
      disown(el, 'attrs', 'aria-label');
      ownLabel = null;
      return;
    }
    const text = (title.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) {
      if (current !== text) el.setAttribute('aria-label', text);
    } else el.removeAttribute('aria-label');
    ownLabel = text;
  };
  if (title && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
    ownLabel = '';
    own(el, 'attrs', 'aria-label');
    syncLabel();
  }
  own(el, 'attrs', 'data-bar');
  own(el, 'attrs', 'data-status');

  /* The status: a .ds-status chip in the head, kept while the status changes so its colour glides. */
  let status = null;
  const renderStatus = () => {
    if (!head) return;
    if (!state.status) {
      status?.remove();
      status = null;
      el.removeAttribute('data-status');
      return;
    }
    const spec = STATUS[state.status];
    if (!status) {
      status = doc.createElement('span');
      status.setAttribute('role', 'status');
      // The frame's own: a re-render of the head leaves it.
      status.setAttribute('data-ds-keep', '');
      const actions = head.querySelector(':scope > .ds-terminal__actions');
      head.insertBefore(status, actions);
    }
    status.className = `ds-status ds-terminal__status ${spec.tone}`.trim();
    let lead;
    if (spec.glyph) lead = iconElement(spec.glyph, 16, '', doc);
    else {
      lead = doc.createElement('span');
      lead.className = 'ds-spinner ds-status__spinner';
      lead.setAttribute('aria-hidden', 'true');
    }
    const word = doc.createElement('span');
    word.textContent = t(spec.word);
    status.replaceChildren(lead, word);
    el.setAttribute('data-status', state.status);
  };

  /* The key bar. */
  const bar = doc.createElement('div');
  bar.className = 'ds-terminal__keys';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', t('terminalKeys'));
  bar.setAttribute('data-ds-keep', '');
  if (screen?.id) bar.setAttribute('aria-controls', screen.id);
  const keyButton = (key) => {
    const spec = KEYS[key];
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = spec?.glyph ? 'ds-btn ds-btn--outlined ds-btn--icon ds-terminal__key' : 'ds-btn ds-btn--outlined ds-terminal__key';
    button.setAttribute('data-ds-terminal-key', key);
    button.tabIndex = -1;
    if (spec?.modifier) button.setAttribute('aria-pressed', String(Boolean(state[key])));
    if (spec?.glyph) {
      button.setAttribute('aria-label', t(spec.name));
      button.append(iconElement(spec.glyph, 18, '', doc));
    } else button.textContent = spec ? t(spec.label) : key;
    return button;
  };
  const keyOf = (key) => (key === null ? null : [...bar.querySelectorAll('.ds-terminal__key')].find((button) => button.getAttribute('data-ds-terminal-key') === key) ?? null);
  const renderBar = () => {
    // The key that held the focus and the one with the tab stop keep them when they are still there.
    const active = doc.activeElement;
    const focused = active && bar.contains(active) ? active.closest('.ds-terminal__key')?.getAttribute('data-ds-terminal-key') ?? null : null;
    const stopped = bar.querySelector('.ds-terminal__key[tabindex="0"]')?.getAttribute('data-ds-terminal-key') ?? null;
    bar.replaceChildren(...state.keys.map(keyButton));
    const stop = keyOf(focused) ?? keyOf(stopped) ?? bar.querySelector('.ds-terminal__key');
    if (stop) stop.tabIndex = 0;
    bar.hidden = state.keys.length === 0;
    el.setAttribute('data-bar', state.bar);
    if (focused !== null && stop && !bar.hidden) stop.focus();
  };
  renderBar();
  el.append(bar);
  const rover = roving(bar, { items: '.ds-terminal__key', orientation: 'horizontal', activate: false });

  const tell = (type, detail) => {
    if (signal.aborted) return;
    emit(el, type, detail);
    listeners[type]?.forEach((fn) => fn(detail));
  };

  const latch = (name, on) => {
    if (state[name] === on) return false;
    state[name] = on;
    bar.querySelector(`[data-ds-terminal-key="${name}"]`)?.setAttribute('aria-pressed', String(on));
    return true;
  };

  const send = (key, data) => {
    const detail = { key, data, ctrl: state.ctrl, alt: state.alt };
    latch('ctrl', false);
    latch('alt', false);
    state.send?.(data);
    tell('key', detail);
  };

  /** A key of the bar, by name or as a character: a modifier toggles, the rest is sent. */
  const press = (key) => {
    const name = KEYS[String(key).toLowerCase()] ? String(key).toLowerCase() : String(key);
    const spec = KEYS[name];
    if (spec?.modifier) {
      latch(name, !state[name]);
      announce(t(state[name] ? 'terminalHeld' : 'terminalReleased', { key: t(spec.label) }));
      return;
    }
    const data = sequence(name, { ctrl: state.ctrl, alt: state.alt });
    if (data !== null) send(name, data);
  };

  // A press on a key never takes the focus from the screen: the soft keyboard stays up.
  const onKey = (event) => /** @type {Element} */ (event.target)?.closest?.('.ds-terminal__key');
  bar.addEventListener('pointerdown', (event) => {
    if (onKey(event) && event.pointerType !== 'mouse' && screen?.contains(doc.activeElement)) event.preventDefault();
  }, { signal });
  bar.addEventListener('mousedown', (event) => {
    if (onKey(event) && screen?.contains(doc.activeElement)) event.preventDefault();
  }, { signal });
  bar.addEventListener('click', (event) => {
    const button = onKey(event);
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    press(button.getAttribute('data-ds-terminal-key'));
  }, { signal });

  // A held modifier takes the next character typed into the screen.
  const typed = (event, char) => {
    if (!state.ctrl && !state.alt) return;
    if ([...char].length !== 1) return;
    const data = sequence(char, { ctrl: state.ctrl, alt: state.alt });
    if (data === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send(char, data);
  };
  screen?.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    if ([...event.key].length === 1) typed(event, event.key);
  }, { capture: true, signal });
  screen?.addEventListener('beforeinput', (event) => {
    if (event.inputType === 'insertText' && event.data) typed(event, event.data);
  }, { capture: true, signal });

  renderStatus();

  // A title that changes (set(), or a re-render of the page) renames the frame.
  const Watch = doc.defaultView?.MutationObserver;
  const watcher = head && ownLabel !== null && Watch ? new Watch(syncLabel) : null;
  watcher?.observe(head, { childList: true, characterData: true, subtree: true });

  const handle = {
    /** @returns {{ status: string|null, title: string, keys: string[], bar: string, ctrl: boolean, alt: boolean }} */
    get() {
      return { status: state.status, title: title?.textContent ?? '', keys: [...state.keys], bar: state.bar, ctrl: state.ctrl, alt: state.alt };
    },
    set(value = {}) {
      let changed = false;
      if (value.status !== undefined) {
        const next = STATUS[value.status] ? value.status : null;
        if (next !== state.status) {
          state.status = next;
          renderStatus();
          changed = true;
        }
      }
      if (value.title !== undefined && title && title.textContent !== String(value.title)) {
        title.textContent = String(value.title);
        syncLabel();
        changed = true;
      }
      if (value.keys !== undefined) {
        const keys = keyList(value.keys);
        if (keys.join('\u0000') !== state.keys.join('\u0000')) {
          state.keys = keys;
          renderBar();
        }
      }
      if (value.bar !== undefined) {
        state.bar = value.bar === 'always' || value.bar === 'off' ? value.bar : 'auto';
        el.setAttribute('data-bar', state.bar);
      }
      if (value.send !== undefined) state.send = typeof value.send === 'function' ? value.send : null;
      if (value.ctrl !== undefined) latch('ctrl', Boolean(value.ctrl));
      if (value.alt !== undefined) latch('alt', Boolean(value.alt));
      if (changed) tell('change', { status: state.status, title: title?.textContent ?? '' });
    },
    press,
    on(type, fn) {
      const set = listeners[type];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    /** Applies the data-ds-terminal-* options whose attributes changed (`names`, from DS.core), else all of them. */
    update(names) {
      const has = (attribute) => !Array.isArray(names) || names.includes(attribute);
      const options = readOptions(el);
      const next = {};
      if (has('data-ds-terminal-keys')) next.keys = options.keys ?? DEFAULT_KEYS;
      if (has('data-ds-terminal-bar')) next.bar = options.bar;
      if (has('data-ds-terminal-status')) next.status = options.status ?? null;
      handle.set(next);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      rover?.destroy?.();
      watcher?.disconnect();
      life.abort();
      Object.values(listeners).forEach((set) => set.clear());
      bar.remove();
      status?.remove();
      if (ownRole) {
        disown(el, 'attrs', 'role');
        el.removeAttribute('role');
      }
      if (ownLabel !== null) {
        disown(el, 'attrs', 'aria-label');
        el.removeAttribute('aria-label');
      }
      disown(el, 'attrs', 'data-bar');
      disown(el, 'attrs', 'data-status');
      el.removeAttribute('data-bar');
      el.removeAttribute('data-status');
    },
  };
  return handle;
}

define('terminal', {
  attribute: 'data-ds-terminal',
  attributes: ['data-ds-terminal-keys', 'data-ds-terminal-bar', 'data-ds-terminal-status'],
  init(el, ctx) {
    return controller(el, readOptions(el), ctx.signal);
  },
});

/**
 * A terminal frame driven from the page; the same controller the attribute
 * path makes. `send(data)` gets the bytes of every key; `keys`, `bar`
 * ('auto', 'always', 'off'), `status` and `title`. On a frame the
 * attribute path already runs, that controller takes the options.
 * @param {Element} el
 * @param {{ send?: (data: string) => void, keys?: string[], bar?: 'auto'|'always'|'off', status?: 'connecting'|'connected'|'disconnected'|null, title?: string }} [options]
 */
export function create(el, options = {}) {
  const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  const running = get(el, 'terminal');
  if (running) {
    running.set(given);
    return running;
  }
  const attributes = readOptions(el);
  return controller(el, { ...attributes, ...given }, null);
}
