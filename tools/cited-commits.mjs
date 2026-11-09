// Whether every commit a Markdown note or a pull request’s body cites is on GitHub (#846). Notes and bodies have cited
// a local scratch merge, an unpushed head, and the pre-rebase copy of a commit that no ref held after the rebase. So
// this fetches origin with --prune first, so a branch deleted on GitHub stops counting, then reads each 7–40 character
// lowercase hex token with a letter a–f in it (a number such as 33554432 isn’t a commit). A token git resolves to a
// commit must be reachable from origin/main, or from the pull request’s own head when it reads a body: reachable from
// some other branch isn’t enough, since branches get deleted. A token that isn’t an object is reported as one and
// doesn’t fail the check, nor does one that names a tree or a blob. It prints one line per cited token and a summary.
//
//   node tools/cited-commits.mjs designs/some-note.md     a Markdown file
//   node tools/cited-commits.mjs --pr 1057                a pull request’s body, against its head too
//   add --no-fetch to check against what was fetched last

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Exit codes: every cited commit is reachable; one isn’t; git, gh or the file couldn’t be read. */
export const EXIT = { pass: 0, fail: 1, error: 2 };

/** A whole hex word, 7 to 40 long, as git abbreviates or spells out a commit’s id. */
const HEX = /\b[0-9a-f]{7,40}\b/g;

/** Each distinct hex token in `text` with a letter a–f in it, in order of first mention. @param {string} text */
export function citedTokens(text) {
  return [...new Set(text.match(HEX) ?? [])].filter((token) => /[a-f]/.test(token));
}

/** git in `cwd`: its exit status and output, never throwing. @param {string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} o */
function git(args, { cwd, env }) {
  const run = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status, out: (run.stdout ?? '').trim(), err: (run.stderr || run.error?.message || '').trim() };
}

/**
 * Where one token stands: a commit reachable from one of `bases`, or not; a known object other than a commit; or no
 * object at all.
 * @param {string} token @param {{ ref: string, label: string }[]} bases @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} o
 */
function standing(token, bases, o) {
  const type = git(['cat-file', '-t', token], o);
  if (type.status !== 0) return { state: 'unknown' };
  if (type.out !== 'commit') return { state: 'other', type: type.out };
  for (const base of bases) {
    const ancestor = git(['merge-base', '--is-ancestor', token, base.ref], o);
    if (ancestor.status === 0) return { state: 'reachable', label: base.label };
    if (ancestor.status !== 1) throw new Error(`git merge-base --is-ancestor ${token} ${base.ref} failed: ${ancestor.err}`);
  }
  return { state: 'unreachable' };
}

/** The line for one token. @param {string} token @param {ReturnType<typeof standing>} s @param {string} bases */
function lineOf(token, s, bases) {
  if (s.state === 'reachable') return `reachable: ${token} (${s.label})`;
  if (s.state === 'unreachable') return `unreachable: ${token} (not on ${bases})`;
  if (s.state === 'other') return `not a commit: ${token} (a ${s.type})`;
  return `not a known object: ${token}`;
}

/** gh’s JSON output for `args`. @param {string[]} args */
const ghJson = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

/**
 * The text to read and the refs a cited commit may be on, for a file or a pull request.
 * @param {{ file?: string, pr?: number }} source @param {(args: string[]) => any} gh
 */
function readSource(source, gh) {
  const main = { ref: 'refs/remotes/origin/main', label: 'origin/main' };
  if (source.file) return { label: source.file, text: readFileSync(source.file, 'utf8'), bases: [main], names: 'origin/main' };
  const view = gh(['pr', 'view', String(source.pr), '--json', 'body,headRefOid']);
  const head = { ref: view.headRefOid, label: 'the pull request’s head' };
  return {
    label: `#${source.pr} head=${view.headRefOid.slice(0, 8)}`,
    text: view.body ?? '',
    bases: [main, head],
    names: 'origin/main or the pull request’s head',
  };
}

/**
 * Checks the commits `source` cites, printing with `log`, and returns the exit code. git runs in `cwd` with `env`.
 * @param {{ file?: string, pr?: number }} source
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, fetch?: boolean, gh?: (args: string[]) => any, log?: (line: string) => void }} [o]
 */
export function citedCommits(source, { cwd, env, fetch = true, gh = ghJson, log = console.log } = {}) {
  const o = { cwd, env };
  const name = source.file ?? `#${source.pr}`;
  /** @param {string} why */
  const error = (why) => {
    log(`cited-commits ${name}: ${why} -> ERROR`);
    return EXIT.error;
  };
  if (fetch) {
    const fetched = git(['fetch', '--prune', '--quiet', 'origin'], o);
    if (fetched.status !== 0) return error(`git fetch --prune origin failed: ${fetched.err.split('\n')[0]}`);
  }
  let read;
  try {
    read = readSource(source, gh);
  } catch (e) {
    return error(`couldn’t read it: ${/** @type {Error} */ (e).message.split('\n')[0]}`);
  }
  for (const base of read.bases) {
    if (git(['rev-parse', '--verify', '--quiet', `${base.ref}^{commit}`], o).status !== 0) return error(`${base.label} isn’t a commit in this clone`);
  }
  const counts = { commits: 0, reachable: 0, unreachable: 0, unknown: 0 };
  try {
    for (const token of citedTokens(read.text)) {
      const s = standing(token, read.bases, o);
      if (s.state === 'reachable' || s.state === 'unreachable') counts.commits++;
      if (s.state in counts) counts[s.state]++;
      log(lineOf(token, s, read.names));
    }
  } catch (e) {
    return error(/** @type {Error} */ (e).message.split('\n')[0]);
  }
  const exit = counts.unreachable ? EXIT.fail : EXIT.pass;
  const tally = Object.entries(counts).map(([key, n]) => `${key}=${n}`);
  log(`cited-commits ${read.label} ${tally.join(' ')} -> ${exit === EXIT.pass ? 'PASS' : 'FAIL'}`);
  return exit;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const fetch = !args.includes('--no-fetch');
  const rest = args.filter((a) => a !== '--no-fetch');
  const pr = rest[0] === '--pr' ? Number(rest[1]) : null;
  const usage = 'Usage: node tools/cited-commits.mjs [--no-fetch] <file.md> | --pr <pull request number>';
  if (pr !== null && (!Number.isInteger(pr) || pr <= 0 || rest.length !== 2)) {
    console.error(usage);
    process.exit(EXIT.error);
  }
  if (pr === null && rest.length !== 1) {
    console.error(usage);
    process.exit(EXIT.error);
  }
  process.exit(citedCommits(pr === null ? { file: rest[0] } : { pr }, { fetch }));
}
