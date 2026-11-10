/**
 * Updating rendered HTML in place, without restarting animations.
 *
 * Replacing innerHTML recreates every node: entrance animations play again,
 * spinners jump back to their start, transitions never run and focus is
 * lost. morphHtml() instead patches the nodes that are already there:
 *
 * - A node of the same tag (and the same key, or both without one) is kept.
 *   Its attributes are synced (changed ones set, missing ones removed) and
 *   its children patched the same way, so a class or --ds-progress change
 *   runs its transition. Text nodes change their text in place.
 * - The shell: tag and attributes. Equal shells, or equivalent ones (the
 *   class sets equal as sets, the styles declaration by declaration, an
 *   empty style equal to none, every other attribute exact; runtime and
 *   owned names aside), are patched, never replaced, also under
 *   { replace: true }. onKeep(kept, template) runs after each kept element
 *   was patched.
 * - Styles go through the CSSOM (style.cssText), never setAttribute: the
 *   markup's style attributes are renamed before the parse and applied
 *   through the CSSOM after it, so a strict style-src without
 *   style-src-attr applies them without a violation report.
 * - Keys: `data-ds-key`, else `id`. A keyed node is looked up among all old
 *   siblings and moved to its place; two different keys never morph into
 *   each other. Unkeyed nodes match by position, with a short look-ahead
 *   (8 siblings) for an identical node, so the cost stays linear.
 * - Runtime state survives: the classes DS adds (ds-enter*, ds-leave*,
 *   ds-has-indicator, ds-pressed, ds-ripples), the custom properties it
 *   writes (--ds-i, --ds-indicator-*, --ds-ripple-x/-y/-r, --ds-motion-origin,
 *   --ds-clip-from), data-ds-staggered and the `inert` of an element in a
 *   DS.motion.leave() (ds-leave*). So does the state a helper owns while
 *   it runs (the record under Symbol.for('ds.owned'), see motion.js): an
 *   overlay from open() until its close settled (data-state, its dropped
 *   `hidden`, `open`, popover, data-anchored, data-placement, the
 *   --closing, --nested and --hidden classes, --ds-menu-x/-y, max-height
 *   and position-anchor; the `inert` of its box or panel during the exit;
 *   aria-expanded on its opener, data-drawer-open on .ds-app, anchor-name
 *   on its anchor, the `inert` of what its trap took), a tooltip's
 *   aria-describedby, a snackbar's .ds-toast--shown, busy()'s aria-busy
 *   and .ds-btn--done, countUp()'s
 *   aria-busy, min-width and tabular figures, a running swap's .ds-swap or
 *   .ds-icon-swap and data-swap, flip()'s z-index and position on the
 *   items that glide and, on their container, data-ds-glide,
 *   --ds-flip-backdrop and the position, isolation, min-height and
 *   align-content it holds, and a gliding chip row's data-ds-glide and
 *   --ds-chips-backdrop. An owned name stays as it is, present or absent;
 *   once the helper lets go, the next patch takes the template's value.
 *   The focused element and its ancestors are always patched, never
 *   replaced; a focused control keeps its live value and selection, a
 *   focused <select> its selected options and a focused radio the choice
 *   of its group (only controls outside the focused one get their value,
 *   checked and selected properties from changed attributes).
 * - `data-ds-keep` nodes (the indicator, ripples, the snackbar announcers
 *   and the tooltip of DS.overlay) are never matched, moved or removed. `data-ds-replace` on a node, old or new, or
 *   `{ replace: true }` for the whole call, brings back replace-on-change
 *   for that subtree (fresh nodes, fresh listeners).
 * - Hooks for DS.motion.flip(): `onInsert(node)` after a new element went
 *   in; `onRemove(node)` may return a Promise, and the node then stays as a
 *   pending removal (inert, aria-hidden, data-ds-leaving) that later morphs
 *   skip, until the Promise settles. DS.motion.leave() marks an element it
 *   will remove the same way (data-ds-leaving), so a re-render during its
 *   exit patches the next live sibling instead. `holdOrder: true` patches
 *   matched children of `target` in place and leaves moves, inserts and
 *   removals to a later call.
 *
 * State reporters and helpers (2.0), each once per element with an
 * { update?, destroy } handle: watchScrolled() (data-scrolled from a
 * sentinel), scrollEdges() (which ends have more to scroll), progress()
 * (a share and its ARIA), roving() (one tab stop for a set of items),
 * followViewport() (the frame follows the on-screen keyboard), followEnd()
 * (a log that sticks to its end), autosize() (a growing textarea) and
 * dropzone() (files by drop, dialog and paste). What they write on
 * elements is owned state, so a re-render keeps it.
 *
 * ES2022 (Safari 16.4); a module may import from an earlier module; newer
 * APIs only behind feature detection, named under Progressive:.
 *
 * Progressive:
 * - visualViewport (followViewport()): without it nothing follows the
 *   keyboard and the frame keeps its height.
 * - scrollIntoView behavior "instant" (followViewport() panning the page
 *   back to its top): without it scrollIntoView(true) instead.
 * - moveBefore (a keyed move keeps the node's animations, focus and iframe
 *   state): without it insertBefore, and a moved node that held the focus
 *   gets it back with its selection. insertBefore makes the node new to
 *   the style engine, so its @starting-style entrances (a status icon)
 *   would play again: it carries data-ds-moving (transition: none in
 *   motion.css) until one style flush at the end of the call.
 */

import { resyncScroll } from './motion.js';

/** How many candidate siblings the look-ahead for an identical node checks. */
const LOOKAHEAD = 8;

/** Classes that DS sets at runtime; a patch never removes them. */
const RUNTIME_CLASS = /^ds-(?:enter|leave)(?:--[\w-]+)?$|^ds-(?:has-indicator|pressed|ripples)$/;

/** Custom properties that DS writes at runtime; a patch keeps them over the new style text. */
const RUNTIME_STYLE = /^--ds-(?:i|indicator-[\w-]+|ripple-[xyr]|motion-origin|clip-from)$/;

/** Attributes that DS sets at runtime; a patch never removes them. */
const RUNTIME_ATTRIBUTES = new Set(['data-ds-staggered', 'data-ds-moving']);

/**
 * The runtime state a DS helper owns on an element right now (motion.js
 * and overlay.js write it under this symbol of the global registry, so
 * every copy of ds.js on the page shares it): { attrs, classes, props },
 * each a Map of name to a count of owners.
 */
const OWNED = Symbol.for('ds.owned');

/** Whether a helper owns `name` of `kind` ('attrs', 'classes', 'props') on the element. */
const owned = (element, kind, name) => Boolean(element[OWNED]?.[kind]?.get(name));

/** An element in a DS.motion.leave() (running, or kept with then: 'keep'): its `inert` is runtime state. */
const exiting = (element) => Array.from(element.classList ?? []).some((name) => /^ds-leave(?:--[\w-]+)?$/.test(name));

/**
 * The focused element as seen from `node`'s tree: inside a shadow root its
 * own activeElement (document.activeElement is the shadow host there, so a
 * morph in a shadow root would overwrite the focused field), else the
 * document's.
 * @param {any} node
 * @returns {any}
 */
function activeIn(node) {
  const root = node?.getRootNode?.();
  return (root?.nodeType === 11 ? root.activeElement : null) ?? node?.ownerDocument?.activeElement ?? null;
}

/**
 * @typedef {object} MorphOptions
 * @property {boolean} [replace]  replace instead of patching nodes whose shell differs
 * @property {boolean} [holdOrder]  patch matched children of the target only (no moves, inserts or removals)
 * @property {(node: Element) => void} [onInsert]  after a new element was inserted
 * @property {(node: Element) => (Promise<unknown>|unknown)} [onRemove]  before an element goes; a Promise keeps it until it settles
 * @property {(kept: Element, template: Element) => void} [onKeep]  after a kept element was patched from `template` (2.0)
 */

/**
 * @typedef {object} Context
 * @property {boolean} replace
 * @property {MorphOptions} options
 * @property {Element|null} active  the focused element at the start of the call
 * @property {Element[]} moved  nodes moved by insertBefore, marked data-ds-moving until the call ends
 */

const isElement = (node) => node?.nodeType === 1;

/** The declarations of a style text as name → "value priority" (a parse good enough to compare two). */
function declarations(text) {
  const out = new Map();
  for (const part of String(text ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim();
    if (name) out.set(name.startsWith('--') ? name : name.toLowerCase(), part.slice(colon + 1).trim().replace(/\s+/g, ' '));
  }
  return out;
}

/**
 * Whether two element shells are equivalent where the exact check failed:
 * the same tag; the class sets equal as sets, without the runtime classes
 * and the classes a helper owns on `a`; the style equal declaration by
 * declaration, without runtime and owned properties (an empty or blank
 * style equals none); every other attribute exact, without runtime and
 * owned ones. Such a node is patched, never replaced, also under
 * `{ replace: true }` or data-ds-replace.
 */
function equivalentShell(a, b) {
  if (!isElement(a) || !isElement(b) || a.tagName !== b.tagName) return false;
  const classes = (element, other) => new Set((element.getAttribute('class') ?? '').split(/\s+/)
    .filter((name) => name && !RUNTIME_CLASS.test(name) && !owned(other, 'classes', name)));
  const ca = classes(a, a);
  const cb = classes(b, a);
  if (ca.size !== cb.size || [...ca].some((name) => !cb.has(name))) return false;
  const styles = (element) => new Map([...declarations(element.getAttribute('style'))]
    .filter(([name]) => !RUNTIME_STYLE.test(name) && !owned(a, 'props', name)));
  const sa = styles(a);
  const sb = styles(b);
  if (sa.size !== sb.size || [...sa].some(([name, value]) => sb.get(name) !== value)) return false;
  const others = (element) => Array.from(element.attributes).filter(({ name }) => name !== 'class' && name !== 'style'
    && !RUNTIME_ATTRIBUTES.has(name) && !owned(a, 'attrs', name) && !(name === 'inert' && exiting(a)));
  const oa = others(a);
  const ob = others(b);
  return oa.length === ob.length && oa.every(({ name, value }) => b.getAttribute(name) === value);
}

/** Same element "shell": tag and attributes, ignoring the children. */
function sameShell(a, b) {
  if (!isElement(a) || !isElement(b)) return false;
  const x = /** @type {Element} */ (a);
  const y = /** @type {Element} */ (b);
  if (x.tagName !== y.tagName || x.attributes.length !== y.attributes.length) return false;
  for (const attribute of Array.from(x.attributes)) {
    if (y.getAttribute(attribute.name) !== attribute.value) return false;
  }
  return true;
}

/** The key of a node: data-ds-key, else id, else null. */
function keyOf(node) {
  if (!isElement(node)) return null;
  return node.getAttribute('data-ds-key') || node.getAttribute('id') || null;
}

const kept = (node) => isElement(node) && node.hasAttribute('data-ds-keep');
const leaving = (node) => isElement(node) && node.hasAttribute('data-ds-leaving');
/** A node a morph never looks at: kept (indicator, ripple) or a pending removal. */
const skipped = (node) => kept(node) || leaving(node);
const blank = (node) => node.nodeType === 3 && !/\S/.test(node.nodeValue ?? '');
const replacing = (node) => isElement(node) && node.hasAttribute('data-ds-replace');

/** The node itself or the first sibling after it that a morph looks at. */
function live(node) {
  let current = node;
  while (current && skipped(current)) current = current.nextSibling;
  return current;
}

/** Holds the focused element (or is it). */
function holdsFocus(node, ctx) {
  return Boolean(ctx.active && isElement(node) && (node === ctx.active || node.contains(ctx.active)));
}

/** Same kind of node: both text, both comments, or elements of one tag. */
function sameKind(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  return !isElement(a) || a.tagName === b.tagName;
}

/* ── Removing and inserting ─────────────────────────── */

/**
 * Removes a node, through onRemove: a returned Promise keeps it as a
 * pending removal (inert, hidden from assistive tech, skipped by later
 * morphs) until it settles. Kept nodes never go.
 */
function removeNode(node, ctx) {
  if (kept(node)) return;
  if (!isElement(node) || typeof ctx.options.onRemove !== 'function') {
    node.remove();
    return;
  }
  const result = ctx.options.onRemove(/** @type {Element} */ (node));
  if (!result || typeof (/** @type {any} */ (result).then) !== 'function') {
    node.remove();
    return;
  }
  const element = /** @type {HTMLElement} */ (node);
  element.setAttribute('data-ds-leaving', '');
  element.setAttribute('aria-hidden', 'true');
  element.inert = true;
  const done = () => element.remove();
  /** @type {Promise<unknown>} */ (result).then(done, done);
}

function insertNode(parent, node, before, ctx) {
  parent.insertBefore(node, before);
  if (isElement(node)) ctx.options.onInsert?.(node);
}

/**
 * Moves a kept node before `before`: moveBefore where it exists (the node
 * keeps its animations and focus), else insertBefore, after which a node
 * that held the focus gets it back with its selection. The insertBefore
 * path marks the node data-ds-moving, so it skips its @starting-style
 * entrances; morphChildren() lifts the marks after one style flush.
 */
function moveNode(parent, node, before, ctx) {
  if (typeof parent.moveBefore === 'function') {
    try {
      parent.moveBefore(node, before);
      return;
    } catch {
      // Not movable atomically (another document, disconnected): insert.
    }
  }
  const focused = holdsFocus(node, ctx) ? /** @type {any} */ (ctx.active) : null;
  let selection = null;
  try {
    if (focused && typeof focused.selectionStart === 'number') selection = [focused.selectionStart, focused.selectionEnd, focused.selectionDirection];
  } catch {
    // Inputs without a selection (checkbox, number) throw on read.
  }
  if (!node.hasAttribute('data-ds-moving')) {
    node.setAttribute('data-ds-moving', '');
    ctx.moved.push(node);
  }
  parent.insertBefore(node, before);
  const doc = parent.ownerDocument;
  if (focused && doc && activeIn(focused) !== focused && typeof focused.focus === 'function') {
    focused.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange?.(selection[0], selection[1], selection[2] ?? undefined);
  }
}

/* ── Patching one node ──────────────────────────────── */

/**
 * Syncs the class attribute, keeping the runtime classes of `old` and its
 * owned classes as they are (an owned class it lacks is not added).
 */
function syncClass(old, next) {
  const current = Array.from(old.classList);
  const wanted = (next.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
    .filter((name) => current.includes(name) || !owned(old, 'classes', name));
  const runtime = current.filter((name) => (RUNTIME_CLASS.test(name) || owned(old, 'classes', name)) && !wanted.includes(name));
  const result = [...wanted, ...runtime];
  if (result.length === current.length && result.every((name) => current.includes(name))) return;
  if (result.length) old.setAttribute('class', result.join(' '));
  else old.removeAttribute('class');
}

/**
 * Syncs the style, then puts back the custom properties DS wrote at
 * runtime and the owned properties as they were (an owned property the
 * element lacked stays absent). Through the CSSOM (style.cssText), so a
 * strict Content-Security-Policy without style-src-attr applies it; the
 * attribute goes only when nothing is left. An element without a style
 * object (none in a browser) gets the attribute.
 */
function syncStyle(old, next) {
  const wanted = next.getAttribute('style');
  if (old.getAttribute('style') === wanted) return;
  const style = old.style;
  if (!style || typeof style.setProperty !== 'function') {
    if (wanted === null) old.removeAttribute('style');
    else old.setAttribute('style', wanted);
    return;
  }
  const runtime = [];
  const props = old[OWNED]?.props;
  const absent = [];
  for (let index = 0; index < style.length; index += 1) {
    const name = style[index];
    if (RUNTIME_STYLE.test(name) || owned(old, 'props', name)) runtime.push([name, style.getPropertyValue(name), style.getPropertyPriority(name)]);
  }
  for (const [name, count] of props ?? []) if (count && !style.getPropertyValue(name)) absent.push(name);
  style.cssText = wanted ?? '';
  for (const name of absent) style.removeProperty(name);
  for (const [name, value, priority] of runtime) style.setProperty(name, value, priority);
  if (!old.style.length) old.removeAttribute('style');
}

/** Whether `node` is a radio button. */
function isRadio(node) {
  return node?.tagName === 'INPUT' && node.type === 'radio';
}

/** Whether two radios form one group: the same name, form and tree. */
function sameGroup(a, b) {
  return Boolean(a.name) && a.name === b.name && a.form === b.form && a.getRootNode() === b.getRootNode();
}

/**
 * Whether `element` is part of the focused control: the control itself, an
 * option of a focused <select>, or a radio in the group of a focused radio.
 * Their choice is the user's while the focus is there.
 */
function inFocusedControl(element, active) {
  if (!active) return false;
  if (element === active) return true;
  if (element.tagName === 'OPTION') return element.closest('select') === active;
  return isRadio(element) && isRadio(active) && sameGroup(element, active);
}

/**
 * Records the live choice of a focused <select> or radio group and returns
 * the function that puts it back after the patch. A changed `selected` or
 * `checked` attribute on an option or radio the user has not touched would
 * move the choice (Chromium and WebKit), so skipping the property is not
 * enough.
 * @param {Element|null} active
 * @returns {(() => void)|null}
 */
function keepChoice(active) {
  if (active?.tagName === 'SELECT') {
    const select = /** @type {HTMLSelectElement} */ (active);
    const before = new Map(Array.from(select.options, (option) => [option, option.selected]));
    return () => {
      const options = Array.from(select.options).filter((option) => before.has(option));
      // Deselect first: on a single select, selecting the saved option deselects the rest.
      if (select.multiple) for (const option of options) if (!before.get(option) && option.selected) option.selected = false;
      for (const option of options) if (before.get(option) && !option.selected) option.selected = true;
    };
  }
  if (isRadio(active) && /** @type {HTMLInputElement} */ (active).name) {
    const group = () => Array.from(active.getRootNode().querySelectorAll('input[type="radio"]')).filter((radio) => sameGroup(radio, active));
    const checked = group().find((radio) => radio.checked) ?? null;
    return () => {
      if (checked?.isConnected) {
        if (!checked.checked) checked.checked = true;
      } else if (!checked) {
        for (const radio of group()) if (radio.checked) radio.checked = false;
      }
    };
  }
  return null;
}

/** An unfocused form control follows a changed attribute with its live property too. */
function syncProperty(element, name, present, ctx) {
  if (inFocusedControl(element, ctx.active)) return;
  const tag = element.tagName;
  if (tag === 'INPUT' && name === 'value') element.value = element.getAttribute('value') ?? '';
  else if (tag === 'INPUT' && name === 'checked') element.checked = present;
  else if (tag === 'OPTION' && name === 'selected') element.selected = present;
}

/** Sets the changed attributes of `next` on `old` and removes the missing ones. */
function syncAttributes(old, next, ctx) {
  for (const attribute of Array.from(old.attributes)) {
    const name = attribute.name;
    if (name === 'class' || name === 'style' || RUNTIME_ATTRIBUTES.has(name) || owned(old, 'attrs', name)) continue;
    if (name === 'inert' && exiting(old)) continue;
    if (attribute.namespaceURI ? next.hasAttributeNS(attribute.namespaceURI, attribute.localName) : next.hasAttribute(name)) continue;
    if (attribute.namespaceURI) old.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    else old.removeAttribute(name);
    syncProperty(old, name, false, ctx);
  }
  for (const attribute of Array.from(next.attributes)) {
    const name = attribute.name;
    if (name === 'class' || name === 'style' || owned(old, 'attrs', name)) continue;
    if (attribute.namespaceURI) {
      if (old.getAttributeNS(attribute.namespaceURI, attribute.localName) === attribute.value) continue;
      old.setAttributeNS(attribute.namespaceURI, name, attribute.value);
    } else {
      if (old.getAttribute(name) === attribute.value) continue;
      old.setAttribute(name, attribute.value);
    }
    syncProperty(old, name, true, ctx);
  }
  syncClass(old, next);
  syncStyle(old, next);
}

/**
 * Patches `old` into `next` (same kind): text in place, or the attributes
 * and then the children of an element.
 */
function patchNode(old, next, ctx) {
  if (!isElement(old)) {
    if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
    return;
  }
  if (!sameShell(old, next)) syncAttributes(old, next, ctx);
  const inner = { ...ctx, replace: ctx.replace || replacing(old) || replacing(next) };
  const before = old.tagName === 'TEXTAREA' ? old.textContent : null;
  patchChildren(old, Array.from(next.childNodes), inner, false);
  // A textarea's value follows its text only until it is edited.
  if (before !== null && old !== ctx.active && old.textContent !== before) old.value = old.textContent;
  ctx.options.onKeep?.(old, next);
}

/**
 * Whether `old` may be patched into `next` in place: the same kind, and
 * neither (nor the call) asks for replacement, unless `old` holds the
 * focus, which is never replaced.
 */
function patchable(old, next, ctx) {
  if (!sameKind(old, next)) return false;
  if (holdsFocus(old, ctx)) return true;
  return !(ctx.replace || replacing(old) || replacing(next));
}

/** The same shell, exactly or up to runtime state, an empty style and class order (equivalentShell). */
const shellOf = (old, next) => sameShell(old, next) || equivalentShell(old, next);

/* ── Children ───────────────────────────────────────── */

/**
 * Looks at most LOOKAHEAD candidate siblings after `cursor` for a node
 * identical to `node` (tags first, isEqualNode last). Blank text, keyed,
 * kept and leaving nodes are no candidates. A hit behind a node that holds
 * the focus does not count (the focused node would go).
 */
function lookAhead(cursor, node, ctx) {
  let candidate = cursor.nextSibling;
  let checked = 0;
  if (holdsFocus(cursor, ctx)) return null;
  while (candidate && checked < LOOKAHEAD) {
    if (!skipped(candidate) && !blank(candidate) && keyOf(candidate) === null) {
      checked += 1;
      if (sameKind(candidate, node) && candidate.isEqualNode(node)) return candidate;
      if (holdsFocus(candidate, ctx)) return null;
    }
    candidate = candidate.nextSibling;
  }
  return null;
}

/**
 * holdOrder: patches the old children that match a desired one (by key,
 * or unkeyed by position and kind) and touches nothing else.
 */
function patchInPlace(parent, desired, ctx) {
  const keyed = new Map();
  const unkeyed = [];
  for (const child of Array.from(parent.childNodes)) {
    if (skipped(child)) continue;
    const key = keyOf(child);
    if (key === null) unkeyed.push(child);
    else if (!keyed.has(key)) keyed.set(key, child);
  }
  let index = 0;
  for (const node of desired) {
    const key = keyOf(node);
    if (key !== null) {
      const old = keyed.get(key);
      if (old && old.tagName === node.tagName) {
        keyed.delete(key);
        patchNode(old, node, ctx);
      }
      continue;
    }
    const limit = Math.min(unkeyed.length, index + LOOKAHEAD + 1);
    for (let at = index; at < limit; at += 1) {
      if (!sameKind(unkeyed[at], node)) continue;
      if (!unkeyed[at].isEqualNode(node)) patchNode(unkeyed[at], node, ctx);
      index = at + 1;
      break;
    }
  }
}

/**
 * Makes the children of `parent` equal to `desired` (detached nodes). For
 * each desired node: a keyed one is looked up by key and moved into
 * place; an unkeyed one is kept when the cursor is identical, recursed
 * into when the cursor has the same shell, found by the look-ahead
 * (dropping what lies between), patched when the cursor has the same tag,
 * else inserted. What is left over goes.
 */
function patchChildren(parent, desired, ctx, top) {
  if (top && ctx.options.holdOrder) {
    patchInPlace(parent, desired, ctx);
    return;
  }
  /** @type {Map<string, Node>} */
  const keyed = new Map();
  for (const child of Array.from(parent.childNodes)) {
    const key = skipped(child) ? null : keyOf(child);
    if (key !== null && !keyed.has(key)) keyed.set(key, child);
  }
  const used = new Set();
  let cursor = live(parent.firstChild);
  const step = () => {
    cursor = live(cursor.nextSibling);
  };

  for (const node of desired) {
    const key = keyOf(node);
    if (key !== null) {
      const old = keyed.get(key);
      if (old && !used.has(old) && sameKind(old, node) && (shellOf(old, node) || patchable(old, node, ctx))) {
        used.add(old);
        if (old === cursor) step();
        else moveNode(parent, old, cursor, ctx);
        patchNode(old, node, ctx);
      } else {
        insertNode(parent, node, cursor, ctx);
      }
      continue;
    }
    if (!cursor) {
      insertNode(parent, node, null, ctx);
      continue;
    }
    const cursorKeyed = keyOf(cursor) !== null;
    // 1. Identical: keep it.
    if (!cursorKeyed && sameKind(cursor, node) && cursor.isEqualNode(node)) {
      step();
      continue;
    }
    // 2. Same shell (or an equivalent one): only the children differ.
    if (!cursorKeyed && shellOf(cursor, node)) {
      const current = cursor;
      step();
      patchNode(current, node, ctx);
      continue;
    }
    // 3. An identical node a few siblings on: what lies between is gone.
    const match = cursorKeyed ? null : lookAhead(cursor, node, ctx);
    if (match) {
      let stale = cursor;
      while (stale && stale !== match) {
        const next = stale.nextSibling;
        // Keyed nodes may still be matched further on; kept and leaving ones stay.
        if (!skipped(stale) && keyOf(stale) === null) removeNode(stale, ctx);
        stale = next;
      }
      cursor = live(match.nextSibling);
      continue;
    }
    // 4. Same tag, both unkeyed: patch in place, or swap it where replacement is asked for.
    if (!cursorKeyed && sameKind(cursor, node)) {
      const current = cursor;
      step();
      if (patchable(current, node, ctx)) patchNode(current, node, ctx);
      else {
        insertNode(parent, node, current, ctx);
        removeNode(current, ctx);
      }
      continue;
    }
    // 5. New.
    insertNode(parent, node, cursor, ctx);
  }

  // Left over: everything from the cursor on, and keyed nodes nobody asked for.
  while (cursor) {
    const stale = cursor;
    cursor = live(stale.nextSibling);
    if (!used.has(stale)) removeNode(stale, ctx);
  }
  for (const old of keyed.values()) {
    if (!used.has(old) && old.parentNode === parent && !leaving(old)) removeNode(old, ctx);
  }
}

/**
 * Makes the children of `target` equal to `nodes` (detached nodes),
 * patching in place (see the header).
 * @param {Node} target
 * @param {Node[]|NodeList} nodes
 * @param {MorphOptions} [options]
 */
export function morphChildren(target, nodes, options = {}) {
  const ctx = {
    replace: options.replace === true,
    options,
    active: activeIn(target),
    moved: [],
  };
  const restore = keepChoice(ctx.active);
  try {
    patchChildren(target, Array.from(nodes), ctx, true);
  } finally {
    restore?.();
    settleMoved(ctx.moved);
  }
}

/**
 * Lifts the data-ds-moving marks after one style flush: the moved nodes
 * get their style without transitions (no @starting-style entrance), and
 * keep it as their before-change style once the mark is gone.
 */
function settleMoved(moved) {
  if (!moved.length) return;
  const view = moved[0].ownerDocument?.defaultView;
  // Reading a computed value resolves the style of the whole document.
  if (typeof view?.getComputedStyle === 'function') void view.getComputedStyle(moved[0]).opacity;
  for (const node of moved) node.removeAttribute('data-ds-moving');
}

/** A comment, or a start tag with its attribute list (quoted values may hold `>`). */
const START_TAG = /<!--[\s\S]*?-->|<([a-zA-Z][^\s/>]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;

/** One attribute of a start tag's list. */
const ATTRIBUTE = /(\s+)([^\s"'>/=]+)((?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)/g;

/** Elements whose content is text: a `style=` inside them is no attribute. */
const RAW_TEXT = /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)$/i;

/** The attribute a style attribute travels as through the parse (STYLE_CARRIER), so the parser never applies it. */
const STYLE_CARRIER = 'data-ds-style';

/**
 * Renames every style attribute of the markup's start tags to
 * STYLE_CARRIER before it is parsed: Chromium reports a style-src-attr
 * violation for a style attribute parsed under a strict
 * Content-Security-Policy, even in a template, and Firefox when such a node
 * goes into the page. carryStyles() writes them back through the CSSOM,
 * which no policy restricts.
 */
function hideStyles(html) {
  if (!/\sstyle\s*=/i.test(html)) return html;
  let out = '';
  let last = 0;
  START_TAG.lastIndex = 0;
  for (let match = START_TAG.exec(html); match; match = START_TAG.exec(html)) {
    if (!match[1]) continue;
    const attributes = match[2].replace(ATTRIBUTE, (whole, space, name, value) => (name.toLowerCase() === 'style' ? `${space}${STYLE_CARRIER}${value}` : whole));
    out += `${html.slice(last, match.index)}<${match[1]}${attributes}${match[3] ? ' /' : ''}>`;
    last = START_TAG.lastIndex;
    if (RAW_TEXT.test(match[1])) {
      const close = html.toLowerCase().indexOf(`</${match[1].toLowerCase()}`, last);
      START_TAG.lastIndex = close < 0 ? html.length : close;
    }
  }
  return out + html.slice(last);
}

/** Gives the parsed nodes their styles back through the CSSOM (see hideStyles()). */
function carryStyles(root) {
  for (const element of Array.from(root?.querySelectorAll?.(`[${STYLE_CARRIER}]`) ?? [])) {
    const text = element.getAttribute(STYLE_CARRIER);
    element.removeAttribute(STYLE_CARRIER);
    if (element.style && typeof element.style.setProperty === 'function') element.style.cssText = text;
    else element.setAttribute('style', text);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/**
 * Sets the content of `target` to `html`, touching only what changed. An
 * <svg> (or MathML) target gets its markup parsed in its own namespace (a
 * chart or a sparkline morphs in place; `<path/>` stays a sibling); the
 * HTML children of a <foreignObject> parse as HTML.
 * @param {Element} target
 * @param {string} html
 * @param {MorphOptions} [options]  replace, holdOrder, onInsert, onRemove, onKeep (pass DS.motion.flip's object straight on)
 */
export function morphHtml(target, html, options = {}) {
  const template = target.ownerDocument.createElement('template');
  // A template parses in an HTML context: <path> would become an HTML
  // element. Foreign content parses inside a root of its own (still inert:
  // a template runs no scripts).
  const foreign = target.namespaceURI === SVG_NS && target.localName !== 'foreignObject' ? 'svg'
    : target.namespaceURI === MATHML_NS ? 'math' : '';
  const markup = hideStyles(String(html));
  template.innerHTML = foreign ? `<${foreign}>${markup}</${foreign}>` : markup;
  const source = foreign ? template.content.firstChild : template.content;
  carryStyles(source);
  morphChildren(target, Array.from(source?.childNodes ?? []), options);
}

/* ── State reporters and DOM helpers (2.0) ──────────── */

/** Takes a name of `kind` as owned runtime state (motion.js keeps the same helpers; the record is shared). */
function own(element, kind, name) {
  if (!element || typeof element !== 'object') return;
  const record = element[OWNED] ?? (element[OWNED] = { attrs: new Map(), classes: new Map(), props: new Map() });
  record[kind].set(name, (record[kind].get(name) ?? 0) + 1);
}

function disown(element, kind, name) {
  const map = element?.[OWNED]?.[kind];
  const count = map?.get(name) ?? 0;
  if (count > 1) map.set(name, count - 1);
  else map?.delete(name);
}

/** The window of a node (an iframe's own), or the global one. */
const windowOf = (node) => node?.ownerDocument?.defaultView ?? globalThis;

/** A handle that does nothing (no element, no DOM). */
const idle = () => ({ update() {}, destroy() {} });

/** Whether `scroller` is the document's own scroller (its scroll events come from the window). */
function documentScroller(scroller) {
  const doc = scroller?.ownerDocument;
  return Boolean(doc) && (scroller === doc.scrollingElement || scroller === doc.documentElement || scroller === doc.body);
}

/* watchScrolled() */

/** The live watch of each scroller. @type {WeakMap<Element, { handle: { update: () => void, destroy: () => void } }>} */
const scrollWatches = new WeakMap();

/** Where data-scrolled goes by default: the app of a view, the panel of a sheet body, the box of a dialog body. */
function scrolledTarget(scroller) {
  const is = (selector) => Boolean(scroller.matches?.(selector));
  if (is('.ds-view')) return scroller.closest('.ds-app') ?? scroller;
  if (is('.ds-sheet__body')) return scroller.closest('.ds-sheet__panel') ?? scroller;
  if (is('.ds-dialog__body')) return scroller.closest('.ds-dialog__box') ?? scroller;
  return scroller;
}

/**
 * Reports whether `scroller` is scrolled away from its top as data-scrolled
 * on `target` (default: the .ds-app of a .ds-view, the .ds-sheet__panel of
 * a .ds-sheet__body, the .ds-dialog__box of a .ds-dialog__body, else the
 * scroller): the fallback of the scroll-driven hairlines and tints, and
 * what the filled top bar fields read. A 1px sentinel first in the
 * scroller (aria-hidden, data-ds-keep, data-ds-sentinel) is watched by an
 * IntersectionObserver, so the attribute changes twice per scroll, never
 * per scroll event; a scroller that is not rendered (a closed sheet)
 * reports nothing. In a positioned scroller (.ds-view, .ds-sheet__body
 * and .ds-dialog__body are) the sentinel is absolute at the padding edge:
 * it takes no grid row, flex line or gap, and the first pixel of scroll
 * sets the attribute; in a static one it stays in flow and its negative
 * margin takes back a flex gap. Back at the top it calls
 * resyncScroll(scroller). data-scrolled is owned state (DS.dom.morphHtml
 * keeps it). Once per scroller: a second call returns the same handle.
 * update() re-reads the scroller's position and gap and puts back a
 * sentinel the page removed; destroy() stops, removes
 * the sentinel and the attribute. On a .ds-dialog__body it also keeps
 * data-ds-text (owned state) while bare text stands among its children,
 * so the body that holds only text and the sentinel is not taken for
 * empty. Without IntersectionObserver (a test
 * fake) a passive scroll listener reads scrollTop.
 * @param {Element|null|undefined} scroller
 * @param {Element} [target]
 * @returns {{ update: () => void, destroy: () => void }}
 */
export function watchScrolled(scroller, target) {
  if (!scroller?.ownerDocument) return idle();
  const existing = scrollWatches.get(scroller);
  if (existing) return existing.handle;
  const doc = scroller.ownerDocument;
  const view = windowOf(scroller);
  const owner = target ?? scrolledTarget(scroller);
  const whole = documentScroller(scroller);
  const sentinel = doc.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.setAttribute('data-ds-keep', '');
  sentinel.setAttribute('data-ds-sentinel', '');
  own(owner, 'attrs', 'data-scrolled');
  const host = () => (whole ? doc.body : scroller);
  const place = () => {
    const style = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(host()) : null;
    if (whole || !style || style.position !== 'static') {
      // Out of flow at the scroller's padding edge: no grid track, no flex
      // line, no gap (a grid row cannot shrink below 0, so a negative
      // margin would leave the gap in), and the first pixel of scroll
      // moves it out (in flow it would sit below the top padding).
      sentinel.style.cssText = 'position: absolute; top: 0; inset-inline: 0; height: 1px; pointer-events: none';
    } else {
      // A static scroller would not contain an absolute sentinel: in flow,
      // its negative margin takes back a flex gap.
      sentinel.style.cssText = `height: 1px; flex-shrink: 0; margin-bottom: ${-1 - (parseFloat(style.rowGap) || 0)}px`;
    }
    if (sentinel.parentNode !== host()) host().insertBefore(sentinel, host().firstChild);
  };
  const report = (scrolled) => {
    if (scrolled === owner.hasAttribute('data-scrolled')) return;
    if (scrolled) owner.setAttribute('data-scrolled', '');
    else owner.removeAttribute('data-scrolled');
    // Back at the top: content that shrank leaves no scroll-driven tint or hairline behind.
    if (!scrolled) resyncScroll(scroller);
  };
  // A dialog body whose content is bare text (no element but the
  // sentinel): CSS cannot see text nodes and would take it for empty, so
  // data-ds-text says it is not. Dialog bodies only (small, so a subtree
  // observer costs little), until destroy().
  const texts = !whole && scroller.matches?.('.ds-dialog__body');
  if (texts) own(scroller, 'attrs', 'data-ds-text');
  const markText = () => {
    if (!texts) return;
    const bare = Array.from(scroller.childNodes).some((node) => node.nodeType === 3 && /\S/.test(node.nodeValue ?? ''));
    if (bare !== scroller.hasAttribute('data-ds-text')) scroller.toggleAttribute('data-ds-text', bare);
  };
  const mutations = texts && typeof view.MutationObserver === 'function'
    ? new view.MutationObserver((records) => {
      if (records.some((record) => record.target === scroller || record.target.parentNode === scroller)) markText();
    })
    : null;
  mutations?.observe(scroller, { childList: true, characterData: true, subtree: true });
  let observer = null;
  let onScroll = null;
  const source = whole ? view : scroller;
  if (typeof view.IntersectionObserver === 'function') {
    observer = new view.IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry?.boundingClientRect.height) return;
      // Scrolled once the sentinel is half out: one pixel of scroll leaves
      // it edge-adjacent, which still counts as intersecting.
      report(!entry.isIntersecting || entry.intersectionRatio < 0.5);
    }, { root: whole ? null : scroller, threshold: [0, 0.5, 1] });
  } else {
    onScroll = () => report((whole ? view.scrollY : scroller.scrollTop) > 0);
    source.addEventListener?.('scroll', onScroll, { passive: true });
  }
  place();
  markText();
  observer?.observe(sentinel);
  const handle = {
    update() {
      if (scrollWatches.get(scroller)?.handle !== handle) return;
      const back = sentinel.parentNode !== host();
      place();
      markText();
      if (back && observer) {
        observer.unobserve(sentinel);
        observer.observe(sentinel);
      }
      onScroll?.();
    },
    destroy() {
      if (scrollWatches.get(scroller)?.handle !== handle) return;
      scrollWatches.delete(scroller);
      observer?.disconnect();
      mutations?.disconnect();
      if (onScroll) source.removeEventListener?.('scroll', onScroll);
      sentinel.remove();
      disown(owner, 'attrs', 'data-scrolled');
      owner.removeAttribute('data-scrolled');
      if (texts) {
        disown(scroller, 'attrs', 'data-ds-text');
        scroller.removeAttribute('data-ds-text');
      }
    },
  };
  scrollWatches.set(scroller, { handle });
  return handle;
}

/* scrollEdges() */

/** The live edge watch of each scroller, by axis. @type {WeakMap<Element, Map<string, { handle: object, update: () => void }>>} */
const edgeWatches = new WeakMap();

/** One ResizeObserver per window for every edge watch: element → the updates it drives. */
const edgeObservers = new WeakMap();

function edgeObserver(view) {
  let entry = edgeObservers.get(view);
  if (!entry && typeof view.ResizeObserver === 'function') {
    const targets = new Map();
    const observer = new view.ResizeObserver((records) => {
      const run = new Set();
      for (const record of records) for (const update of targets.get(record.target) ?? []) run.add(update);
      for (const update of run) update();
    });
    entry = { observer, targets };
    edgeObservers.set(view, entry);
  }
  return entry ?? null;
}

function watchSize(view, element, update) {
  const entry = edgeObserver(view);
  if (!entry || !element) return;
  const list = entry.targets.get(element) ?? new Set();
  if (!list.size) entry.observer.observe(element);
  list.add(update);
  entry.targets.set(element, list);
}

function unwatchSize(view, element, update) {
  const entry = edgeObservers.get(view);
  const list = element ? entry?.targets.get(element) : null;
  if (!list) return;
  list.delete(update);
  if (!list.size) {
    entry.targets.delete(element);
    entry.observer.unobserve(element);
  }
}

/** Sets or removes an attribute only when it changes. */
function flag(element, name, on) {
  if (on === element.hasAttribute(name)) return;
  if (on) element.setAttribute(name, '');
  else element.removeAttribute(name);
}

/**
 * Reports which ends of a scroller have more to scroll, for the CSS that
 * fades or shadows them (sideways tables, .ds-scroll-x, menus, a log
 * above a composer). Owned state on the scroller: data-ds-edges (while it
 * is watched), data-ds-overflow-start and data-ds-overflow-end (more to
 * scroll at that end of `axis`; 'inline' reads Math.abs(scrollLeft), so a
 * right-to-left scroller works), --ds-scrollbar-height ('inline') or
 * --ds-scrollbar-width ('block') in px (the room of the scrollbar), and
 * --ds-table-pin-width (the width of the first cell) when it holds a
 * .ds-table--pin-first. A passive scroll listener updates once per frame,
 * one ResizeObserver per window watches the scroller and its children (a
 * MutationObserver adds the children that come and drops the ones that
 * go), so rows added or opened update the edges; when the overflow goes
 * away it calls resyncScroll(scroller). Once per
 * scroller and axis: a second call returns the same handle.
 * watchScrolled() stays the reporter of the block start (a sentinel, for
 * another target).
 * @param {Element|null|undefined} scroller
 * @param {{ axis?: 'inline'|'block' }} [options]
 * @returns {{ update: () => void, destroy: () => void }}
 */
export function scrollEdges(scroller, options = {}) {
  if (!scroller?.ownerDocument) return idle();
  const axis = options.axis === 'block' ? 'block' : 'inline';
  const watches = edgeWatches.get(scroller) ?? new Map();
  edgeWatches.set(scroller, watches);
  const existing = watches.get(axis);
  if (existing) return existing.handle;
  const view = windowOf(scroller);
  const inline = axis === 'inline';
  const bar = inline ? '--ds-scrollbar-height' : '--ds-scrollbar-width';
  for (const name of ['data-ds-edges', 'data-ds-overflow-start', 'data-ds-overflow-end']) own(scroller, 'attrs', name);
  for (const name of [bar, '--ds-table-pin-width']) own(scroller, 'props', name);
  let frame = 0;
  let overflowed = false;
  // Every element child is watched, not only the first: a list grows by new
  // siblings, and its first child may be an absolute .ds-indicator.
  const watched = new Set();
  const syncChildren = () => {
    const now = new Set(Array.from(scroller.children ?? []));
    for (const node of watched) {
      if (now.has(node)) continue;
      unwatchSize(view, node, schedule);
      watched.delete(node);
    }
    for (const node of now) {
      if (watched.has(node)) continue;
      watchSize(view, node, schedule);
      watched.add(node);
    }
  };
  const children = typeof view.MutationObserver === 'function'
    ? new view.MutationObserver(() => {
      syncChildren();
      schedule();
    })
    : null;
  const measure = () => {
    frame = 0;
    const size = inline ? scroller.scrollWidth - scroller.clientWidth : scroller.scrollHeight - scroller.clientHeight;
    const at = Math.abs(inline ? scroller.scrollLeft : scroller.scrollTop) || 0;
    const overflow = size > 1;
    flag(scroller, 'data-ds-overflow-start', overflow && at > 1);
    flag(scroller, 'data-ds-overflow-end', overflow && size - at > 1);
    const style = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(scroller) : null;
    const borders = inline
      ? (parseFloat(style?.borderTopWidth) || 0) + (parseFloat(style?.borderBottomWidth) || 0)
      : (parseFloat(style?.borderLeftWidth) || 0) + (parseFloat(style?.borderRightWidth) || 0);
    // After that read styled the first edges: the fades transition only
    // under data-ds-edges, so the first measurement shows them at once.
    flag(scroller, 'data-ds-edges', true);
    const room = Math.max(0, (inline ? scroller.offsetHeight - scroller.clientHeight : scroller.offsetWidth - scroller.clientWidth) - borders);
    scroller.style.setProperty(bar, `${Math.round(room)}px`);
    const pinned = scroller.querySelector?.('.ds-table--pin-first') ?? null;
    const first = pinned ? pinned.rows?.[0]?.cells?.[0] ?? pinned.querySelector('th, td') : null;
    if (first) scroller.style.setProperty('--ds-table-pin-width', `${Math.round(first.getBoundingClientRect().width * 100) / 100}px`);
    else scroller.style.removeProperty('--ds-table-pin-width');
    if (overflowed && !overflow) resyncScroll(scroller);
    overflowed = overflow;
    // Without a MutationObserver, the children are synced per measure.
    if (!children) syncChildren();
  };
  const schedule = () => {
    if (frame) return;
    if (typeof view.requestAnimationFrame !== 'function') {
      measure();
      return;
    }
    frame = view.requestAnimationFrame(measure);
  };
  scroller.addEventListener('scroll', schedule, { passive: true });
  watchSize(view, scroller, schedule);
  syncChildren();
  children?.observe(scroller, { childList: true });
  measure();
  const handle = {
    update() {
      if (watches.get(axis)?.handle === handle) measure();
    },
    destroy() {
      if (watches.get(axis)?.handle !== handle) return;
      watches.delete(axis);
      if (frame) view.cancelAnimationFrame?.(frame);
      scroller.removeEventListener('scroll', schedule);
      unwatchSize(view, scroller, schedule);
      children?.disconnect();
      for (const node of watched) unwatchSize(view, node, schedule);
      watched.clear();
      for (const name of ['data-ds-edges', 'data-ds-overflow-start', 'data-ds-overflow-end']) {
        disown(scroller, 'attrs', name);
        if (!watches.size) scroller.removeAttribute(name);
      }
      disown(scroller, 'props', bar);
      disown(scroller, 'props', '--ds-table-pin-width');
      scroller.style.removeProperty(bar);
      if (!watches.size) scroller.style.removeProperty('--ds-table-pin-width');
      if (scroller.getAttribute('style')?.trim() === '') scroller.removeAttribute('style');
    },
  };
  watches.set(axis, { handle, update: measure });
  return handle;
}

/* progress() */

/** Warned once: a share of null without a valueText. */
let warnedText = false;

/**
 * Sets a share and its ARIA in one call, on a .ds-progress (the ARIA on its
 * .ds-progress__track[role="progressbar"]), a .ds-spinner (determinate,
 * the ARIA on itself) or a .ds-meter (--ds-share; ARIA only with
 * role="meter"; never indeterminate). `share` 0 to 1 (clamped, rounded to
 * 0.001): the indeterminate and waiting modifiers go, the share is set
 * through the CSSOM (--ds-progress, a meter's --ds-share), aria-valuenow
 * is the share in percent and aria-valuetext `valueText` (or removed).
 * `share` null: the share is unknown: .ds-progress--indeterminate (or
 * --waiting with `waiting: true`), a spinner turns (no --determinate),
 * aria-valuenow goes and aria-valuetext is `valueText` ("Preparing").
 * Synchronous, so a countUp() started in the same task lands on the same
 * frame. Page state, not owned: render it in the template or set it here,
 * not both.
 * @template {Element} E
 * @param {E} el
 * @param {number|null} share
 * @param {{ valueText?: string, waiting?: boolean }} [options]
 * @returns {E}
 */
export function progress(el, share, options = {}) {
  if (!el) return el;
  const list = el.classList;
  const meter = list.contains('ds-meter');
  const spinner = list.contains('ds-spinner');
  const aria = spinner ? el : meter ? (el.getAttribute('role') === 'meter' ? el : null) : el.querySelector?.('.ds-progress__track[role="progressbar"], [role="progressbar"]') ?? null;
  const text = options.valueText;
  if (share === null || share === undefined || !Number.isFinite(Number(share))) {
    if (meter) return el;
    if (spinner) list.remove('ds-spinner--determinate');
    else {
      list.toggle('ds-progress--indeterminate', !options.waiting);
      list.toggle('ds-progress--waiting', Boolean(options.waiting));
    }
    if (aria) {
      aria.removeAttribute('aria-valuenow');
      if (text) aria.setAttribute('aria-valuetext', String(text));
      else {
        aria.removeAttribute('aria-valuetext');
        if (!warnedText) {
          warnedText = true;
          globalThis.console?.warn?.('DS.dom.progress: an unknown share needs a valueText ("Preparing", "Waiting") for assistive tech');
        }
      }
    }
    return el;
  }
  const value = Math.round(Math.min(1, Math.max(0, Number(share))) * 1000) / 1000;
  if (spinner) list.add('ds-spinner--determinate');
  else if (!meter) list.remove('ds-progress--indeterminate', 'ds-progress--waiting');
  /** @type {HTMLElement} */ (/** @type {unknown} */ (el)).style.setProperty(meter ? '--ds-share' : '--ds-progress', String(value));
  if (aria) {
    aria.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    if (text) aria.setAttribute('aria-valuetext', String(text));
    else aria.removeAttribute('aria-valuetext');
  }
  return el;
}

/* roving() */

/** The live roving focus of each container. @type {WeakMap<Element, { handle: { destroy: () => void } }>} */
const rovers = new WeakMap();

/** The items roving() moves through by default. */
const ROVING_ITEMS = '[role="tab"], [role="radio"], [role="option"]';

/**
 * One tab stop for a set of items (tabs, segmented buttons, a toolbar, a
 * listbox): the arrow keys along `orientation` ('horizontal', 'vertical',
 * or 'both' for a grid, where Up and Down go to the nearest item of the
 * row above or below), Home and End; `wrap` (default true) goes round at
 * the ends. The one tabindex="0" moves with the focus, every other item
 * gets tabindex="-1". aria-disabled items stay reachable (their name is
 * read), disabled ones are skipped. `activate`: 'focus' (default) clicks
 * the item it moves to, so the page's click handler sets the state (or
 * calls `onActivate(item)` instead); 'manual' waits for Enter or Space on
 * an item that is no button; false only moves focus (a toolbar). Left and
 * right swap where the container's computed direction is rtl. Delegated on
 * the container, and a MutationObserver puts the one stop back after a
 * re-render (DS.dom.morphHtml removes a tabindex its template lacks), on
 * new items and on a changed state (the focused item, one marked
 * tabindex="0", the chosen one, the last stop, else the first), so it
 * survives DS.dom.morphHtml; once per container (a second call returns the
 * same handle).
 * @param {Element|null|undefined} container
 * @param {{ items?: string, orientation?: 'horizontal'|'vertical'|'both', wrap?: boolean, activate?: 'focus'|'manual'|false, onActivate?: (item: Element) => void }} [options]
 * @returns {{ destroy: () => void }}
 */
export function roving(container, options = {}) {
  if (!container?.ownerDocument) return { destroy() {} };
  const existing = rovers.get(container);
  if (existing) return existing.handle;
  const selector = options.items ?? ROVING_ITEMS;
  const orientation = options.orientation ?? 'horizontal';
  const wrap = options.wrap !== false;
  const activate = options.activate === undefined ? 'focus' : options.activate;
  const view = windowOf(container);
  const items = () => Array.from(container.querySelectorAll(selector)).filter((item) => !item.matches?.(':disabled') && !item.hidden && !item.closest?.('[hidden], [inert]'));
  const chosen = (item) => ['aria-selected', 'aria-checked', 'aria-pressed'].some((name) => item.getAttribute(name) === 'true') || (item.hasAttribute('aria-current') && item.getAttribute('aria-current') !== 'false');
  let last = null;
  const stop = (current) => {
    last = current;
    for (const item of items()) {
      const value = item === current ? '0' : '-1';
      if (item.getAttribute('tabindex') !== value) item.setAttribute('tabindex', value);
    }
  };
  // The stop after setup or a change: the focused item, one the markup
  // marks, the chosen one, the last stop, else the first.
  const restop = () => {
    const all = items();
    const active = container.ownerDocument.activeElement;
    stop(all.find((item) => item === active || item.contains?.(active))
      ?? all.find((item) => item.getAttribute('tabindex') === '0')
      ?? all.find(chosen)
      ?? (all.includes(last) ? last : null)
      ?? all[0] ?? null);
  };
  restop();
  // A re-render (DS.dom.morphHtml takes away a tabindex its template
  // lacks), new items and a changed state get the one stop back. Its own
  // writes come back once and change nothing.
  const changes = typeof view.MutationObserver === 'function' ? new view.MutationObserver(restop) : null;
  changes?.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['tabindex', 'aria-selected', 'aria-checked', 'aria-pressed', 'aria-current', 'disabled', 'hidden'] });
  const run = (item) => {
    // An aria-disabled item takes the focus (its name is read), never the state.
    if (item.getAttribute('aria-disabled') === 'true') return;
    if (typeof options.onActivate === 'function') options.onActivate(item);
    else item.click?.();
  };
  const nearest = (list, from, down) => {
    const box = from.getBoundingClientRect();
    const rows = list.filter((item) => item !== from).map((item) => ({ item, box: item.getBoundingClientRect() }))
      .filter(({ box: other }) => (down ? other.top >= box.bottom - 1 : other.bottom <= box.top + 1));
    if (!rows.length) return null;
    const row = down ? Math.min(...rows.map(({ box: other }) => other.top)) : Math.max(...rows.map(({ box: other }) => other.top));
    const centre = (rect) => rect.left + rect.width / 2;
    return rows.filter(({ box: other }) => Math.abs(other.top - row) < 1)
      .sort((a, b) => Math.abs(centre(a.box) - centre(box)) - Math.abs(centre(b.box) - centre(box)))[0].item;
  };
  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const list = items();
    const current = list.find((item) => item === event.target || item.contains(event.target));
    if (!current) return;
    if (event.key === 'Enter' || event.key === ' ') {
      if (activate === 'manual' && current.tagName !== 'BUTTON' && current.tagName !== 'A' && current.tagName !== 'INPUT') {
        event.preventDefault();
        run(current);
      }
      return;
    }
    const rtl = typeof view.getComputedStyle === 'function' && view.getComputedStyle(container).direction === 'rtl';
    const index = list.indexOf(current);
    const step = (by) => {
      const at = index + by;
      if (at >= 0 && at < list.length) return list[at];
      return wrap ? list[(at + list.length) % list.length] : null;
    };
    const across = orientation !== 'vertical';
    const along = orientation !== 'horizontal';
    let next;
    if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list[list.length - 1];
    else if (across && event.key === 'ArrowRight') next = step(rtl ? -1 : 1);
    else if (across && event.key === 'ArrowLeft') next = step(rtl ? 1 : -1);
    else if (along && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const down = event.key === 'ArrowDown';
      next = orientation === 'both' ? nearest(list, current, down) ?? (wrap ? (down ? list[0] : list[list.length - 1]) : null) : step(down ? 1 : -1);
    } else return;
    event.preventDefault();
    if (!next || next === current) return;
    stop(next);
    next.focus();
    if (activate === 'focus') run(next);
  };
  const onFocus = (/** @type {FocusEvent} */ event) => {
    const item = items().find((each) => each === event.target);
    if (item) stop(item);
  };
  container.addEventListener('keydown', onKey);
  container.addEventListener('focusin', onFocus);
  const handle = {
    destroy() {
      if (rovers.get(container)?.handle !== handle) return;
      rovers.delete(container);
      changes?.disconnect();
      container.removeEventListener('keydown', onKey);
      container.removeEventListener('focusin', onFocus);
    },
  };
  rovers.set(container, { handle });
  return handle;
}

/* followViewport() */

/**
 * The visual viewport must be this much shorter than its tallest height at
 * the same width (px) before it counts as an on-screen keyboard (a
 * distance, not a time; smaller changes are the browser's own bars).
 */
const KEYBOARD_MIN_PX = 150;

/** The live viewport follower of each document. @type {WeakMap<Document, { handle: { destroy: () => void } }>} */
const viewportFollowers = new WeakMap();

/**
 * The document of a same-origin frame, or null: a cross-origin frame throws
 * or hides it, and its focus stays unknown (not editing).
 */
function frameDocument(frame) {
  try {
    return frame.contentDocument || null;
  } catch {
    return null;
  }
}

/**
 * Whether focus sits in a field that brings up a keyboard, through open
 * shadow roots and same-origin frames (an embedded editor).
 */
function editing(doc) {
  let active = doc.activeElement;
  for (;;) {
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (!/^i?frame$/i.test(active?.tagName || '')) break;
    const inner = frameDocument(active);
    if (!inner) return false;
    active = inner.activeElement;
    doc = inner;
  }
  if (!active || active === doc.body) return false;
  if (active.isContentEditable) return true;
  if (active.tagName === 'TEXTAREA') return !active.readOnly;
  if (active.tagName !== 'INPUT') return false;
  return !active.readOnly && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(active.type);
}

/**
 * The bottom safe-area inset (px), read off a probe as tall as
 * env(safe-area-inset-bottom): script cannot ask for the value of env().
 * The probe is fixed, empty, hidden and data-ds-keep (morphs leave it);
 * created in <body> on the first read, or 0 while there is no body.
 * @returns {number}
 */
function bottomInset(doc, probes) {
  if (!probes.probe) {
    if (!doc.body || typeof doc.createElement !== 'function') return 0;
    const probe = doc.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.setAttribute('data-ds-keep', '');
    probe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom, 0px);margin:0;border:0;padding:0;visibility:hidden;pointer-events:none';
    probes.probe = probe;
    // The inset can go a frame after the viewport shrank: the probe tells.
    if (typeof probes.view.ResizeObserver === 'function') {
      probes.sizes = new probes.view.ResizeObserver(probes.changed);
      probes.sizes.observe(probe);
    }
  }
  // A re-render of the body by other means than a morph may have taken it out.
  if (!probes.probe.parentNode || !probes.probe.isConnected) doc.body?.append(probes.probe);
  return probes.probe.parentNode ? probes.probe.getBoundingClientRect().height || 0 : 0;
}

/**
 * Pans the visual viewport back to the top of the page: an element at the
 * top scrolled into view moves it where window.scrollTo() cannot (the
 * window has not scrolled). Progressive: behavior "instant" (an engine
 * that rejects it scrolls with the boolean form instead).
 */
function panToTop(root) {
  if (typeof root.scrollIntoView !== 'function') return;
  try {
    root.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
  } catch {
    root.scrollIntoView(true);
  }
}

/**
 * Lets the app frame follow the on-screen keyboard: writes
 * --ds-viewport-height (the visual viewport's height, px) on <html>, sets
 * data-ds-keyboard on <html> while the visual viewport is shorter than its
 * tallest height at this width by more than 150px and focus is in a field
 * that types (also inside a same-origin iframe), writes --ds-keyboard-inset (px of the layout viewport the
 * keyboard covers, for the snackbars, dialogs and side sheets) and puts the page back at its top when the
 * browser scrolled the window up or panned the visual viewport down for the keyboard (an unzoomed page).
 * A bottom safe-area inset that the keyboard took away (Chrome on Android, viewport-fit=cover: the visual
 * viewport still counts the gesture bar's strip, which the keyboard covers) comes off the height and onto the
 * inset. shell.css, toast.css, dialog.css and sheet.css read them. Once per document (a second call
 * returns the same handle); destroy() takes everything back.
 * Progressive: visualViewport (feature-detected): without it nothing
 * changes.
 * @param {Document} [doc]
 * @returns {{ destroy: () => void }}
 */
export function followViewport(doc = globalThis.document) {
  const view = doc?.defaultView;
  const viewport = view?.visualViewport;
  if (!viewport || !doc.documentElement) return { destroy() {} };
  const existing = viewportFollowers.get(doc);
  if (existing) return existing.handle;
  const root = doc.documentElement;
  const tallest = new Map();
  own(root, 'attrs', 'data-ds-keyboard');
  for (const name of ['--ds-viewport-height', '--ds-keyboard-inset']) own(root, 'props', name);
  let frame = 0;
  // The bottom inset while no keyboard is up or on its way: one that is coming takes the inset before the
  // visual viewport shrinks, so only a full-height viewport with no field focused says what it is.
  let openInset = 0;
  const probes = { view, probe: null, sizes: null, changed: () => schedule() };
  const update = () => {
    frame = 0;
    const scale = viewport.scale || 1;
    const width = Math.round(viewport.width * scale);
    const height = viewport.height;
    const top = Math.max(height, tallest.get(width) ?? 0);
    tallest.set(width, top);
    const layout = view.innerHeight || height;
    const short = top - height > KEYBOARD_MIN_PX;
    // Chrome on Android drawn edge to edge (viewport-fit=cover) reads the bottom inset as 0 while the keyboard
    // is up, yet its visual viewport still ends where the inset began: the strip is under the keyboard. An
    // engine that keeps the inset under the keyboard (iOS) never reads 0 there, so nothing changes for it.
    const typing = editing(doc);
    const inset = bottomInset(doc, probes);
    if (scale === 1 && layout - height < 2 && !typing) openInset = inset;
    const lost = short && scale === 1 && inset < 0.5 ? openInset : 0;
    root.style.setProperty('--ds-viewport-height', `${Math.round(height - lost)}px`);
    const keyboard = short && typing;
    const covered = Math.max(0, Math.round(layout - height - viewport.offsetTop + lost));
    root.style.setProperty('--ds-keyboard-inset', `${keyboard ? covered : 0}px`);
    if (keyboard !== root.hasAttribute('data-ds-keyboard')) {
      if (keyboard) root.setAttribute('data-ds-keyboard', '');
      else root.removeAttribute('data-ds-keyboard');
    }
    // The frame follows the visual viewport at the top of the page, so a page the browser moved for the
    // keyboard goes back: iOS scrolls the window up to show the field; Chrome on Android keeps the window
    // and pans the visual viewport down into the empty page under the frame (a field scrolled into view, a
    // swipe), where scrolling the window moves nothing. A pinch zoom is the person's.
    if (keyboard && scale === 1) {
      if ((view.scrollY || 0) > 0 && viewport.offsetTop > 0) view.scrollTo(view.scrollX || 0, 0);
      else if (viewport.offsetTop >= 1) panToTop(root);
    }
  };
  const schedule = () => {
    if (frame) return;
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(update) : (update(), 0);
  };
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  doc.addEventListener('focusin', schedule);
  doc.addEventListener('focusout', schedule);
  update();
  const handle = {
    destroy() {
      if (viewportFollowers.get(doc)?.handle !== handle) return;
      viewportFollowers.delete(doc);
      if (frame) view.cancelAnimationFrame?.(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      doc.removeEventListener('focusin', schedule);
      doc.removeEventListener('focusout', schedule);
      probes.sizes?.disconnect();
      probes.probe?.remove();
      disown(root, 'attrs', 'data-ds-keyboard');
      for (const name of ['--ds-viewport-height', '--ds-keyboard-inset']) {
        disown(root, 'props', name);
        root.style.removeProperty(name);
      }
      root.removeAttribute('data-ds-keyboard');
      if (root.getAttribute('style')?.trim() === '') root.removeAttribute('style');
    },
  };
  viewportFollowers.set(doc, { handle });
  return handle;
}

/* followEnd() */

/** The live end follower of each scroller. @type {WeakMap<Element, { handle: { stick: () => void, destroy: () => void } }>} */
const endFollowers = new WeakMap();

/**
 * A log that sticks to its end (a chat, an import log): while the scroller
 * is at its end (within `threshold` px) and its content grows, it stays at
 * the end; scrolling up lets go, and `pill` (a .ds-presence element, its
 * place is .ds-jump) shows while it is let go (`hidden` toggled). A click
 * on the pill, or stick(), goes back to the end: smoothly within one
 * viewport height, else at once. A ResizeObserver watches the content (the
 * scroller's element children: added lines are observed, removed ones let
 * go), so nothing polls. The pill's `hidden` is owned state (a re-render
 * keeps it). Once per scroller.
 * @param {Element|null|undefined} scroller
 * @param {{ pill?: HTMLElement|null, threshold?: number }} [options]
 * @returns {{ stick: () => void, destroy: () => void }}
 */
export function followEnd(scroller, options = {}) {
  if (!scroller?.ownerDocument) return { stick() {}, destroy() {} };
  const existing = endFollowers.get(scroller);
  if (existing) return existing.handle;
  const view = windowOf(scroller);
  const pill = options.pill ?? null;
  const threshold = Math.max(0, Number(options.threshold ?? 1));
  const gap = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  let stuck = gap() <= threshold;
  let last = scroller.scrollTop;
  const show = () => {
    if (pill && pill.hidden !== stuck) pill.hidden = stuck;
  };
  const toEnd = (smooth) => {
    const end = scroller.scrollHeight - scroller.clientHeight;
    if (smooth && typeof scroller.scrollTo === 'function') {
      // The glide's own scroll events go down from here: only a move up
      // against it (the user) lets go again.
      last = scroller.scrollTop;
      scroller.scrollTo({ top: end, behavior: 'smooth' });
    } else {
      scroller.scrollTop = end;
      last = end;
    }
  };
  const onScroll = () => {
    const top = scroller.scrollTop;
    if (gap() <= threshold) stuck = true;
    else if (top < last - 0.5) stuck = false;
    last = top;
    show();
  };
  const grew = () => {
    if (stuck && gap() > threshold) toEnd(false);
    show();
  };
  const sizes = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(grew) : null;
  // Only what changed: a long log costs nothing per line, and a line that
  // is pruned or replaced is let go (an observation holds its element).
  const children = typeof view.MutationObserver === 'function' ? new view.MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.removedNodes ?? [])) if (node.nodeType === 1 && node.parentNode !== scroller) sizes?.unobserve(node);
      for (const node of Array.from(record.addedNodes ?? [])) if (node.nodeType === 1 && node.parentNode === scroller) sizes?.observe(node);
    }
    grew();
  }) : null;
  for (const child of Array.from(scroller.children ?? [])) sizes?.observe(child);
  sizes?.observe(scroller);
  children?.observe(scroller, { childList: true });
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const stick = () => {
    stuck = true;
    toEnd(gap() <= scroller.clientHeight);
    show();
  };
  const onPill = () => stick();
  pill?.addEventListener('click', onPill);
  // The pill's hidden is owned state: a re-render of the log keeps it.
  if (pill) own(pill, 'attrs', 'hidden');
  show();
  const handle = {
    stick,
    destroy() {
      if (endFollowers.get(scroller)?.handle !== handle) return;
      endFollowers.delete(scroller);
      sizes?.disconnect();
      children?.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      pill?.removeEventListener('click', onPill);
      if (pill) disown(pill, 'attrs', 'hidden');
    },
  };
  endFollowers.set(scroller, { handle });
  return handle;
}

/* autosize() */

/** The live autosize of each textarea. @type {WeakMap<Element, { handle: { update: () => void, destroy: () => void } }>} */
const autosized = new WeakMap();

/**
 * Grows a textarea with its text up to its computed max-height (then it
 * scrolls), through the CSSOM; never animated. Where the textarea sizes
 * itself (field-sizing: content, which .ds-input--grow sets where it
 * exists) it does nothing (and drops a height it wrote before). It measures
 * once the textarea is rendered (and again when its width changes), so it
 * is safe to call before the field is in the page or while it is hidden:
 * a ResizeObserver measures when it gets a width. The height and overflow-y
 * it writes are owned state, so a re-render keeps a grown textarea's size.
 * Once per textarea; update() measures again (a value set by script),
 * destroy() removes the listener, the observer and the height.
 * @param {HTMLTextAreaElement|null|undefined} textarea
 * @returns {{ update: () => void, destroy: () => void }}
 */
export function autosize(textarea) {
  if (!textarea?.ownerDocument) return idle();
  const existing = autosized.get(textarea);
  if (existing) return existing.handle;
  const view = windowOf(textarea);
  const style = () => (typeof view.getComputedStyle === 'function' ? view.getComputedStyle(textarea) : null);
  const native = () => style()?.getPropertyValue?.('field-sizing') === 'content';
  let owned = false;
  /** Drops the height and overflow-y this handle wrote (and disowns them). */
  const release = () => {
    if (owned) {
      owned = false;
      disown(textarea, 'props', 'height');
      disown(textarea, 'props', 'overflow-y');
    }
    textarea.style.removeProperty('height');
    textarea.style.removeProperty('overflow-y');
    if (textarea.getAttribute('style')?.trim() === '') textarea.removeAttribute('style');
  };
  const update = () => {
    // A detached or hidden field has no computed style and a scrollHeight of
    // 0: a height measured now would stick (the ResizeObserver measures
    // again once it is rendered).
    if (textarea.isConnected === false || typeof textarea.getClientRects === 'function' && !textarea.getClientRects().length) return;
    if (native()) {
      if (owned) release();
      return;
    }
    if (!owned) {
      // Owned state: a re-render around a focused, grown textarea keeps its height.
      owned = true;
      own(textarea, 'props', 'height');
      own(textarea, 'props', 'overflow-y');
    }
    const computed = style();
    const borders = computed?.boxSizing === 'border-box' ? (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.borderBottomWidth) || 0) : 0;
    const max = parseFloat(computed?.maxHeight);
    textarea.style.height = 'auto';
    const wanted = textarea.scrollHeight + borders;
    const capped = Number.isFinite(max) && max > 0 ? Math.min(wanted, max) : wanted;
    textarea.style.height = `${Math.ceil(capped)}px`;
    textarea.style.overflowY = Number.isFinite(max) && wanted > max ? 'auto' : 'hidden';
  };
  // Measures again when the inline size changes: 0 to a width when the field
  // is inserted or shown, a narrower window that wraps more lines. The block
  // size update() writes does not change it, so it never loops; it writes in
  // the next frame, outside the observer's delivery (a size written there
  // would be an undelivered notification, an error event in every engine).
  let width = -1;
  let frame = 0;
  const sizes = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver((entries) => {
    const inline = entries[entries.length - 1]?.contentRect?.width ?? 0;
    if (inline === width) return;
    width = inline;
    if (inline > 0 && !frame) frame = view.requestAnimationFrame(() => { frame = 0; update(); });
  }) : null;
  sizes?.observe(textarea);
  textarea.addEventListener('input', update);
  update();
  const handle = {
    update,
    destroy() {
      if (autosized.get(textarea)?.handle !== handle) return;
      autosized.delete(textarea);
      sizes?.disconnect();
      if (frame) view.cancelAnimationFrame(frame);
      textarea.removeEventListener('input', update);
      release();
    },
  };
  autosized.set(textarea, { handle });
  return handle;
}

/* dropzone() */

/** The live drop zone of each element. @type {WeakMap<Element, { handle: { destroy: () => void } }>} */
const dropzones = new WeakMap();

/** Whether a drag carries files. */
const carriesFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * Whether `file` matches an `accept` list as the file input reads it:
 * extensions (.csv), MIME types (text/csv) and families (image/*), comma
 * separated, case-insensitive; an empty list takes everything.
 */
function accepts(file, accept) {
  const rules = String(accept ?? '').split(',').map((rule) => rule.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;
  const name = String(file?.name ?? '').toLowerCase();
  const type = String(file?.type ?? '').toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

/**
 * Files by drop, by the file dialog and (with `paste`) from the clipboard,
 * for a .ds-dropzone or any page drop target (a pane, a chat). It counts
 * dragenter and dragleave on `target` (default `zone`), so
 * data-ds-dragover (owned state on `zone`; the CSS shows the drop state)
 * stays on while a file is over a child too, takes dragover (and so the
 * drop) only when the drag carries files, filters them by `accept`
 * (default the input's accept: extensions, MIME types, image/*), keeps
 * one unless `multiple` (default the input's multiple) and calls
 * onFiles(files, event) with what is left. The zone's file input
 * (`input`; absent: .ds-dropzone__input, or the zone's first
 * input[type="file"]) goes the same way and is reset afterwards, so the
 * same file can be chosen again; `input: null` takes no input (drops and
 * paste only), for a pane whose own file input (a composer's attach
 * button) the page already handles. With `paste: true` files pasted while
 * focus is inside `target` count too. A disabled input takes nothing. Once
 * per zone.
 * @param {Element|null|undefined} zone
 * @param {{ onFiles: (files: File[], event: Event) => void, accept?: string, multiple?: boolean, paste?: boolean, target?: Element, input?: HTMLInputElement|null }} options
 * @returns {{ destroy: () => void }}
 */
export function dropzone(zone, options) {
  if (!zone?.ownerDocument) return { destroy() {} };
  const existing = dropzones.get(zone);
  if (existing) return existing.handle;
  const doc = zone.ownerDocument;
  const target = options?.target ?? zone;
  const input = options?.input !== undefined
    ? options.input
    : zone.querySelector?.('.ds-dropzone__input') ?? zone.querySelector?.('input[type="file"]') ?? null;
  const accept = () => options?.accept ?? input?.accept ?? '';
  const multiple = () => options?.multiple ?? Boolean(input?.multiple);
  const blocked = () => Boolean(input?.disabled);
  let depth = 0;
  own(zone, 'attrs', 'data-ds-dragover');
  const over = (on) => {
    if (on === zone.hasAttribute('data-ds-dragover')) return;
    if (on) zone.setAttribute('data-ds-dragover', '');
    else zone.removeAttribute('data-ds-dragover');
  };
  const hand = (list, event) => {
    const files = Array.from(list ?? []).filter((file) => accepts(file, accept()));
    const taken = multiple() ? files : files.slice(0, 1);
    if (taken.length) options?.onFiles?.(taken, event);
    return taken.length > 0;
  };
  const onEnter = (event) => {
    if (!carriesFiles(event) || blocked()) return;
    event.preventDefault();
    depth += 1;
    over(true);
  };
  const onOver = (event) => {
    if (!carriesFiles(event) || blocked()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onLeave = (event) => {
    if (!carriesFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) over(false);
  };
  const onDrop = (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    over(false);
    if (!blocked()) hand(event.dataTransfer?.files, event);
  };
  const onChange = (event) => {
    hand(input.files, event);
    input.value = '';
  };
  const onPaste = (event) => {
    if (blocked() || !target.contains?.(doc.activeElement) && doc.activeElement !== target) return;
    const files = event.clipboardData?.files;
    if (!files?.length) return;
    if (hand(files, event)) event.preventDefault();
  };
  target.addEventListener('dragenter', onEnter);
  target.addEventListener('dragover', onOver);
  target.addEventListener('dragleave', onLeave);
  target.addEventListener('drop', onDrop);
  input?.addEventListener('change', onChange);
  if (options?.paste) doc.addEventListener('paste', onPaste);
  const handle = {
    destroy() {
      if (dropzones.get(zone)?.handle !== handle) return;
      dropzones.delete(zone);
      target.removeEventListener('dragenter', onEnter);
      target.removeEventListener('dragover', onOver);
      target.removeEventListener('dragleave', onLeave);
      target.removeEventListener('drop', onDrop);
      input?.removeEventListener('change', onChange);
      doc.removeEventListener('paste', onPaste);
      disown(zone, 'attrs', 'data-ds-dragover');
      zone.removeAttribute('data-ds-dragover');
    },
  };
  dropzones.set(zone, { handle });
  return handle;
}
