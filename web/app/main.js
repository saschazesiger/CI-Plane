/*
 * The frame of the interface: hash routes with DS.motion.transition(), the
 * drawer, the shared side sheet, live updates and the events every view gets
 * delegated. Sign-in, the first password, the account capsule, sign-out and
 * the event stream are the Z-Dash server's shell (/z-dash/server/shell.js):
 * start() resolves once someone is signed in, on(topic) hears the change
 * notices.
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
import { start as startShell, on } from '/z-dash/server/shell.js';
import * as api from './api.js';
import { $, $$, M, esc, head, alertHtml, copyFrom, toast } from './ui.js';
import overview from './overview.js';
import jobs from './jobs.js';
import workers from './workers.js';
import pools from './pools.js';
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
  pools,
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
  const hideDrawer = !!ctx.session && !ctx.session.setupDone;
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
    '<button class="ds-btn ds-btn--text ds-sm" type="button" data-act="retry">Try again</button>');
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

/*
 * The shell's change notices: one call of refresh() per notice, whatever
 * topics it names. A notice for every topic (an empty set: the stream came
 * back, the tab woke, someone signed in again) refreshes the view and the
 * session too.
 */
let notices = null;

function onTopics(topics) {
  if (!notices) {
    notices = new Set();
    queueMicrotask(() => {
      const all = notices.has('*');
      const these = notices;
      notices = null;
      if (all) reloadSession().catch(() => {});
      refresh(all ? null : these);
    });
  }
  if (!topics.size) notices.add('*');
  for (const topic of topics) notices.add(topic);
}

for (const topic of ['state', 'tasks', 'live', 'cloudflare']) on(topic, onTopics);

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

sheet.addEventListener('ds:close', (event) => {
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

/**
 * The shell's session (name, via, email, open, ...) with what CI-Plane adds
 * from GET /api/setup: whether the setup assistant is finished, and the demo.
 */
async function reloadSession() {
  const [session, setup] = await Promise.all([api.get('/api/session'), api.get('/api/setup')]);
  ctx.session = { ...session, setupDone: !!setup.done, demo: !!setup.demo };
  $('#demo-tag').hidden = !ctx.session.demo;
  return ctx.session;
}

/* ── Wiring ───────────────────────────────────────────────────────── */

DS.icons.fill(document);
for (const element of $$('[data-icon-done]')) element.insertAdjacentHTML('afterbegin', DS.icons.icon(DS.icons.check, 16));
DS.ripple.attach(document);
DS.overlay.tooltips(document);
DS.indicator.create(nav, { active: '[aria-current="page"]', className: 'ds-drawer__indicator' });
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

/* The first load, once the shell has someone signed in: a skeleton while the first view's data comes, then the view
   staggers in once. */
async function start() {
  await startShell();
  DS.dom.morphHtml(page, SKELETON, { replace: true });
  const startedAt = Date.now();
  try {
    await reloadSession();
  } catch (error) {
    DS.dom.morphHtml(page, alertHtml('error', 'CI-Plane does not answer', esc(error.message),
      '<a class="ds-btn ds-btn--text ds-sm" href="">Try again</a>'), { replace: true });
    return;
  }
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
  document.documentElement.setAttribute('data-cp-ready', '');
}

start();

export { toast };
