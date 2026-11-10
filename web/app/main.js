/*
 * The frame of the interface: session and sign-in, hash routes with
 * DS.motion.transition(), the drawer, the shared side sheet, live updates
 * over server-sent events, and the events every view gets delegated.
 *
 * A view is an object:
 *   title, nav           the document title and the drawer item it belongs to
 *   load(params)         fetches its data (a Promise)
 *   html(data, params)   its markup, rendered with DS.dom.morphHtml
 *   mount(data, params)  after the first render (optional)
 *   update(data, params) a live refresh in place (optional)
 *   topics               the live topics that refresh it (default: state)
 *   on(type, event)      click, change, input, submit and keydown inside the page
 *   sheet(type, event)   the same inside the side sheet it opened
 *   leave()              before another view replaces it (optional)
 */
import * as api from './api.js';
import { $, $$, M, esc, head, alertHtml, copyFrom, toast } from './ui.js';
import overview from './overview.js';
import jobs from './jobs.js';
import workers from './workers.js';
import repos from './repos.js';
import settings from './settings.js';
import { setupView, addWorkerView, addAccountView, githubView } from './setup.js';

const DS = window.DS;
const app = $('#app');
const page = $('#page');
const view = $('#main');
const drawer = $('#drawer');
const nav = $('#nav');
const sheet = $('#sheet');
const sheetBody = $('#sheet-body');
const menuButton = $('#menu');

const VIEWS = {
  overview,
  jobs,
  workers,
  'workers/add': addWorkerView,
  repositories: repos,
  'repositories/add': addAccountView,
  settings,
  setup: setupView,
  github: githubView,
};

/** What the views share: the session, the current route and its data. */
export const ctx = {
  session: null,
  route: '',
  params: new URLSearchParams(),
  view: null,
  data: null,
  sheetOwner: null,
  go,
  refresh,
  openSheet,
  closeSheet,
  reloadSession,
  page,
  sheetBody,
};

/* ── Routes ───────────────────────────────────────────────────────── */

function parse(hash) {
  const match = /^#\/([a-z/]+)(?:\?(.*))?$/.exec(hash || '');
  let route = match ? match[1] : 'overview';
  if (!VIEWS[route]) route = 'overview';
  return { route, params: new URLSearchParams(match ? match[2] || '' : '') };
}

/** The route a session must see: the assistant until the setup is done. */
function guarded(route) {
  const s = ctx.session;
  if (!s) return route;
  if (s.needsPassword) return 'setup';
  if (!s.setupDone && route !== 'github' && route !== 'setup') return 'setup';
  return route;
}

let navigation = 0;

async function go(hash, { push = true, replace = false, type = 'fade-through' } = {}) {
  let { route, params } = parse(hash);
  const target = guarded(route);
  if (target !== route) {
    route = target;
    params = new URLSearchParams();
    hash = `#/${route}`;
    replace = true;
  }
  if (replace) history.replaceState(null, '', hash);
  else if (push && location.hash !== hash) history.pushState(null, '', hash);
  const next = VIEWS[route];
  const token = ++navigation;
  let data;
  let error = null;
  try {
    data = await next.load(params);
  } catch (err) {
    error = err;
  }
  if (token !== navigation) return;
  // A destination: fade-through; the modal drawer closes inside the update.
  await M.transition(() => {
    if (app.hasAttribute('data-drawer-open')) DS.overlay.close(drawer);
    if (sheet.open) DS.overlay.close(sheet);
    show(next, route, params, data, error);
    return page;
  }, { type, focus: true });
  if (!error && next.mount && ctx.view === next) next.mount(data, params);
}

function show(next, route, params, data, error) {
  if (ctx.view && ctx.view !== next && ctx.view.leave) ctx.view.leave();
  ctx.view = next;
  ctx.route = route;
  ctx.params = params;
  ctx.data = data;
  const hideDrawer = !!ctx.session && (ctx.session.needsPassword || !ctx.session.setupDone);
  app.toggleAttribute('data-drawer-hidden', hideDrawer);
  menuButton.hidden = hideDrawer;
  view.classList.toggle('ds-view--fill', !!next.fill && !error);
  DS.dom.morphHtml(page, error ? failedHtml(next, error) : next.html(data, params), { replace: true });
  const current = next.nav || route;
  for (const item of $$('[data-route]', drawer)) {
    if (item.getAttribute('data-route') === current) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  document.title = `${typeof next.title === 'function' ? next.title(data, params) : next.title} · CI-Plane`;
  view.scrollTop = 0;
}

function failedHtml(next, error) {
  const title = typeof next.title === 'function' ? next.title(null, ctx.params) : next.title;
  return head(title, '') + alertHtml('error', 'This page could not be loaded', esc(error.message),
    '<button class="ds-btn ds-btn--text ds-btn--sm" type="button" data-act="retry">Try again</button>');
}

/* ── Live updates ─────────────────────────────────────────────────── */

let refreshing = false;
let pendingTopics = null;

/** Refetches and updates the current view in place, once at a time. */
async function refresh(topics) {
  const current = ctx.view;
  if (!current || !current.update) return;
  const wanted = current.topics || ['state'];
  if (topics && !wanted.some((topic) => topics.has(topic))) return;
  if (refreshing) {
    pendingTopics = pendingTopics || new Set();
    for (const topic of topics || ['state']) pendingTopics.add(topic);
    return;
  }
  refreshing = true;
  try {
    const data = await current.load(ctx.params);
    if (ctx.view === current) {
      ctx.data = data;
      current.update(data, ctx.params);
    }
  } catch (error) {
    // The next change or the stream's reconnect brings fresh data.
  } finally {
    refreshing = false;
  }
  if (pendingTopics) {
    const again = pendingTopics;
    pendingTopics = null;
    refresh(again);
  }
}

let stream = null;
let offlineTimer = 0;
const panel = $('.ds-panel');
let banner = null;

function connect() {
  if (stream) return;
  stream = api.live((topics) => refresh(topics), (up) => {
    clearTimeout(offlineTimer);
    if (up) {
      showOffline(false);
      refresh(new Set(['state', 'tasks', 'live']));
    } else {
      offlineTimer = setTimeout(() => showOffline(true), 4000);
    }
  });
}

function disconnect() {
  if (stream) stream.close();
  stream = null;
}

/* A message for the whole app while the server does not answer. */
function showOffline(on) {
  if (on === Boolean(banner?.isConnected)) return;
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'ds-banner';
    DS.dom.morphHtml(banner, alertHtml('warning', '', 'CI-Plane does not answer. What you see stays as it was until it is back; the page reconnects by itself.', '', 'role="status"'));
  }
  M.flip(panel, () => { if (on) panel.prepend(banner); else banner.remove(); }, { items: ':scope > *' });
}

/* ── The side sheet ───────────────────────────────────────────────── */

/** Opens the sheet with a record of the current view; the view gets its events. */
function openSheet({ title, subtitle = '', html, opener }) {
  ctx.sheetOwner = ctx.view;
  $('#sheet-title').textContent = title;
  $('#sheet-subtitle').textContent = subtitle;
  DS.dom.morphHtml(sheetBody, html);
  sheetBody.scrollTop = 0;
  if (!sheet.open) DS.overlay.open(sheet, { opener });
}

function closeSheet() {
  if (sheet.open) DS.overlay.close(sheet);
}

sheet.addEventListener('ds-close', (event) => {
  if (event.target !== sheet) return;
  const owner = ctx.sheetOwner;
  if (owner && owner.sheetClosed) owner.sheetClosed();
});

for (const type of ['click', 'change', 'input', 'submit', 'keydown']) {
  sheetBody.addEventListener(type, (event) => {
    if (type === 'click') {
      const copy = event.target.closest('[data-copy]');
      if (copy) {
        copyFrom(copy);
        return;
      }
    }
    if (ctx.sheetOwner && ctx.sheetOwner.sheet) ctx.sheetOwner.sheet(type, event);
  });
}

/* ── Delegated events of the page ────────────────────────────────── */

for (const type of ['click', 'change', 'input', 'submit', 'keydown']) {
  page.addEventListener(type, (event) => {
    if (type === 'click') {
      const copy = event.target.closest('[data-copy]');
      if (copy) {
        copyFrom(copy);
        return;
      }
      if (event.target.closest('[data-act="retry"]')) {
        go(location.hash, { push: false });
        return;
      }
    }
    if (ctx.view && ctx.view.on) ctx.view.on(type, event);
  });
}

// The copy button of the dialog that shows the remove command.
document.addEventListener('click', (event) => {
  const copy = event.target.closest('dialog [data-copy]');
  if (copy && !sheet.contains(copy)) copyFrom(copy);
});

// Links to a route navigate in place; every other link loads.
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="#/"]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go(link.getAttribute('href'));
});
window.addEventListener('popstate', () => go(location.hash, { push: false }));

// An error message goes once the field is corrected.
document.addEventListener('input', (event) => {
  const input = event.target;
  if (input.getAttribute && input.getAttribute('aria-invalid') === 'true') {
    input.removeAttribute('aria-invalid');
    const hint = document.getElementById(`${input.id}-error`);
    if (hint) hint.remove();
  }
});

/* ── Session ──────────────────────────────────────────────────────── */

const auth = $('#auth');
const boot = $('#boot');
const loginForm = $('#login-form');

function showAccount(session) {
  const account = $('#account');
  account.hidden = !session.signedIn;
  $('#demo-tag').hidden = !session.demo;
  let name = 'Admin';
  let email = 'Signed in with the password';
  if (session.demo) {
    name = 'Demo';
    email = 'Nothing real is touched';
  } else if (session.via === 'tunnel') {
    name = session.email;
    email = 'Signed in with Cloudflare Access';
  }
  $('#account-name').textContent = name;
  $('#account-email').textContent = email;
  const avatar = $('#account-avatar');
  avatar.textContent = name.slice(0, 1).toUpperCase();
  avatar.setAttribute('aria-label', `${name}, ${email}`);
  avatar.setAttribute('data-tip', `${name}, ${email}`);
  $('#sign-out').hidden = session.demo;
}

async function reloadSession() {
  ctx.session = await api.get('/api/session');
  showAccount(ctx.session);
  return ctx.session;
}

function showLogin(message = '') {
  disconnect();
  boot.hidden = true;
  app.hidden = true;
  auth.hidden = false;
  DS.dom.morphHtml($('#auth-alert'), message ? alertHtml('warning', '', esc(message)) : '');
  loginForm.reset();
  $('#login-password').focus();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#login-password');
  const button = $('[type="submit"]', loginForm);
  if (!input.value) {
    DS.dom.morphHtml($('#auth-alert'), alertHtml('error', '', 'Enter the admin password.'));
    input.focus();
    return;
  }
  try {
    await M.busy(button, () => api.post('/api/login', { password: input.value }));
  } catch (error) {
    DS.dom.morphHtml($('#auth-alert'), alertHtml('error', '', esc(error.message)));
    input.select();
    input.focus();
    return;
  }
  auth.hidden = true;
  start();
});

$('#sign-out').addEventListener('click', async () => {
  if (ctx.session && ctx.session.via === 'tunnel') {
    // Cloudflare Access ends its session at this address of the tunnel host.
    location.assign('/cdn-cgi/access/logout');
    return;
  }
  try {
    await api.post('/api/logout');
  } catch (error) {
    // Signed out on this side either way.
  }
  showLogin('You are signed out.');
});

api.whenSignedOut(() => {
  if (!auth.hidden) return;
  ctx.session = null;
  showLogin('Your session ended. Sign in again.');
});

/* ── Wiring ───────────────────────────────────────────────────────── */

DS.icons.fill(document);
for (const element of $$('[data-icon-done]')) element.insertAdjacentHTML('afterbegin', DS.icons.icon(DS.icons.check, 16));
DS.ripple.attach(document);
DS.overlay.tooltips(document);
DS.indicator.createIndicator(nav, { active: '[aria-current="page"]', className: 'ds-drawer__indicator' });
DS.dom.scrollEdges(nav, { axis: 'block' });
DS.dom.watchScrolled(view);
DS.dom.followViewport();

menuButton.addEventListener('click', () => {
  if (app.hasAttribute('data-drawer-open')) DS.overlay.close(drawer);
  else DS.overlay.open(drawer, { opener: menuButton });
});

const SKELETON = '<div class="ds-skeleton" role="status"><span class="ds-sr">Loading ...</span>' +
  '<span class="ds-loadbar" aria-hidden="true"><span class="ds-loadbar__bar"></span></span>' +
  '<span class="ds-skeleton__line ds-skeleton__line--heading" aria-hidden="true"></span>' +
  '<span class="ds-skeleton__line ds-skeleton__line--lead" aria-hidden="true"></span>' +
  '<div class="ds-skeleton__card" aria-hidden="true"><span class="ds-skeleton__line ds-skeleton__line--title"></span><span class="ds-skeleton__line"></span>' +
  '<span class="ds-skeleton__line ds-skeleton__line--short"></span><span class="ds-skeleton__line ds-skeleton__line--mid"></span></div>' +
  '<div class="ds-skeleton__card" aria-hidden="true"><span class="ds-skeleton__line ds-skeleton__line--title"></span><span class="ds-skeleton__line"></span>' +
  '<span class="ds-skeleton__line ds-skeleton__line--mid"></span></div></div>';

/* The first load: a skeleton while the first view's data comes, then the view staggers in once. */
async function start() {
  let session;
  try {
    session = await reloadSession();
  } catch (error) {
    boot.hidden = true;
    auth.hidden = false;
    DS.dom.morphHtml($('#auth-alert'), alertHtml('error', 'CI-Plane does not answer', esc(error.message),
      '<a class="ds-btn ds-btn--text ds-btn--sm" href="">Try again</a>'));
    return;
  }
  if (!session.signedIn && !session.needsPassword) {
    showLogin();
    return;
  }
  boot.hidden = true;
  auth.hidden = true;
  app.hidden = false;
  const startedAt = Date.now();
  DS.dom.morphHtml(page, SKELETON, { replace: true });
  let { route, params } = parse(location.hash);
  const target = guarded(route);
  if (target !== route) {
    route = target;
    params = new URLSearchParams();
    history.replaceState(null, '', `#/${route}`);
  }
  const next = VIEWS[route];
  let data;
  let error = null;
  try {
    data = await next.load(params);
  } catch (err) {
    error = err;
  }
  await M.settleLoader(startedAt, { element: $('.ds-skeleton', page) });
  show(next, route, params, data, error);
  if (!error && next.mount) next.mount(data, params);
  M.staggerOnce(page);
  if (session.signedIn) connect();
  document.documentElement.setAttribute('data-cp-ready', '');
}

/** Called after the first password was set: the session exists now. */
export async function signedInNow() {
  await reloadSession();
  connect();
}

start();

export { toast };
