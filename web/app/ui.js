/*
 * Small helpers every view uses: markup builders on Dashboard-Style
 * (status chips, page heads, buttons with busy faces, copy buttons, field
 * errors), formatting of times and sizes, and the snackbar.
 */

const DS = window.DS;
export const M = DS.motion;

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const icon = (name, size = 20, className) => DS.icons.icon(DS.icons[name], size, className);
export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/* ── Time and size ─────────────────────────────────────────────────── */

export function ago(ms) {
  if (!ms) return 'never';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** A span of time: "7 s", "3 min", "1 h 20 min". */
export function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const day = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const isoTime = (ms) => new Date(ms).toISOString();

export function gb(mb, digits = 0) {
  const value = mb / 1024;
  return `${value >= 100 || !digits ? Math.round(value) : value.toFixed(digits)} GB`;
}

/** CPU counts as written: 4, 0.5, 28.8. */
export const cpus = (value) => String(Math.round(value * 10) / 10);

/* ── Markup ────────────────────────────────────────────────────────── */

/** A status chip: always an icon (or the spinner) and a word. */
export function chip(kind, label, glyph) {
  const mark = kind === 'running' ? '<span class="ds-spinner ds-status__spinner" aria-hidden="true"></span>' : icon(glyph || 'info', 16);
  return `<span class="ds-status${kind && kind !== 'neutral' ? ` ds-status--${kind}` : ''}">${mark}<span>${esc(label)}</span></span>`;
}

/** The page head: the way back, the title (it takes focus after navigation), the lead and the actions. */
export function head(title, lead, actions = '', back = null) {
  return '<header class="ds-page-head">' +
    (back ? `<a class="ds-btn ds-btn--text ds-btn--sm ds-page-head__back" href="${back.href}">${icon('arrowLeft', 18)}<span class="ds-sr">Back to </span>${esc(back.label)}</a>` : '') +
    `<div class="ds-page-head__row"><div class="ds-page-head__text"><h1 class="ds-page-head__title" tabindex="-1">${esc(title)}</h1>` +
    `<p class="ds-page-head__lead">${lead}</p></div>${actions ? `<div class="ds-page-head__actions">${actions}</div>` : ''}</div></header>`;
}

/** A button with the busy and done faces of DS.motion.busy(). */
export function busyButton(className, label, busyLabel, doneLabel, attributes = '', glyph = '') {
  const type = /\btype=/.test(attributes) ? '' : 'type="button" ';
  return `<button class="${className}" ${type}${attributes}><span class="ds-btn__faces">` +
    `<span class="ds-btn__face">${glyph ? icon(glyph, 16) : ''}${esc(label)}</span>` +
    `<span class="ds-btn__face ds-btn__face--busy" aria-hidden="true"><span class="ds-spinner ds-spinner--sm"></span>${esc(busyLabel)}</span>` +
    `<span class="ds-btn__face ds-btn__face--done" aria-hidden="true">${icon('check', 16)}${esc(doneLabel)}</span></span></button>`;
}

/** A code block with its copy button. */
export function codeWithCopy(id, code, label) {
  return `<div class="ds-field__row ds-field__row--top"><pre class="ds-code-block ds-code-block--wrap cp-grow" id="${id}" tabindex="0" aria-label="${esc(label)}"><code>${esc(code)}</code></pre>` +
    `<button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" aria-label="Copy: ${esc(label)}" data-tip="Copy" data-copy="${id}">` +
    `<span class="ds-icon-swap" data-swap="a"><span class="ds-icon-swap__a">${icon('copy', 20)}</span><span class="ds-icon-swap__b">${icon('check', 20)}</span></span></button></div>`;
}

/** Copies the text of the element a [data-copy] button names; the icon turns into a check for a moment. */
export async function copyFrom(button) {
  const source = document.getElementById(button.getAttribute('data-copy'));
  if (!source) return;
  const text = source.value ?? source.textContent;
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (error) {
    // Without the clipboard API (http on another host): select it, so Ctrl+C works.
    const range = document.createRange();
    range.selectNodeContents(source);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copied = document.execCommand && document.execCommand('copy');
  }
  if (!copied) {
    toast('The text is selected: press Ctrl+C (or Cmd+C) to copy it.', { kind: 'info' });
    return;
  }
  const swap = $('.ds-icon-swap', button);
  if (swap) {
    swap.setAttribute('data-swap', 'b');
    setTimeout(() => swap.setAttribute('data-swap', 'a'), M.motionDuration(swap, '--ds-hold-success') + 600);
  }
  toast('Copied.');
}

export function empty({ glyph = 'box', title, text = '', action = '', done = false, id = '' }) {
  return `<div class="ds-empty${done ? ' ds-empty--done' : ''}"${id ? ` id="${id}"` : ''}${done ? ' role="status"' : ''}>` +
    `<span class="ds-empty__disc" aria-hidden="true">${icon(done ? 'check' : glyph, 24)}</span>` +
    `<p class="ds-empty__title">${esc(title)}</p>${text ? `<p class="ds-empty__text">${text}</p>` : ''}${action}</div>`;
}

export function switchHtml({ attrs = '', label, checked, hint = '', srLabel = false, id }) {
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  return `<label class="ds-switch"><input type="checkbox" role="switch" ${attrs}${checked ? ' checked' : ''} aria-labelledby="${labelId}"${hint ? ` aria-describedby="${hintId}"` : ''}>` +
    `<span class="ds-switch__track" aria-hidden="true"></span><span class="ds-switch__label${srLabel ? ' ds-sr' : ''}" id="${labelId}">${esc(label)}</span>` +
    (hint ? `<small class="ds-switch__hint" id="${hintId}">${esc(hint)}</small>` : '') +
    '<span class="ds-switch__state" aria-hidden="true"><span class="ds-switch__on">On</span><span class="ds-switch__off">Off</span></span></label>';
}

/** An alert; kind is '', 'success', 'warning' or 'error'. */
export function alertHtml(kind, title, text, actions = '', attrs = '') {
  const glyph = { error: 'alertCircle', warning: 'alert', success: 'checkCircle' }[kind] || 'info';
  const role = kind === 'error' ? ' role="alert"' : '';
  return `<div class="ds-alert${kind ? ` ds-alert--${kind}` : ''}"${role} ${attrs}>${icon(glyph, 20)}<div class="ds-alert__text">` +
    (title ? `<p class="ds-alert__title">${esc(title)}</p>` : '') + (text ? `<p>${text}</p>` : '') + '</div>' +
    (actions ? `<div class="ds-alert__actions">${actions}</div>` : '') + '</div>';
}

/** The steps of a task as .ds-tasks: done, running, failed. */
export function taskSteps(task) {
  if (!task) return '';
  const steps = task.steps || [];
  const items = steps.map((step, index) => {
    const last = index === steps.length - 1;
    let status = 'done';
    if (last && task.state === 'running') status = 'running';
    if (last && task.state === 'failed') status = 'failed';
    const mark = status === 'running' ? '<span class="ds-spinner ds-spinner--sm"></span>' : icon(status === 'failed' ? 'alertCircle' : 'checkCircle', 20);
    const word = { done: 'done', running: 'running', failed: 'failed' }[status];
    return `<li class="ds-tasks__item" data-status="${status}" data-ds-key="s${index}"><span class="ds-tasks__mark">${mark}</span>` +
      `<span class="ds-tasks__text">${esc(step.text)}<span class="ds-sr">: ${word}</span></span></li>`;
  });
  if (!steps.length && task.state === 'running') {
    items.push('<li class="ds-tasks__item" data-status="running" data-ds-key="s0"><span class="ds-tasks__mark"><span class="ds-spinner ds-spinner--sm"></span></span><span class="ds-tasks__text">Starting<span class="ds-sr">: running</span></span></li>');
  }
  const count = task.state === 'running' ? `Step ${Math.max(steps.length, 1)}` : task.state === 'done' ? 'Done' : 'Stopped';
  return `<div class="ds-tasks__head"><h3 class="ds-card__title">${esc(task.title)}</h3><p class="ds-meta">${count}</p></div>` +
    `<ol class="ds-tasks" aria-label="Steps of: ${esc(task.title)}">${items.join('')}</ol>` +
    (task.state === 'failed' ? alertHtml('error', 'This did not work', esc(task.error)) : '') +
    (task.state === 'done' && task.message ? alertHtml('success', '', esc(task.message)) : '');
}

/* ── Feedback ──────────────────────────────────────────────────────── */

export function toast(text, options = {}) {
  return DS.overlay.toast(null, text, options);
}

export function toastError(error, key) {
  return DS.overlay.toast(null, error?.message || String(error), { kind: 'error', key });
}

/** aria-invalid and an error hint with its icon, linked by aria-describedby. */
export function setError(input, message) {
  if (!input) return false;
  const id = `${input.id}-error`;
  const hint = document.getElementById(id);
  const described = (input.getAttribute('aria-describedby') || '').split(' ').filter((token) => token && token !== id);
  if (!message) {
    input.removeAttribute('aria-invalid');
    if (hint) hint.remove();
    if (described.length) input.setAttribute('aria-describedby', described.join(' '));
    else input.removeAttribute('aria-describedby');
    return false;
  }
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', [...described, id].join(' '));
  if (hint) hint.lastChild.textContent = message;
  else {
    const host = input.closest('.ds-field') || input.parentElement;
    host.insertAdjacentHTML('beforeend', `<small class="ds-field__hint ds-field__hint--error" id="${id}">${icon('alertCircle', 16)}<span>${esc(message)}</span></small>`);
  }
  return true;
}

/** Shows the field errors of an ApiError on the inputs named data-field="key"; focuses the first. */
export function showFieldErrors(root, fields, prefix = '') {
  let first = null;
  for (const input of $$('[data-field]', root)) {
    const key = prefix + input.getAttribute('data-field');
    if (setError(input, fields?.[key] || '') && !first) first = input;
  }
  if (first) first.focus();
  return first;
}

export function clearErrors(root) {
  for (const input of $$('[aria-invalid="true"]', root)) setError(input, '');
}

/* ── Domain chips ──────────────────────────────────────────────────── */

const CONCLUSIONS = {
  success: ['ok', 'Succeeded', 'check'],
  failure: ['error', 'Failed', 'alertCircle'],
  cancelled: ['', 'Cancelled', 'ban'],
  timed_out: ['error', 'Timed out', 'clock'],
  skipped: ['', 'Skipped', 'ban'],
};

/** The state of a job in words, with an icon. */
export function jobChip(job) {
  switch (job.state) {
    case 'queued':
      return Date.now() - job.waitingSince > 5 * 60_000 ? chip('warning', 'Waiting', 'clock') : chip('', 'Waiting', 'clock');
    case 'assigned':
      return chip('running', 'Starting');
    case 'running':
      return chip('running', 'Running');
    case 'ignored':
      return chip('', 'Ignored', 'ban');
    default: {
      const [kind, label, glyph] = CONCLUSIONS[job.conclusion] || ['', 'Completed', 'check'];
      return chip(kind, label, glyph);
    }
  }
}

/** The state of a worker in words, with an icon. */
export function workerChip(worker) {
  if (!worker.enabled) return chip('', 'Switched off', 'ban');
  if (worker.task && worker.task.state === 'running') return chip('running', 'Preparing');
  switch (worker.state) {
    case 'online':
      return worker.draining ? chip('', 'Draining', 'clock') : chip('ok', 'Online', 'check');
    case 'unreachable':
      return chip('error', 'Unreachable', 'wifiOff');
    case 'unhealthy':
      return chip('error', 'Unhealthy', 'alertCircle');
    case 'disk-full':
      return chip('warning', 'Disk full', 'hardDrive');
    default:
      if (worker.task && worker.task.state === 'failed') return chip('error', 'Preparation failed', 'alertCircle');
      return chip('warning', 'Not connected', 'wifiOff');
  }
}

/** A share 0..1 for a meter, clamped. */
export const share = (part, whole) => (whole > 0 ? Math.max(0, Math.min(1, part / whole)) : 0);

/** A meter with its tone: warning from 85 %, error from 95 %. */
export function meter(value, label, text) {
  const tone = value >= 0.95 ? ' ds-meter--error' : value >= 0.85 ? ' ds-meter--warning' : '';
  return `<span class="ds-meter${tone}" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(value * 100)}" aria-valuetext="${esc(text)}" style="--ds-share: ${value.toFixed(3)}"></span>`;
}
