// Checks that a change adds no nested ternary (#685). Biome’s style/noNestedTernary isn’t on in biome.json, since main
// still has hits, so this runs it on its own, with two rules. A hit on a line the change adds fails, so removing an old
// one doesn’t pay for adding another. And a file with more hits than its blob at the merge base fails, since Biome
// reports the inner ternary’s span: an outer “a ? 1 :” added on its own line above an unchanged “b ? 2 : 3” puts no hit
// on an added line. The ones already on main stay until they’re fixed.
//
// The change is the diff from the merge base with main (tools/merge-base.mjs) to the working tree, so edits not yet
// committed count too; files git doesn’t track yet don’t, and CI sees only committed files. Only added, modified and
// renamed .mjs, .js and .cjs files are read, with the repo’s biome.json, so a file Biome doesn’t lint is skipped. Biome
// runs once on those files, and once more on their blobs at the merge base (a renamed one’s under its old path, a new
// one counting 0), copied into a temp folder: `biome lint --stdin-file-path` prints no diagnostics. Its cost grows with
// the changed files and their size, one `git show` each, never with the whole tree. With no base, it fails in CI and
// skips elsewhere. `npm run lint:project` runs it.
//
//   node tools/lint-ternary.mjs        against origin/main, or origin/$BASE_REF when that is set
//   node tools/lint-ternary.mjs REF    against REF

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedRanges } from './diff-added-lines.mjs';
import { isEntry } from './lint-lib.mjs';
import { baseRef, mergeBase, noBase } from './merge-base.mjs';

const BIOME = fileURLToPath(new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url));
const RULE = 'lint/style/noNestedTernary';
const LINTED = /\.(mjs|js|cjs)$/;

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

/**
 * The files `git diff -z --name-status` lists, each with its path now and its path at the base: '' for an added file,
 * and a renamed one’s old path.
 * @param {string} listed
 * @returns {{ path: string, oldPath: string }[]}
 */
export function changedFiles(listed) {
  const fields = listed.split('\0');
  /** @type {{ path: string, oldPath: string }[]} */
  const files = [];
  let i = 0;
  while (i < fields.length && fields[i] !== '') {
    const status = fields[i];
    if (status.startsWith('R')) {
      files.push({ oldPath: fields[i + 1], path: fields[i + 2] });
      i += 3;
      continue;
    }
    if (status === 'A') files.push({ oldPath: '', path: fields[i + 1] });
    else files.push({ oldPath: fields[i + 1], path: fields[i + 1] });
    i += 2;
  }
  return files;
}

/** How many hits each path has. @param {{ path: string }[]} hits */
export function countByPath(hits) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const hit of hits) counts.set(hit.path, (counts.get(hit.path) ?? 0) + 1);
  return counts;
}

/**
 * The files with more hits now than at the base, where a file missing from a count has none.
 * @param {string[]} paths @param {Map<string, number>} before @param {Map<string, number>} after
 */
export function risenCounts(paths, before, after) {
  const risen = paths.map((path) => ({ path, before: before.get(path) ?? 0, after: after.get(path) ?? 0 }));
  return risen.filter((file) => file.after > file.before);
}

/** A count of nested ternaries, in words. @param {number} n */
export const ternaries = (n) => (n === 1 ? '1 nested ternary' : `${n} nested ternaries`);

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

/**
 * The hits in these files’ blobs at the base, each under its path now. They’re copied into a temp folder with the
 * repo’s biome.json, less its plugins, which only lint browser specs and live in the repo. A repo with no biome.json
 * gets an empty one, Biome’s defaults, as its working tree has.
 * @param {string} top @param {(args: string[]) => string} git @param {string} at @param {{ path: string, oldPath: string }[]} files
 */
function baseHits(top, git, at, files) {
  const old = files.filter((file) => file.oldPath);
  if (!old.length) return [];
  const dir = mkdtempSync(join(tmpdir(), 'lint-ternary-'));
  try {
    const config = existsSync(join(top, 'biome.json')) ? JSON.parse(readFileSync(join(top, 'biome.json'), 'utf8')) : {};
    delete config.$schema;
    delete config.plugins;
    writeFileSync(join(dir, 'biome.json'), JSON.stringify(config));
    for (const file of old) {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true });
      writeFileSync(join(dir, file.path), git(['show', `${at}:${file.oldPath}`]));
    }
    const paths = old.map((file) => file.path);
    return nestedTernaries(biomeReport(dir, paths));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const diffArgs = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '--diff-filter=AMR'];
  const globs = ['--', '*.mjs', '*.js', '*.cjs'];
  const added = addedRanges(git([...diffArgs, '-U0', at, ...globs]));
  const changed = changedFiles(git([...diffArgs, '-z', '--name-status', at, ...globs]));
  const linted = changed.filter((file) => added.has(file.path) && LINTED.test(file.path));
  const files = linted.map((file) => file.path);
  const hitsNow = files.length ? nestedTernaries(biomeReport(top, files)) : [];
  const hits = newHits(hitsNow, added);
  const risen = risenCounts(files, countByPath(baseHits(top, git, at, linted)), countByPath(hitsNow));
  for (const hit of hits) console.log(`${hit.path}:${hit.start}: nested ternary on a changed line`);
  for (const file of risen) console.log(`${file.path}: ${ternaries(file.after)}, up from ${file.before} at the base`);
  if (hits.length || risen.length) {
    const found = [];
    if (hits.length) found.push(`${ternaries(hits.length)} on a changed line`);
    if (risen.length) found.push(`${risen.length === 1 ? '1 file' : `${risen.length} files`} with more than at ${at.slice(0, 8)}`);
    console.log(`\nlint-ternary: ${found.join(', and ')}. Use an if, or a small named helper with early returns.`);
    process.exitCode = 1;
  } else {
    console.log(`lint-ternary: no nested ternary on a line changed since ${at.slice(0, 8)}, and no file has more than there.`);
    console.log('Files git doesn’t track aren’t checked: CI sees only committed files.');
  }
}
