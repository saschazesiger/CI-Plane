/*
 * Workers and pools: one list grouped by tier, in the order the scheduler
 * uses them. A worker row is dragged by its grip (or moved with the arrow
 * keys on the grip) to reorder it or to move it into another tier; the tier
 * headings are rows too, so passing one changes the tier. A pool (runners
 * of another provider) sits in its tier after the workers; its tier is set
 * in its dialog. Each row has a switch, meters and its state, and opens a
 * side sheet with details and the actions.
 */
import * as api from './api.js';
import { ctx } from './main.js';
import {
  $, $$, M, esc, icon, head, ago, day, clock, span, gb, cpus, plural, chip, workerChip, meter, share, empty,
  switchHtml, busyButton, taskSteps, alertHtml, toast, toastError, setError, showFieldErrors, clearErrors,
  priorityName, priorityOptions, PRIORITY_HINT,
} from './ui.js';

const DS = window.DS;
const MAX_TIER = 9;

/*
 * openId: the worker in the sheet; poolId: the pool in the sheet (or to open);
 * checks: the last check of each pool, kept while the page is open.
 */
const state = { openId: 0, poolId: 0, saving: false, applied: null, sorted: null, checks: new Map() };

const RELAY_FILE = '.github/workflows/ci-plane-relay.yml';

/* The providers of pools: a short name for the row and a glyph. */
const KINDS = {
  github: ['GitHub-hosted', 'cloud'],
  blacksmith: ['Blacksmith', 'wrench'],
  custom: ['Other provider', 'plug'],
};
const kindName = (kind) => (KINDS[kind] || KINDS.custom)[0];
const kindGlyph = (kind) => (KINDS[kind] || KINDS.custom)[1];

function tierNote(tier, first, workers, pools) {
  if (!workers && !pools) return 'Empty: drag a worker here to use it only when the tiers above are full';
  const when = tier === first ? 'Used first' : 'Used when the tiers above are full or off';
  return workers && pools ? `${when}; its workers before its pools` : when;
}

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

function poolChip(p, d) {
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

function poolRowHtml(p, d) {
  const current = state.poolId === p.id && $('#sheet').open ? ' aria-current="true"' : '';
  return `<li class="ds-list__item" data-ds-key="p${p.id}" data-pool="${p.id}"${current}>` +
    `<span class="ds-list__media" aria-hidden="true">${icon(kindGlyph(p.kind), 20)}</span>` +
    `<span class="ds-list__text"><span class="ds-list__title"><button class="ds-list__action" type="button" data-open-pool="${p.id}" id="pool-${p.id}">${esc(p.name)}</button> <span class="ds-tag ds-tone-neutral">${kindName(p.kind)}</span></span>` +
    `<span class="ds-list__meta">${esc(p.repo)} · ${esc(useText(p, true))} · ${esc(machinesText(p))}</span></span>` +
    poolMetersHtml(p) + `<span class="cp-col-status">${poolChip(p, d)}</span>` +
    `<span class="ds-list__actions">${switchHtml({ id: `pool-enable-${p.id}`, attrs: `data-pool-enable="${p.id}"`, label: `${p.name} takes jobs`, checked: p.enabled, srLabel: true })}</span></li>`;
}

const byOrder = (x, y) => x.tier - y.tier || x.position - y.position || x.id - y.id;

function liveText(w) {
  const l = w.live;
  if (!l.connected || !l.at) return { cpu: 0, mem: 0, disk: 0, cpuText: 'No data', memText: 'No data', diskText: 'No data' };
  const mem = share(l.memTotalMb - l.memAvailMb, l.memTotalMb);
  const disk = share(l.diskMb - l.diskFreeMb, l.diskMb);
  return {
    cpu: Math.min(1, l.cpuPct / 100), mem, disk,
    cpuText: `${Math.round(l.cpuPct)} %`, memText: `${Math.round(mem * 100)} %`, diskText: `${Math.round(disk * 100)} %`, diskFree: `${gb(l.diskFreeMb)} free`,
  };
}

function metersHtml(w) {
  const t = liveText(w);
  const one = (label, value, text) => `<span class="cp-meter"><span class="ds-meta">${label} ${esc(text)}</span>${meter(value, `${label} of ${w.name}`, text)}</span>`;
  return `<span class="cp-meters">${one('CPU', t.cpu, t.cpuText)}${one('Memory', t.mem, t.memText)}${one('Disk', t.disk, t.diskText)}</span>`;
}

function rowHtml(w) {
  return `<li class="ds-list__item" data-ds-key="w${w.id}" data-worker="${w.id}">` +
    `<button class="ds-btn ds-btn--quiet ds-btn--icon ds-grip" type="button" aria-label="Move ${esc(w.name)}" aria-describedby="workers-move-hint">${icon('grip', 20)}</button>` +
    `<span class="ds-list__text"><span class="ds-list__title"><button class="ds-list__action" type="button" data-open="${w.id}" id="worker-${w.id}">${esc(w.name)}</button> <span class="ds-tag ds-tone-neutral">Own server</span></span>` +
    `<span class="ds-list__meta">${esc(w.host)} · ${w.cpus || '?'} CPUs · ${w.memMb ? gb(w.memMb) : '? GB'} · ${plural(w.capacity.runners, 'runner')}${w.cpuPriority && w.cpuPriority !== 'normal' ? ` · ${priorityName(w.cpuPriority).toLowerCase()} priority` : ''}</span></span>` +
    metersHtml(w) + `<span class="cp-col-status">${workerChip(w)}</span>` +
    `<span class="ds-list__actions">${switchHtml({ id: `enable-${w.id}`, attrs: `data-enable="${w.id}"`, label: `${w.name} takes jobs`, checked: w.enabled, srLabel: true })}</span></li>`;
}

/**
 * The rows: a heading per tier in use, its workers, then its pools; and the
 * tier after the last worker as a place to drop.
 */
function itemsHtml(d) {
  const { workers } = d;
  const pools = [...d.pools].sort(byOrder);
  const last = workers.reduce((m, w) => Math.max(m, w.tier), 0);
  const tiers = [...new Set([...workers.map((w) => w.tier), ...pools.map((p) => p.tier), Math.min(MAX_TIER, last + 1)])].sort((a, b) => a - b);
  return tiers.map((tier) => {
    const mine = workers.filter((w) => w.tier === tier);
    const theirs = pools.filter((p) => p.tier === tier);
    return `<li class="cp-tier" data-tier="${tier}" data-ds-key="tier-${tier}"><h2 class="ds-card__subtitle">Tier ${tier}</h2>` +
      `<span class="ds-meta">${tierNote(tier, tiers[0], mine.length, theirs.length)}</span></li>` +
      mine.map(rowHtml).join('') + theirs.map((p) => poolRowHtml(p, d)).join('');
  }).join('');
}

/**
 * The tier of every worker row as the list shows it now: the heading above
 * it. Gaps are closed when saving (tiers 1 and 3 become 1 and 2), so an
 * emptied tier never stays behind.
 */
function readOrder(list, compact = true) {
  const rows = [];
  let tier = 0;
  for (const item of $$(':scope > li', list)) {
    if (item.classList.contains('cp-tier')) {
      tier = Number(item.getAttribute('data-tier'));
      continue;
    }
    if (item.hasAttribute('data-worker')) rows.push({ id: Number(item.getAttribute('data-worker')), tier: tier || 1 });
  }
  if (!compact) return rows;
  // The tiers of pools stay as they are; a tier of workers only moves down
  // into a gap, never past a pool, so the order of use stays the same.
  const pooled = new Set((ctx.data?.pools || []).map((p) => p.tier));
  const used = [...new Set([...rows.map((r) => r.tier), ...pooled])].sort((x, y) => x - y);
  const to = new Map();
  let n = 0;
  for (const t of used) {
    n = pooled.has(t) ? t : n + 1;
    to.set(t, n);
  }
  return rows.map((r) => ({ id: r.id, tier: to.get(r.tier) }));
}

function positionText(list, item) {
  const order = readOrder(list, false);
  const id = Number(item?.getAttribute('data-worker'));
  const me = order.find((o) => o.id === id);
  if (!me) return '';
  const inTier = order.filter((o) => o.tier === me.tier);
  return `${item.querySelector('.ds-list__action').textContent}: tier ${me.tier}, position ${inTier.indexOf(me) + 1} of ${inTier.length}`;
}

let saveTimer = 0;

function ensureSortable() {
  const list = $('#workers-list');
  if (!list || state.sorted === list) return;
  state.sorted = list;
  DS.motion.sortable(list, {
    announce: () => positionText(list, list.querySelector('[data-ds-dragging]') || document.activeElement?.closest('li')),
    onChange: () => {
      // Arrow keys move one place per press: save once the moves settle.
      state.saving = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveOrder(list), 600);
    },
  });
}

async function saveOrder(list) {
  const order = readOrder(list).map(({ id, tier }) => ({ id, tier }));
  try {
    await api.post('/api/workers/order', { order });
  } catch (error) {
    toastError(error, 'order');
  } finally {
    state.saving = false;
  }
  ctx.refresh(new Set(['state']));
}

/* ── The side sheet ───────────────────────────────────────────────── */

function runnerChip(r) {
  switch (r.state) {
    case 'provisioning': return chip('running', 'Starting');
    case 'starting': return chip('running', 'Connecting');
    case 'idle': return chip('', 'Idle', 'clock');
    case 'busy': return chip('', 'Running a job', 'play');
    case 'cleaning': return chip('running', 'Cleaning up');
    default: return r.failed ? chip('error', 'Failed', 'alertCircle') : chip('', 'Removed', 'check');
  }
}

function sheetHtml(d) {
  const w = d.worker;
  const c = w.capacity;
  const t = liveText(w);
  const task = w.task && (w.task.state === 'running' || (w.task.state === 'failed' && w.state === 'setup')) ? w.task : null;
  const reason = w.stateReason ? `<p class="ds-muted">${esc(w.stateReason)}</p>` : '';
  const facts = [
    ['Address', `${esc(w.user)}@${esc(w.host)}:${w.port}`],
    ['Tier', `${w.tier} <span class="ds-meta">(position ${w.position + 1})</span>`],
    ['CPU priority', esc(priorityName(w.cpuPriority))],
    ['CPUs', String(w.cpus || '–')],
    ['Memory', w.memMb ? gb(w.memMb) : '–'],
    ['Disk', w.diskMb ? gb(w.diskMb) : '–'],
    ['Docker', esc(w.docker || '–')],
    ['Host key', `<code>${esc(w.hostKey.split(' ')[0] || '–')}</code> <span class="ds-meta">pinned when it was added</span>`],
    ['Added', day(w.createdAt)],
    ['Last seen', w.lastSeenAt ? ago(w.lastSeenAt) : 'never'],
  ];
  const bar = (value) => `<span class="ds-meter${value >= 0.95 ? ' ds-tone-error' : value >= 0.85 ? ' ds-tone-warning' : ''}" aria-hidden="true" style="--ds-share: ${value.toFixed(3)}"></span>`;
  return '<div class="ds-stack">' +
    `<div class="cp-row">${workerChip(w)}</div>${reason}` +
    (task ? `<div class="ds-card ds-card--filled">${taskSteps(task)}${task.state === 'failed' ? `<div class="cp-row">${busyButton('ds-btn', 'Try again', 'Starting', 'Started', `data-act="prepare"`, 'sync')}</div>` : ''}</div>` : '') +
    switchHtml({ id: 'sheet-enable', attrs: `data-enable="${w.id}"`, label: 'Takes jobs', checked: w.enabled, hint: 'Off: no new jobs start here; running jobs finish.' }) +
    '<div class="cp-row">' +
      `<button class="ds-btn" type="button" data-act="drain" aria-describedby="drain-hint">${icon(w.draining ? 'play' : 'pause', 16)}${w.draining ? 'Stop draining' : 'Drain'}</button>` +
      busyButton('ds-btn', 'Clean up now', 'Cleaning up', 'Cleaned up', 'data-act="cleanup"', 'trash') +
      `<button class="ds-btn" type="button" data-act="edit" aria-haspopup="dialog">${icon('pencil', 16)}Edit</button>` +
      `<button class="ds-btn ds-btn--text" type="button" data-act="remove">Remove ...</button>` +
    '</div>' +
    `<p class="ds-meta" id="drain-hint">${w.draining ? 'Draining: running jobs finish, no new ones start. Stop draining to take jobs again.' : 'Drain before maintenance: running jobs finish, no new ones start. Clean up removes leftovers of old runners and unused images.'}</p>` +
    '<h3 class="ds-card__subtitle">Capacity</h3>' +
    '<ul class="ds-kv-list ds-kv-list--bars">' +
      `<li><span>CPUs taken</span><strong>${cpus(c.usedCpus)} of ${cpus(c.cpus)}</strong>${bar(share(c.usedCpus, c.cpus))}</li>` +
      `<li><span>Memory reserved</span><strong>${gb(c.usedMemMb)} of ${gb(c.memMb)}</strong>${bar(share(c.usedMemMb, c.memMb))}</li>` +
      `<li><span>CPU in use now</span><strong>${t.cpuText}</strong>${bar(t.cpu)}</li>` +
      `<li><span>Memory in use now</span><strong>${t.memText}</strong>${bar(t.mem)}</li>` +
      `<li><span>Disk used</span><strong>${t.diskText}${t.diskFree ? `, ${t.diskFree}` : ''}</strong>${bar(t.disk)}</li>` +
    '</ul>' +
    `<p class="ds-meta">CPUs taken: ${cpus(c.busyCpus)} busy right now, whatever uses them, and ${cpus(c.heldCpus)} held for runners that have just started. Memory is reserved by each runner for its size; the rest is kept for the system. A worker takes a job only when the free CPUs and the memory of its size are there.</p>` +
    `<dl class="ds-facts ds-facts--rows">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` +
    '<h3 class="ds-card__subtitle">Latest runners</h3>' +
    (d.runners.length ? `<ul class="ds-list" aria-label="Latest runners">${d.runners.map((r) =>
      `<li class="ds-list__item" data-ds-key="r${r.id}"><span class="ds-list__text"><span class="ds-list__title">${esc(r.repo)}</span>` +
      `<span class="ds-list__meta">${esc(r.size)} · ${esc(r.name)} · ${ago(r.createdAt)}${r.error ? ` · ${esc(r.error)}` : ''}</span></span>${runnerChip(r)}</li>`).join('')}</ul>`
      : '<p class="ds-muted">No runner has started here yet.</p>') +
    '<h3 class="ds-card__subtitle">Recent events</h3>' +
    (d.events.length ? `<ol class="ds-timeline" role="list" aria-label="Recent events of ${esc(w.name)}">${[...d.events].sort((x, y) => y.at - x.at).map((e) =>
      `<li class="ds-timeline__item${e.level === 'info' ? '' : ' ds-timeline__item--icon'}" data-ds-key="e${e.id}">${e.level === 'info' ? '' : `<span class="ds-timeline__marker" aria-hidden="true">${icon('alert', 16)}</span>`}` +
      `<div class="ds-timeline__head"><p class="ds-timeline__title">${esc(e.message)}</p></div>` +
      `<p class="ds-timeline__meta"><time datetime="${new Date(e.at).toISOString()}">${day(e.at)}, ${clock(e.at)}</time></p></li>`).join('')}</ol>`
      : '<p class="ds-muted">Nothing happened here yet.</p>') +
    '</div>';
}

async function openWorker(id, opener) {
  state.openId = id;
  state.poolId = 0;
  try {
    const d = await api.get(`/api/workers/${id}`);
    state.detail = d;
    ctx.openSheet({ title: d.worker.name, subtitle: `${d.worker.host} · tier ${d.worker.tier}`, html: sheetHtml(d), opener });
  } catch (error) {
    state.openId = 0;
    toastError(error, 'worker');
  }
}

async function refreshSheet() {
  if (!state.openId || !$('#sheet').open || ctx.sheetOwner !== view) return;
  try {
    const d = await api.get(`/api/workers/${state.openId}`);
    if (d.worker.id !== state.openId) return;
    state.detail = d;
    $('#sheet-title').textContent = d.worker.name;
    $('#sheet-subtitle').textContent = `${d.worker.host} · tier ${d.worker.tier}`;
    DS.dom.morphHtml(ctx.sheetBody, sheetHtml(d));
  } catch (error) {
    if (error.status === 404) ctx.closeSheet();
  }
}

/* ── Actions ──────────────────────────────────────────────────────── */

async function setEnabled(input) {
  const id = Number(input.getAttribute('data-enable'));
  // Both switches of a worker (row and sheet) show the same.
  for (const other of $$(`[data-enable="${id}"]`, document)) other.checked = input.checked;
  try {
    await api.patch(`/api/workers/${id}`, { enabled: input.checked });
  } catch (error) {
    for (const other of $$(`[data-enable="${id}"]`, document)) other.checked = !input.checked;
    toastError(error, 'enable');
  }
}

function editWorker(opener) {
  const w = state.detail.worker;
  const dialog = $('#worker-dialog');
  const form = $('#worker-form');
  const tiers = Math.min(MAX_TIER, Math.max(...ctx.data.workers.map((o) => o.tier), w.tier) + 1);
  DS.dom.morphHtml($('#worker-tier'), Array.from({ length: tiers }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === w.tier ? ' selected' : ''}>Tier ${n}${n === 1 ? ' (filled first)' : ''}</option>`).join(''));
  DS.dom.morphHtml($('#worker-priority'), priorityOptions(w.cpuPriority));
  $('#worker-priority').value = w.cpuPriority || 'normal';
  $('#worker-priority-hint').textContent = PRIORITY_HINT;
  $('#worker-name').value = w.name;
  setError($('#worker-name'), '');
  form.onsubmit = async (event) => {
    event.preventDefault();
    const name = $('#worker-name').value.trim();
    if (setError($('#worker-name'), name ? '' : 'Give the worker a name.')) {
      $('#worker-name').focus();
      return;
    }
    try {
      await M.busy(event.submitter || $('[type="submit"]', form), () => api.patch(`/api/workers/${w.id}`, {
        name, tier: Number($('#worker-tier').value), cpuPriority: $('#worker-priority').value,
      }));
    } catch (error) {
      if (error.fields && error.fields.name) {
        setError($('#worker-name'), error.fields.name);
        $('#worker-name').focus();
      } else toastError(error, 'edit');
      return;
    }
    DS.overlay.close(dialog);
    toast(`${name} saved.`);
    refreshSheet();
  };
  DS.overlay.open(dialog, { opener });
}

async function removeWorker(opener) {
  const w = state.detail.worker;
  const busy = w.capacity.runners;
  let result = null;
  const ok = await DS.overlay.confirm({
    title: `Remove ${w.name}?`,
    text: busy
      ? `${w.name} still runs ${plural(busy, 'runner')}. Removed now, jobs that wait for one start on another worker, and jobs that run there are lost. To avoid that, drain it first and remove it once it is idle.`
      : `CI-Plane stops using ${w.name} and forgets it. Afterwards you get a command that removes what CI-Plane set up on the server.`,
    confirmLabel: busy ? `Remove ${w.name} anyway` : `Remove ${w.name}`,
    destructive: true,
    opener,
    onConfirm: async () => { result = await api.del(`/api/workers/${w.id}${busy ? '?force=true' : ''}`); },
    errorText: `${w.name} could not be removed. Reload the page and try again.`,
  });
  if (!ok) return;
  state.openId = 0;
  ctx.closeSheet();
  DS.dom.morphHtml($('#removed-command'), `<code>${esc(result.removeCommand)}</code>`);
  $('#removed-title').textContent = `${w.name} was removed`;
  DS.overlay.open($('#removed-dialog'), { returnTo: () => $('h1', ctx.page) });
  ctx.refresh(new Set(['state']));
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
  const c = state.checks.get(p.id);
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

function openPool(id, opener) {
  const p = findPool(id);
  if (!p) {
    toast('This pool does not exist any more.', { kind: 'info' });
    return;
  }
  state.openId = 0;
  state.poolId = id;
  const c = state.checks.get(id);
  ctx.openSheet({ title: p.name, subtitle: `${kindName(p.kind)} · tier ${p.tier}`, html: poolSheetHtml(p, ctx.data, !!(c && c.problems.length)), opener });
  renderList();
}

function refreshPoolSheet() {
  if (!state.poolId || !$('#sheet').open || ctx.sheetOwner !== view) return;
  const p = findPool(state.poolId);
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
  state.checks.set(id, { problems, addUrl: r.addUrl || '' });
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

async function setPoolEnabled(input) {
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
  state.poolId = 0;
  state.checks.delete(p.id);
  ctx.data.pools = ctx.data.pools.filter((o) => o.id !== p.id);
  ctx.closeSheet();
  renderList();
  toast(`${p.name} was removed.`);
  ctx.refresh(new Set(['state']));
}

/* ── Pools: the dialog to add or edit one ─────────────────────────── */

/* pool: the pool being edited, or null; step: 'kind' or 'form'; values: what the form shows. */
const dlg = { pool: null, step: 'kind', kind: '', values: null };

const preset = (kind) => (ctx.data.presets || []).find((x) => x.kind === kind) || { kind, label: kindName(kind), name: '', standard: '', large: '', hint: '', docs: '' };

function valuesFrom(p) {
  return { name: p.name, repo: p.repo, tier: p.tier, afterSec: p.afterSec, max: p.max, standard: p.standard, large: p.large, budgetMin: p.budgetMin };
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
  const repos = (d.repos || []).filter((r) => r.private).map((r) => r.fullName);
  if (v.repo && !repos.includes(v.repo)) repos.unshift(v.repo);
  const repoOptions = `<option value=""${v.repo ? '' : ' selected'}>Choose a repository</option>` +
    repos.map((r) => `<option value="${esc(r)}"${r === v.repo ? ' selected' : ''}>${esc(r)}</option>`).join('');
  const counts = (n) => {
    const w = d.workers.filter((o) => o.tier === n).length;
    const p = d.pools.filter((o) => o.tier === n && (!dlg.pool || o.id !== dlg.pool.id)).length;
    const parts = [w ? plural(w, 'worker') : '', p ? plural(p, 'pool') : ''].filter(Boolean).join(', ');
    return `Tier ${n}${n === 1 ? ', used first' : ''}${parts ? ` (${parts})` : ''}`;
  };
  const tiers = Array.from({ length: MAX_TIER }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === Number(v.tier) ? ' selected' : ''}>${counts(n)}</option>`).join('');
  const wait = Number(v.afterSec) > 0;
  const repoHint = (repos.length ? 'A private repository the GitHub App sees; its owner pays the minutes. Its runs show the names of your runners, so never a public one.'
    : 'CI-Plane sees no private repository yet. Create one, for example ci-plane-relay, and install the GitHub App on it under Repositories.') +
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
    repo: $('#pool-repo').value,
    tier: num('#pool-tier'),
    afterSec: wait ? Math.round(num('#pool-after') * 60) : 0,
    max: num('#pool-max'),
    standard: $('#pool-standard').value.trim(),
    large: $('#pool-large').value.trim(),
    budgetMin: num('#pool-budget'),
  };
}

function openPoolDialog(pool, opener) {
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
      dlg.values = { name: x.name, repo: dlg.values?.repo || '', tier: MAX_TIER, afterSec: 180, max: 5, standard: x.standard, large: x.large, budgetMin: 0 };
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
  state.checks.delete(saved.id);
  renderList();
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

function poolSheetAction(t) {
  const button = t.closest('[data-act]');
  const p = findPool(state.poolId);
  if (!button || !p) return;
  switch (button.getAttribute('data-act')) {
    case 'pool-edit': openPoolDialog(p, button); break;
    case 'pool-check': checkPool(p.id, button); break;
    case 'pool-resume': resumePool(p.id, button); break;
    case 'pool-remove': removePool(p, button); break;
    default:
  }
}

/** Renders the list again from what is known, after a change made here. */
function renderList() {
  const list = $('#workers-list');
  if (list && ctx.data && !state.saving && !list.querySelector('[data-ds-dragging]')) {
    M.flip(list, (morph) => DS.dom.morphHtml(list, itemsHtml(ctx.data), morph));
  }
}

/* ── The view ─────────────────────────────────────────────────────── */

const view = {
  title: 'Workers',
  topics: ['state', 'live', 'tasks'],
  async load(params) {
    const key = params.toString();
    if (key !== state.applied) {
      state.applied = key;
      state.openId = Number(params.get('open')) || 0;
      state.poolId = Number(params.get('pool')) || 0;
    }
    const [w, p] = await Promise.all([api.get('/api/workers'), api.get('/api/pools')]);
    return { ...w, ...p };
  },

  html(d) {
    const action = `<a class="ds-btn ds-btn--filled" href="#/workers/add">${icon('plus', 16)}Add worker</a>` +
      (d.available ? `<button class="ds-btn" type="button" data-act="add-pool" aria-haspopup="dialog">${icon('plus', 16)}Add pool</button>` : '');
    const lead = 'Your servers, and pools of runners from other providers. Tier 1 is used first; inside a tier your workers go first, the least busy one right now gets the job.';
    if (!d.workers.length && !d.pools.length) {
      return head('Workers', lead, action) + `<section class="ds-card">${empty({ glyph: 'server', title: 'No worker yet',
        text: 'A worker is any Linux server CI-Plane reaches over SSH. Its setup is one command.' +
          (d.available ? ' A pool runs jobs on machines of another provider, like GitHub-hosted runners.' : ''),
        action: '<a class="ds-btn ds-btn--tonal" href="#/workers/add">Add the first worker</a>' })}</section>`;
    }
    return head('Workers', lead, action) +
      '<section class="ds-card" aria-labelledby="workers-title">' +
        '<div class="ds-card__row"><h2 class="ds-card__title" id="workers-title">Order of use</h2></div>' +
        '<p class="ds-muted" id="workers-move-hint">Drag a worker by its handle, or focus the handle and use the arrow keys, to change the order or move it to another tier. ' +
          'A pool gets its tier under Edit.</p>' +
        `<ul class="ds-list ds-list--interactive" id="workers-list" aria-label="Workers and pools by tier">${itemsHtml(d)}</ul>` +
      '</section>';
  },

  mount() {
    ensureSortable();
    if (state.poolId) {
      const row = $(`#workers-list [data-pool="${state.poolId}"]`);
      if (row) row.scrollIntoView({ block: 'center' });
      openPool(state.poolId, null);
    } else if (state.openId) openWorker(state.openId, null);
  },

  update(d) {
    const list = $('#workers-list');
    // Never re-order under a drag or before the new order is saved.
    if (list && !state.saving && !list.querySelector('[data-ds-dragging]')) {
      M.flip(list, (morph) => DS.dom.morphHtml(list, itemsHtml(d), morph), { live: true });
    } else if (!list || (!d.workers.length && !d.pools.length)) {
      DS.dom.morphHtml($('#page'), this.html(d));
      ensureSortable();
    }
    if (state.poolId) refreshPoolSheet();
    else refreshSheet();
  },

  sheetClosed() {
    const pool = state.poolId;
    state.openId = 0;
    state.poolId = 0;
    if (pool) renderList();
  },

  on(type, event) {
    const t = event.target;
    if (type === 'click') {
      let el;
      if ((el = t.closest('[data-open]'))) openWorker(Number(el.getAttribute('data-open')), el);
      else if ((el = t.closest('[data-open-pool]'))) openPool(Number(el.getAttribute('data-open-pool')), el);
      else if ((el = t.closest('[data-act="add-pool"]'))) openPoolDialog(null, el);
    } else if (type === 'change' && t.hasAttribute('data-enable')) {
      setEnabled(t);
    } else if (type === 'change' && t.hasAttribute('data-pool-enable')) {
      setPoolEnabled(t);
    }
  },

  async sheet(type, event) {
    const t = event.target;
    if (type === 'change' && t.hasAttribute('data-enable')) {
      setEnabled(t);
      return;
    }
    if (type === 'change' && t.hasAttribute('data-pool-enable')) {
      setPoolEnabled(t);
      return;
    }
    if (type !== 'click') return;
    if (state.poolId) {
      poolSheetAction(t);
      return;
    }
    const button = t.closest('[data-act]');
    if (!button || !state.detail) return;
    const w = state.detail.worker;
    switch (button.getAttribute('data-act')) {
      case 'drain':
        try {
          await api.patch(`/api/workers/${w.id}`, { draining: !w.draining });
          toast(w.draining ? `${w.name} takes jobs again.` : `${w.name} is draining: running jobs finish, no new ones start.`);
          refreshSheet();
        } catch (error) {
          toastError(error, 'drain');
        }
        break;
      case 'cleanup':
        try {
          const r = await M.busy(button, () => api.post(`/api/workers/${w.id}/cleanup`));
          toast(`${w.name}: ${r.message}.`);
        } catch (error) {
          toastError(error, 'cleanup');
        }
        break;
      case 'prepare':
        try {
          await M.busy(button, () => api.post(`/api/workers/${w.id}/prepare`), { done: false });
          refreshSheet();
        } catch (error) {
          toastError(error, 'prepare');
        }
        break;
      case 'edit':
        editWorker(button);
        break;
      case 'remove':
        removeWorker(button);
        break;
      default:
    }
  },
};

export default view;

