#!/usr/bin/env node
/**
 * Checks a theme file against the rules of docs/theming.md, without
 * dependencies (Node 18 or later):
 *
 *   node <copy>/tools/check-theme.mjs css/theme.css [more.css ...] [--with <copy>/themes/dark.css]
 *
 * The files are read as loaded after ds.css, in this order; `--with` files
 * load after them (a shipped theme your theme is used with) and count only
 * for the contrast pairs. Output: one line per finding,
 * "<file>:<line> <error|warning|info> <rule> <message>"; exit 1 when there
 * is an error, 2 on a usage error.
 *
 * Errors: an unknown --ds-* name (tools read ../tokens.json); a motion
 * token or motion hook set (theme-rules.mjs MOTION); a rule on :root;
 * @layer; !important; --ds-font-input under 16px; a removed name
 * (../deprecations.json). Warnings: a deprecated name (with its
 * replacement); a scale, runtime or internal property set; a text pair
 * under 4.5:1, a control, icon or outline pair under 3:1 (pairResults(),
 * resolving var(), hex, rgb() and color-mix(in srgb, ...); anything else is
 * reported as "not checked"); a component selector restyled in a theme.
 *
 * Every rule whose selector names .ds-theme sets roles: plain .ds-theme
 * (or .ds-theme.<widget>) is the base, every other selector or @media
 * block a variant checked over the base and, with --with, over the base
 * with those files; a variant warns only when it fails in each of them (a
 * dark variant of an accent passes over the dark theme).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, selectorList } from './css-scan.mjs';
import { isMotion, pairResults } from './theme-rules.mjs';

const BASE = /^\.ds-theme(\.[\w-]+)*$/;
const THEME_SCOPE = /\.ds-theme\b/;
/** Classes a theme may name without restyling a component. */
const NEUTRAL_CLASSES = new Set(['ds-theme', 'ds-base']);

/** The pixel size of a `font` shorthand (the first `<n>px` before a `/` or the family). */
function fontSize(value) {
  const match = /(?:^|\s)(\d*\.?\d+)px(?:\s*\/|\s)/.exec(` ${value} `);
  return match ? Number(match[1]) : null;
}

/**
 * The findings for `files` ([{ path, css }]), with `withFiles` loaded after
 * them for the contrast pairs. `tokens` is the parsed tokens.json,
 * `deprecations` the parsed deprecations.json (or null).
 */
export function checkTheme({ files, withFiles = [], tokens, deprecations = null }) {
  const findings = [];
  const add = (level, file, line, rule, message) => findings.push({ level, file, line, rule, message });
  const known = new Map((tokens?.tokens ?? []).map((entry) => [entry.name, entry]));
  const defaults = (name) => known.get(name)?.default ?? undefined;
  const names = deprecations?.names ?? [];

  /** Declarations per variant: base, then the others by label. */
  const collect = (list) => {
    const base = {};
    const variants = new Map();
    for (const { path, css } of list) {
      for (const rule of scan(css).rules) {
        const selectors = selectorList(rule.selector).filter((selector) => THEME_SCOPE.test(selector));
        if (!selectors.length) continue;
        const isBase = !rule.context.some((at) => at.startsWith('@media') || at.startsWith('@supports') || at.startsWith('@container')) && selectors.every((selector) => BASE.test(selector));
        const target = isBase ? base : (() => {
          const label = [...rule.context, rule.selector].join(' ');
          if (!variants.has(label)) variants.set(label, { path, line: rule.line, values: {} });
          return variants.get(label).values;
        })();
        for (const declaration of rule.declarations) if (declaration.property.startsWith('--')) target[declaration.property] = declaration.value;
      }
    }
    return { base, variants };
  };

  for (const { path, css } of files) {
    const scanned = scan(css);
    for (const statement of scanned.statements) {
      if (/^@layer\b/.test(statement.text)) add('error', path, statement.line, 'layer', 'a theme is never in @layer: unlayered rules win over every ds.* layer');
    }
    for (const at of scanned.atRules) {
      if (/^@layer\b/.test(at.prelude)) add('error', path, at.line, 'layer', 'a theme is never in @layer: unlayered rules win over every ds.* layer');
    }
    for (const rule of scanned.rules) {
      const selectors = selectorList(rule.selector);
      if (selectors.some((selector) => /:root\b/.test(selector))) add('error', path, rule.line, 'root', `${rule.selector}: tokens live on .ds-theme, never on :root`);
      const restyled = selectors.some((selector) => [...selector.matchAll(/\.(ds-[\w-]+)/g)].some((match) => !NEUTRAL_CLASSES.has(match[1])));
      for (const declaration of rule.declarations) {
        const { property, value, line } = declaration;
        if (declaration.important) add('error', path, line, 'important', `${property}: no !important in a theme`);
        if (!property.startsWith('--')) {
          if (restyled) add('warning', path, line, 'restyle', `${rule.selector} { ${property} }: a theme sets roles and hooks; restyling a component overrides it in every state`);
          continue;
        }
        if (!property.startsWith('--ds-')) continue;
        if (isMotion(property)) {
          add('error', path, line, 'motion', `${property}: motion tokens and motion hooks are one scheme for every product; never set them`);
          continue;
        }
        const entry = known.get(property);
        const deprecation = names.find((d) => d.name === property);
        if (deprecation?.removed) add('error', path, line, 'removed', `${property} was removed in ${deprecation.removed}${deprecation.replacement ? `: use ${deprecation.replacement}` : ''}`);
        else if (deprecation) add('warning', path, line, 'deprecated', `${property} is deprecated since ${deprecation.deprecated}${deprecation.replacement ? `: use ${deprecation.replacement}` : ''}`);
        else if (!entry) add('error', path, line, 'unknown', `${property} is not a token of this version (tokens.json)`);
        else if (!entry.themeable) add('warning', path, line, 'not-themeable', `${property} is ${/^[aeiou]/.test(entry.layer) ? 'an' : 'a'} ${entry.layer} property: themes set roles and hooks only`);
        if (property === '--ds-input-font') {
          const size = fontSize(value.startsWith('var(') ? '' : value);
          if (size !== null && size < 16) add('warning', path, line, 'input-font', `${property}: ${size}px on phones makes iOS zoom into fields`);
        }
      }
    }
    // Removed names read anywhere (var(--ds-old), a keyframe, a class), by the patterns of deprecations.json.
    for (const entry of names.filter((d) => d.removed && d.pattern)) {
      const pattern = new RegExp(entry.pattern, 'g');
      const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        if (!findings.some((f) => f.file === path && f.line === line && f.rule === 'removed')) add('error', path, line, 'removed', `${entry.name} was removed in ${entry.removed}${entry.replacement ? `: use ${entry.replacement}` : ''}`);
      }
    }
  }

  // Values: the base of the theme files over the defaults, then each variant, then the --with files.
  const theme = collect(files);
  const extra = collect(withFiles);
  const first = files[0]?.path ?? 'theme';
  // A group is one way the theme is used; a variant is fine when one of its
  // contexts passes (a dark variant passes over the --with dark theme, a
  // light one over the base), so only a variant that fails everywhere warns.
  const groups = [[{ label: null, layers: [theme.base] }]];
  const withLabel = withFiles.length ? `with ${withFiles.map((file) => file.path).join(', ')}` : null;
  if (withLabel) groups.push([{ label: withLabel, layers: [theme.base, extra.base] }]);
  for (const [label, variant] of theme.variants) {
    const group = [{ label, layers: [theme.base, variant.values] }];
    if (withLabel) group.push({ label: `${label}, ${withLabel}`, layers: [theme.base, extra.base, variant.values] });
    groups.push(group);
  }
  for (const group of groups) {
    const results = group.map(({ label, layers }) => {
      const found = [];
      const lookup = (name) => {
        for (const layer of [...layers].reverse()) if (name in layer) return layer[name];
        return defaults(name);
      };
      const where = label ? ` (${label})` : '';
      // Field text: the input role (or the reading role it follows) at 16px or more.
      let input = lookup('--ds-font-input');
      for (let hops = 0; input && /^var\(--ds-[\w-]+\)$/.test(input) && hops < 8; hops += 1) input = lookup(input.slice(4, -1));
      const size = input ? fontSize(input) : null;
      if (size !== null && size < 16) found.push({ level: 'error', file: first, line: 0, rule: 'input-font', message: `--ds-font-input resolves to ${size}px${where}: keep field text at 16px or more (iOS zooms into smaller fields)` });
      for (const pair of pairResults(lookup)) {
        if (pair.ratio === null) found.push({ level: 'info', file: first, line: 0, rule: 'contrast', message: `${pair.fg} on ${pair.bg}${where}: not checked (a colour form this check does not resolve)` });
        else if (pair.ratio < pair.min) found.push({ level: 'warning', file: first, line: 0, rule: 'contrast', message: `${pair.fg} on ${pair.bg}${where}: ${pair.ratio.toFixed(2)}:1, needs ${pair.min}:1 (${pair.kind})` });
      }
      return found;
    });
    if (results.length > 1 && results.some((found) => !found.some((finding) => finding.level !== 'info'))) continue;
    for (const found of results) findings.push(...found);
  }
  return findings;
}

/** "<file>:<line> <level> <rule> <message>" (line 0: the theme as a whole). */
export function formatFinding(finding) {
  return `${finding.file}:${finding.line} ${finding.level} ${finding.rule} ${finding.message}`;
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [];
  const withFiles = [];
  let tokensPath = join(here, '..', 'tokens.json');
  let deprecationsPath = join(here, '..', 'deprecations.json');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--with' && argv[i + 1]) withFiles.push(argv[(i += 1)]);
    else if (arg === '--tokens' && argv[i + 1]) tokensPath = argv[(i += 1)];
    else if (arg === '--deprecations' && argv[i + 1]) deprecationsPath = argv[(i += 1)];
    else if (arg.startsWith('-')) {
      console.error('Usage: node tools/check-theme.mjs <theme.css> [more.css ...] [--with <shipped theme>]');
      return 2;
    } else files.push(arg);
  }
  if (!files.length) {
    console.error('Usage: node tools/check-theme.mjs <theme.css> [more.css ...] [--with <shipped theme>]');
    return 2;
  }
  const tokens = readJson(resolve(tokensPath));
  if (!tokens) {
    console.error(`check-theme.mjs: ${tokensPath} not found (run it from a copy's tools/ folder, or pass --tokens)`);
    return 2;
  }
  const read = (path) => ({ path, css: readFileSync(path, 'utf8') });
  const findings = checkTheme({ files: files.map(read), withFiles: withFiles.map(read), tokens, deprecations: readJson(resolve(deprecationsPath)) });
  for (const finding of findings) (finding.level === 'error' ? console.error : console.log)(formatFinding(finding));
  const errors = findings.filter((finding) => finding.level === 'error').length;
  const warnings = findings.filter((finding) => finding.level === 'warning').length;
  console.log(`check-theme: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
  return errors ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
