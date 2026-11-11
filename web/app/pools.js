/*
 * Pools: runners on machines of other providers (GitHub-hosted runners,
 * Blacksmith, others), started through the relay workflow in a private
 * repository. The page lists the pools and the accounts for runners: GitHub
 * accounts whose app only starts that workflow. They are kept apart from
 * the repository integration: CI-Plane runs no jobs of theirs and registers
 * no runners there. The sheet and the dialog of a pool are shared with the
 * Workers page, which shows the pools in its order of use.
 */
import * as api from './api.js';
import { ctx } from './main.js';
import {
  $, $$, M, esc, icon, head, ago, day, span, plural, chip, meter, share, empty,
  switchHtml, busyButton, alertHtml, toast, toastError, setError, showFieldErrors, clearErrors,
} from './ui.js';

const DS = window.DS;
const MAX_TIER = 9;

/* poolId: the pool in the sheet (or to open); checks: the last check of each pool, kept while the page is open. */
export const ps = { poolId: 0, checks: new Map() };

/** Renders the list of the page that shows the pools again, after a change made here. */
const relist = () => ctx.view && ctx.view.relist && ctx.view.relist();

/** Who starts the runs of a pool: the app of an account. */
function appText(p, d) {
  const r = (d.repos || []).find((x) => x.accountId === p.accountId && x.fullName.toLowerCase() === p.repo.toLowerCase());
  if (r) return r.runners ? `The app of ${r.owner}, an account for runners` : `The app of ${r.owner}, of the repository integration`;
  return p.accountId ? 'An app CI-Plane does not see any more' : 'The app of the repository integration that sees the repository';
}

const RELAY_FILE = '.github/workflows/ci-plane-relay.yml';

/* The providers of pools: a short name for the row and a glyph. */
const KINDS = {
  github: ['GitHub-hosted', 'cloud'],
  blacksmith: ['Blacksmith', 'wrench'],
  custom: ['Other provider', 'plug'],
};
export const kindName = (kind) => (KINDS[kind] || KINDS.custom)[0];
export const kindGlyph = (kind) => (KINDS[kind] || KINDS.custom)[1];


/* ── Pools: what a row and the sheet say ──────────────────────────── */

const hm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const minutes = (sec) => `${Math.round((sec / 60) * 10) / 10} min`;
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
const budgetUsed = (p) => p.budgetMin > 0 && p.usedMin >= p.budgetMin;

/** The first day of next month, when a used-up budget starts again. */
function nextMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

function useText(p, short = false) {
  if (!p.afterSec) return short ? 'at once' : 'As soon as no worker or pool of a lower tier has room';
  return short ? `for jobs waiting ${minutes(p.afterSec)}` : `Only for jobs that have waited ${minutes(p.afterSec)}`;
}

function machinesText(p) {
  return `${p.standard || '–'}${p.large ? ` / large: ${p.large}` : ', no large jobs'}`;
}

export function poolChip(p, d) {
  if (!p.enabled) return chip('', 'Switched off', 'ban');
  if (!d.publicUrl) return chip('error', 'Tunnel not connected', 'wifiOff');
  if (p.paused) return chip('warning', `Paused until ${hm(p.pausedUntil)}`, 'clock');
  if (budgetUsed(p)) return chip('warning', 'Budget used up', 'wallet');
  return chip('ok', 'On', 'check');
}

/** A share without the warning tones: a pool that is full is no problem. */
function plainMeter(value, label, text) {
  return `<span class="ds-meter" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(value * 100)}" aria-valuetext="${esc(text)}" style="--ds-share: ${value.toFixed(3)}"></span>`;
}

function poolMetersHtml(p) {
  const runners = `${p.active} of ${p.max}`;
  const used = p.budgetMin ? `${p.usedMin} of ${p.budgetMin}` : `${p.usedMin}`;
  return '<span class="cp-meters">' +
    `<span class="cp-meter"><span class="ds-meta">Runners ${esc(runners)}</span>${plainMeter(share(p.active, p.max), `Runners of ${p.name} now`, runners)}</span>` +
    `<span class="cp-meter"><span class="ds-meta">Minutes ${esc(used)}</span>${p.budgetMin ? meter(share(p.usedMin, p.budgetMin), `Runner minutes of ${p.name} this month`, `${used} minutes`) : ''}</span>` +
    '<span class="cp-meter"></span></span>';
}

export function poolRowHtml(p, d, withTier = false) {
  const current = ps.poolId === p.id && $('#sheet').open ? ' aria-current="true"' : '';
  return `<li class="ds-list__item" data-ds-key="p${p.id}" data-pool="${p.id}"${current}>` +
    `<span class="ds-list__media" aria-hidden="true">${icon(kindGlyph(p.kind), 20)}</span>` +
    `<span class="ds-list__text"><span class="ds-list__title"><button class="ds-list__action" type="button" data-open-pool="${p.id}" id="pool-${p.id}">${esc(p.name)}</button> <span class="ds-tag ds-tone-neutral">${kindName(p.kind)}</span></span>` +
    `<span class="ds-list__meta">${withTier ? `Tier ${p.tier} · ` : ''}${esc(p.repo)} · ${esc(useText(p, true))} · ${esc(machinesText(p))}</span></span>` +
    poolMetersHtml(p) + `<span class="cp-col-status">${poolChip(p, d)}</span>` +
    `<span class="ds-list__actions">${switchHtml({ id: `pool-enable-${p.id}`, attrs: `data-pool-enable="${p.id}"`, label: `${p.name} takes jobs`, checked: p.enabled, srLabel: true })}</span></li>`;
}

/* ── Pools: the sheet ─────────────────────────────────────────────── */

function workflowHtml(d, open) {
  if (!d.workflow) return '';
  return `<details class="ds-collapsible ds-disclosure" id="pool-workflow"${open ? ' open' : ''}><summary>The relay workflow${icon('chevronDown', 20, 'ds-chevron')}</summary><div class="ds-disclosure__body ds-stack">` +
    `<p class="ds-muted">The pool's repository needs this file as <code>${RELAY_FILE}</code> on its default branch: each of its runs starts one runner on a machine of the provider. Check says whether it is there.</p>` +
    '<figure class="ds-code"><div class="ds-code__head ds-sm">' +
      `<span class="ds-code__title">${RELAY_FILE}</span><span class="ds-code__actions">` +
      '<button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" aria-label="Copy the relay workflow" data-tip="Copy" data-copy="relay-workflow">' +
      `<span class="ds-icon-swap" data-swap="a"><span class="ds-icon-swap__a">${icon('copy', 20)}</span><span class="ds-icon-swap__b">${icon('check', 20)}</span></span></button></span></div>` +
      `<pre class="ds-code-block" id="relay-workflow" tabindex="0" aria-label="The relay workflow, ${RELAY_FILE}"><code>${esc(d.workflow)}</code></pre></figure>` +
    '</div></details>';
}

/** What the last check of a pool found: ready, or what is missing and the way to add the workflow. */
function checkHtml(p) {
  const c = ps.checks.get(p.id);
  if (!c) return '';
  if (!c.problems.length) {
    return alertHtml('success', 'Ready', `${esc(p.repo)} has the relay workflow, and its runs can reach CI-Plane.`);
  }
  const add = c.addUrl ? `<a class="ds-btn ds-btn--text ds-sm" href="${esc(c.addUrl)}" target="_blank" rel="noopener">Add the workflow on GitHub${icon('external', 16)}</a>` : '';
  return alertHtml('warning', `${p.name} is not ready`, c.problems.map((x) => esc(sentence(x))).join('</p><p>'),
    add + busyButton('ds-btn ds-btn--text ds-sm', 'Check again', 'Checking', 'Checked', 'data-act="pool-check"'));
}

function poolSheetHtml(p, d, workflowOpen) {
  let notes = '';
  if (!d.publicUrl) {
    notes += alertHtml('error', 'Cloudflare tunnel not connected', 'The runs of this pool could not reach CI-Plane, so it takes no jobs until the tunnel is up.',
      `<a class="ds-btn ds-btn--text ds-sm" href="#/settings?section=cloudflare">Open the settings${icon('arrowRight', 16)}</a>`);
  }
  if (p.paused) {
    notes += alertHtml('warning', `Pauses until ${hm(p.pausedUntil)}`,
      `${esc(sentence(p.pauseReason || 'A runner did not start'))} CI-Plane tries it again by itself then; if that fails too, it pauses for ${span(p.nextPauseSec * 1000)}.`,
      busyButton('ds-btn ds-btn--text ds-sm', 'Try again now', 'Starting', 'Started', 'data-act="pool-resume"'));
  }
  if (budgetUsed(p)) {
    notes += alertHtml('warning', 'The budget of this month is used up',
      `${p.name} takes no jobs until ${nextMonth()}. Raise the monthly budget to use it before.`);
  }
  const facts = [
    ['Provider', esc(kindName(p.kind))],
    ['Repository', `<a href="https://github.com/${esc(p.repo)}" target="_blank" rel="noopener">${esc(p.repo)}${icon('external', 16)}</a>`],
    ['Started by', esc(appText(p, d))],
    ['Tier', `${p.tier} <span class="ds-meta">(after the workers of tier ${p.tier})</span>`],
    ['Use', esc(useText(p))],
    ['Runners at the same time', String(p.max)],
    ['Machine for standard jobs', `<code>${esc(p.standard)}</code>`],
    ['Machine for large jobs', p.large ? `<code>${esc(p.large)}</code>` : '<span class="ds-muted">None: large jobs never go here</span>'],
    ['Monthly budget', p.budgetMin ? `${p.budgetMin.toLocaleString('en')} minutes` : 'No limit'],
    ['Added', day(p.createdAt)],
  ];
  const used = p.budgetMin ? share(p.usedMin, p.budgetMin) : 0;
  return '<div class="ds-stack">' +
    `<div class="cp-row">${poolChip(p, d)}<span class="ds-tag ds-tone-neutral">${kindName(p.kind)}</span></div>` +
    notes + `<div class="ds-stack" id="pool-check" aria-live="polite">${checkHtml(p)}</div>` +
    switchHtml({ id: 'sheet-pool-enable', attrs: `data-pool-enable="${p.id}"`, label: 'Takes jobs', checked: p.enabled, hint: 'Off: no new runners start here; running jobs finish.' }) +
    '<div class="cp-row">' +
      `<button class="ds-btn" type="button" data-act="pool-edit" aria-haspopup="dialog">${icon('pencil', 16)}Edit</button>` +
      busyButton('ds-btn', 'Check', 'Checking', 'Checked', 'data-act="pool-check"', 'shieldCheck') +
      '<button class="ds-btn ds-btn--text" type="button" data-act="pool-remove">Remove ...</button>' +
    '</div>' +
    '<p class="ds-meta">Check asks GitHub whether the repository has the relay workflow and whether its runs can reach CI-Plane.</p>' +
    '<h3 class="ds-card__subtitle">This month</h3>' +
    '<ul class="ds-kv-list ds-kv-list--bars">' +
      `<li><span>Runners now</span><strong>${p.active} of ${p.max}</strong><span class="ds-meter" aria-hidden="true" style="--ds-share: ${share(p.active, p.max).toFixed(3)}"></span></li>` +
      `<li><span>Runner minutes</span><strong>${p.usedMin.toLocaleString('en')}${p.budgetMin ? ` of ${p.budgetMin.toLocaleString('en')}${budgetUsed(p) ? ', used up' : ''}` : ', no limit'}</strong>` +
        `${p.budgetMin ? `<span class="ds-meter${used >= 1 ? ' ds-tone-error' : used >= 0.85 ? ' ds-tone-warning' : ''}" aria-hidden="true" style="--ds-share: ${used.toFixed(3)}"></span>` : ''}</li>` +
    '</ul>' +
    '<p class="ds-meta">CI-Plane counts the minutes of the runners it starts here itself; the provider\'s bill may round them differently.</p>' +
    `<dl class="ds-facts ds-facts--rows">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` +
    workflowHtml(d, workflowOpen) +
    '</div>';
}

const findPool = (id) => (ctx.data?.pools || []).find((p) => p.id === id);

export function openPool(id, opener) {
  const p = findPool(id);
  if (!p) {
    toast('This pool does not exist any more.', { kind: 'info' });
    return;
  }
  ps.poolId = id;
  const c = ps.checks.get(id);
  ctx.openSheet({ title: p.name, subtitle: `${kindName(p.kind)} · tier ${p.tier}`, html: poolSheetHtml(p, ctx.data, !!(c && c.problems.length)), opener });
  relist();
}

export function refreshPoolSheet() {
  if (!ps.poolId || !$('#sheet').open || !ctx.sheetOwner || !ctx.sheetOwner.pools) return;
  const p = findPool(ps.poolId);
  if (!p) {
    ctx.closeSheet();
    return;
  }
  $('#sheet-title').textContent = p.name;
  $('#sheet-subtitle').textContent = `${kindName(p.kind)} · tier ${p.tier}`;
  DS.dom.morphHtml(ctx.sheetBody, poolSheetHtml(p, ctx.data, !!$('#pool-workflow')?.open));
}

/** Asks GitHub whether a pool would work, and shows what it found in its sheet. */
async function checkPool(id, button) {
  let r;
  try {
    const ask = () => api.post(`/api/pools/${id}/check`);
    r = await (button ? M.busy(button, ask) : ask());
  } catch (error) {
    toastError(error, 'pool-check');
    return;
  }
  const problems = r.problems || [];
  ps.checks.set(id, { problems, addUrl: r.addUrl || '' });
  refreshPoolSheet();
  // Not ready: the workflow is what is missing most of the time.
  if (problems.length && $('#pool-workflow')) $('#pool-workflow').open = true;
  const p = findPool(id);
  const name = p ? p.name : 'The pool';
  DS.overlay.announce(problems.length ? `${name} is not ready. ${problems.join(' ')}` : `${name} is ready.`);
}

async function resumePool(id, button) {
  try {
    await M.busy(button, () => api.post(`/api/pools/${id}/resume`));
    toast('Tried again: the pause is over.');
  } catch (error) {
    toastError(error, 'pool-resume');
  }
  ctx.refresh(new Set(['state']));
}

export async function setPoolEnabled(input) {
  const id = Number(input.getAttribute('data-pool-enable'));
  for (const other of $$(`[data-pool-enable="${id}"]`, document)) other.checked = input.checked;
  try {
    await api.patch(`/api/pools/${id}`, { enabled: input.checked });
  } catch (error) {
    for (const other of $$(`[data-pool-enable="${id}"]`, document)) other.checked = !input.checked;
    toastError(error, 'pool-enable');
  }
}

async function removePool(p, opener) {
  let failed = null;
  const ok = await DS.overlay.confirm({
    title: `Remove ${p.name}?`,
    text: `CI-Plane stops starting runners on ${p.name} and forgets it. The relay workflow stays in ${p.repo} until you delete it there.`,
    confirmLabel: `Remove ${p.name}`,
    destructive: true,
    opener,
    // The server says why it refuses (runners on it right now): show its words.
    onConfirm: async () => {
      try {
        await api.del(`/api/pools/${p.id}`);
      } catch (error) {
        failed = error;
      }
    },
  });
  if (!ok) return;
  if (failed) {
    toastError(failed, 'pool-remove');
    return;
  }
  ps.poolId = 0;
  ps.checks.delete(p.id);
  ctx.data.pools = ctx.data.pools.filter((o) => o.id !== p.id);
  ctx.closeSheet();
  relist();
  toast(`${p.name} was removed.`);
  ctx.refresh(new Set(['state']));
}

/* ── Pools: the dialog to add or edit one ─────────────────────────── */

/* pool: the pool being edited, or null; step: 'kind' or 'form'; values: what the form shows. */
const dlg = { pool: null, step: 'kind', kind: '', values: null };

const preset = (kind) => (ctx.data.presets || []).find((x) => x.kind === kind) || { kind, label: kindName(kind), name: '', standard: '', large: '', hint: '', docs: '' };

function valuesFrom(p) {
  return { name: p.name, accountId: p.accountId, repo: p.repo, tier: p.tier, afterSec: p.afterSec, max: p.max, standard: p.standard, large: p.large, budgetMin: p.budgetMin };
}

function kindStepHtml() {
  const presets = ctx.data.presets || [];
  return '<p class="ds-dialog__text">A pool starts runners on machines of another provider, through a small workflow in one of your private repositories. ' +
      'It takes jobs in its tier like a worker: give it tier 1 to use it first, a high tier to use it only when your workers are full.</p>' +
    '<div class="ds-radios" role="radiogroup" aria-label="Who runs the machines">' +
    presets.map((x) => `<label class="ds-radio"><input type="radio" name="pool-kind" value="${esc(x.kind)}"${x.kind === dlg.kind ? ' checked' : ''}>` +
      `<span><strong>${esc(x.label)}</strong><small>${esc(x.hint)}</small></span></label>`).join('') +
    '</div>';
}

function field(id, key, label, control, hint = '') {
  return `<div class="ds-field"><label class="ds-field__label" for="${id}">${label}</label>${control}` +
    (hint ? `<small class="ds-field__hint" id="${id}-hint">${hint}</small>` : '') + '</div>';
}

function formStepHtml() {
  const v = dlg.values;
  const x = preset(dlg.kind);
  const d = ctx.data;
  // One choice for both: the repository and the app that starts runs in it.
  const key = (accountId, repo) => `${accountId}|${repo}`;
  const chosen = v.repo ? key(v.accountId || 0, v.repo) : '';
  const usable = (d.repos || []).filter((r) => r.private);
  const groups = new Map();
  for (const r of usable) {
    const label = r.runners ? `${r.owner}: account for runners` : `${r.owner}: repository integration`;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(r);
  }
  const option = (value, text) => `<option value="${esc(value)}"${value === chosen ? ' selected' : ''}>${esc(text)}</option>`;
  let repoOptions = `<option value=""${chosen ? '' : ' selected'}>Choose a repository</option>`;
  if (chosen && !usable.some((r) => key(r.accountId, r.fullName) === chosen)) repoOptions += option(chosen, v.repo);
  for (const [label, list] of groups) {
    repoOptions += `<optgroup label="${esc(label)}">${list.map((r) => option(key(r.accountId, r.fullName), r.fullName)).join('')}</optgroup>`;
  }
  const runnerRepos = usable.some((r) => r.runners);
  const counts = (n) => {
    const w = (d.workers || []).filter((o) => o.tier === n).length;
    const p = (d.pools || []).filter((o) => o.tier === n && (!dlg.pool || o.id !== dlg.pool.id)).length;
    const parts = [w ? plural(w, 'worker') : '', p ? plural(p, 'pool') : ''].filter(Boolean).join(', ');
    return `Tier ${n}${n === 1 ? ', used first' : ''}${parts ? ` (${parts})` : ''}`;
  };
  const tiers = Array.from({ length: MAX_TIER }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === Number(v.tier) ? ' selected' : ''}>${counts(n)}</option>`).join('');
  const wait = Number(v.afterSec) > 0;
  const repoHint = (runnerRepos
    ? 'A private repository of an account for runners; its owner pays the minutes. Its runs show the names of your runners, so never a public one.'
    : 'Connect the GitHub account whose minutes the pool should use under Pools, Accounts for runners, and choose a private repository for its app, for example ci-plane-relay.') +
    (dlg.kind === 'blacksmith' ? ' Blacksmith needs a repository of an organisation.' : '');
  const docs = x.docs ? ` <a href="${esc(x.docs)}" target="_blank" rel="noopener">Machines of ${esc(x.label)}${icon('external', 16)}</a>` : '';
  return (x.hint ? alertHtml('', x.label, esc(x.hint) + docs) : '') +
    field('pool-name', 'name', 'Name', `<input class="ds-input" id="pool-name" data-field="name" autocomplete="off" maxlength="40" value="${esc(v.name)}" aria-describedby="pool-name-hint">`,
      'Shown in CI-Plane, on jobs that ran here.') +
    field('pool-repo', 'repo', 'Repository', `<select class="ds-input" id="pool-repo" data-field="repo" aria-describedby="pool-repo-hint">${repoOptions}</select>`, esc(repoHint)) +
    field('pool-tier', 'tier', 'Tier', `<select class="ds-input" id="pool-tier" data-field="tier" aria-describedby="pool-tier-hint">${tiers}</select>`,
      '1 is used first; workers of the same tier go first.') +
    '<fieldset class="ds-fieldset"><legend class="ds-fieldset__legend">Use</legend>' +
      '<div class="ds-radios" role="radiogroup" aria-label="Use">' +
        `<label class="ds-radio"><input type="radio" name="pool-use" value="now"${wait ? '' : ' checked'}><span><strong>As soon as no worker or pool of a lower tier has room</strong>` +
          '<small>With a low tier, this pool is used first: for example to use up free minutes.</small></span></label>' +
        `<label class="ds-radio"><input type="radio" name="pool-use" value="wait"${wait ? ' checked' : ''}><span><strong>Only for jobs that have waited a while</strong>` +
          '<small>For the hours when your workers are full: a job waits for them this long first.</small></span></label>' +
      '</div>' +
      `<div class="ds-field" id="pool-wait-field"${wait ? '' : ' hidden'}><label class="ds-field__label" for="pool-after">Waited at least</label>` +
        `<div class="ds-input-group"><input class="ds-input" id="pool-after" data-field="afterSec" type="number" min="0.5" max="1440" step="any" inputmode="decimal" value="${wait ? Math.round((v.afterSec / 60) * 10) / 10 : 3}">` +
        '<span class="ds-input-group__suffix" aria-hidden="true">minutes</span></div></div>' +
    '</fieldset>' +
    '<div class="ds-form-grid ds-form-grid--2">' +
      field('pool-max', 'max', 'Runners at the same time', `<input class="ds-input" id="pool-max" data-field="max" type="number" min="1" max="100" step="1" inputmode="numeric" value="${esc(v.max)}" aria-describedby="pool-max-hint">`,
        'Your plan with the provider may have a lower limit.') +
      field('pool-budget', 'budgetMin', 'Monthly budget (optional)', `<div class="ds-input-group"><input class="ds-input" id="pool-budget" data-field="budgetMin" type="number" min="0" step="1" inputmode="numeric" value="${v.budgetMin || ''}" placeholder="No limit" aria-describedby="pool-budget-hint"><span class="ds-input-group__suffix" aria-hidden="true">minutes</span></div>`,
        'Runner minutes per calendar month; CI-Plane counts them. Used up, the pool takes no jobs until next month.') +
      field('pool-standard', 'standard', 'Machine for standard jobs', `<input class="ds-input" id="pool-standard" data-field="standard" autocomplete="off" spellcheck="false" value="${esc(v.standard)}" aria-describedby="pool-standard-hint">`,
        'The runs-on label of the machine, like ubuntu-latest.') +
      field('pool-large', 'large', 'Machine for large jobs (optional)', `<input class="ds-input" id="pool-large" data-field="large" autocomplete="off" spellcheck="false" value="${esc(v.large)}" aria-describedby="pool-large-hint">`,
        'Leave it empty, and jobs with the label large never go to this pool.') +
    '</div>';
}

function dialogActionsHtml() {
  const back = !dlg.pool && dlg.step === 'form' ? '<button class="ds-btn ds-btn--text" type="button" data-pool-back>Back</button>' : '';
  const label = dlg.step === 'kind' ? 'Continue' : dlg.pool ? 'Save' : 'Add pool';
  const submit = dlg.step === 'kind'
    ? `<button class="ds-btn ds-btn--filled" type="submit">${label}</button>`
    : busyButton('ds-btn ds-btn--filled', label, 'Saving', 'Saved', 'type="submit"');
  return `${back}<button class="ds-btn ds-btn--text" type="button" data-ds-close>Cancel</button>${submit}`;
}

function renderDialog() {
  $('#pool-dialog-title').textContent = dlg.pool ? `Edit ${dlg.pool.name}` : dlg.step === 'kind' ? 'Add a pool: who runs the machines?' : `Add a pool: ${preset(dlg.kind).label}`;
  DS.dom.morphHtml($('#pool-dialog-body'), dlg.step === 'kind' ? kindStepHtml() : formStepHtml());
  DS.dom.morphHtml($('#pool-dialog-actions'), dialogActionsHtml());
}

/** What the form shows now, as the API takes it. */
function readPoolForm() {
  const num = (id) => Number($(id).value || 0);
  const wait = $('input[name="pool-use"]:checked')?.value === 'wait';
  return {
    name: $('#pool-name').value.trim(),
    kind: dlg.kind,
    accountId: Number($('#pool-repo').value.split('|')[0]) || 0,
    repo: $('#pool-repo').value.split('|').slice(1).join('|'),
    tier: num('#pool-tier'),
    afterSec: wait ? Math.round(num('#pool-after') * 60) : 0,
    max: num('#pool-max'),
    standard: $('#pool-standard').value.trim(),
    large: $('#pool-large').value.trim(),
    budgetMin: num('#pool-budget'),
  };
}

export function openPoolDialog(pool, opener) {
  const first = (ctx.data.presets || [])[0];
  Object.assign(dlg, pool
    ? { pool, step: 'form', kind: pool.kind, values: valuesFrom(pool) }
    : { pool: null, step: 'kind', kind: first ? first.kind : 'github', values: null });
  renderDialog();
  DS.overlay.open($('#pool-dialog'), { opener });
}

async function submitPool(event) {
  event.preventDefault();
  const form = $('#pool-form');
  if (dlg.step === 'kind') {
    const kind = $('input[name="pool-kind"]:checked', form)?.value || dlg.kind;
    if (!dlg.values || kind !== dlg.kind) {
      const x = preset(kind);
      dlg.values = { name: x.name, accountId: dlg.values?.accountId || 0, repo: dlg.values?.repo || '', tier: MAX_TIER, afterSec: 180, max: 5, standard: x.standard, large: x.large, budgetMin: 0 };
    }
    dlg.kind = kind;
    dlg.step = 'form';
    renderDialog();
    $('#pool-name').focus();
    return;
  }
  const body = readPoolForm();
  clearErrors(form);
  let r;
  try {
    r = await M.busy(event.submitter || $('[type="submit"]', form), () => (dlg.pool ? api.patch(`/api/pools/${dlg.pool.id}`, body) : api.post('/api/pools', body)));
  } catch (error) {
    if (!showFieldErrors(form, error.fields)) toastError(error, 'pool');
    DS.overlay.announce(error.message, { assertive: true });
    return;
  }
  const saved = r.pool;
  DS.overlay.close($('#pool-dialog'));
  toast(dlg.pool ? `${saved.name} saved.` : `${saved.name} was added. Checking whether it is ready ...`);
  // The list and the sheet show it at once; the check says whether its repository is ready.
  const d = ctx.data;
  const i = d.pools.findIndex((p) => p.id === saved.id);
  const shown = { active: 0, usedMin: 0, nextPauseSec: 60, ...(i >= 0 ? d.pools[i] : {}), ...saved, paused: false };
  if (i >= 0) d.pools[i] = shown;
  else d.pools.push(shown);
  ps.checks.delete(saved.id);
  relist();
  openPool(saved.id, null);
  await checkPool(saved.id, $('#sheet-body [data-act="pool-check"]'));
  ctx.refresh(new Set(['state']));
}

const poolForm = $('#pool-form');
poolForm.addEventListener('submit', submitPool);
poolForm.addEventListener('change', (event) => {
  if (event.target.name === 'pool-use') $('#pool-wait-field').hidden = event.target.value !== 'wait';
});
poolForm.addEventListener('click', (event) => {
  if (!event.target.closest('[data-pool-back]')) return;
  dlg.values = { ...readPoolForm() };
  dlg.step = 'kind';
  renderDialog();
  $('input[name="pool-kind"]:checked', poolForm)?.focus();
});

export function poolSheetAction(t) {
  const button = t.closest('[data-act]');
  const p = findPool(ps.poolId);
  if (!button || !p) return;
  switch (button.getAttribute('data-act')) {
    case 'pool-edit': openPoolDialog(p, button); break;
    case 'pool-check': checkPool(p.id, button); break;
    case 'pool-resume': resumePool(p.id, button); break;
    case 'pool-remove': removePool(p, button); break;
    default:
  }
}

/* ── Accounts for runners ─────────────────────────────────────────── */

/* connecting: the form to connect an account is open; kind and org: what it shows. */
const ra = { connecting: false, kind: 'user', org: '' };

function connectFormHtml() {
  const org = ra.kind === 'org';
  return '<form class="ds-form" id="ra-form" novalidate>' +
    '<div class="ds-radios ds-radios--tiles" role="radiogroup" aria-label="Whose minutes">' +
      `<label class="ds-radio"><input type="radio" name="ra-kind" value="user"${org ? '' : ' checked'}><span class="ds-radio__icon" aria-hidden="true">${icon('user', 20)}</span>` +
        `<span><strong>My personal account</strong><small>The minutes of the account you are signed in with on GitHub.</small></span><span class="ds-radio__mark" aria-hidden="true">${icon('check', 14)}</span></label>` +
      `<label class="ds-radio"><input type="radio" name="ra-kind" value="org"${org ? ' checked' : ''}><span class="ds-radio__icon" aria-hidden="true">${icon('building', 20)}</span>` +
        `<span><strong>An organisation</strong><small>You need to be an owner of it. Blacksmith needs one.</small></span><span class="ds-radio__mark" aria-hidden="true">${icon('check', 14)}</span></label>` +
    '</div>' +
    (org ? '<div class="ds-field"><label class="ds-field__label" for="ra-org">Name of the organisation</label><div class="ds-input-group">' +
      `<span class="ds-input-group__prefix" aria-hidden="true">github.com/</span><input class="ds-input" id="ra-org" autocomplete="off" spellcheck="false" data-field="org" value="${esc(ra.org)}" aria-describedby="ra-org-hint"></div>` +
      '<small class="ds-field__hint" id="ra-org-hint">As in its address on GitHub, for example acme-labs.</small></div>' : '') +
    '<h3 class="ds-card__subtitle">What happens on GitHub</h3>' +
    '<div class="ds-prose ds-prose--dense"><ol>' +
      `<li>GitHub shows the app CI-Plane prepared for ${org ? 'the organisation' : 'your account'}. Choose <strong>Create GitHub App</strong>.</li>` +
      '<li>GitHub asks where to install it. Choose only the private repository for the relay workflow, for example ci-plane-relay, then <strong>Install</strong>.</li>' +
      '<li>GitHub sends you back here. Add a pool with that repository.</li></ol></div>' +
    '<p class="ds-meta">The app may start and read workflows (Actions: read and write) and nothing else. It has no webhook and no access to runners, so CI-Plane runs no jobs of this account through it.</p>' +
    '<div class="ds-form-actions"><button class="ds-btn ds-btn--text" type="button" data-act="ra-cancel">Cancel</button>' +
      `${busyButton('ds-btn ds-btn--filled', 'Continue on GitHub', 'Preparing', 'Opening', 'type="submit"')}</div>` +
    '</form>';
}

function accountChip(a) {
  if (!a.installationId) return chip('warning', 'Not installed', 'alert');
  if (a.health.lastError) return chip('error', 'Problem', 'alertCircle');
  if (!a.repos.length) return chip('warning', 'No repository', 'alert');
  return chip('ok', 'Ready', 'check');
}

function accountRowHtml(a) {
  const org = a.ownerType === 'Organization';
  const repos = a.repos.map((r) => r.fullName + (r.private ? '' : ' (public)')).join(', ');
  const meta = [`App ${a.slug}`, repos || 'no repository yet', a.pools.length ? `used by ${a.pools.join(', ')}` : 'no pool yet'].join(' · ');
  const install = a.installationId ? 'Choose repositories on GitHub' : 'Install on GitHub';
  return `<li class="ds-list__item" data-ds-key="ra${a.id}">` +
    `<span class="ds-list__media" aria-hidden="true">${icon(org ? 'building' : 'user', 20)}</span>` +
    `<span class="ds-list__text"><span class="ds-list__title">${esc(a.owner)} <span class="ds-tag ds-tone-neutral">${org ? 'Organisation' : 'Personal account'}</span></span>` +
    `<span class="ds-list__meta">${esc(meta)}</span></span>` +
    `<span class="cp-col-status">${accountChip(a)}</span>` +
    '<span class="ds-list__actions">' +
      `<a class="ds-btn ds-btn--quiet ds-btn--icon" href="${esc(a.installUrl)}" aria-label="${esc(install)}: ${esc(a.owner)}" data-tip="${esc(install)}">${icon('external', 18)}</a>` +
      `<button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" data-ra-sync="${a.id}" aria-label="Read the repositories of ${esc(a.owner)} again" data-tip="Read again from GitHub">${icon('refresh', 18)}</button>` +
      `<button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" data-ra-remove="${a.id}" aria-label="Remove ${esc(a.owner)}" data-tip="Remove">${icon('trash', 18)}</button>` +
    '</span></li>';
}

function accountNotes(accounts) {
  let html = '';
  for (const a of accounts) {
    if (!a.installationId) {
      html += alertHtml('warning', `The app of ${esc(a.owner)} is not installed yet`, 'Install it on the private repository that runs the relay workflow; until then its pools start no runners.',
        `<a class="ds-btn ds-btn--text ds-sm" href="${esc(a.installUrl)}">Install on GitHub${icon('external', 16)}</a>`);
    } else if (a.health.lastError) {
      html += alertHtml('warning', `GitHub reports a problem with the app of ${esc(a.owner)}`, esc(sentence(a.health.lastError)));
    }
  }
  return html;
}

function accountsHtml(d) {
  const accounts = d.runnerAccounts || [];
  const intro = '<p class="ds-muted">GitHub accounts whose Actions minutes the pools use. They are kept apart from the repositories: their app may only start the relay workflow, ' +
    'CI-Plane runs no jobs of theirs and registers no runners there. Connect as many as you like, also accounts whose repositories never use CI-Plane.</p>';
  const connect = ra.connecting ? `<div id="ra-connect">${connectFormHtml()}</div>`
    : `<div class="cp-row"><button class="ds-btn" type="button" data-act="ra-connect">${icon('plus', 16)}Connect a GitHub account</button></div>`;
  const list = accounts.length
    ? `<ul class="ds-list" id="ra-list" aria-label="Accounts for runners">${accounts.map(accountRowHtml).join('')}</ul>`
    : (ra.connecting ? '' : `<p class="ds-muted">No account for runners yet.</p>`);
  return '<div class="ds-card__row"><h2 class="ds-card__title" id="ra-title">Accounts for runners</h2></div>' +
    intro + accountNotes(accounts) + list + connect;
}

function rerenderAccounts() {
  const card = $('#ra-card');
  if (card && ctx.data) DS.dom.morphHtml(card, accountsHtml(ctx.data));
}

async function startConnect(button) {
  const form = $('#ra-form');
  clearErrors(form);
  const org = ra.kind === 'org' ? ($('#ra-org').value || '').trim() : '';
  if (ra.kind === 'org' && !org) {
    setError($('#ra-org'), 'Enter the name of the organisation.');
    $('#ra-org').focus();
    return;
  }
  let manifest;
  try {
    manifest = await M.busy(button, () => api.post('/api/runner-accounts/manifest', { org }), { done: false });
  } catch (error) {
    if (!showFieldErrors(form, error.fields)) toastError(error, 'ra');
    return;
  }
  try {
    sessionStorage.setItem('cp-github-from', 'pools');
  } catch (error) {
    // Without storage the return lands on Repositories.
  }
  // GitHub's manifest flow: a form posted to github.com with the manifest as one field.
  const post = document.createElement('form');
  post.method = 'post';
  post.action = /[?&]state=/.test(manifest.action) ? manifest.action : `${manifest.action}${manifest.action.includes('?') ? '&' : '?'}state=${encodeURIComponent(manifest.state)}`;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = manifest.manifest;
  post.append(input);
  post.hidden = true;
  document.body.append(post);
  post.submit();
}

async function syncAccount(id, button) {
  const a = (ctx.data.runnerAccounts || []).find((x) => x.id === id);
  try {
    await M.busy(button, () => api.post(`/api/runner-accounts/${id}/sync`));
    toast(`The repositories of ${a ? a.owner : 'the account'} were read again.`);
  } catch (error) {
    toastError(error, 'ra-sync');
  }
  ctx.refresh(new Set(['state']));
}

async function removeAccount(id, opener) {
  const a = (ctx.data.runnerAccounts || []).find((x) => x.id === id);
  if (!a) return;
  let failed = null;
  let settingsUrl = '';
  const ok = await DS.overlay.confirm({
    title: `Remove ${a.owner}?`,
    text: `CI-Plane forgets the app ${a.slug} and its key. GitHub has no way to delete an app from outside, so CI-Plane then links to its settings, where you delete it.`,
    confirmLabel: `Remove ${a.owner}`,
    destructive: true,
    opener,
    // The server says why it refuses (pools that use the account): show its words.
    onConfirm: async () => {
      try {
        settingsUrl = (await api.del(`/api/runner-accounts/${id}`)).settingsUrl || '';
      } catch (error) {
        failed = error;
      }
    },
  });
  if (!ok) return;
  if (failed) {
    toastError(failed, 'ra-remove');
    return;
  }
  ctx.data.runnerAccounts = ctx.data.runnerAccounts.filter((x) => x.id !== id);
  rerenderAccounts();
  toast(`${a.owner} was removed. Delete its GitHub App on GitHub too.`,
    settingsUrl ? { action: { label: 'Open on GitHub', onClick: () => window.open(settingsUrl, '_blank', 'noopener') } } : {});
  ctx.refresh(new Set(['state']));
}

/* ── The view ─────────────────────────────────────────────────────── */

const byOrder = (x, y) => x.tier - y.tier || x.position - y.position || x.id - y.id;

function poolsListHtml(d) {
  return [...d.pools].sort(byOrder).map((p) => poolRowHtml(p, d, true)).join('');
}

function poolsCardHtml(d) {
  if (!d.pools.length) {
    return empty({ glyph: 'cloud', title: 'No pool yet',
      text: 'A pool runs jobs on machines of another provider, like GitHub-hosted runners: to take the overflow when your workers are full, or to use up free minutes first.' +
        ((d.runnerAccounts || []).length ? '' : ' Connect the GitHub account whose minutes it should use first, below.'),
      action: d.available ? '<button class="ds-btn ds-btn--tonal" type="button" data-act="add-pool" aria-haspopup="dialog">Add the first pool</button>' : '' });
  }
  return '<div class="ds-card__row"><h2 class="ds-card__title" id="pools-title">Pools</h2></div>' +
    '<p class="ds-muted">Each pool is used in its tier, after the workers of that tier; the Workers page shows the whole order.</p>' +
    `<ul class="ds-list ds-list--interactive" id="pools-list" aria-labelledby="pools-title">${poolsListHtml(d)}</ul>`;
}

const view = {
  title: 'Pools',
  pools: true, // it shows pools and their sheet
  async load(params) {
    ps.poolId = Number(params.get('pool')) || 0;
    const [p, a, w] = await Promise.all([api.get('/api/pools'), api.get('/api/runner-accounts'), api.get('/api/workers')]);
    return { ...p, runnerAccounts: a.accounts, workers: w.workers };
  },

  html(d) {
    const action = d.available ? `<button class="ds-btn ds-btn--filled" type="button" data-act="add-pool" aria-haspopup="dialog">${icon('plus', 16)}Add pool</button>` : '';
    const lead = 'Runners on machines of other providers: GitHub-hosted runners, Blacksmith or others. CI-Plane starts each one through a small workflow in a private repository of an account for runners.';
    return head('Pools', lead, action) +
      `<section class="ds-card" id="pools-card" aria-label="Pools">${poolsCardHtml(d)}</section>` +
      `<section class="ds-card" id="ra-card" aria-labelledby="ra-title">${accountsHtml(d)}</section>`;
  },

  mount() {
    if (ps.poolId) openPool(ps.poolId, null);
  },

  update(d) {
    DS.dom.morphHtml($('#pools-card'), poolsCardHtml(d));
    // The connect form keeps what was typed and the focus.
    if (!ra.connecting) rerenderAccounts();
    if (ps.poolId) refreshPoolSheet();
  },

  relist() {
    if (ctx.data) DS.dom.morphHtml($('#pools-card'), poolsCardHtml(ctx.data));
  },

  leave() {
    ra.connecting = false;
  },

  sheetClosed() {
    const pool = ps.poolId;
    ps.poolId = 0;
    if (pool) this.relist();
  },

  on(type, event) {
    const t = event.target;
    if (type === 'submit' && t.id === 'ra-form') {
      event.preventDefault();
      startConnect(event.submitter || $('[type="submit"]', t));
      return;
    }
    if (type === 'change' && t.name === 'ra-kind') {
      ra.kind = t.value;
      DS.dom.morphHtml($('#ra-connect'), connectFormHtml());
      if (ra.kind === 'org') $('#ra-org').focus();
      return;
    }
    if (type === 'input' && t.id === 'ra-org') {
      ra.org = t.value;
      return;
    }
    if (type === 'change' && t.hasAttribute('data-pool-enable')) {
      setPoolEnabled(t);
      return;
    }
    if (type !== 'click') return;
    let el;
    if ((el = t.closest('[data-open-pool]'))) openPool(Number(el.getAttribute('data-open-pool')), el);
    else if ((el = t.closest('[data-act="add-pool"]'))) openPoolDialog(null, el);
    else if ((el = t.closest('[data-ra-sync]'))) syncAccount(Number(el.getAttribute('data-ra-sync')), el);
    else if ((el = t.closest('[data-ra-remove]'))) removeAccount(Number(el.getAttribute('data-ra-remove')), el);
    else if ((el = t.closest('[data-act="ra-connect"]'))) {
      ra.connecting = true;
      rerenderAccounts();
      $('input[name="ra-kind"]:checked')?.focus();
    } else if ((el = t.closest('[data-act="ra-cancel"]'))) {
      ra.connecting = false;
      rerenderAccounts();
      $('[data-act="ra-connect"]')?.focus();
    }
  },

  sheet(type, event) {
    const t = event.target;
    if (type === 'change' && t.hasAttribute('data-pool-enable')) {
      setPoolEnabled(t);
      return;
    }
    if (type === 'click') poolSheetAction(t);
  },
};

export default view;
