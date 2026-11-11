/*
 * Jobs: a table with filter chips, search and pages, rendered through
 * flip() and morphHtml; a side sheet with the facts of one job, why it
 * waits or was ignored, and its timeline.
 */
import * as api from './api.js';
import { ctx } from './main.js';
import { $, $$, M, esc, icon, head, ago, span, clock, day, jobChip, empty, alertHtml, toastError } from './ui.js';

const DS = window.DS;

const CHIPS = [
  ['queued', 'Waiting'],
  ['running', 'Running'],
  ['completed', 'Completed'],
  ['ignored', 'Ignored'],
];

const state = {
  applied: null, // the route parameters the filters were last taken from
  states: new Set(),
  q: '',
  page: 0,
  size: 25,
  openId: 0,
  total: 0,
};

function applyParams(params) {
  const key = params.toString();
  if (key === state.applied) return;
  state.applied = key;
  state.states = new Set((params.get('state') || '').split(',').filter((s) => CHIPS.some(([v]) => v === s)));
  state.q = params.get('q') || '';
  state.page = 0;
  state.openId = Number(params.get('open')) || 0;
}

function query() {
  const p = new URLSearchParams({ limit: String(state.size), offset: String(state.page * state.size) });
  if (state.states.size) p.set('state', [...state.states].join(','));
  if (state.q.trim()) p.set('q', state.q.trim());
  return `/api/jobs?${p}`;
}

function rowHtml(j) {
  return `<tr data-ds-key="j${j.id}">` +
    `<td class="ds-col--text"><button class="ds-link-btn ds-table__row-link" type="button" data-job="${j.id}" id="job-${j.id}">${esc(j.name)}</button>` +
      `<div class="ds-meta">${esc(j.repo)}${j.branch ? ` · ${esc(j.branch)}` : ''}</div></td>` +
    `<td class="ds-col--secondary ds-nowrap">${esc(j.size || '–')}</td>` +
    `<td class="ds-col--secondary ds-nowrap">${esc(j.worker || '–')}</td>` +
    `<td class="ds-num ds-nowrap"><time datetime="${new Date(j.queuedAt).toISOString()}">${ago(j.queuedAt)}</time></td>` +
    `<td>${jobChip(j)}</td></tr>`;
}

function chipsHtml(counts) {
  return CHIPS.map(([value, label]) =>
    `<label class="ds-chip"><input class="ds-chip__input" type="checkbox" name="state" value="${value}"${state.states.has(value) ? ' checked' : ''}>` +
    `<span class="ds-chip__body">${icon('check', 18, 'ds-chip__check')}<span>${label}</span> <span class="ds-badge ds-tone-neutral" data-count="${value}">${counts[value] || ''}</span></span></label>`).join('');
}

function rangeText(total) {
  const start = state.page * state.size;
  return total ? `${start + 1}–${Math.min(total, start + state.size)} of ${total}` : '0 of 0';
}

function paginationInner(total) {
  const last = Math.max(0, Math.ceil(total / state.size) - 1);
  const button = (to, label, glyph, blocked) => `<button class="ds-btn ds-btn--quiet ds-btn--icon" type="button" data-page="${to}" aria-label="${label}" data-tip="${label}"${blocked ? ' aria-disabled="true"' : ''}>${icon(glyph, 20)}</button>`;
  return '<div class="ds-pagination__size"><label class="ds-pagination__label" for="page-size">Rows per page</label>' +
    `<select class="ds-input ds-input--filled" id="page-size">${[25, 50, 100].map((n) => `<option${n === state.size ? ' selected' : ''}>${n}</option>`).join('')}</select></div>` +
    `<p class="ds-pagination__range" aria-live="polite">${rangeText(total)}</p>` +
    button('first', 'First page', 'chevronFirst', state.page === 0) + button('previous', 'Previous page', 'chevronLeft', state.page === 0) +
    button('next', 'Next page', 'chevronRight', state.page >= last) + button('last', 'Last page', 'chevronLast', state.page >= last);
}

function emptyHtml(d) {
  const filtered = state.states.size || state.q.trim();
  if (filtered) {
    return empty({ glyph: 'search', title: 'No job matches', text: 'Try another search or clear the filters.',
      action: '<button class="ds-btn ds-btn--tonal" type="button" data-act="clear">Clear filters</button>' });
  }
  return empty({ glyph: 'activity', title: 'No jobs yet',
    text: 'A job shows up here when a workflow with <code>runs-on: [self-hosted, ci-plane]</code> runs in a connected repository.',
    action: '<a class="ds-btn ds-btn--tonal" href="#/setup?step=5">Show me the workflow line</a>' });
}

function renderRows(d, live = false) {
  const body = $('#jobs-body');
  if (!body) return;
  state.total = d.total;
  for (const badge of $$('[data-count]')) badge.textContent = d.counts[badge.getAttribute('data-count')] || '';
  M.flip(body, (morph) => DS.dom.morphHtml(body, d.jobs.map(rowHtml).join(''), morph), { items: 'tr', live });
  DS.dom.morphHtml($('#jobs-pages'), paginationInner(d.total));
  const slot = $('#jobs-empty');
  const table = $('#jobs-wrap');
  const none = !d.jobs.length;
  table.hidden = none;
  $('#jobs-pages').hidden = none;
  if (none) {
    DS.dom.morphHtml(slot, emptyHtml(d));
    if (slot.hidden) {
      slot.hidden = false;
      M.enter(slot, 'fade');
    }
  } else slot.hidden = true;
}

let searchTimer = 0;

async function reload() {
  try {
    const d = await M.refresh($('#jobs-card'), () => api.get(query()));
    ctx.data = d;
    renderRows(d);
  } catch (error) {
    toastError(error, 'jobs');
  }
}

/* ── The side sheet ───────────────────────────────────────────────── */

const IGNORED_HELP = [
  [/unknown label/, 'CI-Plane runs a job only when every label in runs-on is one it knows. Add the label as a size under Settings, or change runs-on in the workflow.'],
  [/two sizes/, 'A job can ask for one size only. Change runs-on in the workflow.'],
  [/switched off/, 'Switch it on under Repositories; the next job is then run.'],
  [/default size/, 'Choose an existing default size under Settings.'],
];

function eventGlyph(e) {
  if (e.level === 'error') return 'alertCircle';
  if (e.level === 'warn') return 'alert';
  const [group, what] = e.kind.split('.');
  if (group === 'runner') return what === 'removed' ? 'trash' : 'box';
  return { queued: 'clock', assigned: 'server', started: 'play', completed: 'checkCircle', requeued: 'sync', swapped: 'sync' }[what] || 'activity';
}

function timelineHtml(events) {
  let lastDay = '';
  return events.map((e) => {
    const d = day(e.at);
    const group = d !== lastDay ? `<li class="ds-timeline__group" role="presentation"><h4 class="ds-timeline__day">${d}</h4></li>` : '';
    lastDay = d;
    return group + `<li class="ds-timeline__item ds-timeline__item--icon" data-ds-key="e${e.id}"><span class="ds-timeline__marker" aria-hidden="true">${icon(eventGlyph(e), 16)}</span>` +
      `<div class="ds-timeline__head"><p class="ds-timeline__title">${esc(e.message)}</p></div>` +
      `<p class="ds-timeline__meta"><time datetime="${new Date(e.at).toISOString()}">${clock(e.at)}</time></p></li>`;
  }).join('');
}

/** Where the job ran: a link to its worker, or GitHub's machine of the failover, which has no page here. */
function workerFact(j) {
  if (!j.worker) return '–';
  if (j.workerId < 0) return `${esc(j.worker)} <span class="ds-meta">(a machine of GitHub's, through the failover)</span>`;
  return `<a href="#/workers?open=${j.workerId}">${esc(j.worker)}</a>`;
}

function sheetHtml(d) {
  const j = d.job;
  const facts = [
    ['Repository', esc(j.repo)],
    ['Workflow', esc(j.workflow || '–')],
    ['Branch', esc(j.branch || '–')],
    ['runs-on', `<code>${esc((j.labels || []).join(', '))}</code>`],
    ['Size', esc(j.size || '–')],
    ['Worker', workerFact(j)],
    ['Runner', esc(j.runner || '–')],
    ['Queued', `${day(j.queuedAt)}, ${clock(j.queuedAt)}`],
  ];
  if (j.startedAt) facts.push(['Waited', span(j.startedAt - j.queuedAt)]);
  if (j.startedAt && j.completedAt) facts.push(['Ran for', span(j.completedAt - j.startedAt)]);
  else if (j.startedAt && j.state === 'running') facts.push(['Running for', span(Date.now() - j.startedAt)]);
  if (j.attempts > 1) facts.push(['Start attempts', String(j.attempts)]);

  let note = '';
  if (j.state === 'queued') {
    note = alertHtml('', 'Why it waits', esc(j.reason || 'CI-Plane is choosing a worker for it.') +
      ' It starts by itself as soon as a worker has room; nothing needs to be done unless this stays.');
  } else if (j.state === 'ignored') {
    const help = (IGNORED_HELP.find(([re]) => re.test(j.reason)) || [null, 'Change runs-on in the workflow, or adjust the sizes under Settings.'])[1];
    note = alertHtml('warning', 'Not run by CI-Plane', `${esc(j.reason)}. ${esc(help)}`);
  } else if (j.state === 'running' && !j.runnerId && j.reason) {
    note = alertHtml('', 'Runs elsewhere', esc(j.reason));
  }
  return '<div class="ds-stack">' +
    `<div class="cp-row">${jobChip(j)}${j.htmlUrl ? `<a class="ds-btn ds-sm" href="${esc(j.htmlUrl)}" target="_blank" rel="noopener">Open on GitHub${icon('external', 16)}</a>` : ''}</div>` +
    note +
    `<dl class="ds-facts ds-facts--rows">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` +
    '<h3 class="ds-card__subtitle">Timeline</h3>' +
    (d.events.length ? `<ol class="ds-timeline" role="list" aria-label="Timeline of ${esc(j.name)}">${timelineHtml(d.events)}</ol>`
      : '<p class="ds-muted">No events were recorded for this job.</p>') +
    '</div>';
}

async function openJob(id, opener) {
  state.openId = id;
  try {
    const d = await api.get(`/api/jobs/${id}`);
    ctx.openSheet({ title: d.job.name, subtitle: `${d.job.repo} · ${d.job.workflow}`, html: sheetHtml(d), opener });
  } catch (error) {
    state.openId = 0;
    toastError(error, 'job');
  }
}

/* ── The view ─────────────────────────────────────────────────────── */

export default {
  title: 'Jobs',
  topics: ['state'],

  load(params) {
    applyParams(params);
    return api.get(query());
  },

  html(d) {
    return head('Jobs', 'Every job CI-Plane was asked to run. A row opens the job with its timeline.') +
      '<section class="ds-card" id="jobs-card">' +
        '<div class="ds-toolbar"><div class="ds-filters"><div class="ds-field ds-field--grow"><label class="ds-sr" for="jobs-q">Search jobs</label>' +
          `<div class="ds-search">${icon('search', 20)}<input class="ds-input" id="jobs-q" type="search" placeholder="Search repository, job, workflow or branch" value="${esc(state.q)}" autocomplete="off"></div></div></div>` +
          `<fieldset class="ds-chips" id="jobs-chips"><legend class="ds-sr">Show</legend>${chipsHtml(d.counts)}</fieldset></div>` +
        `<div class="ds-table-wrap" id="jobs-wrap"${d.jobs.length ? '' : ' hidden'}><table class="ds-table ds-table--interactive"><caption class="ds-sr">Jobs</caption><thead><tr>` +
          '<th scope="col">Job</th><th scope="col" class="ds-col--secondary">Size</th>' +
          '<th scope="col" class="ds-col--secondary">Worker</th><th scope="col" class="ds-num cp-col-time">Queued</th><th scope="col" class="cp-col-status">Status</th>' +
        `</tr></thead><tbody id="jobs-body">${d.jobs.map(rowHtml).join('')}</tbody></table></div>` +
        `<div id="jobs-empty"${d.jobs.length ? ' hidden' : ''}>${d.jobs.length ? '' : emptyHtml(d)}</div>` +
        `<nav class="ds-pagination" id="jobs-pages" aria-label="Pages of jobs"${d.jobs.length ? '' : ' hidden'}>${paginationInner(d.total)}</nav>` +
      '</section>';
  },

  mount() {
    if (state.openId) openJob(state.openId, null);
  },

  update(d) {
    renderRows(d, true);
    // The same record refreshed: never a transition.
    if (state.openId && $('#sheet').open && ctx.sheetOwner === this) {
      api.get(`/api/jobs/${state.openId}`).then((detail) => {
        if (state.openId === detail.job.id) DS.dom.morphHtml(ctx.sheetBody, sheetHtml(detail));
      }).catch(() => {});
    }
  },

  sheetClosed() {
    state.openId = 0;
  },

  on(type, event) {
    const t = event.target;
    if (type === 'click') {
      let el;
      if ((el = t.closest('[data-job]'))) openJob(Number(el.getAttribute('data-job')), el);
      else if ((el = t.closest('[data-page]'))) {
        if (el.getAttribute('aria-disabled') === 'true') return;
        const last = Math.max(0, Math.ceil(state.total / state.size) - 1);
        const to = el.getAttribute('data-page');
        state.page = to === 'first' ? 0 : to === 'previous' ? Math.max(0, state.page - 1) : to === 'next' ? Math.min(last, state.page + 1) : last;
        reload();
      } else if (t.closest('[data-act="clear"]')) {
        state.states.clear();
        state.q = '';
        state.page = 0;
        $('#jobs-q').value = '';
        for (const box of $$('#jobs-chips input')) box.checked = false;
        reload();
        $('#jobs-q').focus();
      }
    } else if (type === 'change') {
      if (t.name === 'state') {
        if (t.checked) state.states.add(t.value);
        else state.states.delete(t.value);
        state.page = 0;
        reload();
      } else if (t.id === 'page-size') {
        state.size = Number(t.value);
        state.page = 0;
        reload();
      }
    } else if (type === 'input' && t.id === 'jobs-q') {
      state.q = t.value;
      state.page = 0;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(reload, 200);
    }
  },
};
