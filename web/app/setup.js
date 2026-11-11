/*
 * The setup assistant (password, Cloudflare, GitHub, first worker, try it)
 * and the two assistants it shares with the pages: "Add worker" and "Add
 * repository or organisation". Each step explains itself, checks live, and
 * survives a reload: long operations run on the server as tasks.
 */
import * as api from './api.js';
import { ctx, signedInNow } from './main.js';
import {
  $, $$, M, esc, icon, head, ago, gb, plural, chip, jobChip, workerChip, empty, codeWithCopy, busyButton,
  alertHtml, taskSteps, toast, toastError, setError, showFieldErrors, clearErrors, priorityOptions, PRIORITY_HINT,
} from './ui.js';

const DS = window.DS;

const STEPS = [
  { key: 'password', label: 'Password' },
  { key: 'cloudflare', label: 'Cloudflare' },
  { key: 'github', label: 'GitHub' },
  { key: 'worker', label: 'First worker' },
  { key: 'job', label: 'Try it' },
];

/* What the user typed, kept across live re-renders and step changes. */
const cf = { token: '', zones: null, zoneId: '', sub: 'ci', emails: '', editing: false };
const gh = { kind: 'user', org: '', adding: false };
const wk = { host: '', port: '22', name: '', tier: '1', priority: 'normal', result: null, error: '', attempts: 0, retryAt: 0, timer: 0, workerId: 0 };

/* ── Step 1: password ─────────────────────────────────────────────── */

function passwordHtml(d) {
  if (ctx.session.needsPassword) {
    return '<h2 class="ds-card__title">Choose the admin password</h2>' +
      '<p class="ds-muted">You are the first visitor, so you choose the password. You sign in with it on this local address; from outside, Cloudflare Access signs you in instead (step 2).</p>' +
      '<form class="ds-form" id="password-form" novalidate><div class="ds-form-grid ds-form-grid--2">' +
        '<div class="ds-field"><label class="ds-field__label" for="pw-new">Password</label>' +
          '<input class="ds-input" id="pw-new" name="password" type="password" autocomplete="new-password" minlength="10" data-field="password" aria-describedby="pw-new-hint" autofocus>' +
          '<small class="ds-field__hint" id="pw-new-hint">At least 10 characters. A few random words are easy to type and hard to guess.</small></div>' +
        '<div class="ds-field"><label class="ds-field__label" for="pw-repeat">Repeat the password</label>' +
          '<input class="ds-input" id="pw-repeat" type="password" autocomplete="new-password"></div>' +
      '</div><div class="ds-form-actions">' + busyButton('ds-btn ds-btn--filled', 'Set password and continue', 'Saving', 'Saved', 'type="submit"') +
      '</div></form>';
  }
  let text = 'Sign in with it on this local address. Forgot it? Start CI-Plane with the environment variable CI_PLANE_ADMIN_PASSWORD set to a new one.';
  if (ctx.session.demo) text = 'The demo needs no password: everybody who opens it is signed in.';
  else if (ctx.session.via === 'tunnel') text = 'You are signed in through Cloudflare Access. On the local address, the admin password is needed.';
  return '<h2 class="ds-card__title">Admin password</h2>' + alertHtml('success', 'The admin password is set', esc(text));
}

async function submitPassword(form, submitter) {
  const pw = $('#pw-new', form);
  const repeat = $('#pw-repeat', form);
  clearErrors(form);
  if (pw.value.length < 10) {
    setError(pw, 'Use at least 10 characters.');
    pw.focus();
    return;
  }
  if (repeat.value !== pw.value) {
    setError(repeat, 'The two passwords are not the same.');
    repeat.focus();
    return;
  }
  try {
    await M.busy(submitter, () => api.post('/api/setup/password', { password: pw.value }));
  } catch (error) {
    if (error.status === 409) {
      toast(error.message, { kind: 'info' });
      location.reload();
      return;
    }
    if (!showFieldErrors(form, error.fields)) toastError(error, 'password');
    return;
  }
  await signedInNow();
  toast('Password set. You are signed in.');
  ctx.go('#/setup?step=2', { type: 'forward' });
}

/* ── Step 2: Cloudflare ───────────────────────────────────────────── */

const TOKEN_PERMISSIONS = [
  ['Account', 'Cloudflare Tunnel', 'Edit'],
  ['Account', 'Access: Apps and Policies', 'Edit'],
  ['Account', 'Access: Organizations, Identity Providers, and Groups', 'Edit'],
  ['Zone', 'DNS', 'Edit'],
  ['Zone', 'Zone', 'Read'],
];

function cloudflareHtml(d) {
  const st = d.status;
  const task = d.task;
  const running = task && task.state === 'running';
  const intro = '<h2 class="ds-card__title">Connect Cloudflare</h2>' +
    '<p class="ds-muted">GitHub has to reach CI-Plane over the internet to hand it jobs. A Cloudflare Tunnel gives CI-Plane a public address without opening a port on your network, and Cloudflare Access lets only the people you name open this page from outside.</p>';
  if (running) {
    return intro + `<div class="ds-card ds-card--filled" id="cf-task">${taskSteps(task)}</div>` +
      '<p class="ds-meta">This takes about a minute. You may leave this page; the setup continues and shows here again.</p>';
  }
  if (st.configured && st.verified && !cf.editing) {
    return intro + alertHtml('success', 'The tunnel is up', `CI-Plane is reachable at <a href="${esc(st.publicUrl)}" target="_blank" rel="noopener">${esc(st.publicUrl)}</a>. It asks for a Cloudflare login there, and GitHub's webhooks get through to /webhook.`) +
      `<ul class="ds-kv-list"><li><span>Public address</span><strong>${esc(st.publicUrl)}</strong></li>` +
      `<li><span>May sign in</span><strong>${esc(st.emails.join(', '))}</strong></li>` +
      `<li><span>Tunnel</span><strong>${st.running ? 'Running' : 'Stopped'}, ${st.connected ? 'connected' : 'not connected'}</strong></li></ul>` +
      '<div class="cp-row"><button class="ds-btn" type="button" data-act="cf-again">Set it up again ...</button></div>';
  }
  let problem = '';
  if (task && task.state === 'failed') problem = `<div class="ds-card ds-card--filled">${taskSteps(task)}</div>`;
  else if (st.configured && !st.verified) {
    problem = alertHtml('warning', 'The tunnel is set up but not working', esc(st.error || 'It could not be reached from outside yet.') + ' Run the setup again to repair it.');
  }
  const zones = cf.zones;
  const zone = zones && zones.find((z) => z.id === cf.zoneId);
  const tokenDone = zones && zones.length;
  const permissions = TOKEN_PERMISSIONS.map(([scope, what, level]) => `<li><span>${scope} · ${what}</span><strong>${level}</strong></li>`).join('');
  return intro + problem +
    '<form class="ds-form" id="cf-form" novalidate>' +
      '<h3 class="ds-card__subtitle">1. Create an API token</h3>' +
      '<p class="ds-muted">The button opens Cloudflare\'s token page with these permissions filled in. Pick your account and the domain CI-Plane should use, then choose Create token.</p>' +
      `<ul class="ds-kv-list">${permissions}</ul>` +
      `<div class="cp-row"><a class="ds-btn" href="${esc(d.tokenUrl)}" target="_blank" rel="noopener">${icon('external', 16)}Create the token on Cloudflare</a></div>` +
      '<p class="ds-meta">No Zero Trust on your account yet? Cloudflare asks you to pick a plan on first use; the free plan is enough. CI-Plane keeps the token encrypted and needs it again only to repair or remove the tunnel.</p>' +
      '<h3 class="ds-card__subtitle">2. Paste it here</h3>' +
      '<div class="ds-field"><label class="ds-field__label" for="cf-token">API token</label><div class="ds-field__row">' +
        `<input class="ds-input" id="cf-token" type="password" autocomplete="off" spellcheck="false" data-field="apiToken" value="${esc(cf.token)}" aria-describedby="cf-token-hint">` +
        busyButton(tokenDone ? 'ds-btn' : 'ds-btn ds-btn--filled', 'Check token', 'Checking', 'Valid', 'data-act="cf-zones"') + '</div>' +
        (tokenDone
          ? `<small class="ds-field__hint ds-field__hint--success" id="cf-token-hint">${icon('checkCircle', 16)}<span>Valid: it may use ${plural(zones.length, 'domain')}.</span></small>`
          : '<small class="ds-field__hint" id="cf-token-hint">Cloudflare shows the token once, right after you created it.</small>') + '</div>' +
      (tokenDone ? '<h3 class="ds-card__subtitle">3. Choose the address and who may sign in</h3>' +
        '<div class="ds-form-grid ds-form-grid--2">' +
          '<div class="ds-field"><label class="ds-field__label" for="cf-zone">Domain</label>' +
            `<select class="ds-input" id="cf-zone" data-field="zoneId">${zones.map((z) => `<option value="${esc(z.id)}"${z.id === cf.zoneId ? ' selected' : ''}>${esc(z.name)}</option>`).join('')}</select></div>` +
          '<div class="ds-field"><label class="ds-field__label" for="cf-sub">Subdomain</label><div class="ds-input-group">' +
            `<input class="ds-input" id="cf-sub" autocomplete="off" spellcheck="false" data-field="hostname" value="${esc(cf.sub)}" aria-describedby="cf-sub-hint">` +
            `<span class="ds-input-group__suffix" aria-hidden="true">.${esc(zone ? zone.name : '')}</span></div>` +
            `<small class="ds-field__hint" id="cf-sub-hint">CI-Plane will be at https://${esc(cf.sub || '...')}.${esc(zone ? zone.name : '')}. The name must not be in use yet.</small></div>` +
        '</div>' +
        '<div class="ds-field"><label class="ds-field__label" for="cf-emails">Who may sign in from outside</label>' +
          `<textarea class="ds-input" id="cf-emails" data-field="emails" spellcheck="false" aria-describedby="cf-emails-hint" placeholder="you@example.com">${esc(cf.emails)}</textarea>` +
          '<small class="ds-field__hint" id="cf-emails-hint">One e-mail address per line. Cloudflare sends a one-time code to these addresses; nobody else gets in.</small></div>' +
        '<div class="ds-form-actions">' + busyButton('ds-btn ds-btn--filled', 'Set up the tunnel', 'Starting', 'Started', 'data-act="cf-setup"') +
          (cf.editing ? '<button class="ds-btn ds-btn--text" type="button" data-act="cf-cancel">Cancel</button>' : '') + '</div>'
        : '') +
    '</form>';
}

function readCloudflare() {
  const v = (id) => ($(id) ? $(id).value : undefined);
  if (v('#cf-token') !== undefined) cf.token = v('#cf-token');
  if (v('#cf-zone') !== undefined) cf.zoneId = v('#cf-zone');
  if (v('#cf-sub') !== undefined) cf.sub = v('#cf-sub').trim().toLowerCase();
  if (v('#cf-emails') !== undefined) cf.emails = v('#cf-emails');
}

async function checkToken(button) {
  readCloudflare();
  const form = $('#cf-form');
  clearErrors(form);
  if (!cf.token.trim()) {
    setError($('#cf-token'), 'Paste the API token you created on Cloudflare.');
    $('#cf-token').focus();
    return;
  }
  try {
    const r = await M.busy(button, () => api.post('/api/cloudflare/zones', { apiToken: cf.token.trim() }));
    cf.zones = r.zones;
    if (!r.zones.length) {
      setError($('#cf-token'), 'The token works, but it may use no domain. Create it again and include the domain under Zone Resources.');
      return;
    }
    if (!r.zones.some((z) => z.id === cf.zoneId)) cf.zoneId = r.zones[0].id;
    if (!cf.emails && ctx.session.email) cf.emails = ctx.session.email;
    rerender();
    const sub = $('#cf-sub');
    if (sub) sub.focus();
  } catch (error) {
    cf.zones = null;
    if (!showFieldErrors(form, error.fields)) toastError(error, 'cf');
  }
}

async function startTunnel(button) {
  readCloudflare();
  const form = $('#cf-form');
  clearErrors(form);
  const zone = (cf.zones || []).find((z) => z.id === cf.zoneId);
  const emails = cf.emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const bad = [
    setError($('#cf-sub'), /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(cf.sub) ? '' : 'Use letters, digits and dashes, like ci.') && $('#cf-sub'),
    setError($('#cf-emails'), emails.length ? '' : 'Enter at least one e-mail address: only these people may sign in from outside.') && $('#cf-emails'),
  ].filter(Boolean);
  if (bad.length) {
    bad[0].focus();
    return;
  }
  try {
    await M.busy(button, () => api.post('/api/cloudflare/setup', { apiToken: cf.token.trim(), zoneId: cf.zoneId, hostname: `${cf.sub}.${zone.name}`, emails }), { done: false });
  } catch (error) {
    if (!showFieldErrors(form, error.fields)) toastError(error, 'cf');
    return;
  }
  cf.editing = false;
  ctx.refresh(new Set(['tasks']));
}

/* ── Step 3: GitHub ───────────────────────────────────────────────── */

function githubFormHtml(publicUrl) {
  if (!publicUrl) {
    return alertHtml('warning', 'Set up the Cloudflare tunnel first', 'GitHub sends jobs to the public address of the tunnel, so the app needs it when it is created.',
      '<a class="ds-btn ds-btn--text ds-sm" href="#/setup?step=2">Go to the Cloudflare step</a>');
  }
  const org = gh.kind === 'org';
  return '<form class="ds-form" id="gh-form" novalidate>' +
    '<div class="ds-radios ds-radios--tiles" role="radiogroup" aria-label="Where the repositories are">' +
      `<label class="ds-radio"><input type="radio" name="gh-kind" value="user"${org ? '' : ' checked'}><span class="ds-radio__icon" aria-hidden="true">${icon('user', 20)}</span>` +
        `<span><strong>My personal account</strong><small>Repositories under github.com/your-name.</small></span><span class="ds-radio__mark" aria-hidden="true">${icon('check', 14)}</span></label>` +
      `<label class="ds-radio"><input type="radio" name="gh-kind" value="org"${org ? ' checked' : ''}><span class="ds-radio__icon" aria-hidden="true">${icon('building', 20)}</span>` +
        `<span><strong>An organisation</strong><small>You need to be an owner of it.</small></span><span class="ds-radio__mark" aria-hidden="true">${icon('check', 14)}</span></label>` +
    '</div>' +
    (org ? '<div class="ds-field"><label class="ds-field__label" for="gh-org">Name of the organisation</label><div class="ds-input-group">' +
      `<span class="ds-input-group__prefix" aria-hidden="true">github.com/</span><input class="ds-input" id="gh-org" autocomplete="off" spellcheck="false" data-field="org" value="${esc(gh.org)}" aria-describedby="gh-org-hint"></div>` +
      '<small class="ds-field__hint" id="gh-org-hint">As in its address on GitHub, for example acme-labs.</small></div>' : '') +
    '<h3 class="ds-card__subtitle">What happens on GitHub</h3>' +
    '<div class="ds-prose ds-prose--dense"><ol>' +
      `<li>GitHub shows the app CI-Plane prepared for ${org ? 'the organisation' : 'your account'}. Choose <strong>Create GitHub App</strong>.</li>` +
      '<li>GitHub asks where to install it. Choose the repositories whose jobs CI-Plane should run, then <strong>Install</strong>.</li>' +
      '<li>GitHub sends you back here, and the repositories show up.</li></ol></div>' +
    `<p class="ds-meta">The app may read Actions and metadata and manage ${org ? 'the self-hosted runners of the organisation' : 'self-hosted runners (GitHub calls this Administration: write on personal repositories)'}. It sends its webhooks to ${esc(publicUrl)}/webhook.</p>` +
    `<div class="ds-form-actions">${busyButton('ds-btn ds-btn--filled', 'Continue on GitHub', 'Preparing', 'Opening', 'data-act="gh-go"')}</div>` +
    '</form>';
}

function githubHtml(d) {
  const installed = d.accounts.filter((a) => a.installationId);
  const pending = d.accounts.filter((a) => !a.installationId);
  let html = '<h2 class="ds-card__title">Connect GitHub</h2>' +
    '<p class="ds-muted">CI-Plane creates a GitHub App in your account or organisation and installs it on the repositories you choose. Through it, GitHub tells CI-Plane about queued jobs and CI-Plane registers the runners.</p>';
  for (const a of pending) {
    html += alertHtml('warning', `The app of ${esc(a.owner)} is not installed yet`, 'Install it on the repositories that should use CI-Plane.',
      `<a class="ds-btn ds-btn--text ds-sm" href="${esc(a.installUrl)}">Install on GitHub${icon('external', 16)}</a>`);
  }
  if (installed.length && !gh.adding) {
    html += alertHtml('success', 'GitHub is connected', `${plural(installed.length, 'account')} with ${plural(installed.reduce((n, a) => n + a.repos.length, 0), 'repository', 'repositories')}.`) +
      `<ul class="ds-list" aria-label="Connected accounts">${installed.map((a) => `<li class="ds-list__item" data-ds-key="a${a.id}">${icon(a.ownerType === 'Organization' ? 'building' : 'user', 20, 'ds-list__icon')}` +
        `<span class="ds-list__text"><span class="ds-list__title">${esc(a.owner)}</span><span class="ds-list__meta">${esc(a.repos.map((p) => p.fullName).join(', ') || 'no repository yet')}</span></span></li>`).join('')}</ul>` +
      '<div class="cp-row"><button class="ds-btn" type="button" data-act="gh-add">Add another account or organisation</button></div>';
    return html;
  }
  return html + githubFormHtml(d.publicUrl);
}

async function startGitHub(button, from) {
  const form = $('#gh-form');
  clearErrors(form);
  const org = gh.kind === 'org' ? ($('#gh-org').value || '').trim() : '';
  if (gh.kind === 'org' && !org) {
    setError($('#gh-org'), 'Enter the name of the organisation.');
    $('#gh-org').focus();
    return;
  }
  let manifest;
  try {
    manifest = await M.busy(button, () => api.post('/api/github/manifest', { org }), { done: false });
  } catch (error) {
    if (!showFieldErrors(form, error.fields)) toastError(error, 'gh');
    return;
  }
  try {
    sessionStorage.setItem('cp-github-from', from);
  } catch (error) {
    // Without storage the return lands on Repositories.
  }
  // GitHub's manifest flow: a form posted to github.com with the manifest as one field.
  const post = document.createElement('form');
  post.method = 'post';
  post.action = /[?&]state=/.test(manifest.action) ? manifest.action : `${manifest.action}${manifest.action.includes('?') ? '&' : '?'}state=${encodeURIComponent(manifest.state)}`;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = manifest.manifest;
  post.append(field);
  post.hidden = true;
  document.body.append(post);
  post.submit();
}

/* ── Step 4: a worker ─────────────────────────────────────────────── */

function stopRetry() {
  clearTimeout(wk.timer);
  wk.timer = 0;
  wk.retryAt = 0;
}

function workerHtml(d, inSetup) {
  const added = d.worker;
  let html = '';
  if (inSetup) {
    html += '<h2 class="ds-card__title">Add your first worker</h2>' +
      '<p class="ds-muted">A worker is a Linux server with Docker that runs the jobs. CI-Plane reaches it over SSH with a key of its own; each job gets a fresh runner and its own Docker daemon there, removed afterwards.</p>';
    const online = d.workers.filter((w) => w.state === 'online' && w.enabled);
    if (online.length && !added) {
      return html + alertHtml('success', `${plural(online.length, 'worker')} online`, 'CI-Plane can start runners now.') +
        `<ul class="ds-list" aria-label="Workers">${online.map((w) => `<li class="ds-list__item" data-ds-key="w${w.id}">${icon('server', 20, 'ds-list__icon')}<span class="ds-list__text"><span class="ds-list__title">${esc(w.name)}</span>` +
          `<span class="ds-list__meta">${esc(w.host)} · ${w.cpus} CPUs · ${gb(w.memMb)}</span></span>${workerChip(w)}</li>`).join('')}</ul>` +
        '<div class="cp-row"><a class="ds-btn" href="#/workers/add">Add another worker</a></div>';
    }
  }
  html += '<h3 class="ds-card__subtitle">1. Run this on the server</h3>' +
    '<p class="ds-muted">Copy the command and run it as root on the server (with sudo, or after sudo -i). It installs Docker if it is missing, creates the user ci-plane in the group docker and lets CI-Plane in with its key. It downloads nothing from CI-Plane.</p>' +
    codeWithCopy('setup-command', d.commands.setup, 'Setup command') +
    '<p class="ds-meta">Tested on Ubuntu and Debian on x86_64. The server needs to reach the internet to pull images; CI-Plane needs to reach the server on its SSH port.</p>';
  if (added) return html + preparedHtml(added, inSetup);
  html += '<h3 class="ds-card__subtitle">2. Connect to it</h3>' +
    '<form class="ds-form" id="connect-form" novalidate><div class="ds-form-grid">' +
      '<div class="ds-field"><label class="ds-field__label" for="wk-host">Address of the server</label>' +
        `<input class="ds-input" id="wk-host" autocomplete="off" spellcheck="false" data-field="host" value="${esc(wk.host)}" placeholder="build-1.lan or 192.168.1.20" aria-describedby="wk-host-hint">` +
        '<small class="ds-field__hint" id="wk-host-hint">Its host name or IP address, as CI-Plane reaches it: on your network, a VPN or the internet.</small></div>' +
      '<div class="ds-field"><label class="ds-field__label" for="wk-port">SSH port</label>' +
        `<input class="ds-input" id="wk-port" inputmode="numeric" autocomplete="off" data-field="port" value="${esc(wk.port)}"></div>` +
    '</div><div class="ds-form-actions">' +
      busyButton(wk.result ? 'ds-btn' : 'ds-btn ds-btn--filled', wk.result ? 'Connect again' : 'Connect', 'Connecting', 'Connected', 'type="submit" data-act="wk-check"') +
    '</div></form>';
  if (wk.error) {
    html += alertHtml('error', 'CI-Plane could not connect', esc(wk.error),
      wk.timer ? '<button class="ds-btn ds-btn--text ds-sm" type="button" data-act="wk-stop">Stop trying</button>' : '') +
      (wk.timer ? `<p class="ds-meta" id="wk-retry" role="status">Trying again by itself every 5 seconds (attempt ${wk.attempts}), so you can run the command now and watch.</p>` : '');
  }
  if (wk.result) {
    const f = wk.result.facts;
    const tiers = Math.min(9, Math.max(1, ...d.workers.map((w) => w.tier)) + 1);
    html += '<h3 class="ds-card__subtitle">3. Check and add it</h3>' +
      alertHtml('success', `Connected to ${esc(wk.result.host)}`, 'CI-Plane logged in and looked around. Check the host key, then add the worker.') +
      '<ul class="ds-kv-list">' +
        `<li><span>System</span><strong>${esc(f.os || 'Linux')} · ${esc(f.arch || '')}</strong></li>` +
        `<li><span>CPUs</span><strong>${f.cpus}</strong></li>` +
        `<li><span>Memory</span><strong>${gb(f.memMb)}</strong></li>` +
        `<li><span>Disk for Docker</span><strong>${gb(f.diskMb)}, ${gb(f.diskFreeMb)} free</strong></li>` +
        `<li><span>Docker</span><strong>${esc(f.docker || 'not found')}</strong></li>` +
        `<li><span>Host key</span><strong><code>${esc(f.fingerprint)}</code></strong></li>` +
      '</ul>' +
      '<p class="ds-meta">To compare the host key, run <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the server. CI-Plane pins this key and refuses the server if it ever changes.</p>' +
      '<form class="ds-form" id="add-form" novalidate><div class="ds-form-grid ds-form-grid--2">' +
        '<div class="ds-field"><label class="ds-field__label" for="wk-name">Name</label>' +
          `<input class="ds-input" id="wk-name" autocomplete="off" maxlength="40" data-field="name" value="${esc(wk.name)}"></div>` +
        '<div class="ds-field"><label class="ds-field__label" for="wk-tier">Tier</label>' +
          `<select class="ds-input" id="wk-tier" data-field="tier" aria-describedby="wk-tier-hint">${Array.from({ length: tiers }, (_, i) => i + 1)
            .map((n) => `<option value="${n}"${String(n) === wk.tier ? ' selected' : ''}>Tier ${n}${n === 1 ? ' (filled first)' : ''}</option>`).join('')}</select>` +
          '<small class="ds-field__hint" id="wk-tier-hint">Put servers you would rather keep free into a higher tier.</small></div>' +
      '</div>' +
      '<div class="ds-field"><label class="ds-field__label" for="wk-priority">CPU priority</label>' +
        `<select class="ds-input" id="wk-priority" data-field="cpuPriority" aria-describedby="wk-priority-hint">${priorityOptions(wk.priority)}</select>` +
        `<small class="ds-field__hint" id="wk-priority-hint">${PRIORITY_HINT}</small></div>` +
      `<div class="ds-form-actions">${busyButton('ds-btn ds-btn--filled', 'Add worker', 'Adding', 'Added', 'type="submit" data-act="wk-add"')}</div></form>`;
  }
  return html;
}

function preparedHtml(w, inSetup) {
  const task = w.task;
  let html = `<h3 class="ds-card__subtitle">2. Prepare ${esc(w.name)}</h3>`;
  if (task) html += `<div class="ds-card ds-card--filled">${taskSteps(task)}</div>`;
  if (task && task.state === 'failed') {
    return html + `<div class="cp-row">${busyButton('ds-btn ds-btn--filled', 'Try again', 'Starting', 'Started', `data-act="wk-prepare" data-worker="${w.id}"`, 'sync')}` +
      `<a class="ds-btn ds-btn--text" href="#/workers?open=${w.id}">Open ${esc(w.name)}</a></div>`;
  }
  if (w.state === 'online' && w.live.connected) {
    const next = inSetup
      ? '<a class="ds-btn ds-btn--tonal" href="#/setup?step=5">Next: try it</a>'
      : `<div class="cp-row"><a class="ds-btn ds-btn--tonal" href="#/workers?open=${w.id}">Open ${esc(w.name)}</a><button class="ds-btn ds-btn--text" type="button" data-act="wk-another">Add another worker</button></div>`;
    return html + empty({ done: true, title: `${w.name} is ready`, text: `It is online and takes jobs now, in tier ${w.tier}.`, action: next });
  }
  if (!task || task.state === 'done') {
    return html + `<div class="ds-loading" role="status"><span class="ds-loader ds-sm" aria-hidden="true"></span>Waiting for ${esc(w.name)} to report in. This takes a few seconds.</div>`;
  }
  return html + '<p class="ds-meta">This takes a minute or two, mostly for pulling the images. You may leave this page; the preparation continues.</p>';
}

async function checkWorker(button, retry = false) {
  const form = $('#connect-form');
  if (!form) return;
  wk.host = $('#wk-host').value.trim();
  wk.port = $('#wk-port').value.trim() || '22';
  if (!retry) {
    clearErrors(form);
    stopRetry();
    wk.attempts = 0;
    if (!wk.host) {
      setError($('#wk-host'), 'Enter the address of the server.');
      $('#wk-host').focus();
      return;
    }
  }
  wk.attempts += 1;
  const work = () => api.post('/api/workers/check', { host: wk.host, port: Number(wk.port) || 0, user: 'ci-plane' });
  try {
    wk.result = await (button ? M.busy(button, work) : work());
    wk.error = '';
    stopRetry();
    if (!wk.name) wk.name = defaultName(wk.result.host);
    rerender();
    DS.overlay.announce(`Connected to ${wk.result.host}.`);
    const name = $('#wk-name');
    if (name) name.focus();
  } catch (error) {
    wk.result = null;
    if (error.status === 400 || error.status === 409) {
      wk.error = '';
      stopRetry();
      rerender();
      showFieldErrors($('#connect-form'), error.fields);
      if (!error.fields || !Object.keys(error.fields).length) toastError(error, 'check');
      return;
    }
    wk.error = error.message;
    // Keep trying for a while: the command may not have run yet.
    stopRetry();
    if (wk.attempts < 60) wk.timer = setTimeout(() => checkWorker(null, true), 5000);
    rerender();
  }
}

function defaultName(host) {
  if (/^[\d.:]+$/.test(host)) return host;
  return host.split('.')[0];
}

async function addWorker(button, inSetup) {
  const form = $('#add-form');
  clearErrors(form);
  wk.name = $('#wk-name').value.trim();
  wk.tier = $('#wk-tier').value;
  wk.priority = $('#wk-priority').value;
  if (!wk.name) {
    setError($('#wk-name'), 'Give the worker a name.');
    $('#wk-name').focus();
    return;
  }
  let r;
  try {
    r = await M.busy(button, () => api.post('/api/workers', {
      host: wk.result.host, port: wk.result.port, user: wk.result.user, name: wk.name, tier: Number(wk.tier), cpuPriority: wk.priority, facts: wk.result.facts,
    }));
  } catch (error) {
    if (!showFieldErrors(form, error.fields)) toastError(error, 'add');
    return;
  }
  wk.workerId = r.worker.id;
  const hash = inSetup ? `#/setup?step=4&worker=${r.worker.id}` : `#/workers/add?worker=${r.worker.id}`;
  history.replaceState(null, '', hash);
  ctx.params = new URLSearchParams(hash.split('?')[1]);
  toast(`${r.worker.name} was added. CI-Plane prepares it now.`);
  ctx.refresh(new Set(['tasks']));
}

function resetWorker() {
  stopRetry();
  Object.assign(wk, { host: '', port: '22', name: '', tier: '1', priority: 'normal', result: null, error: '', attempts: 0, workerId: 0 });
}

async function loadWorkerStep(params) {
  const id = Number(params.get('worker')) || 0;
  if (id && id !== wk.workerId) {
    resetWorker();
    wk.workerId = id;
  }
  const [commands, list, detail] = await Promise.all([
    api.get('/api/workers/commands'),
    api.get('/api/workers'),
    id ? api.get(`/api/workers/${id}`).catch(() => null) : Promise.resolve(null),
  ]);
  return { commands, workers: list.workers, worker: detail ? detail.worker : null };
}

/* ── Step 5: try it ───────────────────────────────────────────────── */

function snippet(set) {
  const std = set.sizes[0];
  return 'jobs:\n  build:\n' +
    `    runs-on: [self-hosted, ${set.baseLabel}]${std ? `   # starts where ${std.cpus} CPUs are free, up to ${std.memMb / 1024} GB of memory` : ''}\n` +
    '    steps:\n      - uses: actions/checkout@v4\n      - run: echo "Hello from CI-Plane"\n';
}

function tryHtml(d) {
  const set = d.settings.settings;
  const sizes = set.sizes.map((z, i) => `<tr data-ds-key="z-${esc(z.name)}"><th scope="row">${i ? 'Large' : 'Standard'}</th>` +
    `<td class="ds-num">${z.cpus}</td><td class="ds-num">${z.memMb / 1024} GB</td><td><code>[self-hosted, ${esc(set.baseLabel)}${i ? ', large' : ''}]</code></td></tr>`).join('');
  const jobs = d.jobs.jobs;
  const liveHtml = jobs.length
    ? empty({ done: true, title: 'The first job arrived', text: 'CI-Plane picked it up. Every job shows up under Jobs with its timeline.' }) +
      `<ul class="ds-list ds-list--interactive" id="try-jobs" aria-label="Latest jobs">${jobs.slice(0, 3).map((j) => `<li class="ds-list__item" data-ds-key="j${j.id}">` +
        `${icon('play', 20, 'ds-list__icon')}<span class="ds-list__text"><span class="ds-list__title"><a class="ds-list__action" href="#/jobs?open=${j.id}">${esc(j.name)}</a></span>` +
        `<span class="ds-list__meta">${esc(j.repo)} · ${ago(j.queuedAt)}</span></span>${jobChip(j)}</li>`).join('')}</ul>`
    : `<div class="ds-loading" role="status"><span class="ds-loader ds-sm" aria-hidden="true"></span>Waiting for the first job. Push a commit with this workflow to a connected repository; the job shows up here within seconds.</div>`;
  return '<h2 class="ds-card__title">Run your first job</h2>' +
    `<p class="ds-muted">Use this runs-on line in a workflow of a connected repository. Jobs without the label ${esc(set.baseLabel)} stay on GitHub's own runners.</p>` +
    codeWithCopy('snippet', snippet(set), 'Example workflow') +
    '<h3 class="ds-card__subtitle">Sizes</h3>' +
    '<p class="ds-muted">A job is standard. Add the label <code>large</code> to runs-on for a job that needs more: it starts where that many CPUs are free and may use that much memory. You can change both under Settings.</p>' +
    `<div class="ds-table-wrap"><table class="ds-table ds-density-tight"><caption class="ds-sr">Sizes</caption><thead><tr><th scope="col">Size</th><th scope="col" class="ds-num">Free CPUs to start</th><th scope="col" class="ds-num">Memory</th><th scope="col">runs-on</th></tr></thead><tbody>${sizes}</tbody></table></div>` +
    '<h3 class="ds-card__subtitle">Live</h3>' + `<div id="try-live">${liveHtml}</div>`;
}

/* ── The assistant ────────────────────────────────────────────────── */

const LOADERS = {
  password: async () => ({}),
  cloudflare: () => api.get('/api/cloudflare'),
  github: () => api.get('/api/accounts'),
  worker: (params) => loadWorkerStep(params),
  job: async () => {
    const [settings, jobs] = await Promise.all([api.get('/api/settings'), api.get('/api/jobs?limit=5')]);
    return { settings, jobs };
  },
};

const RENDER = {
  password: passwordHtml,
  cloudflare: cloudflareHtml,
  github: githubHtml,
  worker: (d) => workerHtml(d, true),
  job: tryHtml,
};

function firstOpen(steps) {
  const i = STEPS.findIndex((s) => !steps[s.key]);
  return i < 0 ? STEPS.length - 1 : i;
}

function stepsHtml(d) {
  return '<ol class="ds-steps" aria-label="Setup">' + STEPS.map((s, i) => {
    const done = d.steps[s.key];
    const current = i === d.step;
    const mark = done && !current ? icon('check', 16) : String(i + 1);
    return `<li class="ds-steps__step"${done && !current ? ' data-status="done"' : ''}${current ? ' aria-current="step"' : ''}>` +
      `<span class="ds-steps__mark">${mark}</span><span class="ds-steps__label">${s.label}${done ? '<span class="ds-sr">, done</span>' : ''}</span></li>`;
  }).join('') + '</ol>';
}

function navHtml(d) {
  const key = STEPS[d.step].key;
  const done = d.steps[key];
  const back = d.step > 0 ? `<button class="ds-btn ds-btn--text" type="button" data-step="${d.step}">${icon('arrowLeft', 16)}Back</button>` : '';
  if (ctx.session.needsPassword) return '';
  if (d.step === STEPS.length - 1) {
    return `<div class="ds-form-actions">${busyButton(done ? 'ds-btn ds-btn--filled' : 'ds-btn', 'Finish setup', 'Finishing', 'Done', 'data-act="finish"')}${back}</div>`;
  }
  const next = done
    ? `<button class="ds-btn ds-btn--filled" type="button" data-step="${d.step + 2}">Next: ${STEPS[d.step + 1].label}${icon('arrowRight', 16)}</button>`
    : `<button class="ds-btn" type="button" data-step="${d.step + 2}" aria-describedby="skip-hint">Skip for now</button>`;
  return `<div class="ds-form-actions">${next}${back}${done ? '' : '<p class="ds-meta" id="skip-hint">You can come back to this step later from the setup assistant.</p>'}</div>`;
}

let current = null; // the data of the step on show, for re-renders after input

function stepCard(d) {
  return `<section class="ds-card" id="step-card" aria-label="Step ${d.step + 1} of ${STEPS.length}: ${STEPS[d.step].label}">${RENDER[STEPS[d.step].key](d.data)}</section>`;
}

function rerender() {
  if (ctx.view === setupView && current) {
    DS.dom.morphHtml($('#step-card'), RENDER[STEPS[current.step].key](current.data));
  } else if (ctx.view === addWorkerView && current) {
    DS.dom.morphHtml($('#wk-card'), workerHtml(current, false));
  }
}

async function finish(button) {
  try {
    await M.busy(button, () => api.post('/api/setup/finish'));
  } catch (error) {
    toastError(error, 'finish');
    return;
  }
  await ctx.reloadSession();
  toast('Setup finished. The assistant stays under Setup assistant in the menu.');
  ctx.go('#/overview');
}

export const setupView = {
  title: 'Setup',
  nav: 'setup',
  topics: ['state', 'tasks'],

  async load(params) {
    let setup = { steps: {}, done: false };
    if (!ctx.session.needsPassword) setup = await api.get('/api/setup');
    let step = Number(params.get('step')) - 1;
    if (ctx.session.needsPassword) step = 0;
    else if (!(step >= 0 && step < STEPS.length)) step = firstOpen(setup.steps);
    const data = await LOADERS[STEPS[step].key](params);
    current = { ...setup, step, data };
    return current;
  },

  html(d) {
    const later = ctx.session.signedIn && !ctx.session.setupDone
      ? busyButton('ds-btn ds-btn--text', 'Finish later', 'Saving', 'Saved', 'data-act="finish-later"') : '';
    const lead = ctx.session.needsPassword
      ? 'Welcome. Five short steps take CI-Plane from a fresh start to your first job. It starts with a password, so nobody else on your network can change anything.'
      : 'Five steps from a fresh start to the first job. Each step checks itself and turns green; you can leave and come back at any time.';
    return head('Set up CI-Plane', lead, later) + `<div id="steps-slot">${stepsHtml(d)}</div>` + stepCard(d) + `<div id="nav-slot">${navHtml(d)}</div>`;
  },

  update(d) {
    if (ctx.session.needsPassword) return;
    // Only the card and the marks: the fields keep what was typed and the focus.
    DS.dom.morphHtml($('#steps-slot'), stepsHtml(d));
    DS.dom.morphHtml($('#step-card'), RENDER[STEPS[d.step].key](d.data));
    DS.dom.morphHtml($('#nav-slot'), navHtml(d));
  },

  leave() {
    stopRetry();
    cf.editing = false;
    gh.adding = false;
  },

  on(type, event) {
    stepEvents(type, event, true);
  },
};

function stepEvents(type, event, inSetup) {
  const t = event.target;
  if (type === 'submit') {
    event.preventDefault();
    const submitter = event.submitter || $('[type="submit"]', t);
    if (t.id === 'password-form') submitPassword(t, submitter);
    if (t.id === 'connect-form') checkWorker(submitter);
    if (t.id === 'add-form') addWorker(submitter, inSetup);
    if (t.id === 'cf-form') {
      if (cf.zones && cf.zones.length) startTunnel($('[data-act="cf-setup"]', t));
      else checkToken($('[data-act="cf-zones"]', t));
    }
    if (t.id === 'gh-form') startGitHub($('[data-act="gh-go"]', t), inSetup ? 'setup' : 'repositories');
    return;
  }
  if (type === 'change' && t.name === 'gh-kind') {
    gh.kind = t.value;
    rerenderAccount(inSetup);
    if (gh.kind === 'org') $('#gh-org').focus();
    return;
  }
  if (type === 'change' && t.id === 'cf-zone') {
    readCloudflare();
    rerender();
    return;
  }
  if (type === 'input') {
    if (t.id === 'gh-org') gh.org = t.value;
    if (t.id === 'cf-sub') {
      readCloudflare();
      const zone = (cf.zones || []).find((z) => z.id === cf.zoneId);
      const hint = $('#cf-sub-hint');
      if (hint && zone) hint.textContent = `CI-Plane will be at https://${cf.sub || '...'}.${zone.name}. The name must not be in use yet.`;
    }
    if (t.id === 'cf-token' && cf.zones) {
      cf.zones = null;
      readCloudflare();
      rerender();
      $('#cf-token').focus();
    }
    if (t.id === 'wk-host' && wk.timer) stopRetry();
    return;
  }
  if (type === 'keydown' && event.key === 'Enter' && t.id === 'cf-token') {
    event.preventDefault();
    checkToken($('[data-act="cf-zones"]'));
    return;
  }
  if (type !== 'click') return;
  const step = t.closest('[data-step]');
  if (step) {
    const n = Number(step.getAttribute('data-step'));
    ctx.go(`#/setup?step=${n}`, { type: n > current.step + 1 ? 'forward' : 'back' });
    return;
  }
  const act = t.closest('[data-act]');
  if (!act) return;
  switch (act.getAttribute('data-act')) {
    case 'cf-zones': checkToken(act); break;
    case 'cf-setup': startTunnel(act); break;
    case 'cf-again': cf.editing = true; rerender(); $('#cf-token').focus(); break;
    case 'cf-cancel': cf.editing = false; rerender(); break;
    case 'gh-go': startGitHub(act, inSetup ? 'setup' : 'repositories'); break;
    case 'gh-add': gh.adding = true; rerender(); break;
    case 'wk-stop': stopRetry(); rerender(); break;
    case 'wk-another':
      resetWorker();
      ctx.go('#/workers/add', { replace: true });
      break;
    case 'wk-prepare':
      M.busy(act, () => api.post(`/api/workers/${act.getAttribute('data-worker')}/prepare`), { done: false })
        .then(() => ctx.refresh(new Set(['tasks']))).catch((error) => toastError(error, 'prepare'));
      break;
    case 'finish': finish(act); break;
    case 'finish-later': finish(act); break;
    default:
  }
}

function rerenderAccount(inSetup) {
  if (inSetup) rerender();
  else if (ctx.view === addAccountView) DS.dom.morphHtml($('#gh-card'), githubFormHtml(ctx.data.publicUrl));
}

/* ── Add worker, add account: the same assistants as pages ────────── */

export const addWorkerView = {
  title: 'Add a worker',
  nav: 'workers',
  topics: ['state', 'tasks', 'live'],
  async load(params) {
    const d = await loadWorkerStep(params);
    current = d;
    return d;
  },
  html(d) {
    return head('Add a worker', 'Three steps: run one command on the server, connect, and CI-Plane prepares it. The page turns green when the worker is ready.', '', { href: '#/workers', label: 'Workers' }) +
      `<section class="ds-card" id="wk-card">${workerHtml(d, false)}</section>`;
  },
  update(d) {
    DS.dom.morphHtml($('#wk-card'), workerHtml(d, false));
  },
  leave() {
    stopRetry();
    if (wk.workerId) resetWorker();
  },
  on(type, event) {
    stepEvents(type, event, false);
  },
};

export const addAccountView = {
  title: 'Add repository or organisation',
  nav: 'repositories',
  async load() {
    return api.get('/api/accounts');
  },
  html(d) {
    return head('Add repository or organisation', 'CI-Plane creates a GitHub App in your account or organisation and installs it on the repositories you choose. Two clicks on GitHub.', '', { href: '#/repositories', label: 'Repositories' }) +
      `<section class="ds-card" id="gh-card">${githubFormHtml(d.publicUrl)}</section>`;
  },
  on(type, event) {
    stepEvents(type, event, false);
  },
};

/* ── The way back from GitHub ─────────────────────────────────────── */

function returnTarget() {
  let from = '';
  try {
    from = sessionStorage.getItem('cp-github-from') || '';
  } catch (error) {
    from = '';
  }
  if (from === 'setup' || !ctx.session.setupDone) return '#/setup?step=3';
  return '#/repositories';
}

export const githubView = {
  title: 'GitHub',
  nav: 'repositories',
  load: async () => ({}),
  html() {
    return head('Connecting GitHub', 'One moment: CI-Plane finishes what GitHub sent back.') +
      '<div id="github-status"><div class="ds-loading" role="status"><span class="ds-loader ds-sm" aria-hidden="true"></span>Finishing ...</div></div>';
  },
  async mount(_, params) {
    const status = $('#github-status');
    const fail = (error) => DS.dom.morphHtml(status, alertHtml('error', 'GitHub could not be connected', esc(error.message),
      `<a class="ds-btn ds-btn--text ds-sm" href="${returnTarget() === '#/repositories' ? '#/repositories/add' : '#/setup?step=3'}">Start again</a>`));
    if (params.get('code')) {
      try {
        const r = await api.post('/api/github/complete', { code: params.get('code'), state: params.get('state') || '' });
        DS.dom.morphHtml(status, `<div class="ds-loading" role="status"><span class="ds-loader ds-sm" aria-hidden="true"></span>The app ${esc(r.account.slug)} was created. Opening GitHub to install it ...</div>`);
        location.assign(r.installUrl);
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (params.get('installation_id') || params.get('setup_action')) {
      try {
        const r = await api.post('/api/github/installed', { installationId: Number(params.get('installation_id')) || 0 });
        const repos = r.accounts.reduce((n, a) => n + a.repos.length, 0);
        toast(`GitHub is connected: ${plural(repos, 'repository', 'repositories')}.`);
        ctx.go(returnTarget(), { replace: true });
      } catch (error) {
        fail(error);
      }
      return;
    }
    fail(new Error('GitHub sent nothing back. Start again.'));
  },
};

