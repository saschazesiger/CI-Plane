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
import { ps, poolRowHtml, openPool, refreshPoolSheet, poolSheetAction, setPoolEnabled, openPoolDialog } from './pools.js';
import {
  $, $$, M, esc, icon, head, ago, day, clock, span, gb, cpus, plural, chip, workerChip, meter, share, empty,
  switchHtml, busyButton, taskSteps, alertHtml, toast, toastError, setError, showFieldErrors, clearErrors,
  priorityName, priorityOptions, PRIORITY_HINT,
} from './ui.js';

const DS = window.DS;
const MAX_TIER = 9;

/*
 * openId: the worker in the sheet; the pool in the sheet is ps.poolId (pools.js).
 */
const state = { openId: 0, saving: false, applied: null, sorted: null };

function tierNote(tier, first, workers, pools) {
  if (!workers && !pools) return 'Empty: drag a worker here to use it only when the tiers above are full';
  const when = tier === first ? 'Used first' : 'Used when the tiers above are full or off';
  return workers && pools ? `${when}; its workers before its pools` : when;
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
  ps.poolId = 0;
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
  pools: true, // it shows pools and their sheet
  relist() {
    renderList();
  },
  topics: ['state', 'live', 'tasks'],
  async load(params) {
    const key = params.toString();
    if (key !== state.applied) {
      state.applied = key;
      state.openId = Number(params.get('open')) || 0;
      ps.poolId = Number(params.get('pool')) || 0;
    }
    const [w, p] = await Promise.all([api.get('/api/workers'), api.get('/api/pools')]);
    return { ...w, ...p };
  },

  html(d) {
    const action = `<a class="ds-btn ds-btn--filled" href="#/workers/add">${icon('plus', 16)}Add worker</a>` +
      (d.available ? `<a class="ds-btn" href="#/pools">${icon('cloud', 16)}Pools</a>` : '');
    const lead = 'Your servers, and the pools of runners from other providers (set up under Pools). Tier 1 is used first; inside a tier your workers go first, the least busy one right now gets the job.';
    if (!d.workers.length && !d.pools.length) {
      return head('Workers', lead, action) + `<section class="ds-card">${empty({ glyph: 'server', title: 'No worker yet',
        text: 'A worker is any Linux server CI-Plane reaches over SSH. Its setup is one command.' +
          (d.available ? ' A pool runs jobs on machines of another provider, like GitHub-hosted runners; set one up under Pools.' : ''),
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
    if (ps.poolId) {
      const row = $(`#workers-list [data-pool="${ps.poolId}"]`);
      if (row) row.scrollIntoView({ block: 'center' });
      openPool(ps.poolId, null);
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
    if (ps.poolId) refreshPoolSheet();
    else refreshSheet();
  },

  sheetClosed() {
    const pool = ps.poolId;
    state.openId = 0;
    ps.poolId = 0;
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
    if (ps.poolId) {
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

