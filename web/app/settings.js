/*
 * Settings: sizes, images, capacity, timeouts and the failover to GitHub
 * in one form whose edited fields are marked and wait in the save bar; the
 * Cloudflare tunnel with its allowed e-mail addresses; the password; the
 * version.
 */
import * as api from './api.js';
import { ctx } from './main.js';
import {
  $, $$, M, esc, icon, head, chip, busyButton, alertHtml, taskSteps, toast, toastError, setError, showFieldErrors, clearErrors,
  day, clock, plural, cpus,
} from './ui.js';

const DS = window.DS;
const savebar = DS.overlay.savebar($('#savebar'), { focusTarget: () => $('#settings-form input') });
const CHANGED = '<span class="ds-field__changed ds-sr"> (changed)</span>';

/* Numbers of the settings: the unit shown and how many stored units one shown unit is. */
const NUMBERS = {
  capacity: [
    ['reservePct', 'Kept for the system', '%', 1, 'A share of every worker\'s CPUs and memory that is never counted as free for a job.'],
    ['cpuSettleSec', 'A new runner holds its CPUs for', 'seconds', 1, 'After its job began. A runner that has just started causes no load yet, so the CPUs of its size stay taken until its job begins and are then let go evenly over this time; afterwards only its real load counts.'],
    ['reserveMemMb', 'Memory kept on top', 'GB', 1024, 'Memory every worker keeps for itself in addition to the share above.'],
    ['minDiskFreeMb', 'Least free disk', 'GB', 1000, 'Below this a worker takes no jobs until the janitor has freed space.'],
    ['mirrorCapMb', 'Registry mirror at most', 'GB', 1000, 'The Docker Hub cache on each worker is emptied when it grows past this.'],
  ],
  timeouts: [
    ['startTimeoutSec', 'A runner must connect within', 'seconds', 1, 'Otherwise it is removed and the job gets a new one, if possible on another worker.'],
    ['idleTimeoutSec', 'An idle runner is removed after', 'minutes', 60, 'A runner whose job was cancelled or taken by another runner.'],
    ['spareGraceSec', 'A runner without a job is kept for', 'seconds', 1, 'Gives GitHub time to hand it a job of the same size before it goes.'],
    ['jobTimeoutSec', 'A job may run at most', 'hours', 3600, 'Then its runner is removed, like the limit of GitHub\'s own runners.'],
    ['noOvertakeSec', 'A waiting job is not overtaken after', 'minutes', 60, 'Smaller jobs may start before a large one that does not fit yet, but only this long.'],
    ['failureThreshold', 'A worker pauses after', 'failed starts', 1, 'In a row. CI-Plane tests it every 30 seconds and takes it back by itself.'],
    ['historyDays', 'Keep finished jobs and events for', 'days', 1, 'Older history is deleted.'],
  ],
  relay: [
    ['relayAfterSec', 'Waiting time', 'minutes', 60, 'How long a job waits for room on your workers before it goes to GitHub. Your workers always come first.'],
    ['relayMax', 'At most', 'runners', 1, 'On GitHub at the same time. Your GitHub plan has its own limit of parallel jobs.'],
  ],
};

/* relay: what GET /api/relay says; setupOpen: whether its setup steps are open; check: the result of the last Check. */
const state = { saved: null, sizes: [], defaultSize: '', uid: 0, relay: null, setupOpen: false, check: null };

function numberField([key, label, unit, scale, hint], s) {
  const value = s[key] / scale;
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '');
  return `<div class="ds-field"><label class="ds-field__label" for="set-${key}">${label}${CHANGED}</label>` +
    `<div class="ds-input-group"><input class="ds-input" id="set-${key}" name="${key}" type="number" inputmode="decimal" step="any" min="0" data-field="${key}" data-scale="${scale}" value="${shown}" aria-describedby="set-${key}-hint">` +
    `<span class="ds-input-group__suffix" aria-hidden="true">${unit}</span></div>` +
    `<small class="ds-field__hint" id="set-${key}-hint">${hint}</small></div>`;
}

function textField(key, label, hint, s) {
  return `<div class="ds-field"><label class="ds-field__label" for="set-${key}">${label}${CHANGED}</label>` +
    `<input class="ds-input" id="set-${key}" name="${key}" autocomplete="off" spellcheck="false" data-field="${key}" value="${esc(s[key])}" aria-describedby="set-${key}-hint">` +
    `<small class="ds-field__hint" id="set-${key}-hint">${hint}</small></div>`;
}

/* ── Failover to GitHub ───────────────────────────────────────────── */

/** The repositories that may be the relay repository: the private ones, and the chosen one in any case. */
function repoOptions(saved, current) {
  const names = state.relay.repos.filter((p) => p.private).map((p) => p.fullName);
  for (const name of [current, saved]) {
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.unshift(name);
  }
  return `<option value=""${saved ? '' : ' selected'}>Choose a repository</option>` +
    names.map((n) => `<option value="${esc(n)}"${n === saved ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

/** Why it switched itself off, and how many jobs run on GitHub now: both move by themselves. */
function relayStatusHtml() {
  const r = state.relay;
  let html = '';
  if (r.off) {
    const reason = /[.!?]$/.test(r.off.reason) ? r.off.reason : `${r.off.reason}.`;
    html += alertHtml('warning', `It switched itself off on ${day(r.off.at)} at ${clock(r.off.at)}`, esc(reason));
  }
  if (r.active > 0) html += `<div class="cp-row">${chip('running', `${plural(r.active, 'job')} on GitHub-hosted runners now`)}</div>`;
  return html;
}

function relayCheckHtml() {
  const c = state.check;
  if (!c) return '';
  if (c.unsaved) return alertHtml('', '', 'Save first: the check looks at the saved repository.');
  if (!c.problems.length) {
    return alertHtml('success', '', `Ready: ${esc(c.repo)} has the relay workflow, and GitHub-hosted runners can reach CI-Plane.` +
      (state.saved.relayEnabled ? '' : ' Switch the failover on and save to use it.'));
  }
  return c.problems.map((p) => `<div class="ds-alert ds-alert--plain ds-tone-warning">${icon('alert', 20)}<span class="ds-alert__text">${esc(p)}</span></div>`).join('');
}

function relayHtml(s) {
  const r = state.relay;
  if (!r || !r.available) return '';
  const sizes = s.sizes.some((z) => z.name === s.relayMaxSize) ? s.sizes : [...s.sizes, { name: s.relayMaxSize }];
  const sizeOptions = sizes.map((z) => `<option value="${esc(z.name)}"${z.name === s.relayMaxSize ? ' selected' : ''}>` +
    `${esc(z.name)}${z.cpus ? `: ${cpus(z.cpus)} CPUs, ${Math.round(z.memMb / 102.4) / 10} GB` : ''}</option>`).join('');
  const noPrivate = !r.repos.some((p) => p.private);
  const file = '.github/workflows/ci-plane-relay.yml';
  return '<section class="ds-card" id="relay-card" aria-labelledby="relay-title"><h2 class="ds-card__title" id="relay-title">Failover to GitHub</h2>' +
    '<p class="ds-muted">When no worker has had room for a job for the waiting time below, CI-Plane starts its runner on a GitHub-hosted machine, through a private relay repository. ' +
      'This uses the GitHub Actions minutes of the repository\'s owner: switch it off when they are used up.</p>' +
    `<div class="ds-stack" id="relay-status"${relayStatusHtml() ? '' : ' hidden'}>${relayStatusHtml()}</div>` +
    `<div class="ds-field"><label class="ds-check"><input type="checkbox" id="set-relayEnabled" name="relayEnabled" data-field="relayEnabled" aria-describedby="set-relayEnabled-hint"${s.relayEnabled ? ' checked' : ''}>` +
      `<span>Send waiting jobs to GitHub-hosted runners${CHANGED}</span></label>` +
      '<small class="ds-field__hint" id="set-relayEnabled-hint">It switches itself off after as many failed starts in a row as a worker may have, for example when the minutes are used up.</small></div>' +
    '<div class="ds-field"><label class="ds-field__label" for="set-relayRepo">Relay repository' + CHANGED + '</label>' +
      `<div class="ds-field__row"><select class="ds-input" id="set-relayRepo" name="relayRepo" data-field="relayRepo" aria-describedby="set-relayRepo-hint">${repoOptions(s.relayRepo, s.relayRepo)}</select>` +
      `${busyButton('ds-btn', 'Check', 'Checking', 'Checked', 'data-act="relay-check"')}</div>` +
      `<small class="ds-field__hint" id="set-relayRepo-hint">${noPrivate ? 'CI-Plane sees no private repository yet: follow the steps below.' : 'A private repository with the relay workflow. Check asks GitHub whether everything is in place.'}</small></div>` +
    `<div class="ds-stack" id="relay-check"${state.check ? '' : ' hidden'}>${relayCheckHtml()}</div>` +
    '<div class="ds-form-grid ds-form-grid--3">' +
      NUMBERS.relay.map((f) => numberField(f, s)).join('') +
      '<div class="ds-field"><label class="ds-field__label" for="set-relayMaxSize">Largest size' + CHANGED + '</label>' +
        `<select class="ds-input" id="set-relayMaxSize" name="relayMaxSize" data-field="relayMaxSize" aria-describedby="set-relayMaxSize-hint">${sizeOptions}</select>` +
        '<small class="ds-field__hint" id="set-relayMaxSize-hint">Larger jobs always wait for a worker. A GitHub-hosted machine of a private repository has 2 CPUs and 7 GB.</small></div>' +
    '</div>' +
    `<details class="ds-collapsible ds-disclosure" id="relay-setup"${state.setupOpen ? ' open' : ''}><summary>Set it up${icon('chevronDown', 20, 'ds-chevron')}</summary><div class="ds-disclosure__body ds-stack">` +
      '<div class="ds-prose ds-prose--dense"><ol>' +
        '<li>Create a <strong>private</strong> repository in the account whose minutes the runners should use, for example <code>ci-plane-relay</code>. It holds nothing but the workflow; it must be private because its runs show the names of your runners.</li>' +
        '<li>Install the GitHub App of that account on it: on the <a href="#/repositories">Repositories</a> page, choose <strong>Choose repositories on GitHub</strong> (or <strong>Install on GitHub</strong>) for that account.</li>' +
        `<li>Add this workflow to the repository as <code>${file}</code> on the default branch.</li>` +
        '<li>Choose the repository above, switch the failover on, save, and press <strong>Check</strong>. It says what is missing, if anything.</li>' +
      '</ol></div>' +
      '<figure class="ds-code"><div class="ds-code__head ds-sm">' +
        `<span class="ds-code__title">${file}</span><span class="ds-code__actions">` +
        `<button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" aria-label="Copy the relay workflow" data-tip="Copy" data-copy="relay-workflow">` +
        `<span class="ds-icon-swap" data-swap="a"><span class="ds-icon-swap__a">${icon('copy', 20)}</span><span class="ds-icon-swap__b">${icon('check', 20)}</span></span></button></span></div>` +
        `<pre class="ds-code-block" id="relay-workflow" tabindex="0" aria-label="The relay workflow, ${file}"><code>${esc(r.workflow)}</code></pre></figure>` +
    '</div></details>' +
    '</section>';
}

function sizeRows() {
  return state.sizes.map((z, i) => `<tr data-ds-key="z${z.uid}" data-size="${i}">` +
    `<td data-label="Name"><input class="ds-input" id="size-${z.uid}-name" aria-label="Name of size ${i + 1}" data-field="sizes.${i}.name" data-size-field="name" value="${esc(z.name)}" autocomplete="off" spellcheck="false"></td>` +
    `<td data-label="Free CPUs to start"><input class="ds-input" id="size-${z.uid}-cpus" type="number" step="0.5" min="0.5" inputmode="decimal" aria-label="Free CPUs that size ${i + 1} needs to start" data-field="sizes.${i}.cpus" data-size-field="cpus" value="${z.cpus}"></td>` +
    `<td data-label="Memory (GB)"><input class="ds-input" id="size-${z.uid}-mem" type="number" step="0.5" min="0.5" inputmode="decimal" aria-label="Memory of size ${i + 1} in GB" data-field="sizes.${i}.memMb" data-size-field="memGb" value="${z.memMb / 1024}"></td>` +
    `<td data-label="Default"><input class="ds-radio-input" type="radio" name="defaultSize" value="${i}" aria-label="Size ${i + 1} is the default"${z.name === state.defaultSize ? ' checked' : ''}></td>` +
    `<td class="ds-table__actions"><button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" data-remove-size="${i}" aria-label="Remove size ${i + 1}" data-tip="Remove">${icon('close', 20)}</button></td></tr>`).join('');
}

function formHtml(s) {
  return '<form class="ds-stack ds-stack--page" id="settings-form" novalidate>' +
    '<section class="ds-card" aria-labelledby="sizes-title"><h2 class="ds-card__title" id="sizes-title">Sizes</h2>' +
      `<p class="ds-muted">A job asks for a size with one more label in runs-on, for example <code>runs-on: [self-hosted, ${esc(s.baseLabel)}, size-l]</code>. A job starts on a worker that has the free CPUs of its size right now and can reserve its memory. The memory is also the limit of the job; the CPUs are not: a job may use every CPU nothing else wants. A job without a size gets the default.</p>` +
      '<div class="ds-table-wrap"><table class="ds-table ds-table--stack"><caption class="ds-sr">Sizes</caption><thead><tr>' +
        '<th scope="col">Name</th><th scope="col">Free CPUs to start</th><th scope="col">Memory (GB)</th><th scope="col">Default</th><th scope="col"><span class="ds-sr">Remove</span></th>' +
      `</tr></thead><tbody id="sizes-body">${sizeRows()}</tbody></table></div>` +
      `<p class="ds-meta" id="sizes-error" hidden></p>` +
      `<button class="ds-btn ds-btn--text ds-add-row" type="button" data-act="add-size">${icon('plus', 16)}Add a size</button>` +
    '</section>' +
    '<section class="ds-card" aria-labelledby="runner-title"><h2 class="ds-card__title" id="runner-title">Runner</h2>' +
      textField('runnerImage', 'Runner image', 'GitHub\'s official image. An image of your own must be built on it.', s) +
      `<details class="ds-collapsible ds-disclosure"><summary>Advanced${icon('chevronDown', 20, 'ds-chevron')}</summary><div class="ds-disclosure__body ds-stack">` +
        textField('dindImage', 'Docker image', 'The Docker daemon each job gets for itself.', s) +
        textField('mirrorImage', 'Registry mirror image', 'The pull-through cache for Docker Hub that runs on every worker.', s) +
        textField('baseLabel', 'Label of CI-Plane', 'The label in runs-on that sends a job to CI-Plane. Every workflow uses it: change it only together with them.', s) +
      '</div></details>' +
    '</section>' +
    '<div class="ds-grid-2">' +
      `<section class="ds-card" aria-labelledby="cap-title"><h2 class="ds-card__title" id="cap-title">Capacity and disk</h2>${NUMBERS.capacity.map((f) => numberField(f, s)).join('')}</section>` +
      `<section class="ds-card" aria-labelledby="time-title"><h2 class="ds-card__title" id="time-title">Timeouts and limits</h2>${NUMBERS.timeouts.map((f) => numberField(f, s)).join('')}</section>` +
    '</div>' +
    relayHtml(s) +
    '</form>';
}

function tunnelHtml(cf) {
  const st = cf.status;
  const task = cf.task && cf.task.state === 'running' ? cf.task : null;
  let body;
  if (task) {
    body = `<div class="ds-card ds-card--filled">${taskSteps(task)}</div>`;
  } else if (!st.configured) {
    body = '<p class="ds-muted">Not set up. Without the tunnel GitHub cannot hand jobs to CI-Plane, and this page is reachable on your network only.</p>' +
      '<div class="cp-row"><a class="ds-btn ds-btn--tonal" href="#/setup?step=2">Set up the tunnel</a></div>';
  } else {
    const chips = [
      st.running ? chip('ok', 'Running', 'check') : chip('error', 'Stopped', 'alertCircle'),
      st.connected ? chip('ok', 'Connected', 'check') : chip('error', 'Not connected', 'wifiOff'),
      st.verified ? chip('ok', 'Checked from outside', 'check') : chip('warning', 'Not checked from outside', 'alert'),
    ].join('');
    body = `<div class="cp-row">${chips}</div>` +
      (st.error ? alertHtml('error', 'The tunnel has a problem', `${esc(st.error)}. Repair it by running the setup again.`) : '') +
      `<ul class="ds-kv-list"><li><span>Public address</span><strong><a href="${esc(st.publicUrl)}" target="_blank" rel="noopener">${esc(st.publicUrl)}</a></strong></li>` +
      `<li><span>Webhooks of GitHub go to</span><strong><code>${esc(st.publicUrl)}/webhook</code></strong></li></ul>` +
      '<form class="ds-form" id="emails-form" novalidate><div class="ds-field"><label class="ds-field__label" for="cf-allowed">Who may sign in from outside</label>' +
        `<textarea class="ds-input" id="cf-allowed" data-field="emails" spellcheck="false" aria-describedby="cf-allowed-hint">${esc(st.emails.join('\n'))}</textarea>` +
        '<small class="ds-field__hint" id="cf-allowed-hint">One e-mail address per line. Cloudflare Access sends them a one-time code; nobody else gets in.</small></div>' +
        `<div class="ds-form-actions">${busyButton('ds-btn', 'Save addresses', 'Saving', 'Saved', 'type="submit"')}</div></form>` +
      '<nav class="ds-card__links" aria-label="Tunnel actions">' +
        `<a class="ds-btn ds-btn--text ds-card__link" href="#/setup?step=2">Repair: run the setup again${icon('arrowRight', 16)}</a>` +
        '<button class="ds-btn ds-btn--text ds-card__link" type="button" data-act="cf-remove">Remove the tunnel ...</button></nav>';
  }
  return '<h2 class="ds-card__title" id="tunnel-title">Cloudflare tunnel</h2>' + body;
}

function passwordHtml() {
  const s = ctx.session;
  if (s.demo) return '<h2 class="ds-card__title">Password</h2><p class="ds-muted">The demo has no password: everybody who opens it is signed in.</p>';
  return '<h2 class="ds-card__title" id="pw-title">Password</h2>' +
    '<p class="ds-muted">The admin password signs you in on the local address. Changing it signs out every other browser.</p>' +
    '<form class="ds-form" id="password-change" novalidate>' +
      '<div class="ds-field"><label class="ds-field__label" for="pw-current">Current password</label><input class="ds-input" id="pw-current" type="password" autocomplete="current-password" data-field="current"></div>' +
      '<div class="ds-field"><label class="ds-field__label" for="pw-next">New password</label><input class="ds-input" id="pw-next" type="password" autocomplete="new-password" data-field="password" aria-describedby="pw-next-hint">' +
        '<small class="ds-field__hint" id="pw-next-hint">At least 10 characters.</small></div>' +
      '<div class="ds-field"><label class="ds-field__label" for="pw-again">Repeat the new password</label><input class="ds-input" id="pw-again" type="password" autocomplete="new-password"></div>' +
      `<div class="ds-form-actions">${busyButton('ds-btn', 'Change password', 'Changing', 'Changed', 'type="submit"')}</div>` +
    '</form>';
}

/* ── The form ─────────────────────────────────────────────────────── */

function takeSaved(settings) {
  state.saved = settings;
  state.sizes = settings.sizes.map((z) => ({ ...z, uid: ++state.uid }));
  state.defaultSize = settings.defaultSize;
}

/* A field's value as typed, and as saved: text and number fields, check boxes, selects. */
const SELECT = (input) => input.tagName === 'SELECT';
const typed = (input) => (input.type === 'checkbox' ? input.checked : input.value);
function initial(input) {
  if (input.type === 'checkbox') return input.defaultChecked;
  if (SELECT(input)) return ([...input.options].find((o) => o.defaultSelected) || input.options[0] || { value: '' }).value;
  return input.defaultValue;
}

/** Makes what a field shows its saved value, so Discard returns to it. */
function settle(input) {
  if (input.type === 'checkbox') input.defaultChecked = input.checked;
  else if (SELECT(input)) for (const o of input.options) o.defaultSelected = o.selected;
  else input.defaultValue = input.value;
}

/** Puts a field back to its saved value. */
function restore(input) {
  if (input.type === 'checkbox') input.checked = input.defaultChecked;
  else if (SELECT(input)) input.value = initial(input);
  else input.value = input.defaultValue;
}

/** Renders the form anew from saved settings; the setup steps stay open or closed as they are. */
function renderForm(settings) {
  const setup = $('#relay-setup');
  if (setup) state.setupOpen = setup.open;
  DS.dom.morphHtml($('#settings-slot'), formHtml(settings));
}

/** The settings as the form shows them now. */
function collect() {
  const s = { ...state.saved };
  for (const input of $$('#settings-form [name][data-field]')) {
    const scale = Number(input.getAttribute('data-scale') || 0);
    if (input.type === 'checkbox') s[input.name] = input.checked;
    else s[input.name] = scale ? Math.round(Number(input.value) * scale) : input.value.trim();
  }
  s.sizes = state.sizes.map(({ name, cpus, memMb }) => ({ name: name.trim().toLowerCase(), cpus, memMb }));
  s.defaultSize = state.defaultSize;
  return s;
}

function readSizes() {
  for (const row of $$('#sizes-body tr')) {
    const z = state.sizes[Number(row.getAttribute('data-size'))];
    if (!z) continue;
    z.name = $('[data-size-field="name"]', row).value;
    z.cpus = Number($('[data-size-field="cpus"]', row).value);
    z.memMb = Math.round(Number($('[data-size-field="memGb"]', row).value) * 1024);
  }
  const def = $('input[name="defaultSize"]:checked');
  if (def && state.sizes[Number(def.value)]) state.defaultSize = state.sizes[Number(def.value)].name;
}

/** Marks edited fields and shows the save bar while anything differs from what is saved. */
function syncChanges() {
  const form = $('#settings-form');
  if (!form) return;
  let changed = 0;
  for (const input of $$('[name][data-field]', form)) {
    const differs = typed(input) !== initial(input);
    input.closest('.ds-field').classList.toggle('ds-field--changed', differs);
    if (differs) changed += 1;
  }
  const saved = JSON.stringify([state.saved.sizes.map(({ name, cpus, memMb }) => [name, cpus, memMb]), state.saved.defaultSize]);
  const now = JSON.stringify([state.sizes.map(({ name, cpus, memMb }) => [name.trim().toLowerCase(), cpus, memMb]), state.defaultSize]);
  if (saved !== now) changed += 1;
  if (!changed) {
    savebar.hide();
    return;
  }
  savebar.update(() => { $('#savebar-text').textContent = changed === 1 ? '1 unsaved change' : `${changed} unsaved changes`; });
  savebar.show();
}

function renderSizes() {
  const body = $('#sizes-body');
  M.flip(body, (morph) => DS.dom.morphHtml(body, sizeRows(), morph), { items: 'tr' });
}

async function save(event) {
  event.preventDefault();
  if (!savebar.shown) return;
  const form = $('#settings-form');
  readSizes();
  clearErrors(form);
  const next = collect();
  let r;
  try {
    r = await M.busy($('#savebar-save'), () => api.put('/api/settings', next));
  } catch (error) {
    const first = showFieldErrors(form, error.fields);
    if (error.fields && error.fields.sizes) toast(error.fields.sizes, { kind: 'error', key: 'settings' });
    else if (error.fields && error.fields.defaultSize) toast(error.fields.defaultSize, { kind: 'error', key: 'settings' });
    else if (!first) toastError(error, 'settings');
    DS.overlay.announce(error.message, { assertive: true });
    return;
  }
  takeSaved(r.settings);
  // Saving switches the failover on again after it switched itself off.
  if (r.settings.relayEnabled && state.relay) state.relay = { ...state.relay, off: null };
  if (state.check && state.check.unsaved) state.check = null;
  renderForm(r.settings);
  // The saved values are the fields' new defaults, so Discard returns to them.
  for (const input of $$('#settings-form [name][data-field]')) settle(input);
  syncChanges();
  DS.overlay.closeToasts(null, { key: 'settings' });
  toast('Settings saved. They apply from the next job on.');
}

$('#savebar-discard').addEventListener('click', () => {
  if (!state.saved) return;
  takeSaved(state.saved);
  renderForm(state.saved);
  for (const input of $$('#settings-form [name][data-field]')) restore(input);
  clearErrors($('#settings-form'));
  syncChanges();
});

/* ── The view ─────────────────────────────────────────────────────── */

export default {
  title: 'Settings',
  topics: ['state', 'tasks'],

  async load() {
    const [settings, cf, relay] = await Promise.all([api.get('/api/settings'), api.get('/api/cloudflare'), api.get('/api/relay')]);
    return { ...settings, cf, relay };
  },

  html(d) {
    takeSaved(d.settings);
    state.relay = d.relay;
    state.check = null;
    // Open while nothing is set up; later it is only in the way.
    state.setupOpen = !d.settings.relayRepo;
    return head('Settings', 'Changes to sizes, images and limits wait in the bar at the bottom until you save them; they apply from the next job on.') +
      `<div id="settings-slot">${formHtml(d.settings)}</div>` +
      '<div class="ds-grid-2">' +
        `<section class="ds-card" id="tunnel-card" aria-labelledby="tunnel-title">${tunnelHtml(d.cf)}</section>` +
        `<section class="ds-card" id="password-card">${passwordHtml()}</section>` +
      '</div>' +
      '<section class="ds-card"><h2 class="ds-card__title">About</h2>' +
        `<ul class="ds-kv-list"><li><span>Version</span><strong>${esc(d.version)}</strong></li>` +
        `<li><span>Signed in</span><strong>${esc(ctx.session.demo ? 'Demo' : ctx.session.via === 'tunnel' ? `${ctx.session.email}, through Cloudflare Access` : 'Admin, with the password')}</strong></li></ul>` +
        '<nav class="ds-card__links" aria-label="About CI-Plane">' +
          `<a class="ds-btn ds-btn--text ds-card__link" href="https://github.com/saschazesiger/CI-Plane#readme" target="_blank" rel="noopener">Documentation${icon('external', 16)}</a>` +
          `<a class="ds-btn ds-btn--text ds-card__link" href="https://github.com/saschazesiger/CI-Plane/issues" target="_blank" rel="noopener">Report a problem${icon('external', 16)}</a>` +
          `<a class="ds-btn ds-btn--text ds-card__link" href="#/setup">Setup assistant${icon('arrowRight', 16)}</a></nav>` +
      '</section>';
  },

  mount(d) {
    const section = ctx.params.get('section');
    if (section === 'cloudflare') $('#tunnel-card').scrollIntoView({ block: 'start' });
    else if (section === 'relay' && $('#relay-card')) $('#relay-card').scrollIntoView({ block: 'start' });
  },

  update(d) {
    // The tunnel and the state of the failover move by themselves; the form keeps what is typed.
    DS.dom.morphHtml($('#tunnel-card'), tunnelHtml(d.cf));
    const repos = (r) => JSON.stringify(r.repos.filter((p) => p.private).map((p) => p.fullName));
    const reposMoved = state.relay && repos(state.relay) !== repos(d.relay);
    state.relay = d.relay;
    if (!$('#relay-card')) return;
    const status = $('#relay-status');
    DS.dom.morphHtml(status, relayStatusHtml());
    status.hidden = !status.firstElementChild;
    const select = $('#set-relayRepo');
    if (reposMoved && select) {
      // A repository the app was just installed on can be chosen without a reload.
      const value = select.value;
      DS.dom.morphHtml(select, repoOptions(state.saved.relayRepo, value));
      select.value = value;
    }
    // The failover switches itself off in the saved settings; follow it, or a save would switch it on again.
    if (d.settings.relayEnabled !== state.saved.relayEnabled) {
      state.saved = { ...state.saved, relayEnabled: d.settings.relayEnabled };
      const box = $('#set-relayEnabled');
      const untouched = box.checked === box.defaultChecked;
      box.defaultChecked = d.settings.relayEnabled;
      if (untouched) box.checked = d.settings.relayEnabled;
      syncChanges();
    }
  },

  leave() {
    savebar.hide();
  },

  async on(type, event) {
    const t = event.target;
    if (type === 'submit') {
      if (t.id === 'settings-form') save(event);
      else if (t.id === 'emails-form') {
        event.preventDefault();
        const button = event.submitter || $('[type="submit"]', t);
        const emails = $('#cf-allowed').value.split(/[\s,;]+/).filter(Boolean);
        clearErrors(t);
        try {
          await M.busy(button, () => api.put('/api/cloudflare/emails', { emails }));
          toast('Saved: only these addresses may sign in from outside.');
        } catch (error) {
          if (!showFieldErrors(t, error.fields)) toastError(error, 'emails');
        }
      } else if (t.id === 'password-change') {
        event.preventDefault();
        const button = event.submitter || $('[type="submit"]', t);
        clearErrors(t);
        if (setError($('#pw-again'), $('#pw-again').value === $('#pw-next').value ? '' : 'The two new passwords are not the same.')) {
          $('#pw-again').focus();
          return;
        }
        try {
          const r = await M.busy(button, () => api.post('/api/password', { current: $('#pw-current').value, password: $('#pw-next').value }));
          t.reset();
          toast(r.message);
        } catch (error) {
          if (!showFieldErrors(t, error.fields)) toastError(error, 'password');
        }
      }
      return;
    }
    if (type === 'input' || type === 'change') {
      if (t.closest('#settings-form')) {
        if (t.closest('#sizes-body')) readSizes();
        syncChanges();
      }
      return;
    }
    if (type !== 'click') return;
    let el;
    if ((el = t.closest('[data-act="relay-check"]'))) {
      const select = $('#set-relayRepo');
      if (select.value !== state.saved.relayRepo) {
        state.check = { unsaved: true };
      } else {
        try {
          const r = await M.busy(el, () => api.post('/api/relay/check'));
          state.check = { problems: r.problems, repo: state.saved.relayRepo };
        } catch (error) {
          toastError(error, 'relay-check');
          return;
        }
      }
      const slot = $('#relay-check');
      DS.dom.morphHtml(slot, relayCheckHtml());
      slot.hidden = false;
      const c = state.check;
      DS.overlay.announce(c.unsaved ? 'Save first: the check looks at the saved repository.'
        : c.problems.length ? c.problems.join(' ') : 'Ready: everything is in place.');
    } else if (t.closest('[data-act="add-size"]')) {
      readSizes();
      state.sizes.push({ name: `size-${state.sizes.length + 1}`, cpus: 2, memMb: 4096, uid: ++state.uid });
      renderSizes();
      syncChanges();
      const rows = $$('#sizes-body input[data-size-field="name"]');
      rows[rows.length - 1].select();
    } else if ((el = t.closest('[data-remove-size]'))) {
      readSizes();
      const i = Number(el.getAttribute('data-remove-size'));
      if (state.sizes.length === 1) {
        toast('Keep at least one size: every job needs one.', { kind: 'info' });
        return;
      }
      const [gone] = state.sizes.splice(i, 1);
      if (gone.name === state.defaultSize) state.defaultSize = state.sizes[0].name;
      renderSizes();
      syncChanges();
    } else if ((el = t.closest('[data-act="cf-remove"]'))) {
      const ok = await DS.overlay.confirm({
        title: 'Remove the tunnel?',
        text: 'CI-Plane deletes the tunnel, its DNS record and the Access applications on Cloudflare and stops cloudflared. GitHub can no longer hand it jobs, and this page is reachable on your network only.',
        confirmLabel: 'Remove the tunnel', destructive: true, opener: el,
        onConfirm: () => api.del('/api/cloudflare'),
        errorText: 'The tunnel could not be removed. Check the API token on Cloudflare and try again.',
      });
      if (ok) toast('The tunnel was removed.');
    }
  },
};
