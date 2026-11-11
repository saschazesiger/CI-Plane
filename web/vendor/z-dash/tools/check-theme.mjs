#!/usr/bin/env node
/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
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
 * resolving var(), hex, rgb(), color-mix(in srgb, ...) and light-dark() in
 * each scheme (below); anything else is reported as "not checked"); a
 * component selector restyled in a theme.
 *
 * Every rule whose selector names .ds-theme sets roles: plain .ds-theme
 * (or .ds-theme.<widget>) is the base, every other selector or @media
 * block a variant checked over the base and, with --with, over the base
 * with those files; a variant warns only when it fails in each of them (a
 * dark variant of an accent passes over the dark theme).
 *
 * One file for both schemes: where a role is light-dark(<light>, <dark>),
 * every pair is checked in each scheme the theme shows (the schemes its
 * --ds-color-scheme names: "light dark" both, a pinned
 * [data-ds-scheme="dark"] variant dark only), and a finding names its
 * scheme ("(dark)").
 *
 * 3.0 (docs/theming.md, "Checking a theme"):
 *   seed     a --ds-seed-* property (an error: a seed is the input of
 *            tools/theme.mjs, never a token); a generator header whose command
 *            the generator refuses (an unreadable seed, an unknown scheme)
 *   options  an option the theme sets (--ds-density, --ds-shape,
 *            --ds-size-step, --ds-type-scale, --ds-target-min) in a form the
 *            components cannot compute with (an error: a unit on a number, a
 *            number for a length), or outside its documented values (a
 *            warning); a --ds-* property set under an option class (an
 *            error: it redefines the class)
 *   drift    a file with the header of tools/theme.mjs whose values differ
 *            from what that command writes today (a warning: a hand edit or a
 *            file from an older generator; regenerate it). The CLI and
 *            check-project.mjs pass the generator (`generate`); the
 *            generator's own CLI checks its output without it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, selectorList } from './css-scan.mjs';
import { hasLightDark, isMotion, isRemoved, pairResults, pickLightDark, schemesOf } from './theme-rules.mjs';

const BASE = /^\.ds-theme(\.[\w-]+)*$/;
const THEME_SCOPE = /\.ds-theme\b/;
/** Classes a theme may name without restyling a component. */
const NEUTRAL_CLASSES = new Set(['ds-theme', 'ds-base']);
/** An option class (docs/options.md): the classes keep their meaning in every theme. */
const OPTION_CLASS = /\.(ds-(?:xs|sm|md|lg|xl|density-[a-z]+|shape-[a-z]+|tone-[a-z]+|touch))(?![\w-])/;

/**
 * The option class a selector list styles, or null. A class inside :not()
 * or :has() is a condition (`.ds-theme:not(.ds-touch)`, as compact.css
 * writes it), and one on the theme root itself (`.ds-theme.ds-touch`) a
 * variant of the theme: neither redefines the class.
 */
export function optionStyled(selector) {
  for (const one of selectorList(selector)) {
    const bare = one.replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)/g, '');
    for (const compound of bare.split(/\s*[\s>+~]\s*/)) {
      if (/\.ds-theme(?![\w-])/.test(compound)) continue;
      const match = OPTION_CLASS.exec(compound);
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * The options a theme may set as defaults, with the values the components
 * are built for (docs/options.md): a plain number, from `min` to `max`, in
 * whole steps where `whole`; --ds-target-min is a length.
 */
export const OPTION_VALUES = {
  '--ds-density': { min: -3, max: 0, whole: true, what: '0, -1, -2 or -3 (.ds-density-comfortable ... -tight)' },
  '--ds-shape': { min: 0, max: 1.5, what: '0 (square) to 1.5 (round)' },
  '--ds-size-step': { min: -2, max: 2, whole: true, what: '-2 to 2 (.ds-xs ... .ds-xl)' },
  '--ds-type-scale': { min: 0.75, max: 1.5, what: 'a factor near 1 (1.125: body text 15.75px)' },
  '--ds-target-min': { length: true, what: 'a length (0px, or var(--ds-touch-target) as .ds-touch sets it)' },
};

/**
 * The generator's options from the command in a generated theme's header, or null when the file has none. Every
 * comment counts, not only the first: a copy's preset starts with the version banner, and a project may put a
 * licence or a description above the generated header.
 */
export function generatorCommand(css) {
  const COMMAND = /node\s+\S*theme\.mjs((?:\s+--[\w-]+(?:\s+(?:'[^']*'|"[^"]*"|[^\s*'"-][^\s*]*))?)+)/;
  let header = null;
  let match = null;
  for (const comment of css.matchAll(/\/\*[\s\S]*?\*\//g)) {
    // Only the generator's own header: a project theme that quotes the command (how to make one) is no output of it.
    if (!/generated by tools\/theme\.mjs/i.test(comment[0])) continue;
    match = COMMAND.exec(comment[0]);
    if (match) {
      header = comment;
      break;
    }
  }
  if (!match) return null;
  const options = {};
  const unknown = [];
  const VALUED = ['seed', 'neutral', 'accent', 'error', 'success', 'warning', 'info', 'scheme', 'contrast', 'name'];
  for (const part of match[1].matchAll(/--([\w-]+)(?:\s+('[^']*'|"[^"]*"|[^\s*'"-][^\s*]*))?/g)) {
    // --out names where the file went: the regeneration of the drift check writes nowhere.
    if (part[1] === 'out') continue;
    if (!VALUED.includes(part[1]) || part[2] === undefined) unknown.push(`--${part[1]}`);
    else options[part[1]] = part[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { text: `node tools/theme.mjs${match[1].replace(/\s+/g, ' ')}`, options, unknown, line: css.slice(0, header.index + header[0].indexOf(match[0])).split('\n').length };
}

/** The custom properties of the plain `.ds-theme` rules of a stylesheet, with their lines (the last one wins). */
function baseDeclarations(css) {
  const out = new Map();
  for (const rule of scan(css).rules) {
    if (rule.context.length || rule.selector.trim() !== '.ds-theme') continue;
    for (const declaration of rule.declarations) if (declaration.property.startsWith('--')) out.set(declaration.property, declaration);
  }
  return out;
}

/** The pixel size of a `font` shorthand (the first `<n>px` before a `/` or the family). */
function fontSize(value, scale = 1) {
  // The default roles: the size times the type scale, and the input role's floor over it.
  const floor = /max\(\s*(\d*\.?\d+)px\s*,\s*calc\(\s*(\d*\.?\d+)px \* var\(--ds-type-scale[^)]*\)\s*\)\s*\)/.exec(value);
  if (floor) return Math.max(Number(floor[1]), Number(floor[2]) * scale);
  const scaled = /calc\(\s*(\d*\.?\d+)px \* var\(--ds-type-scale[^)]*\)\s*\)/.exec(value);
  if (scaled) return Number(scaled[1]) * scale;
  const match = /(?:^|\s)(\d*\.?\d+)px(?:\s*\/|\s)/.exec(` ${value} `);
  return match ? Number(match[1]) : null;
}

/**
 * The findings for `files` ([{ path, css }]), with `withFiles` loaded after
 * them for the contrast pairs. `tokens` is the parsed tokens.json,
 * `deprecations` the parsed deprecations.json (or null), `generate` the
 * generateTheme() of tools/theme.mjs (or null: no drift check).
 */
export function checkTheme({ files, withFiles = [], tokens, deprecations = null, generate = null }) {
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
        if (/^--ds-seed(-|$)/.test(property)) {
          add('error', path, line, 'seed', `${property}: a seed is no token; it is the input of tools/theme.mjs (node tools/theme.mjs --seed <colour> --out <file>), which writes every colour role from it`);
          continue;
        }
        const styled = optionStyled(rule.selector);
        if (styled) {
          add('error', path, line, 'options', `${rule.selector} { ${property} }: redefines what .${styled} means; set the default on .ds-theme, and the option classes step from it`);
          continue;
        }
        const option = OPTION_VALUES[property];
        if (option) {
          const text = value.trim();
          const number = /^-?(?:\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : null;
          if (option.length) {
            if (number !== null && number !== 0) add('error', path, line, 'options', `${property}: ${text} is a number; it is ${option.what}`);
          } else if (/^-?(?:\d+\.?\d*|\.\d+)[a-z%]+$/i.test(text)) {
            add('error', path, line, 'options', `${property}: ${text} has a unit; it is a plain number, ${option.what} (components multiply it: calc(var(${property}) * 4px))`);
          } else if (number !== null && (number < option.min || number > option.max || (option.whole && !Number.isInteger(number)))) {
            add('warning', path, line, 'options', `${property}: ${text} is outside what the components are built for: ${option.what}`);
          }
        }
        if (isMotion(property)) {
          add('error', path, line, 'motion', `${property}: motion tokens and motion hooks are one scheme for every product; never set them`);
          continue;
        }
        const entry = known.get(property);
        const deprecation = names.find((d) => d.name === property);
        if (isRemoved(deprecation, deprecations?.version)) add('error', path, line, 'removed', `${property} was removed in ${deprecation.removed}${deprecation.replacement ? `: use ${deprecation.replacement}` : ''}`);
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
    for (const entry of names.filter((d) => isRemoved(d, deprecations?.version) && d.pattern)) {
      const pattern = new RegExp(entry.pattern, 'g');
      const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        if (!findings.some((f) => f.file === path && f.line === line && f.rule === 'removed')) add('error', path, line, 'removed', `${entry.name} was removed in ${entry.removed}${entry.replacement ? `: use ${entry.replacement}` : ''}`);
      }
    }
    // A generated theme: its header names the command; the file holds what that command writes today.
    const command = generatorCommand(css);
    if (command) {
      if (command.unknown.length) add('error', path, command.line, 'seed', `the generator header names ${command.unknown.join(', ')}, which tools/theme.mjs does not take: ${command.text}`);
      else if (generate) {
        let generated = null;
        try {
          generated = generate(command.options);
        } catch (problem) {
          add('error', path, command.line, 'seed', `the generator refuses the command of the header (${command.text}): ${problem.message}`);
        }
        if (generated) {
          const want = baseDeclarations(generated.css);
          const have = baseDeclarations(css);
          const norm = (text) => text.replace(/\s+/g, ' ').trim();
          const differ = [...want].filter(([name, declaration]) => !have.has(name) || norm(have.get(name).value) !== norm(declaration.value)).map(([name]) => name);
          if (differ.length) {
            const first = differ.map((name) => have.get(name)?.line).find((value) => value !== undefined) ?? command.line;
            const names = `${differ.slice(0, 4).join(', ')}${differ.length > 4 ? ` and ${differ.length - 4} more` : ''}`;
            add('warning', path, first, 'drift', `${differ.length} of ${want.size} values differ from what the generator writes for its header's command (${names}): regenerate the file with ${command.text} --out <file>; a deliberate change goes into a theme file loaded after it`);
          }
        }
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
      const raw = (name) => {
        for (const layer of [...layers].reverse()) if (name in layer) return layer[name];
        return defaults(name);
      };
      const where = label ? ` (${label})` : '';
      // Field text: the input role (or the reading role it follows) at 16px or more.
      let input = raw('--ds-font-input');
      for (let hops = 0; input && /^var\(--ds-[\w-]+\)$/.test(input) && hops < 8; hops += 1) input = raw(input.slice(4, -1));
      const size = input ? fontSize(input, Number(raw('--ds-type-scale')) || 1) : null;
      if (size !== null && size < 16) found.push({ level: 'error', file: first, line: 0, rule: 'input-font', message: `--ds-font-input resolves to ${size}px${where}: keep field text at 16px or more (iOS zooms into smaller fields)` });
      // light-dark() roles: each scheme the theme shows, as that scheme sees every value.
      const both = layers.some((layer) => Object.values(layer).some(hasLightDark));
      const views = both ? schemesOf(raw('--ds-color-scheme')).map((scheme) => ({ lookup: (name) => pickLightDark(raw(name), scheme), where: ` (${label ? `${label}, ` : ''}${scheme})` })) : [{ lookup: raw, where }];
      for (const view of views) {
        for (const pair of pairResults(view.lookup)) {
          if (pair.ratio === null) found.push({ level: 'info', file: first, line: 0, rule: 'contrast', message: `${pair.fg} on ${pair.bg}${view.where}: not checked (a colour form this check does not resolve)` });
          else if (pair.ratio < pair.min) found.push({ level: 'warning', file: first, line: 0, rule: 'contrast', message: `${pair.fg} on ${pair.bg}${view.where}: ${pair.ratio.toFixed(2)}:1, needs ${pair.min}:1 (${pair.kind})` });
        }
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

async function main(argv) {
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
  // Imported here, not at the top: the generator's own CLI imports this file to check what it writes.
  const { generateTheme } = await import('./theme.mjs');
  const findings = checkTheme({ files: files.map(read), withFiles: withFiles.map(read), tokens, deprecations: readJson(resolve(deprecationsPath)), generate: generateTheme });
  for (const finding of findings) (finding.level === 'error' ? console.error : console.log)(formatFinding(finding));
  const errors = findings.filter((finding) => finding.level === 'error').length;
  const warnings = findings.filter((finding) => finding.level === 'warning').length;
  console.log(`check-theme: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
  return errors ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
