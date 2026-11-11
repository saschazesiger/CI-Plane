/*
 * Repositories: one card per GitHub account or organisation with its
 * health, a switch and a limit of parallel jobs, and its repositories in a
 * table with the same per repository, plus the failover to GitHub-hosted
 * runners and its check.
 */
import * as api from './api.js';
import { ctx } from './main.js';
import { $, M, esc, icon, head, ago, day, clock, chip, empty, switchHtml, busyButton, alertHtml, toast, toastError, setError } from './ui.js';

const DS = window.DS;

/* The result of the last check of the failover, by repository id; it stays while the page is open. */
const checks = new Map();

const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

function limitText(n) {
  return n > 0 ? `at most ${n} job${n === 1 ? '' : 's'} at a time` : 'no limit';
}

function repoRow(a, p, d) {
  const onGitHub = d.relay.perRepo[String(p.id)] || 0;
  const now = [p.running ? `${p.running} running` : '', p.queued ? `${p.queued} waiting` : '', onGitHub ? `${onGitHub} on GitHub` : '']
    .filter(Boolean).join(', ') || '–';
  const relay = d.relay.available
    ? `<td><div class="cp-row">${switchHtml({ id: `relay-${p.id}`, attrs: `data-relay="${p.id}"`, label: `Failover of ${p.fullName} to GitHub-hosted runners`, checked: p.relay, srLabel: true })}` +
      // Switching it on checks by itself; then the check is at hand for after a fix.
      (p.relay || p.relayOff ? busyButton('ds-btn ds-btn--text ds-sm', 'Check', 'Checking', 'Checked', `data-relay-check="${p.id}" aria-label="Check the failover of ${esc(p.fullName)}"`) : '') + '</div></td>'
    : '';
  return `<tr data-ds-key="r${p.id}">` +
    `<td class="ds-col--text">${esc(p.fullName)}${p.private ? '' : ` ${chip('warning', 'Public', 'globe')}`}</td>` +
    `<td class="ds-nowrap">${now}</td>` +
    `<td class="ds-col--secondary ds-nowrap">${p.lastJobAt ? ago(p.lastJobAt) : 'never'}</td>` +
    `<td><div class="ds-field"><label class="ds-sr" for="limit-r${p.id}">Parallel jobs of ${esc(p.fullName)}, 0 for no limit</label>` +
      `<input class="ds-input cp-limit" id="limit-r${p.id}" type="number" min="0" max="1000" step="1" inputmode="numeric" value="${p.maxParallel}" data-limit-repo="${p.id}" data-name="${esc(p.fullName)}"></div></td>` +
    `<td>${switchHtml({ id: `repo-${p.id}`, attrs: `data-repo="${p.id}"`, label: `Run the jobs of ${p.fullName}`, checked: p.enabled, srLabel: true })}</td>` +
    relay +
    `<td class="ds-table__actions"><span class="ds-hover-actions"><button class="ds-btn ds-btn--quiet ds-btn--icon ds-sm" type="button" data-remove-repo="${p.id}" data-name="${esc(p.fullName)}" aria-label="Remove ${esc(p.fullName)}" data-tip="Remove">${icon('trash', 18)}</button></span></td></tr>`;
}

/** Why the failover of a repository switched itself off, and what its last check found. */
function relayNotes(p, d) {
  if (!d.relay.available) return '';
  const name = esc(p.fullName);
  const c = checks.get(p.id);
  const again = (label, aria) => busyButton('ds-btn ds-btn--text ds-sm', label, 'Checking', 'Checked', `data-relay-check="${p.id}" aria-label="${aria}"`);
  let html = '';
  if (p.relayOff && !p.relay) {
    html += alertHtml('warning', `The failover of ${p.fullName} switched itself off on ${day(p.relayOffAt)} at ${clock(p.relayOffAt)}`,
      esc(sentence(p.relayOff)), c ? '' : again('Check', `Check the failover of ${name}`), `data-ds-key="off-${p.id}"`);
  }
  if (!c) return html;
  if (!c.problems.length) {
    return html + alertHtml('success', '', `Ready: ${name} has the relay workflow, and GitHub-hosted runners can reach CI-Plane.` +
      (p.relay ? '' : ' Switch its failover on to use it.'), '', `data-ds-key="check-${p.id}"`);
  }
  const add = c.addUrl
    ? `<a class="ds-btn ds-btn--text ds-sm" href="${esc(c.addUrl)}" target="_blank" rel="noopener">Add the workflow on GitHub${icon('external', 16)}</a>` : '';
  return html + alertHtml('warning', `The failover of ${p.fullName} is not ready`, c.problems.map((x) => esc(sentence(x))).join('</p><p>'),
    add + again('Check again', `Check the failover of ${name} again`), `data-ds-key="check-${p.id}"`);
}

/** The failover is off for all repositories in the settings while some have it switched on. */
function relayHint(d) {
  if (!d.relay.available || d.relayEnabled || !d.accounts.some((a) => a.repos.some((p) => p.relay))) return '';
  return alertHtml('', 'The failover to GitHub is off for all repositories',
    'Repositories with it switched on wait for your workers until you allow it again in the settings.',
    `<a class="ds-btn ds-btn--text ds-sm" href="#/settings?section=relay">Open the settings${icon('arrowRight', 16)}</a>`, 'data-ds-key="relay-hint"');
}

function accountCard(a, d) {
  const org = a.ownerType === 'Organization';
  const meta = [
    `App ${esc(a.slug)}`,
    a.health.lastWebhookAt ? `last webhook ${ago(a.health.lastWebhookAt)}` : 'no webhook since CI-Plane started',
    a.health.rateRemaining >= 0 ? `${a.health.rateRemaining.toLocaleString('en')} API requests left this hour` : '',
  ].filter(Boolean).join(' · ');
  let notes = '';
  if (!a.installationId) {
    notes += alertHtml('warning', 'The app is not installed yet', `No jobs of ${esc(a.owner)} arrive until the app is installed on the repositories that should use CI-Plane.`,
      `<a class="ds-btn ds-btn--text ds-sm" href="${esc(a.installUrl)}">Install on GitHub${icon('external', 16)}</a>`);
  }
  if (a.health.lastError) notes += alertHtml('warning', 'GitHub reports a problem', esc(a.health.lastError));
  if (!a.enabled) notes += alertHtml('', `${esc(a.owner)} is switched off`, 'Its jobs are ignored until you switch it on again.');
  const repos = a.repos.length
    ? '<div class="ds-table-wrap"><table class="ds-table"><caption class="ds-sr">Repositories of ' + esc(a.owner) + '</caption><thead><tr>' +
      '<th scope="col">Repository</th><th scope="col">Now</th><th scope="col" class="ds-col--secondary">Last job</th><th scope="col">Parallel jobs</th><th scope="col">On</th>' +
      (d.relay.available ? '<th scope="col" class="cp-col-relay">Failover to GitHub</th>' : '') +
      `<th scope="col"><span class="ds-sr">Actions</span></th></tr></thead><tbody>${a.repos.map((p) => repoRow(a, p, d)).join('')}</tbody></table></div>`
    : `<p class="ds-muted">${a.installationId ? 'The app is installed, but on no repository yet. Choose repositories on GitHub.' : 'Repositories show up here once the app is installed.'}</p>`;
  return `<section class="ds-card" data-ds-key="a${a.id}" aria-labelledby="acc-${a.id}">` +
    `<div class="ds-card__row"><h2 class="ds-card__title" id="acc-${a.id}">${icon(org ? 'building' : 'user', 20)}${esc(a.owner)} <span class="ds-tag ds-tone-neutral">${org ? 'Organisation' : 'Personal account'}</span></h2>` +
      switchHtml({ id: `acc-on-${a.id}`, attrs: `data-account="${a.id}"`, label: `Run the jobs of ${a.owner}`, checked: a.enabled, srLabel: true }) + '</div>' +
    `<p class="ds-meta">${meta}</p>${notes}` +
    `<div class="ds-inline-form"><div class="ds-field"><label class="ds-field__label" for="limit-a${a.id}">Parallel jobs of ${esc(a.owner)}</label>` +
      `<input class="ds-input cp-limit" id="limit-a${a.id}" type="number" min="0" max="1000" step="1" inputmode="numeric" value="${a.maxParallel}" data-limit-account="${a.id}" data-name="${esc(a.owner)}" aria-describedby="limit-a${a.id}-hint">` +
      `<small class="ds-field__hint" id="limit-a${a.id}-hint">Across all its repositories; 0 means no limit. Now ${a.running} running.</small></div></div>` +
    a.repos.map((p) => relayNotes(p, d)).join('') +
    repos +
    '<nav class="ds-card__links" aria-label="Actions for ' + esc(a.owner) + '">' +
      `<a class="ds-btn ds-btn--text ds-card__link" href="${esc(a.installUrl)}">Choose repositories on GitHub${icon('external', 16)}</a>` +
      busyButton('ds-btn ds-btn--text ds-card__link', 'Read again from GitHub', 'Reading', 'Read', `data-sync="${a.id}"`) +
      `<button class="ds-btn ds-btn--text ds-card__link" type="button" data-remove-account="${a.id}" data-name="${esc(a.owner)}">Remove ...</button>` +
    '</nav></section>';
}

function cardsHtml(d) {
  return relayHint(d) + d.accounts.map((a) => accountCard(a, d)).join('');
}

/** Renders the cards again from what is known, after a change made here. */
function render() {
  const stack = $('#accounts');
  if (stack && ctx.data) M.flip(stack, (morph) => DS.dom.morphHtml(stack, cardsHtml(ctx.data), morph));
}

function findRepo(id) {
  for (const a of ctx.data.accounts) {
    const p = a.repos.find((r) => r.id === id);
    if (p) return p;
  }
  return null;
}

/** Asks GitHub whether the failover of a repository would work, and shows what it found. */
async function checkRelay(id, button) {
  let r;
  try {
    const ask = () => api.post('/api/relay/check', { repo: id });
    r = await (button ? M.busy(button, ask) : ask());
  } catch (error) {
    toastError(error, 'relay-check');
    return;
  }
  checks.set(id, { problems: r.problems || [], addUrl: r.addUrl || '' });
  render();
  const p = findRepo(id);
  const name = p ? p.fullName : 'The repository';
  DS.overlay.announce(r.problems && r.problems.length ? `The failover of ${name} is not ready. ${r.problems.join(' ')}` : `Ready: ${name} has the relay workflow.`);
}

async function switchRelay(input) {
  const id = Number(input.getAttribute('data-relay'));
  const on = input.checked;
  try {
    await api.patch(`/api/repos/${id}`, { relay: on });
  } catch (error) {
    input.checked = !on;
    toastError(error, 'switch');
    return;
  }
  const p = findRepo(id);
  if (p) {
    p.relay = on;
    // Switched on again: why it switched itself off is history.
    if (on) Object.assign(p, { relayOff: '', relayOffAt: 0 });
  }
  checks.delete(id);
  render();
  // The workflow is usually missing at first: say so right away.
  if (on) await checkRelay(id, $(`#accounts tr [data-relay-check="${id}"]`));
}

async function saveLimit(input, path, name) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    setError(input, 'A whole number from 0 to 1000; 0 means no limit.');
    input.focus();
    return;
  }
  try {
    await api.patch(path, { maxParallel: value });
    input.defaultValue = String(value);
    toast(`${name}: ${limitText(value)}.`);
  } catch (error) {
    setError(input, error.message);
  }
}

export default {
  title: 'Repositories',
  async load() {
    const [d, relay, settings] = await Promise.all([api.get('/api/accounts'), api.get('/api/relay'), api.get('/api/settings')]);
    return { ...d, relay, relayEnabled: settings.settings.relayEnabled };
  },

  html(d) {
    checks.clear();
    const action = `<a class="ds-btn ds-btn--filled" href="#/repositories/add">${icon('plus', 16)}Add repository or organisation</a>`;
    const lead = 'The GitHub accounts and organisations whose jobs CI-Plane runs. A repository that is switched off is ignored.';
    if (!d.accounts.length) {
      return head('Repositories', lead, action) + `<section class="ds-card">${empty({ glyph: 'folder', title: 'No GitHub account connected yet',
        text: 'Connect your personal account or an organisation: CI-Plane creates a GitHub App there in two clicks.',
        action: '<a class="ds-btn ds-btn--tonal" href="#/repositories/add">Connect GitHub</a>' })}</section>`;
    }
    return head('Repositories', lead, action) +
      alertHtml('', 'Only connect repositories you trust', 'Jobs run in privileged containers on your workers. Never use CI-Plane for public repositories that accept pull requests from forks.') +
      `<div class="ds-stack ds-stack--page" id="accounts">${cardsHtml(d)}</div>`;
  },

  mount(d, params) {
    // From the list of the failover in the settings: show that repository.
    const row = params.get('repo') && $(`#accounts tr[data-ds-key="r${Number(params.get('repo'))}"]`);
    if (row) row.scrollIntoView({ block: 'center' });
  },

  update(d) {
    const stack = $('#accounts');
    if (!stack || !d.accounts.length) {
      DS.dom.morphHtml($('#page'), this.html(d));
      return;
    }
    M.flip(stack, (morph) => DS.dom.morphHtml(stack, cardsHtml(d), morph), { live: true });
  },

  async on(type, event) {
    const t = event.target;
    if (type === 'change') {
      if (t.hasAttribute('data-relay')) {
        switchRelay(t);
      } else if (t.hasAttribute('data-repo') || t.hasAttribute('data-account')) {
        const path = t.hasAttribute('data-repo') ? `/api/repos/${t.getAttribute('data-repo')}` : `/api/accounts/${t.getAttribute('data-account')}`;
        try {
          await api.patch(path, { enabled: t.checked });
        } catch (error) {
          t.checked = !t.checked;
          toastError(error, 'switch');
        }
      } else if (t.hasAttribute('data-limit-repo')) {
        saveLimit(t, `/api/repos/${t.getAttribute('data-limit-repo')}`, t.getAttribute('data-name'));
      } else if (t.hasAttribute('data-limit-account')) {
        saveLimit(t, `/api/accounts/${t.getAttribute('data-limit-account')}`, t.getAttribute('data-name'));
      }
      return;
    }
    if (type === 'keydown' && event.key === 'Enter' && t.matches('.cp-limit')) {
      event.preventDefault();
      t.blur();
      return;
    }
    if (type !== 'click') return;
    let el;
    if ((el = t.closest('[data-relay-check]'))) {
      checkRelay(Number(el.getAttribute('data-relay-check')), el);
    } else if ((el = t.closest('[data-sync]'))) {
      try {
        await M.busy(el, () => api.post(`/api/accounts/${el.getAttribute('data-sync')}/sync`));
        toast('The repositories were read again from GitHub.');
      } catch (error) {
        toastError(error, 'sync');
      }
    } else if ((el = t.closest('[data-remove-repo]'))) {
      const name = el.getAttribute('data-name');
      const ok = await DS.overlay.confirm({
        title: `Remove ${name}?`,
        text: `It comes back with its next job or the next sync while the GitHub App is installed on it; to keep it away for good, take it out of the app's repositories on GitHub. To pause it, the switch is enough.`,
        confirmLabel: `Remove ${name}`, destructive: true, opener: el,
        onConfirm: () => api.del(`/api/repos/${el.getAttribute('data-remove-repo')}`),
        errorText: `${name} could not be removed. Try again.`,
      });
      if (ok) toast(`${name} was removed.`);
    } else if ((el = t.closest('[data-remove-account]'))) {
      const name = el.getAttribute('data-name');
      let result = null;
      const ok = await DS.overlay.confirm({
        title: `Remove ${name}?`,
        text: `CI-Plane forgets the GitHub App of ${name} and its repositories; their jobs no longer run here. The app itself stays on GitHub until you delete it there.`,
        confirmLabel: `Remove ${name}`, destructive: true, opener: el,
        onConfirm: async () => { result = await api.del(`/api/accounts/${el.getAttribute('data-remove-account')}`); },
        errorText: `${name} could not be removed. Try again.`,
      });
      if (ok) {
        toast(`${name} was removed. Delete its GitHub App on GitHub too.`, {
          action: { label: 'Open on GitHub', onClick: () => window.open(result.settingsUrl, '_blank', 'noopener') },
        });
      }
    }
  },
};
