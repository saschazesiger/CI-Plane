/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * The classic-script wrapper of Z-Dash (no dependency): turns the
 * ES modules of js/ into one script that sets window.DS, as ds.js does.
 * scripts/build.mjs writes ds.js with it; tools/bundle.mjs writes a
 * project's ds.bundle.js with only the modules a project uses.
 *
 *   classicScript({ version, banner, header, modules: [{ name, source }], merge })
 *     -> the script text. `modules` in order: a module may import named
 *        exports of a module earlier in the list (one line,
 *        `import { a, b as c } from './motion.js';`), which becomes
 *        `const a = DS.motion.a, c = DS.motion.b;` inside its closure.
 *   classicHeader(names)                        the header comment of ds.js for these modules
 *   moduleBody(source, name, order, { merge, namespace })
 *                                               one module as `DS.<name> = (function () { ... })();`
 *                                               (with merge: `add('<name>', [exports], function () { ... });`)
 *   rewriteImports(source, name, order)         the import lines of one module, rewritten
 *   stripComments(source)                       comments, blank lines and indentation out; strings,
 *                                               template and regex literals untouched, nothing renamed
 *
 * `merge: true` (the default; ds.js and every bundle) adds what this script
 * holds to a copy of the same version that is already on the page, by
 * name: a module the page lacks, or the exports a module on the page lacks
 * (a bundle's icons pruned to other glyphs); a module the page has in full
 * is neither made again nor replaced. So two partial bundles, a bundle and
 * ds.js, or a widget's copy share one ZDash.versions[version]
 * object, and its modules read the page's own (and ZDash.runtime,
 * DS.core's, is one per page whatever the version). window.DS and the
 * warning of another version are the first copy's business. `merge: false`
 * is the 2.x behaviour: a second copy of the same version returns at once.
 *
 * With a core module, DS.init, DS.get, DS.define and DS.config are its
 * functions at the top level (CORE_ALIASES).
 *
 * Copied to dist/tools/ by scripts/build.mjs; plain ES2022.
 */

/** `import { a, b as c } from './motion.js';` on one line. */
const SIBLING_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*(?:'\.\/([\w-]+)\.js'|"\.\/([\w-]+)\.js")\s*;?[ \t]*$/;

/**
 * Rewrites the imports of one module for the classic build (see the file
 * comment). Default, namespace and bare imports, later or unknown modules
 * and imports over several lines throw.
 * @param {string} source
 * @param {string} name   the module's name
 * @param {string[]} order  every module of the script, in order
 */
export function rewriteImports(source, name, order) {
  const position = order.indexOf(name);
  return source.replace(/^[ \t]*import\b.*$/gm, (line) => {
    const statement = line.trim();
    const match = SIBLING_IMPORT.exec(statement);
    if (!match) {
      if (/^import\s*\{[^}]*$/.test(statement)) throw new Error(`${name}.js: an import must sit on one line: ${statement}`);
      if (/^import\s*\*/.test(statement)) throw new Error(`${name}.js: namespace imports are not supported: ${statement}`);
      if (/^import\s*['"]/.test(statement)) throw new Error(`${name}.js: bare imports are not supported: ${statement}`);
      if (/^import\s*\{/.test(statement)) throw new Error(`${name}.js: only sibling modules (./<name>.js) can be imported: ${statement}`);
      if (/^import\s+[\w$]/.test(statement)) throw new Error(`${name}.js: default imports are not supported: ${statement}`);
      throw new Error(`${name}.js: unsupported import: ${statement}`);
    }
    const from = match[2] ?? match[3];
    const index = order.indexOf(from);
    if (index < 0) throw new Error(`${name}.js: unknown module ./${from}.js (not in MODULES)`);
    if (index >= position) throw new Error(`${name}.js: ./${from}.js is not earlier in MODULES; import only from an earlier module`);
    const bindings = match[1].split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
      const names = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(part);
      if (!names) throw new Error(`${name}.js: cannot read the import binding "${part}"`);
      return `${names[2] || names[1]} = DS.${from}.${names[1]}`;
    });
    if (!bindings.length) throw new Error(`${name}.js: an empty import: ${statement}`);
    return `const ${bindings.join(', ')};`;
  });
}

/**
 * One ES module as a function body that returns its exports. Only
 * `export const` and `export function` are allowed; imports only from an
 * earlier module (rewriteImports). With `merge`, the body goes to the
 * script's add() (see classicScript), which makes it only when the page
 * lacks the module or one of its exports. `namespace` is the object the
 * plain form assigns to (DS; the styleguide's demos use SG).
 */
export function moduleBody(source, name, order, { merge = false, namespace = 'DS' } = {}) {
  const exports = [];
  const body = rewriteImports(source, name, order).replace(/^export (const|function) ([\w$]+)/gm, (match, kind, id) => {
    exports.push(id);
    return `${kind} ${id}`;
  });
  if (/^\s*export\b/m.test(body)) throw new Error(`${name}.js: only "export const" and "export function" are supported`);
  const members = exports.map((id) => `      ${id}: ${id}`).join(',\n');
  const indented = body.trimEnd().split('\n').map((line) => (line ? `    ${line}` : line)).join('\n');
  const make = `function () {\n${indented}\n\n    return Object.freeze({\n${members}\n    });\n  }`;
  if (merge) return `  add('${name}', [${exports.map((id) => `'${id}'`).join(', ')}], ${make});\n`;
  return `  ${namespace}.${name} = (${make})();\n`;
}

/** Words after which a `/` starts a regular expression literal, not a division. */
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * The source without comments and blank lines, and without the indentation
 * of lines outside template literals: strings, template literals and
 * regular expression literals stay byte for byte, nothing is renamed.
 * `/*!` comments (licence banners) stay. A small tokenizer, not a parser: a
 * `/` after an identifier, a number, `)` or `]` is a division, anywhere
 * else it starts a regular expression.
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  let last = '';
  let word = '';
  const templates = [];
  let lineStart = true;
  const trimEnd = () => {
    let end = out.length;
    while (end && (out[end - 1] === ' ' || out[end - 1] === '\t')) end -= 1;
    out = out.slice(0, end);
  };
  const emit = (text) => {
    out += text;
    const trimmed = text.trim();
    if (trimmed) {
      last = trimmed.at(-1);
      lineStart = false;
    }
  };
  const quoted = (quote) => {
    let j = i + 1;
    while (j < source.length && source[j] !== quote && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
    emit(source.slice(i, j + 1));
    i = j + 1;
  };
  const template = () => {
    // From just after a ` (or the } that ends a ${...}) to the closing ` or the next ${.
    let j = i;
    while (j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) j += source[j] === '\\' ? 2 : 1;
    if (source[j] === '`') {
      emit(source.slice(i, j + 1));
      i = j + 1;
    } else {
      emit(source.slice(i, j + 2));
      templates.push(0);
      i = j + 2;
    }
  };
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '\n') {
      if (!lineStart) out += '\n';
      lineStart = true;
      i += 1;
      while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i += 1;
      continue;
    }
    if ((char === ' ' || char === '\t') && lineStart) {
      i += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      trimEnd();
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      if (source[i + 2] === '!') emit(source.slice(i, stop));
      else if (/[\w$]/.test(out.at(-1) ?? '') && /[\w$]/.test(source[stop] ?? '')) out += ' ';
      else trimEnd();
      i = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      word = '';
      quoted(char);
      continue;
    }
    if (char === '`') {
      word = '';
      emit('`');
      i += 1;
      template();
      continue;
    }
    if (templates.length && (char === '{' || char === '}')) {
      if (char === '{') templates[templates.length - 1] += 1;
      else if (templates[templates.length - 1] === 0) {
        templates.pop();
        emit('}');
        i += 1;
        template();
        continue;
      } else templates[templates.length - 1] -= 1;
    }
    if (char === '/') {
      const division = (/[\w$)\]]/.test(last) && !BEFORE_REGEX.has(word));
      if (!division) {
        let j = i + 1;
        let inClass = false;
        while (j < source.length && source[j] !== '\n') {
          if (source[j] === '\\') j += 1;
          else if (source[j] === '[') inClass = true;
          else if (source[j] === ']') inClass = false;
          else if (source[j] === '/' && !inClass) break;
          j += 1;
        }
        j += 1;
        while (/[a-z]/i.test(source[j] ?? '')) j += 1;
        word = '';
        emit(source.slice(i, j));
        i = j;
        continue;
      }
    }
    if (/[\w$]/.test(char)) {
      let j = i;
      while (j < source.length && /[\w$]/.test(source[j])) j += 1;
      word = source.slice(i, j);
      emit(word);
      i = j;
      continue;
    }
    if (!/\s/.test(char)) word = '';
    emit(char);
    i += 1;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/^\n+/, '');
}

/** The exports of a core module that DS also holds at the top level (DS.init is DS.core.init). */
export const CORE_ALIASES = ['init', 'get', 'define', 'config'];

/** `text` as the lines of a block comment, wrapped at 76 columns. */
const commentLines = (text) => {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > 73) {
      lines.push(` * ${line}`);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, ` * ${line}`].join('\n');
};

/** The header comment of ds.js for the modules `names` (in order), the default of classicScript(). */
export function classicHeader(names) {
  const aliases = names.includes('core') ? ` DS.${CORE_ALIASES.slice(0, -1).join(', DS.')} and DS.${CORE_ALIASES.at(-1)} are DS.core's.` : '';
  return `/*
${commentLines(`Classic-script build of src/js (no modules needed): window.DS.${names.join(', DS.')} hold the same exports as the ES modules in js/.${aliases} Generated by scripts/build.mjs; do not edit.`)}
 * Icon shapes: Lucide (ISC) and Feather (MIT), see LICENSE.
 *
 * Two copies on one page (a host page and an embedded widget, two
 * bundles): every copy registers itself in ZDash.versions[version]
 * and shares the page's one ZDash.runtime (DS.core). A second copy
 * of the same version adds what the first lacks into it by name (a module,
 * or an export of a module) and keeps everything the first has.
 * window.DS is set only when it is absent or holds the same version, so the
 * first copy keeps it; a copy of another version warns once and leaves DS
 * alone. A widget reads ZDash.versions['<its version>'] || DS.
 */`;
}

/** Adds a module to DS by name (merge mode): made only when DS lacks it or one of its exports; what DS has stays. */
const ADD = `  var add = function (name, exports, make) {
    var theirs = DS[name];
    if (theirs && exports.every(function (key) { return key in theirs; })) return;
    var mine = make();
    if (!theirs) {
      DS[name] = mine;
      return;
    }
    var merged = {};
    Object.keys(theirs).forEach(function (key) { merged[key] = theirs[key]; });
    Object.keys(mine).forEach(function (key) { if (!(key in merged)) merged[key] = mine[key]; });
    DS[name] = Object.freeze(merged);
  };
`;

/**
 * The whole classic script (see the file comment).
 * @param {{ version: string, banner?: string, header?: string, modules: { name: string, source: string }[], merge?: boolean }} options
 */
export function classicScript({ version, banner = '', header, modules, merge = true }) {
  if (!/^[\w.+-]+$/.test(version)) throw new Error(`classicScript: not a version: ${version}`);
  const order = modules.map((module) => module.name);
  const parts = modules.map((module) => moduleBody(module.source, module.name, order, { merge }));
  const start = merge
    ? `  var first = versions[version];\n  var DS = first || { version: version };\n${ADD}`
    : `  if (versions[version]) return;\n  var DS = { version: version };\n`;
  const aliases = order.includes('core')
    ? `  // DS.core's entry points at the top level; a copy already on the page keeps its own.
  [${CORE_ALIASES.map((key) => `'${key}'`).join(', ')}].forEach(function (key) {
    if (DS[key] === undefined && DS.core[key] !== undefined) DS[key] = DS.core[key];
  });
`
    : '';
  const settle = merge ? `  // window.DS and the warning are the first copy's business.\n  if (first) return;\n` : '';
  return `${banner}${header ?? classicHeader(order)}
(function (root) {
  'use strict';
  var version = '${version}';
  // DashboardStyle: the deprecated name from before the rename (3.0), the same object.
  var registry = root.ZDash || root.DashboardStyle || {};
  root.ZDash = registry;
  if (!root.DashboardStyle) root.DashboardStyle = registry;
  var versions = registry.versions || (registry.versions = {});
${start}
${parts.join('\n')}
${aliases}${settle}  versions[version] = DS;
  var current = root.DS;
  var warn = function (message) {
    if (root.console && typeof root.console.warn === 'function') root.console.warn(message);
  };
  if (current === undefined || current === null || (typeof current === 'object' && current.version === version)) root.DS = DS;
  else if (typeof current.version === 'string') warn('Z-Dash ' + version + ' loaded on a page that already runs ' + current.version + ': window.DS stays ' + current.version + '; this copy is ZDash.versions[\\'' + version + '\\'].');
  else warn('Z-Dash ' + version + ': window.DS already holds something else; it is left alone, this copy is ZDash.versions[\\'' + version + '\\'].');
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
}
