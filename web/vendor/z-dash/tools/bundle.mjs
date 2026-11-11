#!/usr/bin/env node
/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Writes a project's Z-Dash bundle: only the stylesheets, modules
 * and icons the project uses, without dependencies (Node 22 or later).
 *
 *   node <copy>/tools/bundle.mjs [--config ds.config.json] [--dist <copy>] [--out <dir>]
 *                                [--check] [--report] [--dry-run]
 *
 * It reads the manifest.json of the copy it sits in (../manifest.json), or
 * of the copy --dist (or the config's "dist") names.
 *
 * ds.config.json (paths and globs relative to the config file; globs know
 * `*`, `**`, `?`, `{a,b}` and a leading `!` that excludes):
 *   {
 *     "content": ["src/**\/*.{html,js,ts,tsx}"],   the files to scan
 *     "out": "public/ds",                          where the bundle goes (default: the config's folder)
 *     "entries": { "admin": ["admin/**"] },        one bundle per entry, ds.<entry>.* (content is scanned for each)
 *     "safelist": ["ds-btn--*", "component:chart", "module:dom", "icon:check"],
 *     "minify": true,                              the .min.css files of the copy, the script without
 *                                                  comments (js-wrap.mjs stripComments; default true)
 *     "js": "classic",                             "classic" (window.DS), "esm" (an entry module) or false
 *     "icons": "auto"                              "auto" (the names the scan finds), "all", or [names] added to them
 *   }
 *
 * Output, per entry (ds.bundle.* without entries): ds.<entry>.css (the layer
 * statement, the sublayer statement, the core, the components in manifest
 * order), ds.<entry>.js and ds.<entry>.json (the report: every component,
 * module and icon with the reason it is in, sizes), plus properties.css
 * (the @property rules, for a widget in a shadow root: link it in the host
 * document).
 *
 * The scan reads every file as plain text: complete ds-* class names and
 * data-ds-* attributes (and data-tip) against the manifest, DS.<module>.<export> (DS.init,
 * DS.get, DS.define and DS.config are the core's) and imports of js/<module>.js and of the
 * React adapter's react/<file>.js (manifest.json "react": the stylesheets that file renders), and icon names (DS.icons.<name>,
 * icon('<name>'), data-icon / data-ds-icon="<name>", named imports of
 * js/icons.js). A class built at run time ('ds-btn--' + kind,
 * `ds-${name}`) is an error with its file and line, unless a safelist
 * glob covers it; so is an icon name it cannot read, unless "icons" is
 * "all" or a list.
 *
 *   --check    write nothing; exit 1 with a summary when the written bundle is
 *              stale or misses a class the scan finds (CI)
 *   --report   print every component, module and icon with its reason
 *   --dry-run  print what would be written, write nothing
 *
 * Exit 0 when done, 1 on a scan error or a stale bundle (--check), 2 on a
 * configuration error. Copied to dist/tools/ by scripts/build.mjs; plain ES2022.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { classicScript, stripComments } from './js-wrap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOMEPAGE = 'https://github.com/saschazesiger/Z-Dash';
const CONFIG_KEYS = ['$schema', 'content', 'out', 'entries', 'safelist', 'minify', 'js', 'icons', 'dist'];
const SKIP_DIRS = new Set(['node_modules', '.git']);
/** Icon helpers of the icons module: exports that are not glyphs. */
const ICON_HELPERS = new Set(['icon', 'iconElement', 'fill', 'ICON_SIZE']);
/** The exports of the core that ds.js and every classic bundle also put on DS itself: DS.init(document). */
const CORE_ALIASES = new Set(['init', 'get', 'define', 'config']);

const posix = (path) => path.split(sep).join('/');
const unique = (list) => [...new Set(list)];

/** A configuration or manifest problem (exit 2). */
export class ConfigError extends Error {}

// ── Globs ────────────────────────────────────────────────────────────────

/** A glob (`*`, `**`, `?`, `{a,b}`, `[...]`) as a regular expression over posix paths. */
export function globRegExp(glob) {
  let pattern = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      pattern += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else if (char === '{') { braces += 1; pattern += '(?:'; }
    else if (char === '}' && braces > 0) { braces -= 1; pattern += ')'; }
    else if (char === ',' && braces > 0) pattern += '|';
    else if (char === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) pattern += '\\[';
      else {
        pattern += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else pattern += char.replace(/[.+^$()|\\\]]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

/** The folder part of a glob before its first wildcard (where a walk can start). */
function globBase(glob) {
  const parts = glob.split('/');
  const base = [];
  for (const part of parts.slice(0, -1)) {
    if (/[*?{[]/.test(part)) break;
    base.push(part);
  }
  return base.join('/');
}

function walk(root, dir, skip, out) {
  let names;
  try {
    names = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const path = dir ? `${dir}/${name}` : name;
    if (skip(path)) continue;
    let stat;
    try {
      stat = statSync(join(root, path));
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(root, path, skip, out);
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

/**
 * The files under `root` that the globs match (posix, relative, sorted);
 * a glob that starts with `!` excludes. `skip(path)` leaves a file or folder
 * out (the copy, the bundle itself).
 */
export function expandGlobs(root, globs, skip = () => false) {
  const include = globs.filter((glob) => !glob.startsWith('!')).map((glob) => glob.replace(/^\.\//, ''));
  const exclude = globs.filter((glob) => glob.startsWith('!')).map((glob) => globRegExp(glob.slice(1).replace(/^\.\//, '')));
  const found = new Set();
  for (const glob of include) {
    const pattern = globRegExp(glob);
    const base = globBase(glob);
    if (!/[*?{[]/.test(glob)) {
      if (existsSync(join(root, glob)) && statSync(join(root, glob)).isFile() && !skip(glob)) found.add(glob);
      continue;
    }
    for (const path of walk(root, base, skip, [])) if (pattern.test(path)) found.add(path);
  }
  return [...found].filter((path) => !exclude.some((pattern) => pattern.test(path))).sort();
}

// ── The copy ─────────────────────────────────────────────────────────────

/**
 * The copy a bundle is made from: its manifest and everything the scan and
 * the output need, read once.
 * @param {{ dist?: string, manifest?: object|string }} options
 */
export function loadCopy({ dist = resolve(HERE, '..'), manifest } = {}) {
  const root = resolve(dist);
  let data = manifest;
  if (data === undefined || typeof data === 'string') {
    const path = data === undefined ? join(root, 'manifest.json') : resolve(data);
    if (!existsSync(path)) throw new ConfigError(`no manifest at ${path}: point --dist at a copy of Z-Dash 3 (its folder holds manifest.json)`);
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new ConfigError(`${path}: ${error.message}`);
    }
  }
  for (const key of ['version', 'layers', 'core', 'order', 'components']) {
    if (data[key] === undefined) throw new ConfigError(`manifest.json: "${key}" is missing`);
  }
  const read = (path) => {
    const file = join(root, path);
    if (!existsSync(file)) throw new ConfigError(`the copy has no ${path} (manifest.json names it)`);
    return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  };
  const classes = new Map();
  const attributes = new Map();
  const keyframes = new Set();
  const note = (map, name, component) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(component);
  };
  for (const [name, component] of Object.entries(data.components)) {
    for (const cls of component.classes ?? []) note(classes, cls, name);
    for (const attribute of component.attributes ?? []) note(attributes, attribute, name);
    // [data-tip] has no data-ds- prefix and no stylesheet names it, so neither meta.json nor the module list says it.
    if (name === 'tooltip') note(attributes, 'data-tip', name);
    for (const frames of component.keyframes ?? []) keyframes.add(frames);
  }
  const coreCss = (data.core.css ?? []).map((path) => ({ path, text: read(path) }));
  const coreClasses = new Set();
  for (const { text } of coreCss) {
    const plain = text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of plain.replace(/\{[^{}]*\}/g, '{}').matchAll(/\.(ds-[\w-]+)/g)) if (!classes.has(match[1])) coreClasses.add(match[1]);
    for (const match of plain.matchAll(/@keyframes\s+(ds-[\w-]+)/g)) keyframes.add(match[1]);
  }
  const modules = new Map(Object.entries(data.js ?? {}));
  // Attributes that need a module whatever they sit on ([data-ds-close] and the overlay core).
  const moduleAttributes = new Map();
  for (const [name, module] of modules) for (const attribute of module.attributes ?? []) note(moduleAttributes, attribute, name);
  const iconsModule = modules.get('icons');
  const iconSource = iconsModule ? read(iconsModule.file) : '';
  const glyphs = new Set(glyphNames(iconSource));
  // Glyphs the modules of the copy import from the icons module themselves (a snackbar's close button).
  const moduleGlyphs = new Map();
  for (const [name, module] of modules) {
    if (name === 'icons') continue;
    const source = read(module.file);
    const used = [];
    for (const match of source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/icons\.js['"]/gm)) {
      for (const part of match[1].split(',')) {
        const id = part.trim().split(/\s+as\s+/)[0];
        if (glyphs.has(id)) used.push(id);
      }
    }
    moduleGlyphs.set(name, used);
  }
  // The React adapter's files (react/<name>.js): the stylesheets each needs, since the classes sit in the adapter, not the project.
  const react = new Map(Object.entries(data.react ?? {}));
  return { root, manifest: data, read, classes, attributes, moduleAttributes, keyframes, coreClasses, modules, glyphs, iconSource, moduleGlyphs, react };
}

/** The glyph exports of an icons module: `export const name = '<...>';`. */
export function glyphNames(source) {
  return [...source.matchAll(/^export const ([\w$]+) = '</gm)].map((match) => match[1]).filter((name) => !ICON_HELPERS.has(name));
}

// ── Scan ─────────────────────────────────────────────────────────────────

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/**
 * The React adapter files an import specifier names, as [file, entry]
 * pairs: one, or for react/index.js the files of the names imported from it
 * (every file when the import names none, or is a namespace).
 */
function adapterFiles(specifier, names, copy) {
  if (!copy.react?.size) return [];
  const path = specifier.replace(/[?#].*$/, '');
  const hit = [...copy.react].find(([file]) => path === file || path.endsWith(`/${file}`));
  if (!hit) return [];
  if (!hit[0].endsWith('/index.js')) return [hit];
  return [...copy.react].filter(([file, entry]) => file !== hit[0] && (!names?.length || entry.exports.some((name) => names.includes(name))));
}

/** The module of the copy an import specifier names, or null. */
function moduleOf(specifier, copy) {
  const path = specifier.replace(/[?#].*$/, '');
  for (const [name, module] of copy.modules) {
    if (path === module.file || path.endsWith(`/${module.file}`)) return name;
  }
  return null;
}

const camelToKebab = (name) => name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

/**
 * Everything one file uses, as plain text (see the file comment).
 * @returns {{ file: string, uses: { kind: string, name: string, module?: string, line: number }[],
 *            partials: { line: number, prefix: string, text: string }[], dynamicIcons: { line: number, text: string }[],
 *            unknown: { kind: string, name: string, line: number }[] }}
 */
export function scanText(text, file, copy) {
  const line = lineIndex(text);
  const uses = [];
  const partials = [];
  const dynamicIcons = [];
  const unknown = [];
  const use = (kind, name, offset, extra = {}) => uses.push({ kind, name, line: line(offset), ...extra });
  const icon = (name, offset) => {
    if (copy.glyphs.has(name)) use('icon', name, offset);
    else unknown.push({ kind: 'icon', name, line: line(offset) });
  };

  // Classes, keyframes, and names built at run time.
  /** The line around a match, at most about 80 characters of it. */
  const excerpt = (offset, length) => {
    const lineStart = text.lastIndexOf('\n', offset) + 1;
    const lineEnd = text.indexOf('\n', offset) < 0 ? text.length : text.indexOf('\n', offset);
    const start = lineEnd - lineStart > 80 ? Math.max(lineStart, offset - 30) : lineStart;
    return text.slice(start, Math.min(lineEnd, start + Math.max(80, offset - start + length + 20))).trim();
  };
  for (const match of text.matchAll(/(?<![\w$-])ds-[\w-]*/g)) {
    const token = match[0];
    const after = text.slice(match.index + token.length, match.index + token.length + 40);
    const quote = text[match.index - 1] ?? '';
    // 'ds-btn--' + kind, `ds-${name}`, 'ds-btn' + suffix (but 'ds-btn ' + other is a list of whole names).
    const built = /[-_]$/.test(token) || after.startsWith('${')
      || (/['"`]/.test(quote) && after.startsWith(quote) && /^.\s*\+\s*(?!['"`]\s)/.test(after));
    if (built) {
      partials.push({ line: line(match.index), prefix: token, text: excerpt(match.index, token.length) });
      continue;
    }
    if (copy.classes.has(token) || copy.coreClasses.has(token)) use('class', token, match.index);
    else if (copy.keyframes.has(token)) use('keyframes', token, match.index);
    else unknown.push({ kind: 'class', name: token, line: line(match.index) });
  }

  // Attributes, written or read through dataset.
  const knownAttribute = (name) => copy.attributes.has(name) || copy.moduleAttributes?.has(name);
  for (const match of text.matchAll(/(?<![\w-])data-ds-[\w-]*[\w]/g)) {
    if (knownAttribute(match[0])) use('attribute', match[0], match.index);
  }
  for (const match of text.matchAll(/(?<![\w-])data-tip(?![\w-])|\bdataset\.tip\b/g)) {
    if (knownAttribute('data-tip')) use('attribute', 'data-tip', match.index);
  }
  for (const match of text.matchAll(/\bdataset\.ds([A-Z][\w$]*)/g)) {
    const name = `data-ds${camelToKebab(match[1])}`;
    if (knownAttribute(name)) use('attribute', name, match.index);
  }

  // DS.<module>.<export>, DS.<module>['<export>'], DS.<module>[<dynamic>], const { a } = DS.<module>.
  for (const match of text.matchAll(/(?<![\w$])DS\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*(['"])([\w$]+)\3\s*\]|(\s*\[))?/g)) {
    const [, module, dotted, , quoted, dynamic] = match;
    if (module === 'version') continue;
    if (CORE_ALIASES.has(module) && copy.modules.has('core') && (copy.modules.get('core').exports ?? []).includes(module)) {
      use('export', module, match.index, { module: 'core' });
      continue;
    }
    if (!copy.modules.has(module)) {
      unknown.push({ kind: 'module', name: `DS.${module}`, line: line(match.index) });
      continue;
    }
    const member = dotted ?? quoted;
    const exportsOf = copy.modules.get(module).exports ?? [];
    if (member && (module !== 'icons' || ICON_HELPERS.has(member)) && exportsOf.includes(member)) {
      use('export', member, match.index, { module });
      continue;
    }
    use('module', module, match.index);
    if (module === 'icons') {
      if (member) icon(member, match.index);
      else if (dynamic) dynamicIcons.push({ line: line(match.index), text: excerpt(match.index, 12) });
    } else if (member) unknown.push({ kind: 'export', name: `DS.${module}.${member}`, line: line(match.index) });
  }
  for (const match of text.matchAll(/\{([^{}]*)\}\s*=\s*DS\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*[.[])/g)) {
    const module = match[2];
    if (!copy.modules.has(module)) continue;
    for (const part of match[1].split(',')) {
      const id = part.trim().split(/\s*:\s*/)[0].trim();
      if (!id) continue;
      if (module === 'icons') {
        if (!ICON_HELPERS.has(id)) icon(id, match.index);
      } else if ((copy.modules.get(module).exports ?? []).includes(id)) use('export', id, match.index, { module });
    }
  }

  // ES imports of the copy's modules (and the names they import).
  const namespaces = [];
  for (const match of text.matchAll(/\b(?:import|export)\s*(?:type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+)|\*)?\s*from\s*(['"])([^'"\n]+)\4|\bimport\s*(?:\(\s*)?(['"])([^'"\n]+)\6/g)) {
    const specifier = match[5] ?? match[7];
    const glyph = /(?:^|\/)js\/icons\/([\w$]+)\.js$/.exec(specifier.replace(/[?#].*$/, ''));
    const via = `import '${specifier}'`;
    if (glyph && copy.modules.has('icons')) {
      use('module', 'icons', match.index, { via });
      icon(glyph[1], match.index);
      continue;
    }
    // An adapter component: the stylesheets it renders (and those its modules always need); its modules load themselves.
    const names = match[2]?.split(',').map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean);
    const adapters = adapterFiles(specifier, names, copy);
    if (adapters.length) {
      for (const [, entry] of adapters) {
        const needed = new Set(entry.components ?? []);
        for (const name of entry.modules ?? []) for (const other of copy.modules.get(name)?.requires ?? []) needed.add(other);
        for (const name of needed) use('component', name, match.index, { via });
      }
      continue;
    }
    const module = moduleOf(specifier, copy);
    if (!module) continue;
    use('module', module, match.index, { via });
    if (match[2]) {
      for (const part of match[2].split(',')) {
        const id = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
        if (!id) continue;
        if (module === 'icons') {
          if (!ICON_HELPERS.has(id)) icon(id, match.index);
        } else if ((copy.modules.get(module).exports ?? []).includes(id)) use('export', id, match.index, { module, via: `import { ${id} }` });
      }
    }
    if (match[3]) namespaces.push({ id: match[3], module });
  }
  for (const { id, module } of namespaces) {
    for (const match of text.matchAll(new RegExp(`(?<![\\w$.])${id.replace(/\$/g, '\\$')}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) {
      const member = match[1];
      if (module === 'icons') {
        if (!ICON_HELPERS.has(member)) icon(member, match.index);
      } else if ((copy.modules.get(module).exports ?? []).includes(member)) use('export', member, match.index, { module });
    }
  }

  // Icon names in markup and calls: a name the scan cannot read is an error unless "icons" lists the glyphs.
  for (const match of text.matchAll(/(?<![\w-])data-(?:ds-)?icon\s*=\s*(?:(['"])([^'"\n]*)\1|\{\s*(['"])([^'"\n]*)\3\s*\}|([A-Za-z_$][\w$]*)(?=[\s/>]|$)|(\S))/g)) {
    const value = match[2] ?? match[4] ?? match[5];
    if (value !== undefined && /^[A-Za-z_$][\w$]*$/.test(value)) icon(value, match.index);
    else dynamicIcons.push({ line: line(match.index), text: excerpt(match.index, match[0].length) });
  }
  for (const match of text.matchAll(/\bsetAttribute\(\s*(['"])data-(?:ds-)?icon\1\s*,\s*(?:(['"])([\w$]+)\2)?|\bdataset\.(?:dsIcon|icon)\s*=(?!=)\s*(?:(['"])([\w$]+)\4)?/g)) {
    const value = match[3] ?? match[5];
    if (value) icon(value, match.index);
    else dynamicIcons.push({ line: line(match.index), text: excerpt(match.index, match[0].length) });
  }
  for (const match of text.matchAll(/(?<![\w$])icon(?:Element)?\(\s*(['"])([A-Za-z_$][\w$]*)\1/g)) icon(match[2], match.index);

  return { file, uses, partials, dynamicIcons, unknown };
}

// ── Resolve ──────────────────────────────────────────────────────────────

/** A safelist entry: "component:<name>", "module:<name>", "icon:<name>" or a class glob. */
function readSafelist(safelist, copy) {
  const result = { components: [], modules: [], icons: [], globs: [], errors: [] };
  for (const entry of safelist) {
    const kind = /^(component|module|icon):(.+)$/.exec(entry);
    if (kind) {
      const [, type, name] = kind;
      const known = type === 'component' ? name in copy.manifest.components : type === 'module' ? copy.modules.has(name) : copy.glyphs.has(name);
      if (!known) result.errors.push(`safelist: no ${type} "${name}" in the copy`);
      else result[`${type}s`].push(name);
    } else result.globs.push({ glob: entry, pattern: globRegExp(entry) });
  }
  return result;
}

/** True when a safelist glob covers every class a name built from `prefix` could become. */
function covered(prefix, safe, copy, safeClasses) {
  for (const { glob } of safe.globs) {
    const star = glob.search(/[*?{[]/);
    if (star >= 0 && prefix.startsWith(glob.slice(0, star)) && glob.slice(star) === '*') return true;
  }
  const candidates = [...copy.classes.keys()].filter((name) => name.startsWith(prefix));
  return candidates.length > 0 && candidates.every((name) => safeClasses.has(name));
}

/**
 * What a bundle holds for a set of scans: every component, module and icon
 * with the reason it is in, the classes the scan found, and the errors.
 */
export function resolveBundle(scans, copy, { safelist = [], icons = 'auto' } = {}) {
  const { manifest } = copy;
  const components = new Map();
  const modules = new Map();
  const iconNames = new Map();
  const classes = new Map();
  const errors = [];
  const warnings = [];
  const unknown = new Map();
  const queue = [];
  // A component the page uses brings its behaviour modules; one that only another component's CSS requires (a list
  // styles a .ds-meter it may hold) brings its stylesheet alone: its behaviour is found by the attributes the page
  // writes, like any other. Otherwise a list would carry the whole chart engine.
  const used = new Set();
  const addComponent = (name, reason) => {
    const direct = !reason.startsWith('required by ');
    if (components.has(name)) {
      if (direct && !used.has(name)) {
        used.add(name);
        for (const module of manifest.components[name].js ?? []) addModule(module, `needed by ${name}`);
      }
      return;
    }
    if (!(name in manifest.components)) {
      errors.push(`manifest.json: ${reason} names the component "${name}", which the copy does not have`);
      return;
    }
    components.set(name, reason);
    if (direct) used.add(name);
    queue.push({ type: 'component', name });
  };
  const addModule = (name, reason) => {
    if (modules.has(name)) return;
    if (!copy.modules.has(name)) {
      errors.push(`manifest.json: ${reason} names the module "${name}", which the copy does not have`);
      return;
    }
    modules.set(name, reason);
    queue.push({ type: 'module', name });
  };

  const safe = readSafelist(safelist, copy);
  errors.push(...safe.errors);
  const safeClasses = new Set();
  for (const name of safe.components) for (const cls of manifest.components[name].classes ?? []) safeClasses.add(cls);
  for (const { pattern } of safe.globs) for (const cls of copy.classes.keys()) if (pattern.test(cls)) safeClasses.add(cls);

  if (copy.modules.has('core')) addModule('core', 'always included');
  const exportUses = [];
  for (const scan of scans) {
    for (const entry of scan.uses) {
      const where = `${scan.file}:${entry.line}`;
      if (entry.kind === 'class') {
        if (!classes.has(entry.name)) classes.set(entry.name, where);
        for (const name of copy.classes.get(entry.name) ?? []) addComponent(name, `${where} ${entry.name}`);
      } else if (entry.kind === 'attribute') {
        for (const name of copy.attributes.get(entry.name) ?? []) addComponent(name, `${where} ${entry.name}`);
        for (const name of copy.moduleAttributes?.get(entry.name) ?? []) addModule(name, `${where} ${entry.name}`);
      } else if (entry.kind === 'component') addComponent(entry.name, `${where} ${entry.via}`);
      else if (entry.kind === 'module') addModule(entry.name, `${where} ${entry.via ?? `DS.${entry.name}`}`);
      else if (entry.kind === 'export') {
        const via = entry.via ?? `DS.${entry.module}.${entry.name}`;
        addModule(entry.module, `${where} ${via}`);
        exportUses.push({ module: entry.module, name: entry.name, where, via });
      } else if (entry.kind === 'icon') {
        if (!iconNames.has(entry.name)) iconNames.set(entry.name, where);
      }
    }
    for (const partial of scan.partials) {
      if (!covered(partial.prefix, safe, copy, safeClasses)) {
        errors.push(`${scan.file}:${partial.line} a class name built at run time (${partial.text}): the scan sees only complete names; write them out or add a safelist glob such as "${partial.prefix}*"`);
      }
    }
    for (const dynamic of scan.dynamicIcons) {
      if (icons === 'auto') errors.push(`${scan.file}:${dynamic.line} an icon name the scan cannot read (${dynamic.text}): name the glyphs in "icons" (or set "icons": "all")`);
    }
    for (const entry of scan.unknown) {
      const key = `${entry.kind} ${entry.name}`;
      if (!unknown.has(key)) unknown.set(key, `${scan.file}:${entry.line}`);
    }
  }
  for (const glob of safe.globs) {
    const matched = [...copy.classes.keys()].filter((cls) => glob.pattern.test(cls));
    if (!matched.length) warnings.push(`safelist: "${glob.glob}" matches no class of the copy`);
    for (const cls of matched) for (const name of copy.classes.get(cls)) addComponent(name, `safelist "${glob.glob}"`);
  }
  for (const name of safe.components) addComponent(name, `safelist "component:${name}"`);
  for (const name of safe.modules) addModule(name, `safelist "module:${name}"`);
  for (const name of safe.icons) if (!iconNames.has(name)) iconNames.set(name, `safelist "icon:${name}"`);
  if (Array.isArray(icons)) {
    for (const name of icons) {
      if (!copy.glyphs.has(name)) errors.push(`icons: no glyph "${name}" in the copy`);
      else if (!iconNames.has(name)) iconNames.set(name, 'config "icons"');
    }
  }
  if (iconNames.size && copy.modules.has('icons')) {
    const [first, where] = [...iconNames][0];
    addModule('icons', /:\d+$/.test(where) ? `${where} icon ${first}` : `icon ${first} (${where})`);
  }
  for (const { module, name, where } of exportUses) {
    for (const component of copy.modules.get(module).exportRequires?.[name] ?? []) addComponent(component, `needed by DS.${module}.${name} (${where})`);
  }

  while (queue.length) {
    const item = queue.shift();
    if (item.type === 'component') {
      const component = manifest.components[item.name];
      for (const name of component.requires ?? []) addComponent(name, `required by ${item.name}`);
      if (used.has(item.name)) for (const name of component.js ?? []) addModule(name, `needed by ${item.name}`);
    } else {
      const module = copy.modules.get(item.name);
      for (const name of module.imports ?? []) addModule(name, `imported by ${item.name}`);
      const css = module.requires ?? (item.name in manifest.components ? [item.name] : []);
      for (const name of css) addComponent(name, `needed by module ${item.name}`);
      for (const glyph of copy.moduleGlyphs.get(item.name) ?? []) if (!iconNames.has(glyph)) iconNames.set(glyph, `used by module ${item.name}`);
    }
  }
  if (icons === 'all') for (const glyph of copy.glyphs) if (!iconNames.has(glyph)) iconNames.set(glyph, 'config "icons": "all"');

  // Cascade order: the manifest order; components it does not list (base, motion, utilities) first.
  const rank = (name) => {
    const index = manifest.order.indexOf(name);
    return index < 0 ? Object.keys(manifest.components).indexOf(name) - Object.keys(manifest.components).length : index;
  };
  const sortedComponents = new Map([...components].sort((a, b) => rank(a[0]) - rank(b[0])));
  const moduleOrder = orderModules([...modules.keys()], copy);
  const sortedModules = new Map(moduleOrder.map((name) => [name, modules.get(name)]));
  const glyphOrder = [...copy.glyphs];
  const sortedIcons = new Map([...iconNames].sort((a, b) => glyphOrder.indexOf(a[0]) - glyphOrder.indexOf(b[0])));
  return { components: sortedComponents, modules: sortedModules, icons: sortedIcons, classes: new Map([...classes].sort()), errors: unique(errors), warnings, unknown: [...unknown].map(([name, where]) => `${where} ${name}`) };
}

/** Modules in the order of the manifest, each after the modules it imports. */
function orderModules(names, copy) {
  const keys = [...copy.modules.keys()];
  const wanted = new Set(names);
  const out = [];
  const visit = (name, chain) => {
    if (out.includes(name)) return;
    if (chain.includes(name)) throw new ConfigError(`manifest.json: an import cycle ${[...chain, name].join(' -> ')}`);
    for (const dependency of copy.modules.get(name).imports ?? []) if (wanted.has(dependency)) visit(dependency, [...chain, name]);
    out.push(name);
  };
  for (const name of keys) if (wanted.has(name)) visit(name, []);
  return out;
}

// ── Output ───────────────────────────────────────────────────────────────

const sizes = (text) => ({ bytes: Buffer.byteLength(text), gzip: gzipSync(Buffer.from(text), { level: 9 }).length });
const PROPERTY = /@property\s+(--[\w-]+)\s*\{[^{}]*\}/g;
/** Ordering statements (`@layer a, b;`): the bundle writes its own once. */
const LAYER_STATEMENT = /@layer\s+[\w.-]+(?:\s*,\s*[\w.-]+)*\s*;[ \t]*\n?/g;

function stripPart(css) {
  return css.replace(/\/\*![\s\S]*?\*\/\n?/g, '').replace(LAYER_STATEMENT, '').trim();
}

/** The icons module with only the glyphs in `keep` (the GLYPHS map of fill() too). */
export function pruneIcons(source, keep) {
  const removed = new Set();
  let text = source.replace(/^export const ([\w$]+) = '<.*\n/gm, (line, name) => {
    if (ICON_HELPERS.has(name) || keep.has(name)) return line;
    removed.add(name);
    return '';
  });
  text = text.replace(/(const GLYPHS = \{)([\s\S]*?)(\};)/, (all, open, body, close) => {
    const names = body.split(',').map((part) => part.trim()).filter((name) => name && !removed.has(name));
    return `${open}\n  ${names.join(', ')}\n${close}`;
  });
  return text;
}

/**
 * The files of one bundle: css, js (or null), properties and the report.
 * `jsBase` is the path from the bundle's folder to the copy, for "esm".
 */
export function renderBundle(resolved, copy, { entry = 'bundle', minify = true, js = 'classic', jsBase = '.', files = {} } = {}) {
  const { manifest } = copy;
  const banner = `/*! Z-Dash ${manifest.version} | MIT License | ${HOMEPAGE} | bundle "${entry}": ${resolved.components.size} components (ds.${entry}.json) */\n`;
  // The script's banner leaves the components out: a change of CSS alone leaves the script as it is.
  const scriptBanner = `/*! Z-Dash ${manifest.version} | MIT License | ${HOMEPAGE} | bundle "${entry}" (ds.${entry}.json) */\n`;
  const pick = (path) => {
    if (!minify) return path;
    const min = path.replace(/\.css$/, '.min.css');
    return existsSync(join(copy.root, min)) ? min : path;
  };
  const parts = [];
  for (const path of manifest.core.css) parts.push({ label: path, text: stripPart(copy.read(pick(path))) });
  const componentSizes = new Map();
  for (const name of resolved.components.keys()) {
    const component = manifest.components[name];
    const path = minify ? component.min ?? pick(component.css) : component.css;
    const text = stripPart(copy.read(path));
    componentSizes.set(name, sizes(text));
    parts.push({ label: component.css, text });
  }
  const statements = [manifest.layers, manifest.sublayers].filter(Boolean);
  let css = minify
    ? `${banner}${statements.join('')}${parts.map((part) => part.text).join('')}\n`
    : `${banner}${statements.join('\n')}\n\n${parts.map((part) => `/* ── ${part.label} ── */\n${part.text}\n`).join('\n')}`;
  // Registrations the bundle reads but no included file makes (a copy that keeps them only in properties.css).
  const registered = new Set([...css.matchAll(PROPERTY)].map((match) => match[1]));
  const extra = manifest.core.properties && existsSync(join(copy.root, manifest.core.properties))
    ? [...copy.read(manifest.core.properties).matchAll(PROPERTY)].filter((match) => !registered.has(match[1]) && css.includes(`var(${match[1]}`)).map((match) => match[0])
    : [];
  if (extra.length) css += `${minify ? '' : '\n'}${extra.join(minify ? '' : '\n\n')}\n`;
  const properties = [...css.matchAll(PROPERTY)].map((match) => ({ name: match[1], text: match[0] }));

  let script = null;
  if (js === 'classic') {
    const modules = [...resolved.modules.keys()].map((name) => {
      let source = copy.read(copy.modules.get(name).file);
      if (name === 'icons') source = pruneIcons(source, new Set(resolved.icons.keys()));
      return { name, source: minify ? stripComments(source) : source };
    });
    const header = `/*
 * Z-Dash bundle "${entry}" (tools/bundle.mjs; do not edit): window.DS with
 * ${[...resolved.modules.keys()].map((name) => `DS.${name}`).join(', ')}${resolved.modules.has('icons') ? ` and ${resolved.icons.size} icons` : ''}.
 * Icon shapes: Lucide (ISC) and Feather (MIT), see LICENSE.
 * Another bundle or ds.js of the same version on the page adds its modules
 * to the same ZDash.versions[version] object.
 */`;
    script = classicScript({ version: manifest.version, banner: scriptBanner, header, modules, merge: true });
  } else if (js === 'esm') {
    const base = jsBase.replace(/\/$/, '');
    const spec = (file) => (isAbsolute(base) || /^\.{1,2}(\/|$)/.test(base) ? `${base}/${file}` : `./${base}/${file}`);
    const lines = [];
    for (const name of resolved.modules.keys()) {
      const file = copy.modules.get(name).file;
      if (name === 'icons') {
        const exportsOf = copy.modules.get('icons').exports ?? [];
        const names = [...exportsOf.filter((id) => ICON_HELPERS.has(id)), ...resolved.icons.keys()];
        lines.push(`import { ${names.join(', ')} } from '${spec(file)}';`, `export const icons = Object.freeze({ ${names.join(', ')} });`);
      } else lines.push(`export * as ${name} from '${spec(file)}';`);
    }
    script = `${scriptBanner}/*
 * Z-Dash bundle "${entry}" as an ES module (tools/bundle.mjs; do not edit):
 * the modules this project uses, by name. A bundler takes it from here.
 */
export const version = '${manifest.version}';
${lines.join('\n')}
`;
  }

  const report = {
    name: manifest.name ?? 'z-dash',
    version: manifest.version,
    entry,
    minify,
    js,
    files: {
      css: { file: files.css ?? `ds.${entry}.css`, ...sizes(css) },
      ...(script === null ? {} : { js: { file: files.js ?? `ds.${entry}.js`, ...sizes(script) } }),
      properties: { file: files.properties ?? 'properties.css', count: properties.length },
    },
    components: [...resolved.components].map(([name, reason]) => ({ name, reason, ...componentSizes.get(name) })),
    modules: [...resolved.modules].map(([name, reason]) => ({ name, reason })),
    icons: [...resolved.icons].map(([name, reason]) => ({ name, reason })),
    classes: Object.fromEntries(resolved.classes),
    unknown: resolved.unknown,
  };
  return { css, js: script, properties, report };
}

function propertiesFile(version, blocks) {
  return `/*! Z-Dash ${version} | MIT License | ${HOMEPAGE} */
/*
 * The @property registrations of the bundle (tools/bundle.mjs; do not
 * edit). @property applies only in stylesheets of the document: a widget
 * whose bundle sits in a shadow root links this file in the host document.
 */
${blocks.join('\n')}
`;
}

// ── Config and the whole run ─────────────────────────────────────────────

/** The config, checked, with defaults (paths stay relative to `base`). */
export function readConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ConfigError('the config is a JSON object');
  const extra = Object.keys(config).filter((key) => !CONFIG_KEYS.includes(key));
  if (extra.length) throw new ConfigError(`unknown config keys: ${extra.join(', ')} (known: ${CONFIG_KEYS.slice(1).join(', ')})`);
  const globs = (value, where) => {
    if (!Array.isArray(value) || value.some((glob) => typeof glob !== 'string' || !glob)) throw new ConfigError(`${where} is a list of globs`);
    return value;
  };
  const content = config.content === undefined ? [] : globs(config.content, '"content"');
  const entries = {};
  if (config.entries !== undefined) {
    if (!config.entries || typeof config.entries !== 'object' || Array.isArray(config.entries)) throw new ConfigError('"entries" is an object of name -> globs');
    for (const [name, value] of Object.entries(config.entries)) {
      if (!/^[a-z0-9][\w-]*$/i.test(name)) throw new ConfigError(`entries: "${name}" is not a file name part (letters, digits, - and _)`);
      entries[name] = globs(value, `entries.${name}`);
    }
  }
  if (!content.length && !Object.keys(entries).length) throw new ConfigError('"content" (or "entries") names the files to scan');
  const safelist = config.safelist === undefined ? [] : globs(config.safelist, '"safelist"');
  const minify = config.minify === undefined ? true : config.minify;
  if (typeof minify !== 'boolean') throw new ConfigError('"minify" is true or false');
  const js = config.js === undefined ? 'classic' : config.js;
  if (!['classic', 'esm', false].includes(js)) throw new ConfigError('"js" is "classic", "esm" or false');
  const icons = config.icons === undefined ? 'auto' : config.icons;
  if (!(icons === 'auto' || icons === 'all' || (Array.isArray(icons) && icons.every((name) => typeof name === 'string')))) throw new ConfigError('"icons" is "auto", "all" or a list of glyph names');
  for (const key of ['out', 'dist']) if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key])) throw new ConfigError(`"${key}" is a path`);
  return { content, entries, safelist, minify, js, icons, out: config.out ?? '.', dist: config.dist };
}

/**
 * Scans a project and makes its bundles.
 * @param {{ config?: string|object, cwd?: string, dist?: string, manifest?: object|string, out?: string,
 *           write?: boolean, check?: boolean, files?: Map<string, string> }} options
 *   config: a path to ds.config.json (default ./ds.config.json) or the config itself;
 *   cwd: the folder relative paths start from (default: the config's folder, or the current one);
 *   dist / manifest / out: override the copy, its manifest and the config's "out";
 *   write: write the files (default true; false for --dry-run); check: compare with the files on disk;
 *   files: texts that replace or add files to the scan, by path relative to cwd.
 * @returns {{ entries: object[], outputs: Map<string, Buffer>, errors: string[], warnings: string[], stale: string[], ok: boolean }}
 */
export function bundle(options = {}) {
  let raw = options.config ?? 'ds.config.json';
  let base = options.cwd ? resolve(options.cwd) : process.cwd();
  let configPath = null;
  if (typeof raw === 'string') {
    const path = resolve(base, raw);
    configPath = path;
    if (!existsSync(path)) throw new ConfigError(`no config at ${path}`);
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new ConfigError(`${path}: ${error.message}`);
    }
    if (!options.cwd) base = dirname(path);
  }
  const config = readConfig(raw);
  const dist = options.dist ? resolve(options.dist) : config.dist ? resolve(base, config.dist) : resolve(HERE, '..');
  const copy = loadCopy({ dist, manifest: options.manifest });
  const out = resolve(base, options.out ?? config.out);
  const names = Object.keys(config.entries).length ? Object.keys(config.entries) : ['bundle'];
  const outputNames = new Set(['properties.css', ...names.flatMap((name) => [`ds.${name}.css`, `ds.${name}.js`, `ds.${name}.json`])]);
  const distRel = posix(relative(base, dist));
  // Never scanned: the copy, the bundle's own files and the config (its safelist globs would read as built names).
  const skip = (path) => (distRel && !distRel.startsWith('..') && (path === distRel || path.startsWith(`${distRel}/`)))
    || (dirname(resolve(base, path)) === out && outputNames.has(path.split('/').at(-1)))
    || resolve(base, path) === configPath;

  const cache = new Map();
  const scanOf = (path) => {
    if (!cache.has(path)) {
      const text = options.files?.get(path) ?? readFileSync(join(base, path), 'utf8');
      cache.set(path, text.includes('\0') ? null : scanText(text.replace(/\r\n/g, '\n'), path, copy));
    }
    return cache.get(path);
  };
  const extraFiles = [...(options.files?.keys() ?? [])];
  const errors = [];
  const warnings = [];
  const entries = [];
  const outputs = new Map();
  const propertyBlocks = new Map();
  const jsBase = posix(relative(out, dist)) || '.';
  for (const name of names) {
    const globs = [...config.content, ...(config.entries[name] ?? [])];
    const patterns = globs.filter((glob) => !glob.startsWith('!')).map((glob) => globRegExp(glob.replace(/^\.\//, '')));
    const files = unique([...expandGlobs(base, globs, skip), ...extraFiles.filter((path) => patterns.some((pattern) => pattern.test(path)))]).sort();
    if (!files.length) warnings.push(`${name}: the globs match no file`);
    const scans = files.map(scanOf).filter(Boolean);
    const resolved = resolveBundle(scans, copy, config);
    errors.push(...resolved.errors);
    warnings.push(...resolved.warnings);
    const rendered = renderBundle(resolved, copy, { entry: name, minify: config.minify, js: config.js, jsBase });
    for (const block of rendered.properties) if (!propertyBlocks.has(block.name)) propertyBlocks.set(block.name, block.text);
    outputs.set(join(out, `ds.${name}.css`), Buffer.from(rendered.css));
    if (rendered.js !== null) outputs.set(join(out, `ds.${name}.js`), Buffer.from(rendered.js));
    outputs.set(join(out, `ds.${name}.json`), Buffer.from(`${JSON.stringify(rendered.report, null, 2)}\n`));
    entries.push({ name, files, resolved, ...rendered });
  }
  outputs.set(join(out, 'properties.css'), Buffer.from(propertiesFile(copy.manifest.version, [...propertyBlocks.values()])));

  const result = { base, out, copy, entries, outputs, errors: unique(errors), warnings: unique(warnings), stale: [], ok: true };
  if (options.check) {
    result.stale = checkWritten(result);
    result.ok = !result.errors.length && !result.stale.length;
    return result;
  }
  result.ok = !result.errors.length;
  if (result.ok && options.write !== false) {
    for (const [path, content] of outputs) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
  return result;
}

/** What --check finds: files missing or changed, and the scan's classes the written CSS lacks. */
function checkWritten(result) {
  const problems = [];
  const show = (path) => posix(relative(result.base, path)) || '.';
  for (const entry of result.entries) {
    const cssPath = join(result.out, `ds.${entry.name}.css`);
    const jsonPath = join(result.out, `ds.${entry.name}.json`);
    const written = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : null;
    if (written === null) {
      problems.push(`missing: ${show(cssPath)} (run tools/bundle.mjs)`);
      continue;
    }
    for (const [cls, where] of entry.resolved.classes) {
      const at = new RegExp(`\\.${cls}(?![\\w-])`);
      if (!at.test(written)) problems.push(`${where} uses .${cls}, which ${show(cssPath)} does not hold`);
    }
    let old = null;
    try {
      old = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null;
    } catch {
      old = null;
    }
    if (old) {
      if (old.version !== entry.report.version) problems.push(`${show(jsonPath)}: made from ${old.version}, the copy is ${entry.report.version}`);
      for (const kind of ['components', 'modules', 'icons']) {
        const before = new Set((old[kind] ?? []).map((item) => item.name));
        const now = new Map(entry.report[kind].map((item) => [item.name, item.reason]));
        for (const [name, reason] of now) if (!before.has(name)) problems.push(`${entry.name}: + ${kind.slice(0, -1)} ${name} (${reason})`);
        for (const name of before) if (!now.has(name)) problems.push(`${entry.name}: - ${kind.slice(0, -1)} ${name} (no longer used)`);
      }
    }
  }
  for (const [path, content] of result.outputs) {
    if (!existsSync(path)) problems.push(`missing: ${show(path)}`);
    else if (!readFileSync(path).equals(content)) problems.push(`stale: ${show(path)}`);
  }
  return unique(problems);
}

// ── CLI ──────────────────────────────────────────────────────────────────

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function parseArgs(argv) {
  const args = { check: false, report: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new ConfigError(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--check') args.check = true;
    else if (arg === '--report') args.report = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--config') args.config = value();
    else if (arg === '--dist') args.dist = value();
    else if (arg === '--manifest') args.manifest = value();
    else if (arg === '--out') args.out = value();
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new ConfigError(`unknown argument ${arg}`);
  }
  return args;
}

/** The command line (see the file comment); returns the exit code. */
export function main(argv = process.argv.slice(2), log = console.log, error = console.error) {
  let args;
  let result;
  try {
    args = parseArgs(argv);
    if (args.help) {
      log('usage: node tools/bundle.mjs [--config ds.config.json] [--dist <copy>] [--out <dir>] [--check] [--report] [--dry-run]');
      return 0;
    }
    const here = (path) => (path === undefined ? undefined : resolve(path));
    result = bundle({ config: args.config, dist: here(args.dist), manifest: here(args.manifest), out: here(args.out), check: args.check, write: !args.dryRun });
  } catch (problem) {
    if (problem instanceof ConfigError) {
      error(`bundle: ${problem.message}`);
      return 2;
    }
    throw problem;
  }
  for (const warning of result.warnings) error(`warning: ${warning}`);
  for (const problem of result.errors) error(problem);
  if (args.report || args.dryRun) {
    for (const entry of result.entries) {
      log(`${entry.name}: ${entry.files.length} files scanned`);
      for (const item of entry.report.components) log(`  component ${item.name.padEnd(14)} ${kb(item.bytes).padStart(9)} ${kb(item.gzip).padStart(8)} gzip  ${item.reason}`);
      for (const item of entry.report.modules) log(`  module    ${item.name.padEnd(14)} ${item.reason}`);
      for (const item of entry.report.icons) log(`  icon      ${item.name.padEnd(14)} ${item.reason}`);
      if (entry.report.unknown.length) log(`  ${entry.report.unknown.length} names the copy does not know (ds.${entry.name}.json, "unknown")`);
    }
  }
  if (args.check) {
    if (!result.ok) {
      if (result.stale.length) error(`The bundle is not up to date (run node tools/bundle.mjs):\n  ${result.stale.join('\n  ')}`);
      return 1;
    }
    log(`The bundle is up to date (${result.entries.map((entry) => `ds.${entry.name}.*`).join(', ')}).`);
    return 0;
  }
  if (!result.ok) return 1;
  for (const entry of result.entries) {
    const { files } = entry.report;
    const js = files.js ? `, ${files.js.file} ${kb(files.js.bytes)} (${kb(files.js.gzip)} gzip)` : '';
    log(`${args.dryRun ? 'Would write' : 'Wrote'} ${files.css.file} ${kb(files.css.bytes)} (${kb(files.css.gzip)} gzip)${js}: ${entry.report.components.length} components, ${entry.report.modules.length} modules, ${entry.report.icons.length} icons -> ${posix(relative(process.cwd(), result.out)) || '.'}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
