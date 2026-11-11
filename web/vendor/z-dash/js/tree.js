/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Tree view (3.0): the APG tree pattern on `.ds-tree` markup. One tab stop
 * (the active item, tabindex="0"); the arrow keys walk the rows that show,
 * Right opens a folder or enters it, Left closes it or goes to its parent,
 * Home and End jump, `*` opens every sibling folder, letters jump by label
 * (DS.a11y.typeahead). Tab goes on to the buttons of the active row
 * (.ds-tree__actions, the grip), then leaves the tree: the buttons of the
 * other rows wait with tabindex="-1".
 *
 *   <ul class="ds-tree" role="tree" aria-label="Files" data-ds-tree> ... </ul>
 *   const files = DS.tree.create(el, { select: 'checkbox', load: (item, { key, signal }) => fetchChildren(key, signal) });
 *   files.get();                      // the checked keys (checkbox), the selected key (single)
 *   files.expand('reports');          // opens a folder, loading it first when it is lazy
 *
 * Selection (`select`, data-ds-tree-select): 'single' (default) chooses one
 * row (aria-selected) on a click, Enter or Space; 'checkbox' makes the tree
 * aria-multiselectable with tri-state checks (aria-checked true, false or
 * mixed): a check reaches every loaded descendant that is not disabled, and
 * each folder above shows what its children hold; an inert
 * .ds-checkbox.ds-tree__check in the row mirrors it. 'none' only opens and
 * activates rows (a navigation tree whose labels are links).
 *
 * Lazy children: an item with data-ds-tree-lazy loads them the first time
 * it opens, through `load(item, { key, signal })`, which returns (or
 * resolves to) markup, nodes, or data `{ id, label, icon, meta, href,
 * children: true | [...], expanded, disabled, checked, selected }`
 * (children: true is a lazy folder; an href other than relative, #, http(s)
 * or mailto is dropped, the label stays text). A loader that returns at once (no
 * promise) renders in place, quietly. While a promise runs the item is
 * aria-busy (a spinner replaces the chevron after --ds-delay-loader); a
 * failure leaves it closed with data-state="error" and a word
 * (.ds-tree__error), says so, and the next opening tries again. Without a
 * loader ds:load tells the page, which fills the group itself.
 *
 * Drag (`drag`, data-ds-tree-drag): DS.dnd moves an item and its subtree
 * by its grip (.ds-tree__grip, written into each row), by pointer and by
 * keys: before or after a row, or into a folder (a pointer that rests on a
 * closed folder opens it after --ds-delay-tooltip; Right opens the folder
 * at a keyboard drop place). `accept(item, folder)` may refuse a place
 * (folder: null for the top level). The page saves on ds:drop, whose `to`
 * holds { parent, index } (parent: the folder item, or null).
 *
 * Events (bubbling, on the tree; also through on(type, fn)):
 *   ds:toggle   { item, key, expanded }
 *   ds:select   { item, key }                     single
 *   ds:change   { item, key, checked, keys }      checkbox: the checked keys
 *   ds:activate { item, key }                     Enter, a click on a row
 *   ds:load     { item, key }                     a lazy item without a loader
 *   ds:error    { item, key, error }              a loader failed
 *   ds:drag-start, ds:drag-move, ds:drop, ds:drag-cancel (DS.dnd)
 *
 * Owned state (a morph leaves it alone): tabindex on items and row buttons,
 * aria-labelledby and the label's id where an item has no name of its own,
 * aria-multiselectable, aria-busy, data-state, data-ds-tree-drop. The page
 * that re-renders writes aria-expanded, aria-selected and aria-checked from
 * the events (controlled), or leaves them to the tree.
 *
 * ES2022; no DOM is touched until an element is initialised.
 *
 * Progressive:
 * - moveBefore (a moved item keeps its running animations and the focus):
 *   without it insertBefore, and the focus is put back on the item.
 */
import { define, emit, t } from './core.js';
import { enter, motionDuration } from './motion.js';
import { morphHtml, own, disown } from './dom.js';
import { announce, typeahead } from './a11y.js';
import { create as draggable } from './dnd.js';
import { chevronRight, folder as folderGlyph, folderOpen, grip as gripGlyph, alertCircle, fill, iconElement } from './icons.js';

const ITEM = '[role="treeitem"]';
const GROUP = '[role="group"]';
const MODES = ['single', 'checkbox', 'none'];
/** The controls of a row that Tab reaches while its item is the active one. */
const ROW_CONTROLS = 'a[href]:not(.ds-tree__label), button, input:not(.ds-tree__check), select, textarea, [tabindex]';

/**
 * The state a folder shows for the states of its children: 'true' when
 * every one is checked, 'false' when none is, else 'mixed'; null without
 * children (the folder keeps its own).
 * @param {Array<string|null|undefined>} states  'true', 'false' or 'mixed' each
 * @returns {'true'|'false'|'mixed'|null}
 */
export function checkState(states) {
  const list = [...states];
  if (!list.length) return null;
  if (list.every((state) => state === 'true')) return 'true';
  if (list.every((state) => state !== 'true' && state !== 'mixed')) return 'false';
  return 'mixed';
}

/** The live controller of each tree. @type {WeakMap<Element, any>} */
const instances = new WeakMap();

let labels = 0;

/**
 * `href` when it is safe to put in a link: relative, a fragment, http(s) or
 * mailto. Anything else (javascript:, data:, a scheme hidden by tabs or
 * spaces, which the URL parser drops) is null: the label shows as text.
 */
const safeUrl = (href) => {
  const text = String(href ?? '').trim();
  if (!text || typeof URL !== 'function') return null;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(text, 'https://base.invalid/').protocol) ? text : null;
  } catch {
    return null;
  }
};

const modeOf = (value) => (MODES.includes(value) ? value : 'single');
const flag = (value) => value !== null && value !== undefined && value !== 'false';

function controller(tree, initial) {
  const doc = tree.ownerDocument;
  const view = doc.defaultView;
  const abort = new AbortController();
  const signal = abort.signal;
  let options = { ...initial, select: modeOf(initial.select) };
  let active = null;
  let dnd = null;
  let moved = null;
  let shown = null;
  let springTimer = 0;
  let springFolder = null;
  const pending = new Map();
  /**
   * Names this controller owns, per element: given back on destroy. Weak, so
   * rows a re-render, a reload or a morph took out go with their claims.
   * @type {WeakMap<Element, Set<string>>}
   */
  const claims = new WeakMap();

  const claim = (element, name) => {
    let names = claims.get(element);
    if (!names) claims.set(element, (names = new Set()));
    if (names.has(name)) return;
    names.add(name);
    own(element, 'attrs', name);
  };
  const write = (element, name, value) => {
    claim(element, name);
    if (value === null) element.removeAttribute(name);
    else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };

  /* ── Structure ─────────────────────────────────────── */

  const isItem = (node) => Boolean(node?.matches?.(ITEM)) && tree.contains(node);
  const items = () => Array.from(tree.querySelectorAll(ITEM));
  const parentOf = (item) => {
    const parent = item.parentElement?.closest(ITEM);
    return parent && tree.contains(parent) ? parent : null;
  };
  const groupOf = (item) => item.querySelector(`:scope > ${GROUP}`);
  const rowOf = (item) => item.querySelector(':scope > .ds-tree__row') ?? item;
  const childrenOf = (item) => {
    const group = groupOf(item);
    return group ? Array.from(group.querySelectorAll(ITEM)).filter((child) => parentOf(child) === item) : [];
  };
  const topItems = () => items().filter((item) => !parentOf(item));
  const isFolder = (item) => item.hasAttribute('aria-expanded');
  const isOpen = (item) => item.getAttribute('aria-expanded') === 'true';
  const isDisabled = (item) => item.getAttribute('aria-disabled') === 'true';
  const keyOf = (item) => item?.getAttribute('data-ds-key') ?? null;
  const labelElement = (item) => rowOf(item).querySelector('.ds-tree__label');
  const labelOf = (item) => {
    const own = item.getAttribute('aria-label');
    if (own) return own.trim();
    return (labelElement(item)?.textContent ?? rowOf(item).textContent ?? '').replace(/\s+/g, ' ').trim();
  };
  const treeName = () => {
    const named = tree.getAttribute('aria-labelledby');
    return (tree.getAttribute('aria-label') ?? (named ? doc.getElementById(named)?.textContent : '') ?? '').replace(/\s+/g, ' ').trim();
  };
  /** Whether every folder above `item` is open: the row shows. */
  const showing = (item) => {
    if (item.hidden) return false;
    for (let parent = parentOf(item); parent; parent = parentOf(parent)) if (!isOpen(parent) || parent.hidden) return false;
    return true;
  };
  /**
   * The rows that show, in order, kept until the next structural change
   * (sync() drops them): a focus move reads them without walking every item.
   * A change the observer has not delivered yet is taken here first.
   */
  const visible = () => {
    if (watcher?.takeRecords?.().length) sync();
    return (shown ??= items().filter(showing));
  };
  const find = (target) => {
    if (!target) return null;
    if (typeof target === 'string') return items().find((item) => keyOf(item) === target) ?? null;
    return isItem(target) ? target : null;
  };

  /* ── The tab stop and the names ────────────────────── */

  const sync = () => {
    shown = null;
    if (!tree.isConnected && !signal.aborted) return;
    const all = items();
    const mode = options.select;
    write(tree, 'aria-multiselectable', mode === 'checkbox' ? 'true' : null);
    if (!all.includes(active) || !showing(active)) {
      const list = all.filter(showing);
      active = list.find((item) => item.getAttribute('aria-selected') === 'true') ?? list.find((item) => item.getAttribute('tabindex') === '0') ?? list[0] ?? null;
    }
    for (const item of all) {
      stop(item, item === active);
      // A name of its own: the label, not the text of every row below it.
      if (!item.hasAttribute('aria-label') && (!item.hasAttribute('aria-labelledby') || claims.get(item)?.has('aria-labelledby'))) {
        const label = labelElement(item);
        if (label) {
          if (!label.id) {
            labels += 1;
            write(label, 'id', `ds-tree-label-${labels}`);
          }
          write(item, 'aria-labelledby', label.id);
        }
      }
      const row = rowOf(item);
      const link = row.querySelector('a.ds-tree__label');
      if (link) write(link, 'tabindex', '-1');
      if (mode === 'checkbox' && !item.hasAttribute('aria-checked')) {
        const parent = parentOf(item);
        const inherited = parent?.getAttribute('aria-checked');
        item.setAttribute('aria-checked', inherited === 'true' ? 'true' : 'false');
      }
      const check = row.querySelector('.ds-tree__check');
      if (check) {
        write(check, 'tabindex', '-1');
        write(check, 'aria-hidden', 'true');
        if (!check.inert) check.inert = true;
        const state = item.getAttribute('aria-checked');
        check.checked = state === 'true';
        check.indeterminate = state === 'mixed';
      }
      if (options.drag && !row.querySelector('.ds-tree__grip')) addGrip(item, row);
      if (!options.drag) row.querySelector('.ds-tree__grip[data-ds-tree-own]')?.remove();
    }
    if (mode === 'checkbox') for (const folder of all.filter(isFolder).reverse()) settle(folder);
  };

  /**
   * A folder's check from its children's. A disabled child that is not
   * checked does not count: checking the folder could never reach it.
   */
  const settle = (folder) => {
    const state = checkState(childrenOf(folder).filter((child) => !isDisabled(child) || child.getAttribute('aria-checked') !== 'false').map((child) => child.getAttribute('aria-checked')));
    if (state && folder.getAttribute('aria-checked') !== state) folder.setAttribute('aria-checked', state);
  };

  /** The tab stop on an item and the buttons of its row (on), or off both. */
  const stop = (item, on) => {
    const value = on ? '0' : '-1';
    write(item, 'tabindex', value);
    for (const control of rowOf(item).querySelectorAll(ROW_CONTROLS)) {
      if (control.closest(ITEM) !== item || control.matches('.ds-tree__label, .ds-tree__check')) continue;
      write(control, 'tabindex', value);
    }
  };

  let queued = false;
  const resync = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!signal.aborted) sync();
    });
  };

  const addGrip = (item, row) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ds-btn ds-btn--quiet ds-btn--icon ds-xs ds-tree__grip';
    button.setAttribute('data-ds-tree-own', '');
    button.setAttribute('aria-label', t('treeMove', { label: labelOf(item) }));
    button.append(iconElement(gripGlyph, 16, undefined, doc));
    row.append(button);
  };

  /* ── Focus ─────────────────────────────────────────── */

  /** Moves the tab stop: only the old and the new row change (the full pass is for structural changes). */
  const setActive = (item) => {
    if (!item || item === active) return;
    if (!showing(item)) {
      active = item;
      sync();
      return;
    }
    const before = active;
    active = item;
    if (before && tree.contains(before)) stop(before, false);
    stop(item, true);
  };
  const focusItem = (item) => {
    if (!item) return;
    setActive(item);
    item.focus({ preventScroll: true });
    rowOf(item).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  /* ── Open, close, load ─────────────────────────────── */

  const fire = (type, detail, cancelable = false) => emit(tree, type, detail, { cancelable });

  const render = (item, content) => {
    let group = groupOf(item);
    if (!group) {
      group = doc.createElement('ul');
      group.className = 'ds-tree__group';
      group.setAttribute('role', 'group');
      item.append(group);
    }
    if (typeof content === 'string') morphHtml(group, content);
    else if (content && typeof content === 'object' && typeof content.nodeType === 'number') group.replaceChildren(content);
    else if (content && typeof content[Symbol.iterator] === 'function') {
      const list = Array.from(content);
      group.replaceChildren(...list.map((entry) => (entry && typeof entry.nodeType === 'number' ? entry : build(entry))));
    }
    fill(group);
    sync();
    return childrenOf(item).length;
  };

  const markError = (item, failed) => {
    const row = rowOf(item);
    row.querySelector(':scope > .ds-tree__error')?.remove();
    write(item, 'data-state', failed ? 'error' : null);
    if (!failed) return;
    const word = doc.createElement('span');
    word.className = 'ds-tree__error';
    word.append(iconElement(alertCircle, 16, undefined, doc), t('treeError'));
    const before = row.querySelector(':scope > :is(.ds-tree__actions, .ds-tree__grip)');
    row.insertBefore(word, before);
  };

  const load = (item) => {
    if (pending.has(item)) return pending.get(item).promise;
    const key = keyOf(item);
    if (typeof options.load !== 'function') {
      item.removeAttribute('data-ds-tree-lazy');
      fire('load', { item, key });
      return Promise.resolve(true);
    }
    const control = new AbortController();
    // A loader that answers at once (no promise) renders in place: nothing
    // arrived later, so there is no busy state and nothing to announce.
    let answer;
    try {
      answer = options.load(item, { key, signal: control.signal });
    } catch (error) {
      answer = Promise.reject(error);
    }
    if (!answer || typeof answer.then !== 'function') {
      item.removeAttribute('data-ds-tree-lazy');
      markError(item, false);
      render(item, answer);
      return Promise.resolve(true);
    }
    write(item, 'aria-busy', 'true');
    markError(item, false);
    const toggle = rowOf(item).querySelector('.ds-tree__toggle');
    if (toggle && !toggle.querySelector('.ds-tree__spinner')) {
      const spinner = doc.createElement('span');
      spinner.className = 'ds-spinner ds-tree__spinner';
      spinner.setAttribute('aria-hidden', 'true');
      toggle.append(spinner);
      enter(spinner, 'delayed');
    }
    const label = labelOf(item);
    const entry = { control, promise: null };
    entry.promise = Promise.resolve(answer)
      .then((content) => {
        if (control.signal.aborted || signal.aborted) return false;
        item.removeAttribute('data-ds-tree-lazy');
        const count = render(item, content);
        announce(t('treeLoaded', { label, count }));
        return true;
      }, (error) => {
        if (control.signal.aborted || signal.aborted) return false;
        markError(item, true);
        announce(t('treeLoadFailed', { label }));
        fire('error', { item, key, error });
        return false;
      })
      .finally(() => {
        pending.delete(item);
        write(item, 'aria-busy', null);
        rowOf(item).querySelector('.ds-tree__toggle > .ds-tree__spinner')?.remove();
      });
    pending.set(item, entry);
    return entry.promise;
  };

  const expand = async (target, open = true) => {
    const item = find(target);
    if (!item || !isFolder(item)) return false;
    if (isOpen(item) === open) return true;
    if (open && item.hasAttribute('data-ds-tree-lazy')) {
      if (!(await load(item)) || signal.aborted) return false;
    }
    item.setAttribute('aria-expanded', String(open));
    if (!open && active && active !== item && item.contains(active)) {
      const focused = item.contains(doc.activeElement);
      active = item;
      sync();
      if (focused) item.focus({ preventScroll: true });
    }
    sync();
    fire('toggle', { item, key: keyOf(item), expanded: open });
    return true;
  };

  /* ── Selection and checks ──────────────────────────── */

  const select = (item) => {
    if (!item || isDisabled(item) || options.select !== 'single') return false;
    for (const other of tree.querySelectorAll(`${ITEM}[aria-selected="true"]`)) if (other !== item) other.setAttribute('aria-selected', 'false');
    if (item.getAttribute('aria-selected') === 'true') return false;
    item.setAttribute('aria-selected', 'true');
    fire('select', { item, key: keyOf(item) });
    return true;
  };

  const checkedKeys = () => items().filter((item) => item.getAttribute('aria-checked') === 'true').map(keyOf).filter((key) => key !== null);

  const check = (item, value, { silent = false } = {}) => {
    if (!item || isDisabled(item) || options.select !== 'checkbox') return false;
    const next = value === undefined ? item.getAttribute('aria-checked') !== 'true' : Boolean(value);
    const state = String(next);
    item.setAttribute('aria-checked', state);
    const group = groupOf(item);
    if (group) for (const child of group.querySelectorAll(ITEM)) if (!isDisabled(child)) child.setAttribute('aria-checked', state);
    for (let parent = parentOf(item); parent; parent = parentOf(parent)) settle(parent);
    sync();
    if (!silent) fire('change', { item, key: keyOf(item), checked: next, keys: checkedKeys() });
    return true;
  };

  const activate = (item) => {
    if (!item || isDisabled(item)) return;
    if (options.select === 'single') select(item);
    if (options.select === 'none' && isFolder(item)) expand(item, !isOpen(item));
    fire('activate', { item, key: keyOf(item) });
  };

  /* ── Keys and pointer ──────────────────────────────── */

  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || dnd?.get()) return;
    const item = event.target;
    if (!isItem(item)) return;
    const list = visible();
    const index = list.indexOf(item);
    let next = null;
    switch (event.key) {
      case 'ArrowDown': next = list[index + 1]; break;
      case 'ArrowUp': next = list[index - 1]; break;
      case 'Home': next = list[0]; break;
      case 'End': next = list.at(-1); break;
      case 'ArrowRight':
        if (isFolder(item) && !isOpen(item)) expand(item, true);
        else if (isFolder(item)) next = childrenOf(item).find(showing);
        break;
      case 'ArrowLeft':
        if (isFolder(item) && isOpen(item)) expand(item, false);
        else next = parentOf(item);
        break;
      case 'Enter': {
        const link = rowOf(item).querySelector('a.ds-tree__label[href]');
        activate(item);
        if (link && !isDisabled(item)) link.click();
        break;
      }
      case ' ':
        if (options.select === 'checkbox') check(item);
        else activate(item);
        break;
      case '*': {
        const parent = parentOf(item);
        const siblings = parent ? childrenOf(parent) : topItems();
        for (const sibling of siblings) if (isFolder(sibling) && !isDisabled(sibling)) expand(sibling, true);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    if (next) focusItem(next);
  };

  const onClick = (/** @type {MouseEvent} */ event) => {
    const row = event.target.closest?.('.ds-tree__row');
    if (!row || !tree.contains(row)) return;
    const item = row.closest(ITEM);
    if (!item || rowOf(item) !== row) return;
    const control = event.target.closest('a[href], button, input, select, textarea, label');
    if (control && row.contains(control) && !control.matches('.ds-tree__label, .ds-tree__check')) {
      setActive(item);
      return;
    }
    setActive(item);
    if (doc.activeElement !== item) item.focus({ preventScroll: true });
    if (isDisabled(item)) {
      event.preventDefault();
      return;
    }
    if (event.target.closest('.ds-tree__toggle')) {
      expand(item, !isOpen(item));
      return;
    }
    if (options.select === 'checkbox') {
      check(item);
      return;
    }
    activate(item);
  };

  const onDouble = (/** @type {MouseEvent} */ event) => {
    const row = event.target.closest?.('.ds-tree__row');
    const item = row?.closest(ITEM);
    if (!item || rowOf(item) !== row || !isFolder(item) || isDisabled(item) || options.select === 'none') return;
    if (event.target.closest('.ds-tree__toggle, .ds-tree__actions, .ds-tree__grip')) return;
    expand(item, !isOpen(item));
  };

  const onFocus = (/** @type {FocusEvent} */ event) => {
    const item = isItem(event.target) ? event.target : event.target.closest?.(ITEM);
    if (item && tree.contains(item)) setActive(item);
  };

  /* ── Drag ──────────────────────────────────────────── */

  const clearMarks = () => {
    for (const marked of tree.querySelectorAll('[data-ds-tree-drop]')) write(marked, 'data-ds-tree-drop', null);
  };
  const folderOfZone = (zone) => (zone === tree ? null : zone.matches(ITEM) ? zone : zone.closest(ITEM));
  const zoneName = (folder) => (folder ? labelOf(folder) : treeName());

  /** A place between rows: the index among the zone's items without the dragged one (DS.dnd's target). */
  const between = (zone, index, ref, mark) => ({ zone, index, ref, mark, parent: folderOfZone(zone) });
  const inside = (folder, context) => {
    const zone = groupOf(folder) ?? folder;
    const count = groupOf(folder) ? context.itemsIn(zone).filter((other) => other !== context.item).length : 0;
    return { zone, index: count, position: 'inside', ref: folder, mark: 'inside', parent: folder };
  };
  const canHold = (folder, context) => isFolder(folder) && !isDisabled(folder) && !folder.hasAttribute('data-ds-tree-lazy') && context.accepts(context.item, groupOf(folder) ?? folder);

  /** Every place a keyboard drag can stop at, in reading order. */
  const slots = (context) => {
    const out = [];
    const walk = (zone) => {
      const list = context.itemsIn(zone).filter((other) => other !== context.item);
      list.forEach((other, index) => {
        out.push(between(zone, index, other, 'before'));
        if (!isFolder(other)) return;
        const group = groupOf(other);
        const open = isOpen(other) && group && context.itemsIn(group).some((child) => child !== context.item);
        if (open) walk(group);
        else if (canHold(other, context)) out.push(inside(other, context));
      });
      if (list.length) out.push(between(zone, list.length, list.at(-1), 'after'));
    };
    walk(tree);
    return out.filter((slot) => slot.position === 'inside' || context.accepts(context.item, slot.zone));
  };
  const same = (a, b) => Boolean(a) && Boolean(b) && a.zone === b.zone && a.index === b.index && a.position === b.position;

  const keyTarget = (key, context) => {
    const list = slots(context);
    const at = list.findIndex((slot) => same(slot, context.current));
    const current = list[at];
    if (key === 'ArrowRight') {
      if (current?.position === 'inside' && isFolder(current.ref) && !isOpen(current.ref)) {
        expand(current.ref, true).then(() => {
          if (dnd?.get()) announce(t('treeLoaded', { label: labelOf(current.ref), count: childrenOf(current.ref).length }));
        });
      }
      return null;
    }
    if (key === 'Home') return list[0] ?? null;
    if (key === 'End') return list.at(-1) ?? null;
    if (key === 'ArrowDown') return list[at < 0 ? 0 : at + 1] ?? null;
    if (key === 'ArrowUp') return at < 0 ? list.at(-1) ?? null : list[at - 1] ?? null;
    return null;
  };

  const spring = (folder) => {
    if (folder === springFolder) return;
    view.clearTimeout(springTimer);
    springFolder = folder;
    if (!folder || isOpen(folder)) return;
    springTimer = view.setTimeout(() => {
      if (dnd?.get() && springFolder === folder) expand(folder, true);
    }, motionDuration(tree, '--ds-delay-tooltip'));
  };

  const pointerTarget = (point, context) => {
    const rows = visible().filter((other) => !context.item.contains(other));
    if (!rows.length) return null;
    let hit = null;
    for (const other of rows) {
      const box = context.layoutBox(rowOf(other));
      if (point.y >= box.top && point.y < box.bottom) {
        hit = { item: other, share: (point.y - box.top) / Math.max(1, box.height) };
        break;
      }
    }
    const zoneOf = (other) => parentOf(other) ? groupOf(parentOf(other)) : tree;
    const indexOf = (other) => context.itemsIn(zoneOf(other)).filter((each) => each !== context.item).indexOf(other);
    if (!hit) {
      const first = rows[0];
      if (point.y < context.layoutBox(rowOf(first)).top) {
        spring(null);
        return between(zoneOf(first), indexOf(first), first, 'before');
      }
      spring(null);
      const last = topItems().filter((other) => other !== context.item).at(-1);
      return last ? between(tree, indexOf(last) + 1, last, 'after') : null;
    }
    const { item: over, share } = hit;
    if (isFolder(over) && share > 0.25 && share < 0.75 && canHold(over, context) && !isOpen(over)) {
      spring(over);
      return inside(over, context);
    }
    spring(null);
    if (isFolder(over) && share > 0.25 && share < 0.75 && isOpen(over) && canHold(over, context)) {
      const children = childrenOf(over).filter((child) => child !== context.item);
      return children.length ? between(groupOf(over), 0, children[0], 'before') : inside(over, context);
    }
    if (share < 0.5) return between(zoneOf(over), indexOf(over), over, 'before');
    // Below the row: the first child of an open folder, else after it among its siblings.
    const children = isFolder(over) && isOpen(over) ? childrenOf(over).filter((child) => child !== context.item) : [];
    if (children.length) return between(groupOf(over), 0, children[0], 'before');
    const zone = zoneOf(over);
    const siblings = context.itemsIn(zone).filter((each) => each !== context.item);
    const index = siblings.indexOf(over) + 1;
    return index < siblings.length ? between(zone, index, siblings[index], 'before') : between(zone, index, over, 'after');
  };

  const mark = (target) => {
    clearMarks();
    if (target?.ref) write(target.ref, 'data-ds-tree-drop', target.mark);
  };

  /** Puts `item` before `reference` in `parent`, keeping the focus inside it (moveBefore where there is one). */
  const put = (parent, item, reference) => {
    const focused = item.getRootNode().activeElement;
    const keep = focused && item.contains(focused) ? focused : null;
    if (typeof parent.moveBefore === 'function') {
      try {
        parent.moveBefore(item, reference);
      } catch {
        parent.insertBefore(item, reference);
      }
    } else parent.insertBefore(item, reference);
    if (keep && item.getRootNode().activeElement !== keep) keep.focus({ preventScroll: true });
  };

  /** Moves `item` (and its subtree) to `target` in the DOM. */
  const move = (item, target) => {
    if (target.position === 'inside') {
      const folder = target.ref;
      let group = groupOf(folder);
      if (!group) {
        group = doc.createElement('ul');
        group.className = 'ds-tree__group';
        group.setAttribute('role', 'group');
        folder.append(group);
      }
      // Open first, so the item (and a keyboard drag's focus) stays in sight.
      if (!isOpen(folder)) folder.setAttribute('aria-expanded', 'true');
      put(group, item, null);
    } else {
      const zone = target.zone;
      const others = Array.from(zone.querySelectorAll(ITEM)).filter((other) => other !== item && other.parentElement === zone);
      put(zone, item, others[target.index] ?? null);
    }
    sync();
  };

  const place = (target, context) => {
    if (dnd?.get()) {
      mark(target);
      return;
    }
    clearMarks();
    spring(null);
    if (context.mode === 'api') {
      move(context.item, target);
      return;
    }
    // A refused drop: back where it came from.
    if (moved && moved.item === context.item) {
      moved = null;
      move(context.item, normalise(target, context.item));
    }
  };

  /** DS.dnd's own `from` ({ zone, index }) as a place of this tree. */
  const normalise = (target, item) => {
    if (target.ref || target.position) return target;
    const zone = target.zone;
    const others = Array.from(zone.querySelectorAll(ITEM)).filter((other) => other !== item && other.parentElement === zone);
    return between(zone, target.index, others[target.index] ?? others.at(-1) ?? null, target.index < others.length ? 'before' : 'after');
  };

  const say = (type, detail) => {
    const target = dnd?.get()?.to;
    const label = detail.label;
    if (type === 'grab') return t('dragGrabbed', { label, position: detail.position, total: detail.total });
    if (type === 'cancel') return t('dragCancelled', { label, position: detail.position, total: detail.total });
    if (type === 'drop') return t('treeDropped', { label, parent: zoneName(lastDrop?.parent ?? null), position: (lastDrop?.index ?? 0) + 1, total: detail.total });
    const where = target ?? lastMove;
    if (!where) return '';
    if (where.position === 'inside') return t('treeMoveInside', { label, target: labelOf(where.ref) });
    const parent = zoneName(where.parent);
    if (where.mark === 'after') return t('treeMoveAfter', { label, target: where.ref ? labelOf(where.ref) : parent, parent });
    return t('treeMoveBefore', { label, target: where.ref ? labelOf(where.ref) : parent, parent });
  };
  let lastMove = null;
  let lastDrop = null;

  const onDragMove = (/** @type {CustomEvent} */ event) => {
    if (event.target === tree) lastMove = event.detail.to;
  };
  const onDrop = (/** @type {CustomEvent} */ event) => {
    if (event.target !== tree) return;
    const { item, to, mode } = event.detail;
    clearMarks();
    spring(null);
    lastDrop = to;
    if (mode === 'api') return;
    move(item, to);
    moved = { item };
    queueMicrotask(() => {
      if (moved?.item === item) moved = null;
    });
  };
  const onDragEnd = (/** @type {CustomEvent} */ event) => {
    if (event.target !== tree) return;
    clearMarks();
    spring(null);
  };

  const startDrag = () => {
    if (dnd || !options.drag) return;
    dnd = draggable(tree, {
      zones: `[role="tree"], ${GROUP}`,
      items: ITEM,
      handle: '.ds-tree__grip',
      label: labelOf,
      zoneLabel: (zone) => zoneName(folderOfZone(zone)),
      accept: (item, zone) => (typeof options.accept === 'function' ? options.accept(item, folderOfZone(zone)) !== false : true),
      target: pointerTarget,
      keyTarget,
      place,
      announce: say,
    });
  };
  const stopDrag = () => {
    dnd?.destroy();
    dnd = null;
    clearMarks();
  };

  /* ── Data rows ─────────────────────────────────────── */

  /** One item from data: escaped text through the DOM, glyphs by name. */
  const build = (data) => {
    const entry = data ?? {};
    const item = doc.createElement('li');
    item.className = 'ds-tree__item';
    item.setAttribute('role', 'treeitem');
    if (entry.id !== undefined && entry.id !== null) item.setAttribute('data-ds-key', String(entry.id));
    const folder = entry.children === true || Array.isArray(entry.children);
    if (folder) {
      item.setAttribute('aria-expanded', entry.expanded && Array.isArray(entry.children) ? 'true' : 'false');
      if (entry.children === true) item.setAttribute('data-ds-tree-lazy', '');
    }
    if (entry.disabled) item.setAttribute('aria-disabled', 'true');
    if (options.select === 'checkbox') {
      if (entry.checked !== undefined) item.setAttribute('aria-checked', entry.checked === 'mixed' ? 'mixed' : String(Boolean(entry.checked)));
    } else if (options.select === 'single') item.setAttribute('aria-selected', String(Boolean(entry.selected)));
    const row = doc.createElement('div');
    row.className = 'ds-tree__row';
    if (folder) {
      const toggle = doc.createElement('span');
      toggle.className = 'ds-tree__toggle';
      toggle.setAttribute('aria-hidden', 'true');
      toggle.append(iconElement(chevronRight, 16, undefined, doc));
      row.append(toggle);
    }
    if (options.select === 'checkbox') {
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.className = 'ds-checkbox ds-tree__check';
      row.append(box);
    }
    if (entry.icon || folder) {
      const glyphs = doc.createElement('span');
      glyphs.className = 'ds-tree__icon';
      glyphs.setAttribute('aria-hidden', 'true');
      if (entry.icon) glyphs.setAttribute('data-icon', String(entry.icon));
      else glyphs.append(iconElement(folderGlyph, 20, undefined, doc), iconElement(folderOpen, 20, undefined, doc));
      row.append(glyphs);
    }
    const href = entry.href ? safeUrl(entry.href) : null;
    const label = doc.createElement(href ? 'a' : 'span');
    label.className = 'ds-tree__label';
    if (href) label.setAttribute('href', href);
    label.textContent = String(entry.label ?? '');
    row.append(label);
    if (entry.meta !== undefined && entry.meta !== null && entry.meta !== '') {
      const meta = doc.createElement('span');
      meta.className = 'ds-tree__meta';
      meta.textContent = String(entry.meta);
      row.append(meta);
    }
    item.append(row);
    if (Array.isArray(entry.children)) {
      const group = doc.createElement('ul');
      group.className = 'ds-tree__group';
      group.setAttribute('role', 'group');
      group.append(...entry.children.map(build));
      item.append(group);
    }
    return item;
  };

  /* ── Wiring ────────────────────────────────────────── */

  tree.addEventListener('keydown', onKey, { signal });
  tree.addEventListener('click', onClick, { signal });
  tree.addEventListener('dblclick', onDouble, { signal });
  tree.addEventListener('focusin', onFocus, { signal });
  tree.addEventListener('ds:drag-move', onDragMove, { signal });
  tree.addEventListener('ds:drop', onDrop, { signal });
  tree.addEventListener('ds:drag-cancel', onDragEnd, { signal });
  const watcher = typeof view?.MutationObserver === 'function' ? new view.MutationObserver(resync) : null;
  const letters = typeahead(tree, { items: visible, label: (item) => labelOf(item).toLowerCase(), onMatch: focusItem });
  watcher?.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-disabled', 'aria-checked', 'hidden'] });
  sync();
  startDrag();
  fill(tree);

  const handle = {
    /** Single: the selected key (or null); checkbox: the checked keys; none: the active key. */
    get() {
      if (options.select === 'checkbox') return checkedKeys();
      if (options.select === 'single') return keyOf(tree.querySelector(`${ITEM}[aria-selected="true"]`));
      return keyOf(active);
    },
    set(value) {
      if (options.select === 'checkbox') {
        const keys = new Set(Array.isArray(value) ? value.map(String) : []);
        // Leaves first, then folders follow from their children.
        for (const item of items().reverse()) {
          if (isDisabled(item)) continue;
          if (!childrenOf(item).length) item.setAttribute('aria-checked', String(keys.has(keyOf(item) ?? '')));
          else if (keys.has(keyOf(item) ?? '')) check(item, true, { silent: true });
        }
        sync();
        return;
      }
      const item = find(value === null || value === undefined ? null : String(value));
      if (options.select === 'single') {
        if (!item) for (const other of tree.querySelectorAll(`${ITEM}[aria-selected="true"]`)) other.setAttribute('aria-selected', 'false');
        else select(item);
      } else if (item) setActive(item);
    },
    on(type, fn) {
      const listener = (/** @type {CustomEvent} */ event) => {
        if (event.target === tree) fn(event.detail);
      };
      tree.addEventListener(`ds:${type}`, listener, { signal });
      return () => tree.removeEventListener(`ds:${type}`, listener);
    },
    /** Opens (or closes, with open false) a folder by key or element, loading it first when it is lazy. */
    expand(target, open = true) {
      return expand(target, open);
    },
    /** Opens every folder that is loaded (lazy ones stay closed), or closes every one. */
    expandAll(open = true) {
      for (const item of items()) if (isFolder(item) && !item.hasAttribute('data-ds-tree-lazy') && !isDisabled(item)) item.setAttribute('aria-expanded', String(open));
      sync();
    },
    /** Checks or unchecks an item (checkbox), with its subtree and the folders above. */
    check(target, value) {
      return check(find(target), value);
    },
    /** Moves the focus (and the tab stop) to an item, opening the folders above it. */
    focus(target) {
      const item = find(target);
      if (!item) return;
      for (let parent = parentOf(item); parent; parent = parentOf(parent)) if (!isOpen(parent)) parent.setAttribute('aria-expanded', 'true');
      sync();
      focusItem(item);
    },
    /** The item of a key. */
    item(key) {
      return find(String(key));
    },
    /** Loads a folder's children again (a lazy one, or one whose loader is called anew). */
    reload(target) {
      const item = find(target);
      if (!item || !isFolder(item)) return Promise.resolve(false);
      item.setAttribute('data-ds-tree-lazy', '');
      return load(item);
    },
    /** Options again: select, load, drag, accept. */
    configure(next = {}) {
      options = { ...options, ...next, select: modeOf(next.select ?? options.select) };
      if (options.drag) startDrag();
      else stopDrag();
      sync();
    },
    update() {
      handle.configure({ select: tree.getAttribute('data-ds-tree-select') ?? options.select, drag: flag(tree.getAttribute('data-ds-tree-drag')) });
    },
    destroy() {
      if (signal.aborted) return;
      abort.abort();
      view.clearTimeout(springTimer);
      for (const entry of pending.values()) entry.control.abort();
      pending.clear();
      watcher?.disconnect();
      letters.destroy();
      stopDrag();
      for (const element of [tree, ...tree.querySelectorAll('*')]) {
        const names = claims.get(element);
        if (!names) continue;
        for (const name of names) disown(element, 'attrs', name);
        claims.delete(element);
      }
      if (instances.get(tree) === handle) instances.delete(tree);
    },
  };
  instances.set(tree, handle);
  return handle;
}

const attributeOptions = (el) => ({ select: el.getAttribute('data-ds-tree-select'), drag: flag(el.getAttribute('data-ds-tree-drag')) });

define('tree', {
  attribute: 'data-ds-tree',
  attributes: ['data-ds-tree-select', 'data-ds-tree-drag'],
  init(el) {
    return instances.get(el) ?? controller(el, attributeOptions(el));
  },
});

/**
 * A tree driven from the page, or the options of one the attribute path
 * made: the same controller. `select`: 'single' (default), 'checkbox' or
 * 'none'. `load(item, { key, signal })`: lazy children. `drag`: move items
 * by their grip. `accept(item, folder)`: whether a place takes the item.
 * @param {Element} el
 * @param {{ select?: 'single'|'checkbox'|'none', load?: (item: Element, context: { key: string|null, signal: AbortSignal }) => any, drag?: boolean, accept?: (item: Element, folder: Element|null) => boolean }} [options]
 */
export function create(el, options = {}) {
  if (!el?.ownerDocument) return { get: () => null, set() {}, on: () => () => {}, expand: () => Promise.resolve(false), expandAll() {}, check: () => false, focus() {}, item: () => null, reload: () => Promise.resolve(false), configure() {}, update() {}, destroy() {} };
  const existing = instances.get(el);
  if (existing) {
    existing.configure(options);
    return existing;
  }
  return controller(el, { ...attributeOptions(el), ...options, select: options.select ?? el.getAttribute('data-ds-tree-select') });
}
