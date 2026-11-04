// Checks that a change adds no nested ternary (#685): no new nested ternary on a line this PR changes. Biome’s
// style/noNestedTernary isn’t on in biome.json, since main still has hits, so this runs it on its own and keeps only
// the hits on a line the change adds. The ones already on main stay until they’re fixed; removing one doesn’t pay for
// adding another, since only added lines count.
//
// The change is the diff from the merge base with main (tools/merge-base.mjs) to the working tree, so edits not yet
// committed count too; files git doesn’t track yet don’t. Only added, modified and renamed .mjs, .js and .cjs files are
// read, and Biome runs once, on just those files, with the repo’s biome.json, so a file Biome doesn’t lint is skipped.
// Its cost grows with the changed files and their size, never with the whole tree. With no base, it fails in CI and
// skips elsewhere. `npm run lint:project` runs it.
//
//   node tools/lint-ternary.mjs        against origin/main, or origin/$BASE_REF when that is set
//   node tools/lint-ternary.mjs REF    against REF

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './lint-lib.mjs';
import { baseRef, mergeBase, noBase } from './merge-base.mjs';

const BIOME = fileURLToPath(new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url));
const RULE = 'lint/style/noNestedTernary';
const LINTED = /\.(mjs|js|cjs)$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const C_ESCAPES = /** @type {Record<string, number>} */ ({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 });

/**
 * A path as git writes it after `+++ `: quoted C-style when it holds a quote, a backslash or a control character, and
 * followed by a tab when it holds a space.
 * @param {string} written
 */
function unquotePath(written) {
  if (!written.startsWith('"')) return written.replace(/\t$/, '');
  const inner = written.slice(1, written.lastIndexOf('"'));
  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      bytes.push(...Buffer.from(inner[i]));
      continue;
    }
    const octal = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    bytes.push(C_ESCAPES[inner[i + 1]] ?? inner.charCodeAt(i + 1));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The lines a `git diff -U0` adds, by file: each file’s added ranges, first and last line, from its hunk headers. Each
 * hunk’s lines are counted off its header, so a removed line that reads “-- a/…” or an added one that reads “++ b/…”
 * stays in its hunk and is never taken for the next file’s header. A `+++` line that names no new file throws, and so
 * does a diff that ends inside a hunk: either would be a diff this can’t read, and must not pass as no added lines.
 * @param {string} diff
 * @returns {Map<string, { start: number, end: number }[]>}
 */
export function addedRanges(diff) {
  /** @type {Map<string, { start: number, end: number }[]>} */
  const byFile = new Map();
  let path = '';
  let removedLeft = 0;
  let addedLeft = 0;
  for (const line of diff.split('\n')) {
    if (removedLeft + addedLeft > 0) {
      if (line.startsWith('-')) removedLeft--;
      if (line.startsWith('+')) addedLeft--;
      continue;
    }
    if (line.startsWith('+++ ')) {
      path = newPath(line);
      continue;
    }
    const hunk = HUNK.exec(line);
    if (!hunk) continue;
    removedLeft = hunkCount(hunk[2]);
    addedLeft = hunkCount(hunk[4]);
    if (addedLeft === 0) continue;
    const start = Number(hunk[3]);
    const ranges = byFile.get(path) ?? [];
    ranges.push({ start, end: start + addedLeft - 1 });
    byFile.set(path, ranges);
  }
  if (removedLeft + addedLeft > 0) throw new Error('lint-ternary: the diff ends inside a hunk.');
  return byFile;
}

/** A hunk header’s line count: one when the header leaves it out. @param {string | undefined} written */
const hunkCount = (written) => (written === undefined ? 1 : Number(written));

/** The new file a `+++ ` header names, or a throw when it names none. @param {string} line */
function newPath(line) {
  const written = unquotePath(line.slice(4));
  if (!written.startsWith('b/')) throw new Error(`lint-ternary: can’t read the diff’s “${line}”.`);
  return written.slice(2);
}

/**
 * Whether a span, from line start to line end, holds any of the added lines.
 * @param {{ start: number, end: number }[]} added @param {number} start @param {number} end
 */
export function overlapsAdded(added, start, end) {
  return added.some((range) => start <= range.end && end >= range.start);
}

/**
 * The nested ternaries in Biome’s JSON report, each with its path and its first and last lines. An error in the report,
 * or diagnostics Biome left out, throws, so a run that read nothing can’t pass as one that found nothing.
 * @param {any} report
 * @returns {{ path: string, start: number, end: number }[]}
 */
export function nestedTernaries(report) {
  const notPrinted = report.summary?.diagnosticsNotPrinted ?? 0;
  if (notPrinted) throw new Error(`lint-ternary: Biome left out ${notPrinted} diagnostics.`);
  /** @type {{ path: string, start: number, end: number }[]} */
  const hits = [];
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.category === RULE) {
      const { path, start, end } = diagnostic.location;
      hits.push({ path, start: start.line, end: end.line });
      continue;
    }
    if (diagnostic.severity === 'error' || diagnostic.severity === 'fatal') {
      throw new Error(`lint-ternary: Biome reported ${diagnostic.category} on ${diagnostic.location?.path}: ${diagnostic.message}`);
    }
  }
  return hits;
}

/**
 * The hits on a line their file’s change adds.
 * @param {{ path: string, start: number, end: number }[]} hits @param {Map<string, { start: number, end: number }[]>} added
 */
export function newHits(hits, added) {
  return hits.filter((hit) => overlapsAdded(added.get(hit.path) ?? [], hit.start, hit.end));
}

/** The top folder of the git checkout the lint runs in, or '' outside one. */
function checkoutTop() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Biome’s report of nested ternaries in these files, run once from the repo’s top folder. */
function biomeReport(/** @type {string} */ top, /** @type {string[]} */ files) {
  const args = [BIOME, 'lint', `--only=${RULE.slice('lint/'.length)}`, '--reporter=json', '--no-errors-on-unmatched', '--max-diagnostics=none'];
  const result = spawnSync(process.execPath, [...args, '--', ...files], { cwd: top, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`lint-ternary: Biome exited ${result.status}: ${result.stderr}${result.stdout}`);
  return JSON.parse(result.stdout);
}

if (isEntry(import.meta.url, process.argv[1])) {
  const top = checkoutTop();
  if (!top) {
    const result = noBase('lint-ternary', 'git checkout here', process.env);
    console.log(result.message);
    process.exit(result.code);
  }
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const ref = baseRef(process.argv[2], process.env);
  const at = mergeBase(git, ref);
  if (!at) {
    const result = noBase('lint-ternary', ref, process.env);
    console.log(result.message);
    process.exit(result.code);
  }
  const diffArgs = ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '-M', '--diff-filter=AMR'];
  const added = addedRanges(git([...diffArgs, at, '--', '*.mjs', '*.js', '*.cjs']));
  const files = [...added.keys()].filter((path) => LINTED.test(path));
  const hits = files.length ? newHits(nestedTernaries(biomeReport(top, files)), added) : [];
  for (const hit of hits) console.log(`${hit.path}:${hit.start}: nested ternary on a changed line`);
  if (hits.length) {
    const counted = hits.length === 1 ? '1 nested ternary' : `${hits.length} nested ternaries`;
    console.log(`\nlint-ternary: ${counted} on a changed line. Use an if, or a small named helper with early returns.`);
    process.exitCode = 1;
  } else console.log(`lint-ternary: no nested ternary on a line changed since ${at.slice(0, 8)}.`);
}
