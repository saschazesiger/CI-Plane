/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Form wizard (DS.wizard): a form in steps, each checked before the next,
 * Back and Next, and a summary step that lists what was entered, on the
 * Steps component.
 *
 *   <form class="ds-wizard" data-ds-wizard aria-labelledby="report-title">
 *     <ol class="ds-steps ds-wizard__steps" aria-label="Report a problem"></ol>
 *     <section class="ds-wizard__panel" aria-labelledby="s1"><h3 class="ds-wizard__title" id="s1">Device</h3> (fields) </section>
 *     <section class="ds-wizard__panel" data-ds-wizard-optional aria-labelledby="s2"> ... </section>
 *     <section class="ds-wizard__panel" data-ds-wizard-summary aria-labelledby="s3">
 *       <h3 class="ds-wizard__title" id="s3">Review</h3><div class="ds-wizard__summary"></div></section>
 *     <div class="ds-wizard__actions">
 *       <button class="ds-btn ds-wizard__back" type="button">Back</button>
 *       <button class="ds-btn ds-btn--filled ds-wizard__next" type="button">Next</button>
 *       <button class="ds-btn ds-btn--filled ds-wizard__submit" type="submit">Send report</button></div>
 *   </form>
 *
 *   const wizard = DS.get(form, 'wizard');    // or DS.wizard.create(form)
 *   wizard.next(); wizard.back(); wizard.go(2); wizard.get();   // { index, count, step, valid }
 *
 * Next checks the fields of the current step (the constraint validation of
 * the browser, then a cancelable ds:validate for the page's own rules):
 * each invalid field gets aria-invalid and an error hint in words, the
 * first one takes the focus, the step turns to error in the steps, and the
 * count is spoken (the page's own aria-invalid fields included; a refusal
 * that marks none says only "Needs attention"). A valid step turns done and the next one shows; its
 * title takes the focus and "Step 2 of 4: Problem" is spoken. Back never
 * checks. The submit button shows on the last step; a submit (Enter in a
 * field, too) before it moves on instead, and on the last step every step
 * is checked again (the first invalid one opens). The form takes
 * novalidate: the wizard checks.
 *
 * The summary step (data-ds-wizard-summary) lists every step before it:
 * its title with an Edit button, and each named field's label and value
 * (a select's option text, the label of a chosen radio or checkbox, file
 * names, a password as dots, "Not given" when empty), as a .ds-facts
 * list. data-ds-wizard-summary="off" on a field leaves it out;
 * data-ds-wizard-label names it.
 *
 * Strings: wizard* keys of DS.core.config({ strings }).
 *
 * ES2022. No Progressive: features.
 */
import { define, emit, t } from './core.js';
import { enter } from './motion.js';
import { morphHtml } from './dom.js';
import { announce } from './a11y.js';
import { icon, iconElement, alertCircle, check } from './icons.js';

const FIELDS = 'input:not([type="hidden"], [type="button"], [type="submit"], [type="reset"], [type="image"]), select, textarea';

let serial = 0;

/** Text for markup. */
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** An element's text without what only a screen reader hears or what marks it required. */
function textOf(node) {
  if (!node) return '';
  const copy = node.cloneNode(true);
  for (const part of copy.querySelectorAll('.ds-sr, .ds-field__required, .ds-field__optional, svg, input, select, textarea')) part.remove();
  return copy.textContent.replace(/\s+/g, ' ').trim();
}

/**
 * What a step panel is called: data-ds-wizard-label, else its title.
 * @param {Element} panel
 * @returns {string}
 */
function labelOf(panel) {
  return panel.getAttribute('data-ds-wizard-label') || textOf(panel.querySelector('.ds-wizard__title, h1, h2, h3, h4, h5, h6, legend')) || '';
}

/**
 * A field's label as a person reads it: data-ds-wizard-label, its
 * <label>, aria-label, or for a radio or a checkbox of a group, the
 * group's legend or name.
 * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} field
 * @returns {string}
 */
export function fieldLabel(field) {
  const own = field.getAttribute('data-ds-wizard-label');
  if (own) return own;
  const group = groupOf(field);
  if (group) return group.getAttribute('aria-label') || textOf(group.querySelector('legend')) || textOf(field.ownerDocument.getElementById(group.getAttribute('aria-labelledby') ?? ''));
  const labelled = field.getAttribute('aria-labelledby');
  if (labelled) return labelled.split(/\s+/).map((id) => textOf(field.ownerDocument.getElementById(id))).filter(Boolean).join(' ');
  return textOf(field.labels?.[0]) || field.getAttribute('aria-label') || field.name || '';
}

/** The group a radio, or a checkbox that shares its name, answers in. */
function groupOf(field) {
  if (field.type !== 'radio' && field.type !== 'checkbox') return null;
  if (field.type === 'checkbox' && !field.form?.querySelectorAll(`input[type="checkbox"][name=${quoted(field.name)}]`)[1]) return null;
  return field.closest('fieldset, [role="radiogroup"], [role="group"]');
}

/**
 * A field's value as a person reads it: a select's option text, the label
 * of a chosen radio or checkbox (several joined), file names, dots for a
 * password; '' when nothing was given.
 * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} field
 * @param {Element} [scope]  where the radios and checkboxes of a group are (default its form)
 * @returns {string}
 */
export function fieldValue(field, scope) {
  const root = scope ?? field.form ?? field.ownerDocument;
  if (field.tagName === 'SELECT') return [...field.selectedOptions].map((option) => option.textContent.trim()).filter(Boolean).join(', ');
  if (field.type === 'radio' || field.type === 'checkbox') {
    const peers = field.name ? [...root.querySelectorAll(`input[name=${quoted(field.name)}]`)] : [field];
    if (field.type === 'checkbox' && peers.length === 1) return field.checked ? t('wizardYes') : t('wizardNo');
    return peers.filter((peer) => peer.checked).map((peer) => textOf(peer.labels?.[0]) || peer.value).join(', ');
  }
  if (field.type === 'file') return [...(field.files ?? [])].map((file) => file.name).join(', ');
  if (field.type === 'password') return field.value ? '••••••••' : '';
  return field.value.trim();
}

/** A name inside an attribute selector. */
const quoted = (name) => `"${String(name).replace(/["\\]/g, '\\$&')}"`;

function controller(form, signal) {
  const doc = form.ownerDocument;
  const listeners = new Map();
  const panels = [...form.querySelectorAll('.ds-wizard__panel')];
  const steps = form.querySelector('.ds-wizard__steps');
  const back = form.querySelector('.ds-wizard__back');
  const next = form.querySelector('.ds-wizard__next');
  const submit = form.querySelector('.ds-wizard__submit');
  const status = panels.map(() => '');
  let index = Math.max(0, panels.findIndex((panel) => !panel.hidden));
  let errorSerial = 0;

  form.noValidate = true;
  for (const panel of panels) {
    const title = panel.querySelector('.ds-wizard__title');
    if (title && !title.hasAttribute('tabindex')) title.setAttribute('tabindex', '-1');
    if (!panel.id) panel.id = `ds-wizard-${++serial}`;
  }

  const notify = (type, detail, options) => {
    if (signal?.aborted) return true;
    const go = emit(form, type, detail, options);
    for (const fn of listeners.get(type) ?? []) fn(detail);
    return go;
  };

  /* ── The steps list ────────────────────── */

  const renderSteps = () => {
    if (!steps) return;
    const html = panels.map((panel, at) => {
      const label = esc(labelOf(panel));
      const state = status[at];
      const current = at === index;
      const optional = panel.hasAttribute('data-ds-wizard-optional') && !state && !current;
      const attrs = (state === 'error' ? ' data-status="error"' : state === 'done' ? ' data-status="done"' : optional ? ' data-status="optional"' : '') + (current ? ' aria-current="step"' : '');
      const mark = state === 'error' ? icon(alertCircle, 16) : state === 'done' ? icon(check, 16) : String(at + 1);
      const read = state === 'done' ? `<span class="ds-sr">, ${esc(t('wizardDone'))}</span>` : '';
      const hint = state === 'error' ? `<span class="ds-steps__hint">${esc(t('wizardFix'))}</span>` : optional ? `<span class="ds-steps__hint">${esc(t('optional'))}</span>` : '';
      return `<li class="ds-steps__step"${attrs}><span class="ds-steps__mark">${mark}</span><span class="ds-steps__label">${label}${read}</span>${hint}</li>`;
    }).join('');
    morphHtml(steps, html);
    if (steps.classList.contains('ds-steps--bar')) steps.setAttribute('aria-label', t('wizardStepOf', { index: index + 1, count: panels.length }));
  };

  /* ── Errors ────────────────────────────── */

  const clearError = (field) => {
    const id = field.getAttribute('data-ds-wizard-error');
    if (!id) return;
    doc.getElementById(id)?.remove();
    field.removeAttribute('data-ds-wizard-error');
    field.removeAttribute('aria-invalid');
    const rest = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((name) => name && name !== id);
    if (rest.length) field.setAttribute('aria-describedby', rest.join(' '));
    else field.removeAttribute('aria-describedby');
  };

  const showError = (field, message, peers) => {
    const id = `ds-wizard-error-${++errorSerial}`;
    const hint = doc.createElement('small');
    hint.className = 'ds-field__hint ds-field__hint--error ds-wizard__error';
    hint.id = id;
    hint.append(iconElement(alertCircle, 16, '', doc), doc.createTextNode(message));
    const group = groupOf(field);
    const holder = group ?? field.closest('.ds-field');
    if (holder) holder.append(hint);
    else (field.closest('label') ?? field).after(hint);
    for (const peer of peers) {
      peer.setAttribute('data-ds-wizard-error', id);
      peer.setAttribute('aria-invalid', 'true');
      peer.setAttribute('aria-describedby', [...(peer.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean), id].join(' '));
    }
  };

  const fieldsOf = (panel) => [...panel.querySelectorAll(FIELDS)].filter((field) => field.willValidate !== false && !field.disabled);

  /** Checks one step; shows the errors only with `report`. */
  const checkStep = (at, report = true) => {
    const panel = panels[at];
    if (!panel || panel.hasAttribute('data-ds-wizard-summary')) return true;
    const fields = fieldsOf(panel);
    for (const field of fields) clearError(field);
    const invalid = [];
    const done = new Set();
    for (const field of fields) {
      if (done.has(field) || field.checkValidity()) continue;
      const peers = (field.type === 'radio' || field.type === 'checkbox') && field.name
        ? fields.filter((other) => other.name === field.name && other.type === field.type)
        : [field];
      for (const peer of peers) done.add(peer);
      invalid.push(field);
      if (report) showError(field, field.validationMessage || t('valueRequired'), peers);
    }
    const page = notify('validate', { index: at, panel, invalid }, { cancelable: true });
    return !invalid.length && page;
  };

  /* ── Moving ────────────────────────────── */

  const show = (to, direction, focus = true) => {
    const from = index;
    index = to;
    panels.forEach((panel, at) => {
      panel.hidden = at !== to;
    });
    if (panels[to].hasAttribute('data-ds-wizard-summary')) renderSummary(panels[to]);
    const last = to === panels.length - 1;
    if (back) back.hidden = to === 0;
    if (next) next.hidden = last;
    if (submit) submit.hidden = !last;
    renderSteps();
    if (from !== to) enter(panels[to], 'swap');
    if (focus && from !== to) {
      (panels[to].querySelector('.ds-wizard__title') ?? panels[to]).focus({ preventScroll: false });
      announce(t('wizardStep', { index: to + 1, count: panels.length, label: labelOf(panels[to]) }));
    }
    if (from !== to) notify('step', { index: to, from, direction, panel: panels[to] });
  };

  const fail = (at) => {
    status[at] = 'error';
    if (at !== index) show(at, 'back');
    else renderSteps();
    // The invalid controls, the page's own included (a refusal through
    // ds:validate): a radio or checkbox group counts once, and so does a
    // group marked invalid as a whole.
    const marked = [...panels[at].querySelectorAll('[aria-invalid="true"]')];
    const outer = marked.filter((node) => !marked.some((other) => other !== node && other.contains(node)));
    const count = new Set(outer.map((node) => ((node.type === 'radio' || node.type === 'checkbox') && node.name ? `${node.type}:${node.name}` : node))).size;
    outer[0]?.focus();
    // A refusal that marks no field: the page says why; the step says it needs attention.
    announce(count === 0 ? t('wizardFix') : count === 1 ? t('wizardError') : t('wizardErrors', { count }), { assertive: true });
  };

  const goTo = (to, direction) => {
    const target = Math.min(panels.length - 1, Math.max(0, to));
    if (target === index) return true;
    if (target > index) {
      for (let at = index; at < target; at += 1) {
        if (!checkStep(at)) {
          fail(at);
          return false;
        }
        status[at] = 'done';
      }
    }
    show(target, direction ?? (target > index ? 'forward' : 'back'));
    return true;
  };

  /* ── The summary ───────────────────────── */

  function renderSummary(panel) {
    const holder = panel.querySelector('.ds-wizard__summary');
    if (!holder) return;
    const at = panels.indexOf(panel);
    const html = panels.slice(0, at).filter((step) => !step.hasAttribute('data-ds-wizard-summary')).map((step) => {
      const seen = new Set();
      const rows = [];
      for (const field of step.querySelectorAll(FIELDS)) {
        if (field.getAttribute('data-ds-wizard-summary') === 'off' || field.disabled) continue;
        const key = (field.type === 'radio' || field.type === 'checkbox') && field.name ? `${field.type}:${field.name}` : field;
        if (seen.has(key)) continue;
        seen.add(key);
        const label = fieldLabel(field);
        if (!label) continue;
        const value = fieldValue(field, form);
        rows.push(`<div><dt>${esc(label)}</dt><dd${value ? '' : ' class="ds-muted"'}>${esc(value || t('wizardEmpty'))}</dd></div>`);
      }
      const name = labelOf(step);
      const stepAt = panels.indexOf(step);
      return `<section class="ds-wizard__group" data-ds-key="${esc(step.id)}"><div class="ds-wizard__group-head"><h4 class="ds-wizard__group-title">${esc(name)}</h4>` +
        `<button class="ds-btn ds-btn--text ds-sm ds-wizard__edit" type="button" data-ds-wizard-go="${stepAt}" aria-label="${esc(t('wizardEdit', { label: name }))}">${esc(t('wizardEditShort'))}</button></div>` +
        `<dl class="ds-facts ds-facts--rows">${rows.join('')}</dl></section>`;
    }).join('');
    morphHtml(holder, html);
  }

  /* ── Events ────────────────────────────── */

  back?.addEventListener('click', () => goTo(index - 1, 'back'), { signal });
  next?.addEventListener('click', () => goTo(index + 1, 'forward'), { signal });

  form.addEventListener('click', (event) => {
    const edit = event.target.closest?.('[data-ds-wizard-go]');
    if (!edit || !form.contains(edit)) return;
    goTo(Number(edit.getAttribute('data-ds-wizard-go')), 'back');
  }, { signal });

  // Before the page's own submit handlers (the target's capture listeners run first).
  form.addEventListener('submit', (event) => {
    if (index < panels.length - 1) {
      event.preventDefault();
      event.stopImmediatePropagation();
      goTo(index + 1, 'forward');
      return;
    }
    for (let at = 0; at < panels.length; at += 1) {
      if (checkStep(at)) continue;
      event.preventDefault();
      event.stopImmediatePropagation();
      fail(at);
      return;
    }
    status[index] = 'done';
  }, { signal, capture: true });

  // A corrected field loses its error at once; its step leaves the error state with the last one.
  const recheck = (event) => {
    const field = event.target;
    if (!field?.hasAttribute?.('data-ds-wizard-error')) return;
    const peers = (field.type === 'radio' || field.type === 'checkbox') && field.name
      ? [...form.querySelectorAll(`[name=${quoted(field.name)}][data-ds-wizard-error]`)]
      : [field];
    if (!field.checkValidity()) return;
    for (const peer of peers) clearError(peer);
    const at = panels.findIndex((panel) => panel.contains(field));
    if (status[at] === 'error' && !panels[at].querySelector('[aria-invalid="true"]')) {
      status[at] = '';
      renderSteps();
    }
  };
  form.addEventListener('input', recheck, { signal });
  form.addEventListener('change', recheck, { signal });

  show(index, 'forward', false);

  return {
    get() {
      return { index, count: panels.length, step: labelOf(panels[index]), panel: panels[index], status: [...status] };
    },
    set(to) {
      return goTo(Number(to));
    },
    go(to) {
      return goTo(Number(to));
    },
    next() {
      return goTo(index + 1, 'forward');
    },
    back() {
      return goTo(index - 1, 'back');
    },
    validate(at = index) {
      const ok = checkStep(at);
      if (!ok) fail(at);
      return ok;
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    destroy() {
      listeners.clear();
    },
  };
}

define('wizard', {
  attribute: 'data-ds-wizard',
  init(el, ctx) {
    return controller(el, ctx.signal);
  },
});

/**
 * A wizard driven from the page; the same controller the attribute path
 * makes.
 * @param {HTMLFormElement} form
 */
export function create(form) {
  const handle = new AbortController();
  const api = controller(form, handle.signal);
  const destroy = api.destroy;
  api.destroy = () => {
    handle.abort();
    destroy();
  };
  return api;
}
