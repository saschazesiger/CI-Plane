/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Object page (DS.object): the edit mode of one record's page, and the band
 * of its sticky head and section anchors.
 *
 *   <div class="ds-object" data-ds-object> head, bar, sections </div>
 *   const record = DS.object.create(el);
 *   record.get();  record.set(['general']);  record.edit('network');  record.done('network');
 *   el.addEventListener('ds:save', (event) => { event.preventDefault(); save(event.detail.values).then(() => record.done(event.detail.section)); });
 *
 * Sections (.ds-object__section) have two faces: .ds-object__view and
 * .ds-object__form (a <form>). The module owns their `hidden` and the
 * section's data-editing:
 * - A [data-ds-object-edit] button in a section turns that section into its
 *   form: the view hides, the form enters (DS.motion.enter(form, 'swap')),
 *   the focus goes to its first field and a screen reader hears "Editing
 *   <title>". One outside the sections (in the head) turns every section
 *   that has a form into it (edit mode, data-editing on the .ds-object; a
 *   read-only section, without a form, stays as it is); then the
 *   [data-ds-object-save] and [data-ds-object-cancel] buttons outside the
 *   sections show and the edit button hides (owned `hidden`).
 * - Submitting a section's form (its submit button, Enter in a field)
 *   sends ds:save on the section ({ section, id, form, values }); unless a
 *   listener cancels it, the section goes back to its view, the focus to its
 *   edit button, and a screen reader hears "<title> saved". A page that
 *   saves on a server cancels ds:save and calls done(section) once saved.
 *   [data-ds-object-save] outside the sections submits every form that
 *   edits (requestSubmit(), so each validates first) as one batch: the
 *   focus moves once, to the head's edit when the last section is done.
 * - [data-ds-object-cancel] in a section, or Escape in its form (unless a
 *   popup in it is open), sends ds:cancel ({ section, id, form }); unless
 *   cancelled, the form resets and the view comes back. Outside the
 *   sections it cancels every section that edits.
 * The band: the head's height and the bar's go on the .ds-object as
 * --ds-object-head and --ds-object-bar (runtime properties, a
 * ResizeObserver), so the bar sticks under the head and a jump lands below
 * both.
 *
 * Owned state (DS.dom.morphHtml keeps it): hidden on the faces and on the
 * edit, save and cancel buttons outside the sections, data-editing on the
 * sections and the .ds-object. Events: ds:edit ({ section, id }), ds:save,
 * ds:cancel and ds:change ({ editing }: the ids that edit) on the .ds-object
 * (ds:save and ds:cancel on the section, bubbling).
 *
 * ES2022. Progressive: none.
 */
import { define, emit, t } from './core.js';
import { enter } from './motion.js';
import { own, disown } from './dom.js';
import { announce, tabbables } from './a11y.js';

/**
 * The values of a form's entries (FormData), as a plain object: a name that
 * comes once is its value, a name that comes more than once (checkboxes, a
 * multiple select) a list of them.
 * @param {Iterable<[string, FormDataEntryValue]>} entries
 * @returns {Record<string, FormDataEntryValue | FormDataEntryValue[]>}
 */
export function values(entries) {
  const out = {};
  for (const [name, value] of entries) {
    // Defined, not assigned: a field named __proto__ stays a value.
    const set = (next) => Object.defineProperty(out, name, { value: next, enumerable: true, writable: true, configurable: true });
    if (!Object.hasOwn(out, name)) set(value);
    else if (Array.isArray(out[name])) out[name].push(value);
    else set([out[name], value]);
  }
  return out;
}

/**
 * The controller of one object page.
 * @param {HTMLElement} article
 * @param {AbortSignal} [signal]
 */
function controller(article, signal) {
  const doc = article.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const abort = new AbortController();
  const listen = { signal: abort.signal };
  signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const listeners = new Set();
  const owned = [];
  const take = (element, name) => {
    if (owned.some(([each, which]) => each === element && which === name)) return;
    own(element, 'attrs', name);
    owned.push([element, name]);
  };

  const sections = () => [...article.querySelectorAll('.ds-object__section')].filter((section) => section.closest('.ds-object') === article);
  const faces = (section) => ({
    view: section.querySelector('.ds-object__view'),
    form: section.querySelector('form.ds-object__form, .ds-object__form form') ?? section.querySelector('.ds-object__form'),
    box: section.querySelector('.ds-object__form'),
  });
  const titleOf = (section) => {
    const id = section.getAttribute('aria-labelledby');
    const title = (id && doc.getElementById(id)) || section.querySelector('.ds-object__title');
    return title?.textContent.trim() ?? '';
  };
  /** The record's name: its own label, else the title of its page head (never a section's title). */
  const objectTitle = () => {
    const id = article.getAttribute('aria-labelledby');
    const title = (id && doc.getElementById(id)) || outside('.ds-page-head__title')[0];
    return article.getAttribute('aria-label') || title?.textContent.trim() || '';
  };
  const editing = (section) => section.hasAttribute('data-editing');
  /** The sections that can edit: those with a form (a read-only section, such as a history, has none). */
  const editable = () => sections().filter((section) => faces(section).box);
  /** Whether every section that can edit edits: the edit mode. */
  const allEdit = () => {
    const list = editable();
    return list.length > 0 && list.every(editing);
  };
  /**
   * Save all is one batch: the sections it submitted, until each is done. The
   * per-section focus moves wait; when the last one is done the focus moves
   * once (settleBatch). `savingAll` is true while Save all submits (the
   * submit events fire synchronously from requestSubmit()).
   */
  const batch = new Set();
  let savingAll = false;
  /** The controls outside the sections: the object-wide edit, save and cancel. */
  const outside = (selector) => [...article.querySelectorAll(selector)].filter((el) => !el.closest('.ds-object__section'));

  const tell = (target, type, detail, cancelable = false) => {
    const go = emit(target, type, detail, { cancelable });
    for (const entry of listeners) if (entry.type === type) entry.fn(detail);
    return go;
  };

  /** Shows the object-wide buttons of the mode: edit while any section views, save and cancel while all that can edit do. */
  const syncMode = () => {
    const all = sections();
    const every = allEdit();
    for (const button of outside('[data-ds-object-edit]')) {
      take(button, 'hidden');
      button.hidden = every;
    }
    for (const button of outside('[data-ds-object-save], [data-ds-object-cancel]')) {
      take(button, 'hidden');
      button.hidden = !every;
    }
    take(article, 'data-editing');
    article.toggleAttribute('data-editing', every);
    const detail = { editing: all.filter(editing).map((section) => section.id || null) };
    tell(article, 'change', detail);
  };

  /** Turns a section into its form (or back); `focus` moves the focus with it. */
  const face = (section, on, focus) => {
    const { view: shown, box } = faces(section);
    if (!box || on === editing(section)) return false;
    take(section, 'data-editing');
    if (shown) take(shown, 'hidden');
    take(box, 'hidden');
    section.toggleAttribute('data-editing', on);
    if (on) {
      if (shown) shown.hidden = true;
      enter(box, 'swap');
      if (focus) tabbables(box)[0]?.focus();
    } else {
      box.hidden = true;
      if (shown) enter(shown, 'swap');
      if (focus) {
        const button = section.querySelector('[data-ds-object-edit]');
        (button ?? section.querySelector('.ds-object__title') ?? section)?.focus?.({ preventScroll: true });
      }
    }
    return true;
  };

  const resolve = (target) => {
    if (!target) return null;
    if (typeof target === 'string') return sections().find((section) => section.id === target) ?? null;
    return target.closest?.('.ds-object__section') ?? null;
  };

  /** Turns a section (an element or its id), or every section that has a form (null), into its form. */
  const edit = (target = null) => {
    const list = target === null ? editable() : [resolve(target)].filter(Boolean);
    let changed = false;
    list.forEach((section, index) => {
      if (editing(section)) return;
      if (!tell(section, 'edit', { section, id: section.id || null }, true)) return;
      if (face(section, true, index === 0)) changed = true;
    });
    if (!changed) return false;
    announce(t('editing', { label: target === null ? objectTitle() : titleOf(list[0]) }));
    syncMode();
    return true;
  };

  /** Leaves a section's form after the page saved it: its view comes back and a screen reader hears it. */
  const done = (target) => {
    const section = resolve(target);
    if (!section || !editing(section)) return false;
    const inBatch = batch.delete(section);
    const focus = !inBatch && (section.contains(doc.activeElement) || doc.activeElement === doc.body);
    if (!face(section, false, focus)) return false;
    announce(t('sectionSaved', { label: titleOf(section) }));
    syncMode();
    if (inBatch && batch.size === 0) settleBatch();
    return true;
  };

  /**
   * The end of a Save all, when the focus was lost on the way (Save all hides
   * with the mode): the head's edit once no section edits, else the first
   * field of a section that still edits (one that did not validate).
   */
  const settleBatch = () => {
    const active = doc.activeElement;
    if (active && active !== doc.body && active.isConnected && !active.closest?.('[hidden]')) return;
    const open = sections().find(editing);
    const target = open ? tabbables(faces(open).box)[0] : outside('[data-ds-object-edit]')[0];
    target?.focus({ preventScroll: true });
  };

  /** Cancels a section (or every section that edits, null): the form resets and the view comes back. */
  const cancel = (target = null) => {
    const list = target === null ? sections().filter(editing) : [resolve(target)].filter((section) => section && editing(section));
    const wasEvery = allEdit();
    let changed = false;
    for (const section of list) {
      const { form } = faces(section);
      if (!tell(section, 'cancel', { section, id: section.id || null, form }, true)) continue;
      batch.delete(section);
      form?.reset?.();
      const focus = section.contains(doc.activeElement) || doc.activeElement === doc.body;
      if (face(section, false, target !== null && focus)) changed = true;
    }
    if (!changed) return false;
    syncMode();
    if (target === null && wasEvery) outside('[data-ds-object-edit]')[0]?.focus({ preventScroll: true });
    return true;
  };

  /** Saves a section (or every section that edits, null) as its submit button would: it validates first. */
  const save = (target = null) => {
    const list = target === null ? sections().filter(editing) : [resolve(target)].filter((section) => section && editing(section));
    savingAll = target === null;
    try {
      for (const section of list) {
        const { form } = faces(section);
        if (form?.requestSubmit) form.requestSubmit();
        else if (form) submit(section, form);
      }
    } finally {
      savingAll = false;
    }
    // A Save all whose forms all stopped at validation: the focus is in the first that failed.
    if (target === null && batch.size === 0) settleBatch();
    return list.length > 0;
  };

  /** A section's form was submitted: ds:save, then back to the view unless a listener cancelled it. */
  const submit = (section, form) => {
    const detail = { section, id: section.id || null, form, values: values(new view.FormData(form)) };
    // Part of a Save all, or a save of its own (also of a section a Save all left open).
    const inBatch = savingAll;
    if (inBatch) batch.add(section);
    else batch.delete(section);
    if (!tell(section, 'save', detail, true)) return;
    const every = allEdit();
    done(section);
    if (!inBatch && every && !sections().some(editing)) outside('[data-ds-object-edit]')[0]?.focus({ preventScroll: true });
  };

  article.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    const button = target?.closest?.('[data-ds-object-edit], [data-ds-object-save], [data-ds-object-cancel]');
    if (!button || !article.contains(button) || button.getAttribute('aria-disabled') === 'true') return;
    const section = button.closest('.ds-object__section');
    if (button.hasAttribute('data-ds-object-edit')) edit(section ?? null);
    else if (button.hasAttribute('data-ds-object-save')) save(section ?? null);
    else cancel(section ?? null);
  }, listen);

  article.addEventListener('submit', (event) => {
    const form = /** @type {HTMLFormElement} */ (event.target);
    const section = form?.closest?.('.ds-object__section');
    if (!section || section.closest('.ds-object') !== article || !editing(section)) return;
    event.preventDefault();
    submit(section, form);
  }, listen);

  article.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    const target = /** @type {Element} */ (event.target);
    const section = target?.closest?.('.ds-object__section');
    if (!section || !editing(section) || !faces(section).box?.contains(target)) return;
    // A popup inside the form (a combobox list, a menu) closes first.
    if (section.querySelector('[aria-expanded="true"]')) return;
    event.preventDefault();
    cancel(section);
  }, listen);

  /* The band: the head's and the bar's heights, for the stickiness and the jumps. */
  const head = [...article.children].find((child) => child.classList.contains('ds-page-head')) ?? null;
  const bar = [...article.children].find((child) => child.classList.contains('ds-toc')) ?? null;
  const measure = () => {
    if (head) article.style.setProperty('--ds-object-head', `${Math.round(head.getBoundingClientRect().height)}px`);
    if (bar) article.style.setProperty('--ds-object-bar', `${Math.round(bar.getBoundingClientRect().height)}px`);
  };
  const sizes = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => measure()) : null;
  if (head) sizes?.observe(head);
  if (bar) sizes?.observe(bar);
  measure();

  // The markup's state: a section that says data-editing shows its form.
  for (const section of sections()) {
    const { view: shown, box } = faces(section);
    if (!box) continue;
    take(section, 'data-editing');
    take(box, 'hidden');
    if (shown) take(shown, 'hidden');
    const on = editing(section);
    box.hidden = !on;
    if (shown) shown.hidden = on;
  }
  syncMode();

  let gone = false;
  return {
    /** The ids of the sections that edit. */
    get() {
      return sections().filter(editing).map((section) => section.id || null);
    },
    /** Edits exactly these sections (ids or elements; true: all, false or []: none); the others cancel. */
    set(value) {
      const all = sections();
      const wanted = value === true ? editable() : value === false || value == null ? [] : (Array.isArray(value) ? value : [value]).map(resolve).filter(Boolean);
      for (const section of all) if (editing(section) && !wanted.includes(section)) cancel(section);
      if (value === true) edit(null);
      else for (const section of wanted) edit(section);
    },
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    edit,
    save,
    cancel,
    done,
    destroy() {
      if (gone) return;
      gone = true;
      abort.abort();
      listeners.clear();
      sizes?.disconnect();
      article.style.removeProperty('--ds-object-head');
      article.style.removeProperty('--ds-object-bar');
      for (const [element, name] of owned) disown(element, 'attrs', name);
      owned.length = 0;
    },
  };
}

define('object', {
  attribute: 'data-ds-object',
  init(el, ctx) {
    return controller(/** @type {HTMLElement} */ (el), ctx.signal);
  },
});

/**
 * An object page driven from the page; the same controller the attribute
 * path makes.
 * @param {HTMLElement} el  the .ds-object article
 */
export function create(el) {
  return controller(el);
}
