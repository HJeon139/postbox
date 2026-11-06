// Checks that a change adds no nested ternary (#685). Biome’s style/noNestedTernary isn’t on in biome.json, since main
// still has hits, so this runs it on its own. Each hit is keyed by the trimmed text of its lines, and a key with more
// hits now, over every file the change touches, than at the merge base fails: so moving, reindenting or splitting code
// with an old hit passes, even into a new file or out of a deleted one (#752), while a copy, an edited line, or a new
// hit that replaces a removed one with other text fails. The excess is put on added lines first, as “on a changed
// line”; one left on an unchanged line is reported as its file’s count, since Biome reports the inner ternary’s span:
// an outer “a ? 1 :” added above an unchanged “b ? 2 : 3” puts no hit on an added line. The ones already on main stay
// until they’re fixed.
//
// A real exception carries `lint-allow ternary: <reason>` on the line this names or the line above, and such a hit is
// left out both now and at the base (#753). Only that line-level form counts: `lint-allow-file ternary` excuses nothing,
// so a whole file can’t opt out, and a failure in a file that has one says so. A `biome-ignore` for the rule would pass
// here but fails `npm run lint` as an unused suppression, since the rule isn’t on in biome.json.
//
// The change is the diff from the merge base with main (tools/merge-base.mjs) to the working tree, so edits not yet
// committed count too; files git doesn’t track yet don’t, and CI sees only committed files. Only added, modified and
// renamed .mjs, .js and .cjs files are read, with the repo’s biome.json, so a file Biome doesn’t lint is skipped. Biome
// runs once on those files, and once more on their blobs at the merge base and those of the deleted ones (a renamed
// one’s under its old path, a new one counting 0), copied into a temp folder: `biome lint --stdin-file-path` prints no
// diagnostics. Its cost grows with the changed files and their size, one `git show` each, never with the whole tree.
// With no base, it fails in CI and skips elsewhere. `npm run lint:project` runs it.
//
//   node tools/lint-ternary.mjs        against origin/main, or origin/$BASE_REF when that is set
//   node tools/lint-ternary.mjs REF    against REF

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedRanges, DIFF_OPTIONS } from './diff-added-lines.mjs';
import { allowedOnLine, isEntry } from './lint-lib.mjs';
import { baseRef, mergeBase, noBase } from './merge-base.mjs';

const BIOME = fileURLToPath(new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url));
const RULE = 'lint/style/noNestedTernary';
const LINTED = /\.(mjs|js|cjs)$/;
const FILE_ALLOW = /lint-allow-file ternary\b/;

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

/** @typedef {{ path: string, start: number, end: number, key: string }} Hit */

/**
 * What a hit is matched by across the change: the trimmed text of its lines, so moving or reindenting it keeps it.
 * @param {string[]} lines its file’s lines @param {{ start: number, end: number }} hit
 */
export function hitKey(lines, hit) {
  return lines
    .slice(hit.start - 1, hit.end)
    .map((line) => line.trim())
    .join('\n');
}

/**
 * The hits now that the hits at the base don’t account for: for each key, those past its count at the base. Hits on
 * unchanged lines take up the base’s count first, so the excess falls on added lines.
 * @template {{ key: string, added: boolean }} T
 * @param {{ key: string }[]} before @param {T[]} now
 * @returns {T[]}
 */
export function excessHits(before, now) {
  /** @type {Map<string, number>} */
  const left = new Map();
  for (const { key } of before) left.set(key, (left.get(key) ?? 0) + 1);
  const excess = [];
  for (const hit of [...now.filter((h) => !h.added), ...now.filter((h) => h.added)]) {
    const n = left.get(hit.key) ?? 0;
    if (n > 0) left.set(hit.key, n - 1);
    else excess.push(hit);
  }
  return excess;
}

/**
 * The hits that no `lint-allow ternary: <reason>` on their line or the line above excuses (#753), each with its key,
 * with each file read from dir once.
 * @param {string} dir @param {{ path: string, start: number, end: number }[]} hits
 * @returns {Hit[]}
 */
function unexcused(dir, hits) {
  /** @type {Map<string, string[]>} */
  const texts = new Map();
  const lines = (/** @type {string} */ path) => {
    if (!texts.has(path)) texts.set(path, readFileSync(join(dir, path), 'utf8').split('\n'));
    return texts.get(path) ?? [];
  };
  const kept = hits.filter((hit) => !allowedOnLine(lines(hit.path), hit.start, 'ternary'));
  return kept.map((hit) => ({ ...hit, key: hitKey(lines(hit.path), hit) }));
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
 * The hits in these files’ blobs at the base, each under its path now, or its old one for a deleted file. They’re
 * copied into a temp folder with the repo’s biome.json, less its plugins, which only lint browser specs and live in the
 * repo. A repo with no biome.json gets an empty one, Biome’s defaults, as its working tree has.
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
    return unexcused(dir, nestedTernaries(biomeReport(dir, paths)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The line ranges a `git diff -U0` adds, by file, read by the shared parser (tools/diff-added-lines.mjs), whose errors
 * are lint-ternary’s here.
 * @param {string} diff
 */
export function changedRanges(diff) {
  try {
    return addedRanges(diff);
  } catch (error) {
    throw new Error(`lint-ternary: ${/** @type {Error} */ (error).message}`);
  }
}

/**
 * Prints what a failing run found, and a line for each failing file whose lint-allow-file ternary excused nothing, and
 * returns the exit code.
 * @param {string} top @param {string} at @param {{ path: string, start: number }[]} hits @param {{ path: string, before: number, after: number }[]} risen
 */
function failed(top, at, hits, risen) {
  for (const hit of hits) console.log(`${hit.path}:${hit.start}: nested ternary on a changed line`);
  for (const file of risen) console.log(`${file.path}: ${ternaries(file.after)}, up from ${file.before} not allowed at the base`);
  for (const path of new Set([...hits, ...risen].map((found) => found.path))) {
    if (!FILE_ALLOW.test(readFileSync(join(top, path), 'utf8'))) continue;
    console.log(`${path}: lint-allow-file ternary isn’t accepted, since lint-ternary takes only a line-level lint-allow ternary: <reason>.`);
  }
  const found = [];
  if (hits.length) found.push(`${ternaries(hits.length)} on a changed line`);
  if (risen.length) found.push(`${risen.length === 1 ? '1 file' : `${risen.length} files`} with more than at ${at.slice(0, 8)}`);
  const how = 'Use an if, or a small named helper with early returns; a real exception carries lint-allow ternary: <reason>.';
  console.log(`\nlint-ternary: ${found.join(', and ')}. ${how}`);
  return 1;
}

/** Runs the lint against the base in argv, from the checkout’s top folder, prints what it found, and returns the exit code. */
function main() {
  const top = checkoutTop();
  if (!top) {
    const result = noBase('lint-ternary', 'git checkout here', process.env);
    console.log(result.message);
    return result.code;
  }
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const ref = baseRef(process.argv[2], process.env);
  const at = mergeBase(git, ref);
  if (!at) {
    const result = noBase('lint-ternary', ref, process.env);
    console.log(result.message);
    return result.code;
  }
  const diffArgs = ['-c', 'core.quotePath=false', 'diff', ...DIFF_OPTIONS];
  const globs = ['--', '*.mjs', '*.js', '*.cjs'];
  const listed = (/** @type {string} */ filter) => changedFiles(git([...diffArgs, filter, '-z', '--name-status', at, ...globs]));
  const added = changedRanges(git([...diffArgs, '--diff-filter=AMR', at, ...globs]));
  const changed = listed('--diff-filter=AMR').filter((file) => LINTED.test(file.path));
  const deleted = listed('--diff-filter=D').filter((file) => LINTED.test(file.path));
  const files = changed.map((file) => file.path);
  const now = files.length ? unexcused(top, nestedTernaries(biomeReport(top, files))) : [];
  const base = baseHits(top, git, at, [...changed, ...deleted]);
  const marked = now.map((hit) => ({ ...hit, added: overlapsAdded(added.get(hit.path) ?? [], hit.start, hit.end) }));
  const excess = excessHits(base, marked);
  const hits = excess.filter((hit) => hit.added);
  const count = (/** @type {Hit[]} */ among, /** @type {string} */ path) => among.filter((hit) => hit.path === path).length;
  const unchanged = new Set(excess.filter((hit) => !hit.added).map((hit) => hit.path));
  const risen = [...unchanged].map((path) => ({ path, before: count(base, path), after: count(now, path) }));
  if (hits.length || risen.length) return failed(top, at, hits, risen);
  console.log(`lint-ternary: no nested ternary added since ${at.slice(0, 8)}: each one here matches one there, moved or not.`);
  console.log('Files git doesn’t track aren’t checked: CI sees only committed files.');
  return 0;
}

// A diff, git or Biome that fails is a failed lint, under lint-ternary’s name, rather than a stack trace.
if (isEntry(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (error) {
    const { message } = /** @type {Error} */ (error);
    console.error(message.startsWith('lint-ternary: ') ? message : `lint-ternary: ${message}`);
    process.exitCode = 1;
  }
}
