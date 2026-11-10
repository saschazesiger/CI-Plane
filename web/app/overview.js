/*
 * Overview: key figures that count on (countUp), alerts that come and go
 * with the data (flip), the capacity of every worker with live meters,
 * what runs now and the latest events. Everything refreshes live.
 */
import * as api from './api.js';
import { $, M, esc, icon, head, ago, span, plural, gb, cpus, jobChip, workerChip, share, empty } from './ui.js';

const DS = window.DS;

const TILES = [
  { key: 'running', glyph: 'play', label: 'Running', href: '#/jobs?state=running', value: (d) => d.running + d.starting,
    note: (d) => (d.starting ? `${d.starting} starting` : d.running ? 'Jobs on a runner now' : 'Nothing runs right now') },
  { key: 'queued', glyph: 'clock', label: 'Queued', href: '#/jobs?state=queued', value: (d) => d.queued,
    note: (d) => (d.queued ? `The oldest waits ${span(Date.now() - d.oldestQueued)}` : 'Nothing waits') },
  { key: 'workers', glyph: 'server', label: 'Workers online', href: '#/workers', value: (d) => d.workersOnline,
    note: (d) => `of ${d.workersTotal}${d.workersOff ? `, ${d.workersOff} switched off` : ''}` },
  { key: 'wait', glyph: 'history', label: 'Median wait', href: '#/jobs?state=completed', value: (d) => Math.round(d.medianWaitMs / 1000),
    format: (v) => span(v * 1000), empty: (d) => !d.waitSamples,
    note: (d) => (d.waitSamples ? `Over ${plural(d.waitSamples, 'job')}, last 24 h` : 'No job started in the last 24 h') },
];

function tileValue(tile, d) {
  if (tile.empty && tile.empty(d)) return '<span class="ds-tile__value ds-tile__value--empty" data-tile="' + tile.key + '">No data</span>';
  const v = tile.value(d);
  return `<span class="ds-tile__value" data-tile="${tile.key}" data-value="${v}">${esc(tile.format ? tile.format(v) : v)}</span>`;
}

function tileItems(d) {
  return TILES.map((tile) =>
    `<a class="ds-tile" href="${tile.href}" data-ds-key="tile-${tile.key}"><span class="ds-tile__label">${icon(tile.glyph, 20)}<span>${tile.label}</span></span>` +
    `${tileValue(tile, d)}<span class="ds-tile__note" data-tile-note="${tile.key}">${esc(tile.note(d))}</span></a>`).join('');
}

const tilesHtml = (d) => `<div class="ds-tiles" id="tiles">${tileItems(d)}</div>`;

function alertsHtml(alerts) {
  return alerts.map((a) => {
    const kind = { error: 'error', warning: 'warning' }[a.level] || '';
    const glyph = { error: 'alertCircle', warning: 'alert' }[a.level] || 'info';
    const action = a.action
      ? `<div class="ds-alert__actions"><a class="ds-btn ds-btn--text ds-btn--sm" href="${esc(a.action.href)}"${a.action.external ? ' target="_blank" rel="noopener"' : ''}>${esc(a.action.label)}${a.action.external ? icon('external', 16) : ''}</a></div>`
      : '';
    return `<div class="ds-alert${kind ? ` ds-alert--${kind}` : ''}" data-ds-key="${esc(a.key)}">${icon(glyph, 20)}` +
      `<div class="ds-alert__text"><p class="ds-alert__title">${esc(a.title)}</p><p>${esc(a.text)}</p></div>${action}</div>`;
  }).join('');
}

function capacityHtml(workers) {
  if (!workers.length) {
    return empty({ glyph: 'server', title: 'No worker yet', text: 'Add a server with Docker; CI-Plane starts the runners there.',
      action: '<a class="ds-btn ds-btn--tonal" href="#/workers/add">Add a worker</a>' });
  }
  return `<div class="cp-capacity" id="capacity">${capacityItems(workers)}</div>`;
}

function capacityItems(workers) {
  return workers.map((w) => {
    const c = w.capacity;
    const cpuShare = share(c.usedCpus, c.cpus);
    const memShare = share(c.usedMemMb, c.memMb);
    const load = w.live.connected ? w.live.cpuPct / 100 : 0;
    const bar = (value) => {
      const tone = value >= 0.95 ? ' ds-meter--error' : value >= 0.85 ? ' ds-meter--warning' : '';
      return `<span class="ds-meter${tone}" aria-hidden="true" style="--ds-share: ${value.toFixed(3)}"></span>`;
    };
    return `<section class="ds-card ds-card--filled" data-ds-key="cap-${w.id}" aria-labelledby="cap-${w.id}-title">` +
      `<div class="ds-card__row"><h3 class="ds-card__subtitle" id="cap-${w.id}-title"><a href="#/workers?open=${w.id}">${esc(w.name)}</a></h3>${workerChip(w)}</div>` +
      '<ul class="ds-kv-list ds-kv-list--bars">' +
        `<li><span>CPUs</span><strong>${cpus(c.usedCpus)} of ${cpus(c.cpus)}</strong>${bar(cpuShare)}</li>` +
        `<li><span>Memory</span><strong>${gb(c.usedMemMb)} of ${gb(c.memMb)}</strong>${bar(memShare)}</li>` +
        `<li><span>Busy now</span><strong>${w.live.connected ? `${Math.round(w.live.cpuPct)} %` : 'No data'}</strong>${bar(load)}</li>` +
      '</ul>' +
      `<p class="ds-meta">Tier ${w.tier} · ${plural(c.runners, 'runner')}${w.draining ? ' · draining' : ''}</p></section>`;
  }).join('');
}

function openHtml(open) {
  if (!open.length) {
    return `<div id="open-empty">${empty({ glyph: 'play', title: 'Nothing runs right now', text: 'Jobs show up here as soon as GitHub queues them.' })}</div>`;
  }
  return `<ul class="ds-list ds-list--interactive" id="open" aria-label="Running and waiting jobs">${openItems(open)}</ul>`;
}

function openItems(open) {
  return open.map((j) =>
    `<li class="ds-list__item" data-ds-key="j${j.id}">${icon(j.state === 'queued' ? 'clock' : 'play', 20, 'ds-list__icon')}` +
    `<span class="ds-list__text"><span class="ds-list__title"><a class="ds-list__action" href="#/jobs?open=${j.id}">${esc(j.name)}</a></span>` +
    `<span class="ds-list__meta">${esc(j.repo)} · ${esc(j.size || 'no size')}${j.worker ? ` · ${esc(j.worker)}` : ''}</span></span>` +
    `${jobChip(j)}</li>`).join('');
}

function eventGlyph(e) {
  if (e.level === 'error') return 'alertCircle';
  if (e.level === 'warn') return 'alert';
  const [group, what] = e.kind.split('.');
  if (group === 'worker') return 'server';
  if (group === 'runner') return 'box';
  return { queued: 'clock', assigned: 'server', started: 'play', completed: 'checkCircle', ignored: 'ban' }[what] || 'activity';
}

export function activityHtml(events) {
  return events.map((e) =>
    `<li class="ds-timeline__item ds-timeline__item--icon" data-ds-key="e${e.id}"><span class="ds-timeline__marker" aria-hidden="true">${icon(eventGlyph(e), 16)}</span>` +
    `<div class="ds-timeline__head"><p class="ds-timeline__title">${esc(e.message)}</p></div>` +
    `<p class="ds-timeline__meta"><time datetime="${new Date(e.at).toISOString()}">${ago(e.at)}</time>` +
    `${e.subject ? ` · <a class="ds-link--quiet" href="${esc(e.href)}">${esc(e.subject)}</a>` : ''}</p></li>`).join('');
}

function activityCard(d) {
  return '<section class="ds-card"><h2 class="ds-card__title">Recent activity</h2>' +
    (d.activity.length
      ? `<ol class="ds-timeline" id="activity" role="list" aria-label="Recent activity">${activityHtml(d.activity)}</ol>`
      : empty({ glyph: 'activity', title: 'Nothing happened yet', text: 'Every step CI-Plane takes is listed here.' })) +
    '</section>';
}

export default {
  title: 'Overview',
  topics: ['state', 'live'],
  load: () => api.get('/api/overview'),

  html(d) {
    return head('Overview', 'What CI-Plane does right now. Figures, meters and the activity update live.') +
      `<div class="ds-stack" id="alerts"${d.alerts.length ? '' : ' hidden'}>${alertsHtml(d.alerts)}</div>` +
      tilesHtml(d) +
      `<section class="ds-card"><div class="ds-card__row"><h2 class="ds-card__title">Capacity</h2><a class="ds-btn ds-btn--text ds-btn--sm" href="#/workers">All workers</a></div>` +
        '<p class="ds-muted">CPUs and memory: what the runners of each worker reserve, of what it can give. Busy now: its real CPU use.</p>' +
        `<div id="capacity-slot">${capacityHtml(d.workers)}</div></section>` +
      '<div class="ds-grid-2">' +
        `<section class="ds-card"><div class="ds-card__row"><h2 class="ds-card__title">Running and waiting</h2><a class="ds-btn ds-btn--text ds-btn--sm" href="#/jobs">All jobs</a></div>` +
          `<div id="open-slot">${openHtml(d.open)}</div></section>` +
        activityCard(d) +
      '</div>';
  },

  update(d) {
    const page = $('#page');
    // Figures count from what they show; notes change at once.
    const tiles = $('#tiles', page);
    if (tiles) {
      for (const tile of TILES) {
        const value = $(`[data-tile="${tile.key}"]`, tiles);
        const wasEmpty = value && value.classList.contains('ds-tile__value--empty');
        const isEmpty = !!(tile.empty && tile.empty(d));
        if (!value || wasEmpty !== isEmpty) {
          DS.dom.morphHtml(tiles, tileItems(d));
          break;
        }
        if (!isEmpty) {
          const from = Number(value.getAttribute('data-value'));
          const to = tile.value(d);
          if (from !== to) {
            value.setAttribute('data-value', String(to));
            M.countUp(value, to, { from, format: tile.format || ((v) => String(Math.round(v))) });
          }
        }
        $(`[data-tile-note="${tile.key}"]`, tiles).textContent = tile.note(d);
      }
    }
    const alerts = $('#alerts', page);
    if (alerts) {
      if (d.alerts.length) alerts.hidden = false;
      M.flip(alerts, (morph) => DS.dom.morphHtml(alerts, alertsHtml(d.alerts), morph), { live: true, refocus: () => $('h1', page) })
        .then(() => { if (!d.alerts.length && alerts.isConnected) alerts.hidden = true; });
    }
    const capacity = $('#capacity', page);
    if (capacity && d.workers.length) {
      M.flip(capacity, (morph) => DS.dom.morphHtml(capacity, capacityItems(d.workers), morph), { live: true });
    } else {
      DS.dom.morphHtml($('#capacity-slot', page), capacityHtml(d.workers));
    }
    const open = $('#open', page);
    if (open && d.open.length) {
      M.flip(open, (morph) => DS.dom.morphHtml(open, openItems(d.open), morph), { live: true });
    } else {
      DS.dom.morphHtml($('#open-slot', page), openHtml(d.open));
    }
    const feed = $('#activity', page);
    if (feed) M.flip(feed, (morph) => DS.dom.morphHtml(feed, activityHtml(d.activity), morph), { live: true });
  },
};

