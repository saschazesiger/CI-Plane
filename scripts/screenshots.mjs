// Takes the screenshots and GIFs of the documentation from the demo mode.
//
//   npm install --prefix /tmp/pw playwright@1.63.0
//   /tmp/pw/node_modules/.bin/playwright install chromium
//   NODE_PATH=/tmp/pw/node_modules node scripts/screenshots.mjs [stills|setup|live ...]
//
// It builds CI-Plane, starts the demo on ports 18080 to 18082 (nothing real is
// touched), drives it with Playwright (Chromium) and writes into docs/images/.
// GIFs are built from screenshots taken in a loop; they need ffmpeg on the
// PATH (or FFMPEG=/path/to/ffmpeg). See docs/development.md.

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not found. Install it outside the repository and point NODE_PATH at it:\n' +
    '  npm install --prefix /tmp/pw playwright@1.63.0\n' +
    '  /tmp/pw/node_modules/.bin/playwright install chromium\n' +
    '  NODE_PATH=/tmp/pw/node_modules node scripts/screenshots.mjs');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'images');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-plane-shots-'));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const parts = process.argv.slice(2);
const want = (p) => parts.length === 0 || parts.includes(p);
fs.mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('-', ...a);

// ── The demo ──────────────────────────────────────────────────────────

const bin = path.join(tmp, 'ci-plane');
log('building CI-Plane');
execFileSync('go', ['build', '-o', bin, './cmd/ci-plane'], { cwd: root, stdio: 'inherit' });

const running = [];
async function demo(port, env) {
  const child = spawn(bin, [], {
    env: { ...process.env, CI_PLANE_DEMO: '1', CI_PLANE_LISTEN: `127.0.0.1:${port}`, CI_PLANE_DEMO_SEED: '1', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  running.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { base, stop: () => child.kill() };
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the demo on port ${port} did not start`);
}
const stopAll = () => running.forEach((c) => c.kill());
process.on('exit', stopAll);

const browser = await chromium.launch();

async function open(base, { width = 1440, height = 900, scheme = 'light', scale = 1 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: scale, reducedMotion: 'no-preference',
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('  page error:', e.message));
  await page.goto(base + '/');
  await page.waitForSelector('[data-cp-ready]');
  return { context, page };
}

// Moves to a page and waits until it rendered and its entrance motion ended.
async function go(page, base, hash, settle = 1200) {
  await page.goto(`${base}/${hash}`);
  await page.waitForSelector('[data-cp-ready]');
  await page.waitForTimeout(settle);
}

// shot takes the window. With `upTo`, the window first grows (or shrinks)
// so that it ends just below that element: no card is cut in half.
async function shot(page, name, { upTo, max = 1600 } = {}) {
  const size = page.viewportSize();
  if (upTo) {
    const box = await page.locator(upTo).first().boundingBox();
    const height = Math.min(max, Math.ceil(box.y + box.height + 16));
    await page.setViewportSize({ width: size.width, height });
    await page.waitForTimeout(500);
  }
  await page.mouse.move(0, 0); // no hover state in the picture
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, name) });
  await page.setViewportSize(size);
  log(name);
}

// ── Stills: a frozen demo, the same picture on every run ──────────────

async function stills() {
  const { base, stop } = await demo(18080, { CI_PLANE_DEMO_FREEZE: '1' });
  log('waiting for the demo to settle');
  await sleep(12000);

  for (const scheme of ['light', 'dark']) {
    const { context, page } = await open(base, { scheme });
    await go(page, base, '#/overview');
    await shot(page, scheme === 'light' ? 'overview.png' : 'overview-dark.png', { upTo: 'section:has(h2:text-is("Capacity"))' });
    if (scheme === 'light') {
      await go(page, base, '#/jobs');
      await shot(page, 'jobs.png');
      // A finished job shows the whole timeline, from queued to removed.
      await go(page, base, '#/jobs?state=completed');
      await page.click('#jobs-body tr:first-child .ds-table__row-link');
      await page.waitForTimeout(1000);
      await shot(page, 'jobs-timeline.png', { upTo: '#sheet .ds-timeline', max: 1300 });
      await page.keyboard.press('Escape');
      await go(page, base, '#/workers');
      await shot(page, 'workers.png', { upTo: 'section:has(h2:text-is("By tier"))' });
      await go(page, base, '#/repositories');
      await shot(page, 'repositories.png', { upTo: '#accounts > section' });
      await go(page, base, '#/settings');
      await shot(page, 'settings.png', { upTo: 'section:has(#runner-title)' });
    }
    await context.close();
  }

  const { context, page } = await open(base, { width: 390, height: 844, scale: 2 });
  await go(page, base, '#/overview');
  await shot(page, 'phone-overview.png');
  await go(page, base, '#/workers');
  await shot(page, 'phone-workers.png');
  await context.close();
  stop();
}

// ── GIF helpers ───────────────────────────────────────────────────────

// A recorder takes screenshots in a loop. Lossless frames of a flat interface
// make GIFs several times smaller (and sharper) than a lossy screen video.
// mark('wait') and mark('show') split the recording: waits play fast. While
// paused (for a still in another size), nothing is recorded.
function recorder(page, every = 100) {
  const dir = fs.mkdtempSync(path.join(tmp, 'frames-'));
  const frames = []; // [file, seconds since the start]
  const marks = [['show', 0]];
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  let on = true;
  let paused = false;
  let busy = Promise.resolve();
  const loop = (async () => {
    while (on) {
      if (paused) {
        await sleep(20);
        continue;
      }
      const at = now();
      const file = path.join(dir, `${String(frames.length).padStart(5, '0')}.png`);
      busy = page.screenshot({ path: file }).then(() => frames.push([file, at]), () => { /* navigating */ });
      await busy;
      await sleep(Math.max(0, every - (now() - at) * 1000));
    }
  })();
  return {
    mark(kind) { marks.push([kind, now()]); },
    async pause() {
      paused = true;
      await busy;
      marks.push(['skip', now()]);
    },
    resume() {
      marks.push(['show', now()]);
      paused = false;
    },
    async stop() {
      on = false;
      await loop;
      marks.push(['end', now()]);
      return { frames, marks };
    },
  };
}

// gif turns a recording into docs/images/<name>: `width` pixels wide, waits
// `fast` times faster, pauses cut out, the last frame held for `hold` seconds.
function gif({ frames, marks }, name, { width = 800, fps = 10, fast = 6, hold = 2 } = {}) {
  const rate = { show: 1, wait: 1 / fast, skip: 0, end: 0 };
  // How long the stretch from a to b plays in the GIF.
  const played = (a, b) => marks.reduce((sum, [kind, from], i) => {
    const to = i + 1 < marks.length ? marks[i + 1][1] : Infinity;
    return sum + Math.max(0, Math.min(b, to) - Math.max(a, from)) * rate[kind];
  }, 0);
  const lines = [];
  frames.forEach(([file, t], i) => {
    const d = i + 1 < frames.length ? played(t, frames[i + 1][1]) : hold;
    if (d >= 0.001) lines.push(`file '${file}'`, `duration ${d.toFixed(3)}`);
  });
  lines.push(`file '${frames[frames.length - 1][0]}'`); // the concat demuxer needs the last one twice
  const list = path.join(tmp, `${name}.txt`);
  fs.writeFileSync(list, lines.join('\n') + '\n');
  const file = path.join(out, name);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-lavfi',
    `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];` +
    '[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle', file]);
  log(`${name} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
}

// ── The first-run assistant on a fresh demo ───────────────────────────

async function setup() {
  const { base, stop } = await demo(18081, { CI_PLANE_DEMO_FRESH: '1', CI_PLANE_DEMO_SPEED: '3' });
  const size = { width: 1200, height: 860 };
  const { context, page } = await open(base, size);
  const clock = recorder(page);
  const type = (sel, text) => page.locator(sel).pressSequentially(text, { delay: 35 });
  // A still shows the whole step: the window grows to the height of the page.
  const still = async (name) => {
    await clock.pause();
    const height = await page.evaluate(() => {
      const main = document.querySelector('#main');
      const bottom = Math.max(...[...main.children].map((c) => c.getBoundingClientRect().bottom));
      return bottom + main.scrollTop + 32;
    });
    await page.setViewportSize({ width: size.width, height: Math.min(2400, Math.max(size.height, Math.ceil(height))) });
    await page.mouse.move(0, 0); // no hover state in the picture
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, name) });
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    clock.resume();
    log(name);
  };

  clock.mark('wait');
  await page.waitForSelector('#password-form');
  clock.mark('show');
  await page.waitForTimeout(800);
  await still('setup-1-password.png');
  await type('#pw-new', 'correct horse battery');
  await type('#pw-repeat', 'correct horse battery');
  await page.click('#password-form [type=submit]');

  await page.waitForSelector('#cf-form');
  await page.waitForTimeout(700);
  await type('#cf-token', 'demo-api-token-1234567890abcdef');
  await page.click('[data-act="cf-zones"]');
  await page.waitForSelector('#cf-sub');
  await page.fill('#cf-emails', '');
  await type('#cf-emails', 'ada@acme-labs.dev');
  await page.waitForTimeout(400);
  await still('setup-2-cloudflare.png');
  await page.click('[data-act="cf-setup"]');
  await page.waitForSelector('#cf-task');
  await page.waitForTimeout(1500);
  clock.mark('wait');
  await page.waitForSelector('text=The tunnel is up', { timeout: 60000 });
  clock.mark('show');
  await page.waitForTimeout(1500);
  await page.click('[data-step="3"]');

  await page.waitForSelector('#gh-form');
  await page.check('input[name="gh-kind"][value="org"]', { force: true });
  await type('#gh-org', 'acme-labs');
  await page.waitForTimeout(500);
  await still('setup-3-github.png');
  await page.click('[data-act="gh-go"]');
  await page.waitForURL(/demo\/github\/new/);
  await page.waitForTimeout(1200);
  await page.click('a:has-text("Create GitHub App")');
  await page.waitForURL(/demo\/github\/install/);
  await page.waitForTimeout(1200);
  await page.click('a:has-text("Install")');
  await page.waitForSelector('text=GitHub is connected', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.click('[data-step="4"]');

  await page.waitForSelector('#connect-form');
  await page.waitForTimeout(900);
  await page.click('[data-copy="setup-command"]');
  await page.waitForTimeout(600);
  await type('#wk-host', 'build-01.lan');
  await page.click('[data-act="wk-check"]');
  await page.waitForSelector('#add-form', { timeout: 30000 });
  await page.locator('#add-form').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await still('setup-4-worker.png');
  await page.click('[data-act="wk-add"]');
  await page.waitForTimeout(1500);
  clock.mark('wait');
  await page.waitForSelector('text=is ready', { timeout: 120000 });
  clock.mark('show');
  await page.waitForTimeout(1500);
  await page.click('text=Next: try it');

  await page.waitForSelector('#snippet');
  await page.waitForTimeout(1500);
  clock.mark('wait');
  await page.waitForSelector('text=The first job arrived', { timeout: 180000 });
  clock.mark('show');
  await page.waitForTimeout(2500);
  await still('setup-5-try.png');
  await page.click('[data-act="finish"]');
  await page.waitForSelector('#tiles');
  await page.waitForTimeout(3000);

  const recording = await clock.stop();
  await context.close();
  stop();
  gif(recording, 'setup.gif');
}

// ── Live jobs on a running demo ───────────────────────────────────────

async function live() {
  const { base, stop } = await demo(18082, { CI_PLANE_DEMO_SPEED: '3' });
  await sleep(8000); // past the start, into the rhythm
  const { context, page } = await open(base, { width: 1200, height: 760 });
  const clock = recorder(page);
  clock.mark('wait');
  await go(page, base, '#/overview', 400);
  clock.mark('show');
  await page.waitForTimeout(10000);
  await go(page, base, '#/jobs', 600);
  await page.waitForTimeout(9000);
  await page.click('#jobs-body tr:first-child .ds-table__row-link');
  await page.waitForTimeout(5000);
  const recording = await clock.stop();
  await context.close();
  stop();
  gif(recording, 'live.gif', { hold: 0.5 });
}

try {
  if (want('stills')) await stills();
  if (want('setup')) await setup();
  if (want('live')) await live();
} finally {
  await browser.close();
  stopAll();
  if (process.env.KEEP_TMP) log(`kept the recordings in ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}
