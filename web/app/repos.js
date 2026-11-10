/*
 * Repositories: one card per GitHub account or organisation with its
 * health, a switch and a limit of parallel jobs, and its repositories in a
 * table with the same per repository.
 */
import * as api from './api.js';
import { ctx } from './main.js';
import { $, M, esc, icon, head, ago, chip, empty, switchHtml, busyButton, alertHtml, toast, toastError, setError } from './ui.js';

const DS = window.DS;

function limitText(n) {
  return n > 0 ? `at most ${n} job${n === 1 ? '' : 's'} at a time` : 'no limit';
}

function repoRow(a, p) {
  const now = [p.running ? `${p.running} running` : '', p.queued ? `${p.queued} waiting` : ''].filter(Boolean).join(', ') || '–';
  return `<tr data-ds-key="r${p.id}">` +
    `<td class="ds-col--text">${esc(p.fullName)}${p.private ? '' : ` ${chip('warning', 'Public', 'globe')}`}</td>` +
    `<td class="ds-nowrap">${now}</td>` +
    `<td class="ds-col--secondary ds-nowrap">${p.lastJobAt ? ago(p.lastJobAt) : 'never'}</td>` +
    `<td><div class="ds-field"><label class="ds-sr" for="limit-r${p.id}">Parallel jobs of ${esc(p.fullName)}, 0 for no limit</label>` +
      `<input class="ds-input cp-limit" id="limit-r${p.id}" type="number" min="0" max="1000" step="1" inputmode="numeric" value="${p.maxParallel}" data-limit-repo="${p.id}" data-name="${esc(p.fullName)}"></div></td>` +
    `<td>${switchHtml({ id: `repo-${p.id}`, attrs: `data-repo="${p.id}"`, label: `Run the jobs of ${p.fullName}`, checked: p.enabled, srLabel: true })}</td>` +
    `<td class="ds-table__actions"><span class="ds-hover-actions"><button class="ds-btn ds-btn--quiet ds-btn--icon ds-btn--sm" type="button" data-remove-repo="${p.id}" data-name="${esc(p.fullName)}" aria-label="Remove ${esc(p.fullName)}" data-tip="Remove">${icon('trash', 18)}</button></span></td></tr>`;
}

function accountCard(a) {
  const org = a.ownerType === 'Organization';
  const meta = [
    `App ${esc(a.slug)}`,
    a.health.lastWebhookAt ? `last webhook ${ago(a.health.lastWebhookAt)}` : 'no webhook since CI-Plane started',
    a.health.rateRemaining >= 0 ? `${a.health.rateRemaining.toLocaleString('en')} API requests left this hour` : '',
  ].filter(Boolean).join(' · ');
  let notes = '';
  if (!a.installationId) {
    notes += alertHtml('warning', 'The app is not installed yet', `No jobs of ${esc(a.owner)} arrive until the app is installed on the repositories that should use CI-Plane.`,
      `<a class="ds-btn ds-btn--text ds-btn--sm" href="${esc(a.installUrl)}">Install on GitHub${icon('external', 16)}</a>`);
  }
  if (a.health.lastError) notes += alertHtml('warning', 'GitHub reports a problem', esc(a.health.lastError));
  if (!a.enabled) notes += alertHtml('', `${esc(a.owner)} is switched off`, 'Its jobs are ignored until you switch it on again.');
  const repos = a.repos.length
    ? '<div class="ds-table-wrap"><table class="ds-table"><caption class="ds-sr">Repositories of ' + esc(a.owner) + '</caption><thead><tr>' +
      '<th scope="col">Repository</th><th scope="col">Now</th><th scope="col" class="ds-col--secondary">Last job</th><th scope="col">Parallel jobs</th><th scope="col">On</th>' +
      `<th scope="col"><span class="ds-sr">Actions</span></th></tr></thead><tbody>${a.repos.map((p) => repoRow(a, p)).join('')}</tbody></table></div>`
    : `<p class="ds-muted">${a.installationId ? 'The app is installed, but on no repository yet. Choose repositories on GitHub.' : 'Repositories show up here once the app is installed.'}</p>`;
  return `<section class="ds-card" data-ds-key="a${a.id}" aria-labelledby="acc-${a.id}">` +
    `<div class="ds-card__row"><h2 class="ds-card__title" id="acc-${a.id}">${icon(org ? 'building' : 'user', 20)}${esc(a.owner)} <span class="ds-tag ds-tag--neutral">${org ? 'Organisation' : 'Personal account'}</span></h2>` +
      switchHtml({ id: `acc-on-${a.id}`, attrs: `data-account="${a.id}"`, label: `Run the jobs of ${a.owner}`, checked: a.enabled, srLabel: true }) + '</div>' +
    `<p class="ds-meta">${meta}</p>${notes}` +
    `<div class="ds-inline-form"><div class="ds-field"><label class="ds-field__label" for="limit-a${a.id}">Parallel jobs of ${esc(a.owner)}</label>` +
      `<input class="ds-input cp-limit" id="limit-a${a.id}" type="number" min="0" max="1000" step="1" inputmode="numeric" value="${a.maxParallel}" data-limit-account="${a.id}" data-name="${esc(a.owner)}" aria-describedby="limit-a${a.id}-hint">` +
      `<small class="ds-field__hint" id="limit-a${a.id}-hint">Across all its repositories; 0 means no limit. Now ${a.running} running.</small></div></div>` +
    repos +
    '<nav class="ds-card__links" aria-label="Actions for ' + esc(a.owner) + '">' +
      `<a class="ds-btn ds-btn--text ds-card__link" href="${esc(a.installUrl)}">Choose repositories on GitHub${icon('external', 16)}</a>` +
      busyButton('ds-btn ds-btn--text ds-card__link', 'Read again from GitHub', 'Reading', 'Read', `data-sync="${a.id}"`) +
      `<button class="ds-btn ds-btn--text ds-card__link" type="button" data-remove-account="${a.id}" data-name="${esc(a.owner)}">Remove ...</button>` +
    '</nav></section>';
}

function cardsHtml(d) {
  return d.accounts.map(accountCard).join('');
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
  load: () => api.get('/api/accounts'),

  html(d) {
    const action = `<a class="ds-btn ds-btn--primary" href="#/repositories/add">${icon('plus', 16)}Add repository or organisation</a>`;
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
      if (t.hasAttribute('data-repo') || t.hasAttribute('data-account')) {
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
    if ((el = t.closest('[data-sync]'))) {
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
        text: `Its jobs are ignored from now on. It comes back with the next sync while the GitHub App is installed on it; to keep it away for good, take it out of the app's repositories on GitHub. To pause it, the switch is enough.`,
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
