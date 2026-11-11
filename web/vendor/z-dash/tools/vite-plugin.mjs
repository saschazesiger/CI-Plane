/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Z-Dash for Vite, without dependencies: the scan of
 * tools/bundle.mjs over the files Vite transforms, served as two virtual
 * modules.
 *
 *   // vite.config.js
 *   import zDash from './vendor/z-dash/tools/vite-plugin.mjs';
 *   export default { plugins: [zDash({ config: 'ds.config.json' })] };
 *
 *   // main.js
 *   import 'virtual:z-dash.css';
 *   import DS from 'virtual:z-dash.js';
 *
 * Options: `config` (a ds.config.json path relative to Vite's root, or the
 * config itself; default ds.config.json when it exists), `dist` (the copy;
 * default the one this file sits in), and any config key (`content`,
 * `safelist`, `minify`, `js`, `icons`) to override it. `content` is
 * scanned at buildStart (default index.html); every module Vite then
 * transforms, and every HTML page, is scanned too. In dev a change that
 * needs other components updates the stylesheet (or reloads the page for
 * the script). In a build the stylesheet is made at buildStart from
 * `content`: a name that only a later module uses is a warning (an error
 * with `strict: true`), so list every source folder in `content`.
 *
 * The script module is the classic bundle (window.DS, its default export)
 * or, with "js": "esm", an entry that re-exports the modules by name.
 * Copied to dist/tools/ by scripts/build.mjs; plain ES2022.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandGlobs, globRegExp, loadCopy, readConfig, renderBundle, resolveBundle, scanText } from './bundle.mjs';

export const CSS_ID = 'virtual:z-dash.css';
export const JS_ID = 'virtual:z-dash.js';
const RESOLVED_CSS = `\0${CSS_ID}`;
const RESOLVED_JS = `\0${JS_ID}`;
const SCANNED = /\.(html?|[cm]?[jt]sx?|vue|svelte|astro|mdx?)$/;
const OPTION_KEYS = ['content', 'safelist', 'minify', 'js', 'icons'];

const posix = (path) => path.split(sep).join('/');

/** The plugin (see the file comment). */
export default function zDash(options = {}) {
  let root = process.cwd();
  let command = 'serve';
  let copy = null;
  let config = null;
  let server = null;
  let rendered = null;
  let distRoot = '';
  const scans = new Map();
  const late = new Set();

  const setup = () => {
    let raw = options.config ?? 'ds.config.json';
    let base = root;
    if (typeof raw === 'string') {
      const path = resolve(root, raw);
      if (existsSync(path)) {
        raw = JSON.parse(readFileSync(path, 'utf8'));
        base = dirname(path);
      } else if (options.config !== undefined) throw new Error(`z-dash: no config at ${path}`);
      else raw = {};
    }
    const merged = { content: ['index.html'], ...raw };
    for (const key of OPTION_KEYS) if (options[key] !== undefined) merged[key] = options[key];
    delete merged.out;
    config = readConfig(merged);
    config.base = base;
    distRoot = options.dist ? resolve(root, options.dist) : config.dist ? resolve(base, config.dist) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
    copy = loadCopy({ dist: distRoot });
  };

  const rel = (file) => posix(relative(config.base, file));
  const ignored = (file) => file.includes('/node_modules/') || file.startsWith(`${posix(distRoot)}/`) || !SCANNED.test(file);

  const resolveAll = () => resolveBundle([...scans.values()].sort((a, b) => (a.file < b.file ? -1 : 1)), copy, config);
  const render = () => {
    const resolved = resolveAll();
    rendered = { ...renderBundle(resolved, copy, { entry: 'vite', minify: config.minify, js: config.js, jsBase: posix(distRoot) }), resolved };
    return rendered;
  };

  /** Errors fail a build and warn in dev (the page keeps running while the name is fixed). */
  const report = (context, errors) => {
    const say = command === 'build' ? context.error?.bind(context) : context.warn?.bind(context);
    for (const problem of errors) (say ?? console.warn)(`z-dash: ${problem}`);
  };

  const update = (cssBefore, jsBefore) => {
    if (!server) return;
    const graph = server.moduleGraph;
    const css = graph.getModuleById(RESOLVED_CSS);
    const js = graph.getModuleById(RESOLVED_JS);
    if (css) graph.invalidateModule(css);
    if (js) graph.invalidateModule(js);
    if (js && jsBefore !== rendered.js) server.ws.send({ type: 'full-reload' });
    else if (css && cssBefore !== rendered.css) {
      if (typeof server.reloadModule === 'function') server.reloadModule(css);
      else server.ws.send({ type: 'full-reload' });
    }
  };

  /** Scans one file Vite hands over; in dev the virtual modules follow, in a build late names are noted. */
  const onFile = (context, file, text) => {
    const path = rel(file);
    const before = scans.get(path);
    const next = scanText(text.replace(/\r\n/g, '\n'), path, copy);
    scans.set(path, next);
    if (before && JSON.stringify(before) === JSON.stringify(next)) return;
    report(context, resolveBundle([next], copy, config).errors.filter((problem) => problem.startsWith(`${path}:`)));
    if (!rendered) return;
    if (command === 'build') {
      const resolved = resolveAll();
      for (const [name, reason] of resolved.components) if (!rendered.resolved.components.has(name)) late.add(`component ${name} (${reason})`);
      for (const [name, reason] of resolved.modules) if (!rendered.resolved.modules.has(name)) late.add(`module ${name} (${reason})`);
      for (const [name, reason] of resolved.icons) if (!rendered.resolved.icons.has(name)) late.add(`icon ${name} (${reason})`);
      return;
    }
    const previous = rendered;
    render();
    if (previous.css !== rendered.css || previous.js !== rendered.js) update(previous.css, previous.js);
  };

  return {
    name: 'z-dash',
    enforce: 'pre',

    configResolved(resolved) {
      root = resolved.root ?? root;
      command = resolved.command ?? command;
      setup();
    },

    buildStart() {
      if (!copy) setup();
      scans.clear();
      late.clear();
      const copyDir = posix(relative(config.base, distRoot));
      for (const file of expandGlobs(config.base, config.content, (path) => path === copyDir || path.startsWith(`${copyDir}/`))) {
        const path = resolve(config.base, file);
        scans.set(file, scanText(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), file, copy));
        if (typeof this.addWatchFile === 'function') this.addWatchFile(path);
      }
      report(this, render().resolved.errors);
    },

    resolveId(id) {
      if (id === CSS_ID) return RESOLVED_CSS;
      if (id === JS_ID) return RESOLVED_JS;
      return null;
    },

    load(id) {
      if (id === RESOLVED_CSS) return rendered.css;
      if (id !== RESOLVED_JS) return null;
      if (config.js === 'classic') return `${rendered.js}\nexport default globalThis.ZDash.versions['${copy.manifest.version}'];\n`;
      if (config.js === 'esm') return rendered.js;
      return 'export default undefined;\n';
    },

    transform(code, id) {
      const file = id.split('?')[0];
      if (id.startsWith('\0') || !isAbsolute(file) || ignored(posix(file))) return null;
      onFile(this, file, code);
      return null;
    },

    transformIndexHtml(html, context) {
      if (context?.filename) onFile(this, context.filename, html);
      return html;
    },

    configureServer(devServer) {
      server = devServer;
      const watch = (file) => {
        const path = rel(file);
        if (!config.content.some((glob) => !glob.startsWith('!') && globRegExp(glob).test(path)) || !existsSync(file)) return;
        onFile({ warn: (message) => devServer.config?.logger?.warn?.(message) ?? console.warn(message) }, file, readFileSync(file, 'utf8'));
      };
      devServer.watcher?.on?.('change', watch);
      devServer.watcher?.on?.('add', watch);
    },

    buildEnd() {
      if (command !== 'build' || !late.size) return;
      const message = `z-dash: the stylesheet was made at buildStart from "content", and these names first appeared in modules outside it: ${[...late].join(', ')}. Add their folders to "content".`;
      if (options.strict) this.error(message);
      else this.warn(message);
    },
  };
}
