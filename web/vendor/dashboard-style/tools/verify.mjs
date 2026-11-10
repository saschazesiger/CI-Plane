#!/usr/bin/env node
/**
 * Verifies a copy of Dashboard-Style against its SHA256SUMS, without
 * network and without dependencies (Node 18 or later):
 *
 *   node <copy>/tools/verify.mjs                 the copy this file sits in
 *   node <copy>/tools/verify.mjs --dir <path>    another copy (or a dist/)
 *
 * Exit 0 when every file matches, 1 on any difference, 2 on a usage error.
 * The rules are those of `vendor.sh --check` (tools/verify.sh is the same
 * check in POSIX sh):
 * - SHA256SUMS lists every file below the directory except files named
 *   SHA256SUMS, VERSION included when the copy has one;
 * - one line per file, "<sha256 in lowercase hex>  <relative path>" (two
 *   spaces, forward slashes), sorted by path in byte order (LC_ALL=C), LF
 *   line ends (a CR is ignored, so a Windows checkout still verifies);
 * - no symbolic link anywhere: the listing cannot cover one.
 * A file that is missing, changed, added or out of order fails.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINE = /^([0-9a-f]{64}) {2}(\S(?:.*\S)?)$/;

/** Every entry below `dir` as posix paths: { files, links } (byte order). */
function walk(dir, prefix = '') {
  const files = [];
  const links = [];
  for (const name of readdirSync(join(dir, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(dir, path));
    if (stat.isSymbolicLink()) links.push(path);
    else if (stat.isDirectory()) {
      const inner = walk(dir, path);
      files.push(...inner.files);
      links.push(...inner.links);
    } else if (name !== 'SHA256SUMS') files.push(path);
  }
  return { files, links };
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * The problems of the copy in `dir`, as human-readable lines (empty when it
 * verifies), and the version its VERSION file names (or null).
 */
export function verify(dir) {
  const root = resolve(dir);
  const problems = [];
  const sumsPath = join(root, 'SHA256SUMS');
  if (!existsSync(sumsPath)) return { problems: [`${sumsPath} not found`], version: null };
  const { files, links } = walk(root);
  for (const link of links.sort(byteOrder)) problems.push(`symbolic link (SHA256SUMS cannot cover it): ${link}`);
  const listed = readFileSync(sumsPath, 'utf8').replace(/\r/g, '').replace(/\n+$/, '').split('\n').filter((line, index, all) => line || all.length > 1);
  const expected = new Map();
  const order = [];
  for (const [index, line] of listed.entries()) {
    const match = LINE.exec(line);
    if (!match) {
      problems.push(`SHA256SUMS line ${index + 1} is not "<sha256>  <path>": ${JSON.stringify(line)}`);
      continue;
    }
    if (expected.has(match[2])) problems.push(`listed twice: ${match[2]}`);
    expected.set(match[2], match[1]);
    order.push(match[2]);
  }
  const sorted = [...order].sort(byteOrder);
  if (order.some((path, index) => path !== sorted[index])) problems.push('SHA256SUMS is not sorted by path in byte order (LC_ALL=C)');
  const present = new Set(files);
  for (const path of [...expected.keys()].sort(byteOrder)) {
    if (!present.has(path)) problems.push(`missing: ${path}`);
    else if (createHash('sha256').update(readFileSync(join(root, path))).digest('hex') !== expected.get(path)) problems.push(`changed: ${path}`);
  }
  for (const path of files.sort(byteOrder)) if (!expected.has(path)) problems.push(`not listed (added): ${path}`);
  let version = null;
  try {
    version = /^version (.+)$/m.exec(readFileSync(join(root, 'VERSION'), 'utf8'))?.[1].trim() ?? null;
  } catch {
    version = null;
  }
  return { problems, version };
}

function main(argv) {
  let dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir' && argv[i + 1]) dir = argv[(i += 1)];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node tools/verify.mjs [--dir <copy>]');
      return 0;
    } else {
      console.error(`verify.mjs: unknown argument ${argv[i]} (usage: node tools/verify.mjs [--dir <copy>])`);
      return 2;
    }
  }
  const { problems, version } = verify(dir);
  if (problems.length) {
    console.error(`verify.mjs: ${dir} does not match its SHA256SUMS:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  console.log(`${dir} matches its SHA256SUMS${version ? ` (${version})` : ''}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
