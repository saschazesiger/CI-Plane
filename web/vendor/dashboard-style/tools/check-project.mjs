#!/usr/bin/env node
/**
 * Checks a project that vendors Dashboard-Style against the project rules
 * of AGENTS.md ("Using Dashboard-Style in a project"), without
 * dependencies (Node 18 or later):
 *
 *   node <copy>/tools/check-project.mjs --config ds-check.json
 *
 * ds-check.json (paths and globs relative to the config file; globs know
 * `*`, `**` and `?`):
 *   {
 *     "prefix": "app",                         the project's class and token prefix
 *     "css": ["css/**\/*.css"],                project stylesheets (themes excluded)
 *     "js": ["js/**\/*.js"],                   project scripts
 *     "html": ["*.html"],                      pages and templates (optional)
 *     "themes": ["css/theme.css"],             theme files (tools/check-theme.mjs)
 *     "themesWith": ["vendor/dashboard-style/themes/dark.css"],  shipped themes the
 *                                              theme is used with (check-theme --with; optional)
 *     "vendor": "vendor/dashboard-style",      the copy
 *     "exceptions": [{ "rule": "restyle", "file": "css/app.css", "selector": ".app-bar .ds-btn", "reason": "why" }]
 *   }
 *
 * Output: one line per finding, "<file>:<line> <rule> <message>" (a
 * warning says so), then a summary; exit 1 when there is an error, 2 on a
 * configuration error. An exception silences one rule for a file (and a
 * selector, when it names one); its reason is required.
 *
 * Rules (RULES below, one per bullet of the project block):
 *   vendor      the copy verifies against its SHA256SUMS (tools/verify.mjs)
 *   classes     every ds- class in markup, scripts and stylesheets exists in
 *               ds.css; a page that links single stylesheets links one that
 *               defines it (definingFiles: not one that only places it)
 *   deprecated  no removed name (deprecations.json; deprecated ones warn)
 *   literals    no colour, radius, font, shadow, duration or curve literal in
 *               <prefix>- rules: tokens only (`linear` on a --ds-loop-*
 *               duration and zero durations pass, as in the system)
 *   keyframes   no own @keyframes; animations name existing ds-* keyframes
 *   themes      every theme file passes tools/check-theme.mjs
 *   layers      no unlayered reset (element-only rules) and no !important
 *   hidden      no [hidden] rule: ds.css handles the attribute
 *   restyle     no project rule that changes the look of a .ds-* element
 *               (only --ds-* hooks and placement), unless excepted
 *   attributes  the page never writes the attributes the system owns (a
 *               write deprecations.json lists is left to deprecated)
 *   dom         a warning for innerHTML on ds markup (use DS.dom.morphHtml)
 *   pressable   a warning for a project ::before state layer (use .ds-pressable)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTheme } from './check-theme.mjs';
import { lineAt, scan, selectorList, splitOutside } from './css-scan.mjs';
import { verify } from './verify.mjs';

/** The rule ids, in the order of the project block of AGENTS.md. */
export const RULES = ['vendor', 'classes', 'deprecated', 'literals', 'keyframes', 'themes', 'layers', 'hidden', 'restyle', 'attributes', 'dom', 'pressable'];

/**
 * Attributes the system writes (the "Attributes" table of
 * docs/components.md, the rows "the system" writes): a page never writes them.
 * data-toast-reserve is written by toast() unless the page passes
 * `reserve: false`, so a file that passes it may write it.
 */
export const SYSTEM_ATTRIBUTES = [
  'data-scrolled',
  'data-ds-sentinel',
  'data-ds-text',
  'data-ds-edges',
  'data-ds-overflow-start',
  'data-ds-overflow-end',
  'data-ds-dragover',
  'data-ds-dragging',
  'data-ds-keyboard',
  'data-ds-savebar',
  'data-ds-savebar-rest',
];
const SHARED_ATTRIBUTES = ['data-toast-reserve'];

/** Properties that place a ds element in a project container without changing its look. */
const PLACEMENT = /^(margin(-[\w-]+)?|scroll-margin(-[\w-]+)?|grid-(area|column|row)(-[\w-]+)?|flex(-grow|-shrink|-basis)?|order|align-self|justify-self|place-self|position|inset(-[\w-]+)?|top|right|bottom|left|z-index|width|min-width|max-width|inline-size|min-inline-size|max-inline-size|height|min-height|max-height|block-size|min-block-size|max-block-size|box-sizing|container(-[\w-]+)?)$/;
/** Classes a project may name anywhere (scopes, not components): the theme root, the page base and the touch
 * opt-in (on .ds-theme or a container). */
const NEUTRAL = new Set(['ds-theme', 'ds-base', 'ds-touch']);
const ANIMATION_WORDS = new Set(['none', 'infinite', 'alternate', 'alternate-reverse', 'normal', 'reverse', 'forwards', 'backwards', 'both', 'running', 'paused', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end', 'initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const COLOUR_WORDS = /(?:^|[\s,(])(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|silver|navy|teal|maroon)(?=$|[\s,)])/i;

const posix = (path) => path.split(sep).join('/');

/** A glob (`*`, `**`, `?`) as a regular expression over posix paths. */
export function globRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      pattern += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(dir, prefix))) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(join(dir, path));
    if (stat.isDirectory()) out.push(...walk(dir, path));
    else out.push(path);
  }
  return out;
}

/** The project files matching `globs`, relative to `root`, outside the copy. */
function matchFiles(root, globs, all, vendor) {
  const patterns = (globs ?? []).map(globRegExp);
  return all.filter((path) => (!vendor || !(`${path}/`).startsWith(`${vendor}/`)) && patterns.some((pattern) => pattern.test(path)));
}

/** The source without var(...) (any depth), url(...) and strings: what is left is literal. */
function literalPart(value) {
  let current = value.replace(/url\([^)]*\)/g, '').replace(/"[^"]*"|'[^']*'/g, '""');
  let previous;
  do {
    previous = current;
    current = current.replace(/var\([^()]*\)/g, '').replace(/(calc|min|max|clamp)\(([^()]*)\)/g, '$2');
  } while (current !== previous);
  return current;
}

/**
 * The kinds of literal in one declaration of a project rule (empty: tokens
 * only). `rule` is the text of the whole rule body, for the longhands. The
 * keyword `linear` is the curve of the system's loops (there is no token
 * for it): it passes in a part that runs on a --ds-loop-* duration (or a
 * longhand of a rule that does), and in a part with no duration (`0s`), as
 * do zero durations themselves.
 */
export function literalKinds(property, value, rule = '') {
  const kinds = [];
  const literal = literalPart(value);
  if (/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(literal) || COLOUR_WORDS.test(` ${literal} `)) kinds.push('colour');
  if (/radius/.test(property) && /(?:^|\s)(?!0(?:px)?(?:\s|$))\d*\.?\d+(px|r?em|%)/.test(literal)) kinds.push('radius');
  if (/^font(-family|-size|-weight)?$/.test(property) && /\d|[a-z]/i.test(literal.replace(/\b(inherit|initial|unset|revert|revert-layer)\b/g, '').trim())) kinds.push('font');
  // An elevation: a shadow with a blur of its own (a 1px ring in a token colour is a hairline, not a shadow).
  if (/shadow$/.test(property) && literal.split(',').some((shadow) => {
    const lengths = [...shadow.matchAll(/(?:^|\s)(-?\d*\.?\d+)(px)?(?=\s|$)/g)].map((match) => Number(match[1]));
    return lengths.length >= 3 && lengths[2] !== 0;
  })) kinds.push('shadow');
  const timed = /^(transition|animation)/.test(property);
  if (timed && /(?:^|[\s,])(?!0m?s\b)\d*\.?\d+m?s\b/.test(literal)) kinds.push('duration');
  const loop = /var\(\s*--ds-loop-/;
  const curve = (part) => {
    const text = literalPart(part);
    if (/\b(cubic-bezier|linear|steps)\(/.test(text) || /(?:^|[\s,])(ease|ease-in|ease-out|ease-in-out|step-start|step-end)(?=$|[\s,])/.test(text)) return true;
    if (!/(?:^|[\s,])linear(?=$|[\s,])/.test(text)) return false;
    if (loop.test(part) || (/-timing-function$/.test(property) && loop.test(rule))) return false;
    // The first time of a part is its duration: `linear` on one of 0s runs nothing.
    const duration = splitOutside(part.trim(), ' ').map((word) => word.text.trim()).find((word) => /^\d*\.?\d+m?s$|^var\(\s*--ds-(dur|loop)-/.test(word));
    return !/^0m?s$/.test(duration ?? '');
  };
  if (timed && splitOutside(value, ',').some((part) => curve(part.text))) kinds.push('curve');
  return kinds;
}

/** The compounds of a selector (descendant and child combinators split), pseudo-elements included. */
function compounds(selector) {
  // The combinators inside :has() / :is() become a character outside [\w-], so `.ds-chip input` there keeps its name.
  return selector.replace(/\([^()]*\)/g, (inner) => inner.replace(/[\s>+~]/g, '\u0001')).split(/\s*[\s>+~]\s*/).filter(Boolean);
}

/**
 * The files of the copy (css/...) that define each class. A file defines a
 * class when one of its selectors has the class in the subject compound and
 * no other component's class before it (`.ds-alert .ds-btn` in alert.css
 * places a button, it does not define one); a class only ever used in
 * context falls back to the files whose subjects carry it, then to every
 * file that mentions it. The scopes are fixed: .ds-theme is tokens.css,
 * .ds-base is base.css.
 */
export function definingFiles(sheets) {
  const tiers = [new Map(), new Map(), new Map()];
  const note = (tier, name, path) => {
    if (!tiers[tier].has(name)) tiers[tier].set(name, new Map());
    tiers[tier].get(name).set(path, (tiers[tier].get(name).get(path) ?? 0) + 1);
  };
  const block = (name) => name.replace(/^ds-/, '').split(/__|--/)[0];
  for (const { path, css } of sheets) {
    for (const rule of scan(css).rules) {
      if (rule.context.some((at) => /^@keyframes\b/.test(at))) continue;
      for (const selector of selectorList(rule.selector)) {
        const parts = compounds(selector);
        const names = (part) => [...part.matchAll(/\.(ds-[\w-]+)/g)].map((match) => match[1]);
        // A class inside :has() or :not() is a condition on the subject, not the subject.
        const subject = names((parts.at(-1) ?? '').replace(/:(has|not)\([^()]*\)/g, ''));
        const context = parts.slice(0, -1).flatMap(names).filter((name) => !NEUTRAL.has(name));
        for (const name of names(selector)) note(2, name, path);
        for (const name of subject) {
          note(1, name, path);
          if (context.every((other) => block(other) === block(name))) note(0, name, path);
        }
      }
    }
  }
  // The file with the most defining rules comes first: it is the one the message names.
  const defined = new Map();
  for (const tier of [...tiers].reverse()) {
    for (const [name, files] of tier) defined.set(name, [...files.keys()].sort((a, b) => files.get(b) - files.get(a) || a.localeCompare(b)));
  }
  defined.set('ds-theme', ['css/tokens.css']);
  defined.set('ds-base', ['css/base.css']);
  return defined;
}

/** The ds- classes of the copy's stylesheets, the keyframes and the files that define each class (css/...). */
function readCopy(vendorDir) {
  const classes = new Set();
  const keyframes = new Set();
  const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ds = existsSync(join(vendorDir, 'ds.css')) ? strip(readFileSync(join(vendorDir, 'ds.css'), 'utf8')) : '';
  for (const match of ds.matchAll(/\.(ds-[\w-]+)/g)) classes.add(match[1]);
  for (const match of ds.matchAll(/@keyframes\s+(ds-[\w-]+)/g)) keyframes.add(match[1]);
  const cssDir = join(vendorDir, 'css');
  const sheets = existsSync(cssDir) ? walk(cssDir).filter((path) => path.endsWith('.css') && !path.startsWith('optional/') && path !== 'index.css')
    .map((path) => ({ path: `css/${path}`, css: readFileSync(join(cssDir, path), 'utf8') })) : [];
  const fileOf = definingFiles(sheets);
  const json = (name) => (existsSync(join(vendorDir, name)) ? JSON.parse(readFileSync(join(vendorDir, name), 'utf8')) : null);
  return { classes, keyframes, fileOf, tokens: json('tokens.json'), deprecations: json('deprecations.json') };
}

/** ds- class names a page or script uses: class attributes, selectors in strings, classList calls. */
function usedClasses(source, kind) {
  const found = [];
  const add = (name, index) => found.push({ name, index });
  for (const match of source.matchAll(/\bclass(?:Name)?\s*=\s*(["'`])([\s\S]*?)\1/g)) {
    for (const word of match[2].matchAll(/(?<![\w-])(ds-[\w-]+)/g)) add(word[1], match.index + match[0].indexOf(match[2]) + word.index);
  }
  if (kind === 'js') {
    for (const match of source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const text = match[2];
      for (const word of text.matchAll(/(?<![\w-])\.(ds-[\w-]+)/g)) add(word[1], match.index + 1 + word.index + 1);
    }
    for (const match of source.matchAll(/classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)/g)) {
      for (const word of match[1].matchAll(/['"`](ds-[\w-]+)['"`]/g)) add(word[1], match.index + match[0].indexOf(word[0]) + 1);
    }
  }
  const unique = new Map();
  // A name built in a template string (`ds-status--${tone}`) ends at the interpolation: not a class to look up.
  for (const entry of found.filter((item) => !item.name.endsWith('-'))) if (!unique.has(`${entry.name}@${entry.index}`)) unique.set(`${entry.name}@${entry.index}`, entry);
  return [...unique.values()];
}

/**
 * Runs every rule on the project described by `config` (relative paths
 * from `root`). Returns { findings: [{ level, file, line, rule, message,
 * selector? }], errors: [config errors] }.
 */
export function checkProject(config, root) {
  const findings = [];
  const configErrors = [];
  const prefix = config.prefix;
  if (!prefix || !/^[a-z][\w-]*$/.test(prefix)) configErrors.push('"prefix": the project prefix, such as "app"');
  if (!config.vendor) configErrors.push('"vendor": the path of the copy');
  for (const exception of config.exceptions ?? []) {
    if (!RULES.includes(exception.rule)) configErrors.push(`exception for an unknown rule "${exception.rule}" (rules: ${RULES.join(', ')})`);
    if (!exception.file) configErrors.push(`exception for ${exception.rule}: a "file" (a path or a glob)`);
    if (!exception.reason || !String(exception.reason).trim()) configErrors.push(`exception for ${exception.rule} in ${exception.file}: a "reason" is required`);
  }
  if (configErrors.length) return { findings, errors: configErrors };

  const vendor = posix(config.vendor).replace(/\/$/, '');
  const vendorDir = resolve(root, vendor);
  const all = walk(root);
  const themes = matchFiles(root, config.themes, all, vendor);
  const cssFiles = matchFiles(root, config.css, all, vendor).filter((path) => !themes.includes(path));
  const jsFiles = matchFiles(root, config.js, all, vendor);
  const htmlFiles = matchFiles(root, config.html, all, vendor);
  const themesWith = (config.themesWith ?? []).map(posix);
  const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
  const add = (level, file, line, rule, message, selector) => findings.push({ level, file, line, rule, message, ...(selector ? { selector } : {}) });

  // vendor
  if (!existsSync(vendorDir)) add('error', vendor, 0, 'vendor', 'the copy is missing');
  else for (const problem of verify(vendorDir).problems) add('error', `${vendor}/SHA256SUMS`, 0, 'vendor', problem);
  const copy = readCopy(vendorDir);

  // deprecated (every project file, themes included)
  const names = copy.deprecations?.names ?? [];
  for (const file of [...cssFiles, ...themes, ...jsFiles, ...htmlFiles]) {
    const source = read(file);
    for (const entry of names.filter((d) => d.pattern)) {
      for (const match of source.matchAll(new RegExp(entry.pattern, 'g'))) {
        add(entry.removed ? 'error' : 'warning', file, lineAt(source, match.index), 'deprecated',
          `${entry.name} ${entry.removed ? `was removed in ${entry.removed}` : `is deprecated since ${entry.deprecated}`}${entry.replacement ? `: use ${entry.replacement}` : ''}`);
      }
    }
  }

  // classes in pages and scripts (a removed class is reported once, by deprecated)
  const removedClasses = new Set(names.filter((d) => d.removed && d.kind === 'class').map((d) => d.name.replace(/^\./, '')));
  const linked = new Map();
  for (const file of htmlFiles) {
    const source = read(file);
    const sheets = [...source.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/g)].map((match) => match[1]).filter((href) => href.includes(vendor) || href.includes('dashboard-style'));
    linked.set(file, sheets);
  }
  for (const [file, kind] of [...htmlFiles.map((f) => [f, 'html']), ...jsFiles.map((f) => [f, 'js'])]) {
    const source = read(file);
    for (const { name, index } of usedClasses(source, kind)) {
      if (copy.keyframes.has(name) || removedClasses.has(name)) continue;
      if (!copy.classes.has(name)) add('error', file, lineAt(source, index), 'classes', `.${name} is not a class of this copy (ds.css)`);
      else if (kind === 'html') {
        const sheets = linked.get(file) ?? [];
        // ds.css and css/index.css (which imports every stylesheet) bring every class.
        const single = sheets.some((href) => /\/css\/[\w/.-]+\.css$/.test(href)) && !sheets.some((href) => /(^|\/)ds\.css$|\/css\/index\.css$/.test(href));
        const needs = copy.fileOf.get(name) ?? [];
        if (single && needs.length && !needs.some((path) => sheets.some((href) => href.endsWith(`/${path}`) || href === path))) {
          const others = needs.length > 1 ? ` (or ${needs.slice(1).join(', ')})` : '';
          add('error', file, lineAt(source, index), 'classes', `.${name} needs ${needs[0]}${others}, which this page does not link`);
        }
      }
    }
  }

  // stylesheets
  for (const file of cssFiles) {
    const source = read(file);
    const scanned = scan(source);
    for (const at of scanned.atRules) {
      if (/^@keyframes\b/.test(at.prelude)) add('error', file, at.line, 'keyframes', `${at.prelude}: no own keyframes; use the ds-* keyframes and the motion tokens`);
    }
    for (const rule of scanned.rules) {
      if (rule.context.some((at) => /^@keyframes\b/.test(at))) continue;
      const layered = rule.context.some((at) => /^@layer\b/.test(at));
      const selectors = selectorList(rule.selector);
      for (const selector of selectors) {
        for (const match of selector.matchAll(/\.(ds-[\w-]+)/g)) {
          if (!copy.classes.has(match[1]) && !NEUTRAL.has(match[1]) && !removedClasses.has(match[1])) add('error', file, rule.line, 'classes', `.${match[1]} is not a class of this copy (ds.css)`, selector);
        }
        if (/\[hidden\]/.test(selector)) add('error', file, rule.line, 'hidden', `${selector}: no [hidden] rule; ds.css hides [hidden] (with .ds-base) and every ds component inside .ds-theme`, selector);
        if (!layered && !/[.#[]/.test(selector)) add('error', file, rule.line, 'layers', `${selector}: an element rule outside a layer beats every ds component; put resets in a layer declared before ds (@layer reset, ds;)`, selector);
      }
      const own = selectors.some((selector) => selector.includes(`.${prefix}-`));
      const reaching = selectors.filter((selector) => {
        const parts = compounds(selector);
        const subject = parts.at(-1) ?? '';
        const dsClass = (part) => [...part.matchAll(/\.(ds-[\w-]+)/g)].some((match) => !NEUTRAL.has(match[1]));
        if (dsClass(subject)) return true;
        return parts.slice(0, -1).some(dsClass) && !subject.includes(`.${prefix}-`);
      });
      const body = rule.declarations.map((d) => `${d.property}:${d.value}`).join(';');
      for (const declaration of rule.declarations) {
        if (declaration.important) add('error', file, declaration.line, 'layers', `${declaration.property}: no !important; unlayered project CSS already wins over every ds layer`, rule.selector);
        if (own && !reaching.length) {
          for (const kind of literalKinds(declaration.property, declaration.value, body)) {
            add('error', file, declaration.line, 'literals', `${rule.selector} { ${declaration.property}: ${declaration.value} }: a ${kind} literal; read a token (--ds-* or --${prefix}-*)`, rule.selector);
          }
        }
        if (/^animation(-name)?$/.test(declaration.property)) {
          for (const part of declaration.value.split(',')) {
            for (const word of literalPart(part).split(/\s+/).filter((w) => /^-?[a-z_][\w-]*$/i.test(w))) {
              if (ANIMATION_WORDS.has(word)) continue;
              if (!copy.keyframes.has(word)) add('error', file, declaration.line, 'keyframes', `animation ${word}: not a keyframe of this copy; use the ds-* keyframes`, rule.selector);
            }
          }
        }
        if (reaching.length && !declaration.property.startsWith('--') && !PLACEMENT.test(declaration.property)) {
          add('error', file, declaration.line, 'restyle', `${reaching.join(', ')} { ${declaration.property} }: changes the look of a ds component; set its hooks (--ds-*) instead`, rule.selector);
        }
      }
      // A project state layer of its own: ::before in currentColor at a state opacity.
      if (own && selectors.some((selector) => /::before/.test(selector) && selector.includes(`.${prefix}-`))) {
        if (/--ds-state-(hover|pressed|focus)/.test(body) || /background(-color)?:currentColor/i.test(body)) add('warning', file, rule.line, 'pressable', `${rule.selector}: a state layer of its own; .ds-pressable gives a project element the hover, press and focus of the system`, rule.selector);
      }
    }
  }

  // themes
  if (themes.length && copy.tokens) {
    const missing = themesWith.filter((path) => !existsSync(join(root, path)));
    for (const path of missing) add('error', path, 0, 'themes', 'a file of "themesWith" is missing');
    const withFiles = themesWith.filter((path) => !missing.includes(path)).map((path) => ({ path, css: read(path) }));
    for (const finding of checkTheme({ files: themes.map((path) => ({ path, css: read(path) })), withFiles, tokens: copy.tokens, deprecations: copy.deprecations })) {
      if (finding.level === 'info') continue;
      add(finding.level, finding.file, finding.line, 'themes', `${finding.rule}: ${finding.message}`);
    }
  } else if (themes.length) add('error', vendor, 0, 'themes', 'tokens.json is missing from the copy');

  // scripts: attributes and innerHTML
  const attribute = new RegExp(`(?:setAttribute|toggleAttribute)\\(\\s*['"\`](${[...SYSTEM_ATTRIBUTES, ...SHARED_ATTRIBUTES].join('|')})['"\`]`, 'g');
  for (const file of jsFiles) {
    const source = read(file);
    const reserveOff = /reserve\s*:\s*false/.test(source);
    // A write that deprecations.json lists (the 1.x hand data-scrolled recipe) is reported once, by deprecated:
    // a warning while it is only deprecated, an error once it is removed.
    const listed = names.filter((entry) => entry.pattern).flatMap((entry) => [...source.matchAll(new RegExp(entry.pattern, 'g'))])
      .map((match) => [match.index, match.index + match[0].length]);
    for (const match of source.matchAll(attribute)) {
      if (SHARED_ATTRIBUTES.includes(match[1]) && reserveOff) continue;
      if (listed.some(([start, end]) => match.index >= start && match.index < end)) continue;
      add('error', file, lineAt(source, match.index), 'attributes', `${match[1]} is written by the system; the page never writes it${SHARED_ATTRIBUTES.includes(match[1]) ? ' (unless it passes reserve: false to toast())' : ''}`);
    }
    for (const match of source.matchAll(/\.dataset\.(scrolled|dsSentinel|dsEdges|dsOverflowStart|dsOverflowEnd|dsDragover|dsDragging|dsKeyboard|dsSavebar|dsSavebarRest)\s*=(?!=)/g)) {
      if (listed.some(([start, end]) => match.index >= start && match.index < end)) continue;
      add('error', file, lineAt(source, match.index), 'attributes', `dataset.${match[1]} is written by the system; the page never writes it`);
    }
    for (const match of source.matchAll(/\.innerHTML\s*\+?=(?!=)([^;]*)/g)) {
      if (/ds-/.test(match[1])) add('warning', file, lineAt(source, match.index), 'dom', 'innerHTML on ds markup: re-render with DS.dom.morphHtml (it patches in place and keeps focus, listeners and motion)');
    }
  }

  // exceptions
  const excepted = (finding) => (config.exceptions ?? []).some((exception) => exception.rule === finding.rule
    && (exception.file === finding.file || globRegExp(exception.file).test(finding.file))
    && (!exception.selector || exception.selector === finding.selector));
  return { findings: findings.filter((finding) => !excepted(finding)), errors: [] };
}

/** "<file>:<line> <rule> <message>", a warning marked as one. */
export function formatFinding(finding) {
  return `${finding.file}:${finding.line} ${finding.rule} ${finding.level === 'warning' ? 'warning: ' : ''}${finding.message}`;
}

function main(argv) {
  let configPath = 'ds-check.json';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config' && argv[i + 1]) configPath = argv[(i += 1)];
    else {
      console.error('Usage: node tools/check-project.mjs --config ds-check.json');
      return 2;
    }
  }
  if (!existsSync(configPath)) {
    console.error(`check-project.mjs: ${configPath} not found`);
    return 2;
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const root = dirname(resolve(configPath));
  const { findings, errors } = checkProject(config, root);
  if (errors.length) {
    for (const error of errors) console.error(`check-project.mjs: ${configPath}: ${error}`);
    return 2;
  }
  for (const finding of findings) (finding.level === 'error' ? console.error : console.log)(formatFinding(finding));
  const count = (level) => findings.filter((finding) => finding.level === level).length;
  console.log(`check-project: ${count('error')} error${count('error') === 1 ? '' : 's'}, ${count('warning')} warning${count('warning') === 1 ? '' : 's'} (${relative(process.cwd(), root) || '.'})`);
  return count('error') ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
