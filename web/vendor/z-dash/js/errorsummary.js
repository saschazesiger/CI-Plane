/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Error summary (DS.errorsummary): the problems of a form at its top, each a
 * link to its field, focused when a submit finds them.
 *
 *   <form class="ds-form" novalidate>
 *     <div class="ds-alert ds-tone-error ds-errorsummary" data-ds-errorsummary tabindex="-1" hidden>
 *       (alertCircle 20)
 *       <div class="ds-alert__text">
 *         <h2 class="ds-alert__title ds-errorsummary__title"></h2>
 *         <ul class="ds-errorsummary__list"></ul>
 *       </div>
 *     </div>
 *     <div class="ds-field"><label class="ds-field__label" for="name">Name</label>
 *       <input class="ds-input" id="name" required>
 *       <small class="ds-field__hint ds-field__hint--error" hidden></small></div>   (optional: the message at the field)
 *     ...
 *   </form>
 *
 *   const summary = DS.errorsummary.create(el);
 *   summary.validate();                        // false, and the summary shows
 *   summary.set([{ field: 'serial', text: 'This serial number is taken.' }]);   // from the server
 *   summary.clear();
 *
 * Which fields: those of the form that fail their own constraints
 * (checkValidity(): required, type, pattern, min, max, maxlength ...) and
 * those the page marked aria-invalid="true" (a check of its own). In the
 * order of the form. The radios of a name are one problem, named by their
 * group (the radiogroup's aria-labelledby or aria-label, else the
 * fieldset's legend), linked to the checked radio or the first, and marked
 * together.
 *
 * Each problem's words: the field's visible error hint (.ds-field__hint--
 * error with text, the page's own message), else "<label>: <the browser's
 * validation message>" (the string errorSummaryField). An empty error hint
 * of the field (hidden) gets the message too, with its icon, linked by
 * aria-describedby, while the problem lasts.
 *
 * On submit (the form's own; capture, so a submit with problems never
 * reaches the page's handler): with problems, the submit stops, every field
 * with one gets aria-invalid="true" (the system's while it lasts), the
 * title says "There are 2 problems" (errorSummaryOne, errorSummaryMany), the
 * list holds a link per problem and the summary shows and takes the focus
 * (tabindex="-1"), so a reader starts there. A link focuses its field (and
 * brings it into view) instead of only scrolling. As each field is fixed
 * (input, change) its problem leaves the list; the summary hides once none
 * is left. A problem that was not in the list waits for the next submit,
 * validate() or set(): nothing joins while a person types. novalidate on the form (set here) keeps the browser's own
 * bubbles away.
 *
 * Events on the summary: ds:invalid ({ errors }) when it shows after a
 * submit or validate(); ds:change ({ errors }) when the list changes.
 *
 * Strings: errorSummaryOne, errorSummaryMany, errorSummaryField
 * (DS.core.config({ strings })).
 *
 * ES2022.
 *
 * Progressive:
 * - focus({ focusVisible: true }) (the summary's ring after a pointer
 *   submit): without it the ring follows the engine's own heuristic, so it
 *   shows after a submit from the keyboard and may not after a click; the
 *   summary still takes the focus and is read.
 */
import { define, emit, t } from './core.js';
import { own } from './dom.js';
import { plural } from './format.js';
import { alertCircle, iconElement } from './icons.js';

let seq = 0;

/** The controls of a form that can have a problem, in its order. */
const CONTROLS = 'input:not([type="hidden"], [type="submit"], [type="button"], [type="reset"], [type="image"]), select, textarea, [role="combobox"], [role="spinbutton"], [role="group"][aria-invalid]';

/**
 * The title of a summary of `count` problems ("There is 1 problem", "There
 * are 3 problems"); '' for none.
 * @param {number} count
 * @returns {string}
 */
export function title(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return '';
  return plural(n, { one: t('errorSummaryOne'), other: t('errorSummaryMany') });
}

const idOf = (el, part) => {
  if (!el.id) {
    seq += 1;
    el.id = `ds-errorsummary-${part}-${seq}`;
  }
  return el.id;
};

/** The text of a label element without its markers ("(optional)", the asterisk, "(changed)"). */
function textOf(label) {
  const copy = /** @type {HTMLElement} */ (label.cloneNode(true));
  copy.querySelectorAll('.ds-field__optional, .ds-field__required, .ds-field__changed, [aria-hidden="true"]').forEach((node) => node.remove());
  return copy.textContent.trim();
}

/** The words of an element's aria-labelledby ('' without it). */
function labelledBy(el) {
  const doc = el.ownerDocument;
  return (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => doc?.getElementById(id)?.textContent ?? '').join(' ').trim();
}

const isRadio = (field) => field.tagName === 'INPUT' && (/** @type {HTMLInputElement} */ (field)).type === 'radio';

/**
 * The words of a field's label: aria-labelledby, its label element, else
 * aria-label, else its name. A radio is named by its group (the radiogroup's
 * name, else its fieldset's legend), never by its option's label.
 */
function labelOf(field) {
  if (isRadio(field)) {
    for (const box of [field.closest('[role="radiogroup"]'), field.closest('fieldset')]) {
      if (!box) continue;
      const legend = box.tagName === 'FIELDSET' ? box.querySelector(':scope > legend') : null;
      const text = labelledBy(box) || (box.getAttribute('aria-label') ?? '').trim() || (legend ? textOf(legend) : '');
      if (text) return text;
    }
    return field.getAttribute('name') ?? '';
  }
  const labelled = labelledBy(field);
  if (labelled) return labelled;
  const label = field.labels?.[0];
  if (label) {
    const text = textOf(label);
    if (text) return text;
  }
  return field.getAttribute('aria-label') ?? field.getAttribute('name') ?? '';
}

function controller(root, signal) {
  const doc = root.ownerDocument;
  const form = /** @type {HTMLFormElement|null} */ (root.closest('form') ?? (root.getAttribute('data-ds-errorsummary') ? doc?.getElementById(root.getAttribute('data-ds-errorsummary') ?? '') : null));
  const titleEl = root.querySelector('.ds-errorsummary__title');
  const list = root.querySelector('.ds-errorsummary__list');
  const listeners = { invalid: new Set(), change: new Set() };
  const on = (target, type, fn, options) => target?.addEventListener(type, fn, { signal, ...options });
  /** The fields this summary marked, and the hints it wrote. */
  const marked = new Set();
  const wrote = new Set();
  /** Problems the page set (a server's answer), by field. */
  let custom = /** @type {Map<Element, string>} */ (new Map());
  let shown = false;
  /** The problems shown: `fields` those that share it (a radio group's radios), `field` the one its link focuses. */
  let errors = /** @type {{ fields: Element[], field: Element, id: string, text: string }[]} */ ([]);

  if (form) {
    own(form, 'attrs', 'novalidate');
    form.noValidate = true;
  }
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  if (titleEl && !root.hasAttribute('aria-labelledby')) root.setAttribute('aria-labelledby', idOf(titleEl, 'title'));
  if (!root.hasAttribute('role')) root.setAttribute('role', 'group');

  const controls = () => (form ? /** @type {HTMLElement[]} */ ([...form.querySelectorAll(CONTROLS)]) : [])
    .filter((field) => !field.closest('[data-ds-errorsummary]') && !(/** @type {any} */ (field)).disabled);

  const hintOf = (field) => /** @type {HTMLElement|null} */ (field.closest('.ds-field')?.querySelector('.ds-field__hint--error') ?? null);

  /**
   * What can have one problem, in the form's order: the radios of a name
   * (one group, one problem, one line), every other control alone.
   */
  const units = () => {
    const out = /** @type {Element[][]} */ ([]);
    const groups = new Map();
    for (const field of controls()) {
      const name = isRadio(field) ? field.getAttribute('name') : '';
      if (!name) {
        out.push([field]);
      } else if (groups.has(name)) {
        groups.get(name).push(field);
      } else {
        const group = [field];
        groups.set(name, group);
        out.push(group);
      }
    }
    return out;
  };

  const failing = (field) => typeof (/** @type {any} */ (field)).checkValidity === 'function' && !(/** @type {any} */ (field)).checkValidity();

  /** The words of a unit's problem, or '' when it has none. */
  const problem = (unit) => {
    const own = unit.map((field) => custom.get(field)).find(Boolean);
    if (own) return own;
    const field = unit.find(failing) ?? unit.find((each) => each.getAttribute('aria-invalid') === 'true' && !marked.has(each));
    if (!field) return '';
    const hint = hintOf(field);
    if (hint && !wrote.has(hint) && !hint.hidden && hint.textContent.trim()) return hint.textContent.trim();
    const message = (/** @type {any} */ (field)).validationMessage || '';
    return message ? t('errorSummaryField', { label: labelOf(field), message }) : labelOf(field);
  };

  const writeHint = (field, text) => {
    const hint = hintOf(field);
    if (!hint || !doc) return;
    if (!text) {
      if (wrote.has(hint)) {
        wrote.delete(hint);
        hint.replaceChildren();
        hint.hidden = true;
      }
      return;
    }
    // Only a hint the page left empty is the summary's to write.
    if (!wrote.has(hint) && (hint.textContent.trim() || !hint.hidden)) return;
    wrote.add(hint);
    const words = custom.get(field) || (/** @type {any} */ (field)).validationMessage || text;
    hint.replaceChildren(iconElement(alertCircle, 16, '', doc), doc.createTextNode(words));
    hint.hidden = false;
    const id = idOf(hint, 'hint');
    const ids = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (!ids.includes(id)) field.setAttribute('aria-describedby', [...ids, id].join(' '));
  };

  const mark = (field, on) => {
    if (on) {
      if (field.getAttribute('aria-invalid') !== 'true') {
        field.setAttribute('aria-invalid', 'true');
        marked.add(field);
      }
    } else if (marked.has(field)) {
      field.removeAttribute('aria-invalid');
      marked.delete(field);
    }
  };

  const collect = () => units().map((fields) => {
    // A group's link goes to its checked radio (the one Tab reaches), else its first.
    const field = fields.find((each) => (/** @type {any} */ (each)).checked) ?? fields[0];
    return { fields, field, id: idOf(field, 'field'), text: problem(fields) };
  }).filter((item) => item.text);

  /** Marks every control of the form by the list: aria-invalid and the written hint while its problem is there. */
  const markAll = (fields = controls()) => {
    for (const field of fields) {
      const text = errors.find((error) => error.fields.includes(field))?.text ?? '';
      mark(field, Boolean(text));
      writeHint(field, text);
    }
  };

  /**
   * The list after a change: the problems already there that still fail,
   * with their words now. A new problem waits for the next submit,
   * validate() or set(), so nothing joins while a person types.
   */
  const reconcile = () => {
    const now = collect();
    return errors.flatMap((error) => now.find((item) => item.fields.some((field) => error.fields.includes(field))) ?? []);
  };

  const render = () => {
    if (titleEl) titleEl.textContent = title(errors.length);
    if (!list || !doc) return;
    const items = errors.map((error) => {
      const item = doc.createElement('li');
      item.setAttribute('data-ds-key', error.id);
      const link = doc.createElement('a');
      link.href = `#${error.id}`;
      link.textContent = error.text;
      item.append(link);
      return item;
    });
    list.replaceChildren(...items);
  };

  const detail = () => ({ errors: errors.map(({ id, text }) => ({ id, text })) });

  const show = (focus) => {
    errors = collect();
    markAll();
    render();
    if (!errors.length) {
      hide();
      return true;
    }
    shown = true;
    root.hidden = false;
    // focusVisible: the ring after a pointer submit too, where the engine knows the option.
    if (focus) root.focus({ preventScroll: false, focusVisible: true });
    emit(root, 'invalid', detail());
    listeners.invalid.forEach((fn) => fn(detail()));
    return false;
  };

  function hide() {
    shown = false;
    errors = [];
    root.hidden = true;
    render();
  }

  /** After a fix: the field's problem (its group's) leaves the list; none left hides it. */
  const refresh = (field) => {
    if (!shown) return;
    const unit = units().find((each) => each.includes(field)) ?? [field];
    for (const each of unit) custom.delete(each);
    const before = errors;
    errors = reconcile();
    // Every field that had a problem: one fix can clear a whole group, and a field the list never named stays as it is.
    markAll(before.flatMap((error) => error.fields));
    const lines = (items) => items.map((error) => `${error.id} ${error.text}`).join('\n');
    if (lines(before) === lines(errors)) return;
    if (!errors.length) {
      hide();
    } else {
      render();
    }
    emit(root, 'change', detail());
    listeners.change.forEach((fn) => fn(detail()));
  };

  on(form, 'submit', (/** @type {SubmitEvent} */ event) => {
    custom = new Map();
    if (show(true)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  on(form, 'input', (event) => refresh(/** @type {Element} */ (event.target)));
  on(form, 'change', (event) => refresh(/** @type {Element} */ (event.target)));
  on(form, 'reset', () => setTimeout(() => {
    for (const field of [...marked]) mark(field, false);
    for (const field of controls()) writeHint(field, '');
    custom = new Map();
    hide();
  }));
  on(list, 'click', (/** @type {MouseEvent} */ event) => {
    const link = /** @type {Element} */ (event.target).closest?.('a[href^="#"]');
    if (!link) return;
    const field = doc?.getElementById(decodeURIComponent(link.getAttribute('href')?.slice(1) ?? ''));
    if (!field) return;
    // A fragment link scrolls but leaves the focus behind in some engines: move it (a group: its first control).
    event.preventDefault();
    const target = field.matches('input, select, textarea, button, [tabindex]') ? field : field.querySelector('input, select, textarea, button, [tabindex]') ?? field;
    target.scrollIntoView?.({ block: 'center' });
    (/** @type {HTMLElement} */ (target)).focus({ preventScroll: true });
  });
  on(doc, 'ds:config', () => { if (shown) { errors = reconcile(); render(); } });

  return {
    get() { return detail(); },
    /**
     * Shows the page's own problems (a server's answer): fields by element or id, with their words.
     * @param {{ field: Element|string, text: string }[]} problems
     */
    set(problems) {
      custom = new Map();
      for (const item of problems ?? []) {
        const field = typeof item.field === 'string' ? doc?.getElementById(item.field) : item.field;
        if (field && item.text) custom.set(field, String(item.text));
      }
      return show(true);
    },
    validate(options = {}) { return show(options.focus !== false); },
    clear() {
      for (const field of [...marked]) mark(field, false);
      for (const field of controls()) writeHint(field, '');
      custom = new Map();
      hide();
    },
    on(type, fn) {
      const set = listeners[type];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    destroy() {
      listeners.invalid.clear();
      listeners.change.clear();
    },
  };
}

define('errorsummary', {
  attribute: 'data-ds-errorsummary',
  init(el, ctx) {
    return controller(el, ctx.signal);
  },
});

/**
 * An error summary driven from the page; the same controller the
 * attribute path makes.
 * @param {Element} el  the .ds-errorsummary inside its form (or data-ds-errorsummary="<form id>")
 */
export function create(el) {
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const made = controller(el, abort?.signal ?? null);
  const destroy = made.destroy;
  made.destroy = () => {
    destroy();
    abort?.abort();
  };
  return made;
}
