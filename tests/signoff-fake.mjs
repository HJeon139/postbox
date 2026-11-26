// A fake world for tools/signoff.mjs’s tests (#845): git, npm, Biome and Node answer from a table, GitHub from A2’s
// recorded fixtures (tests/fixtures/signoff), and files live in a Map. The workflows are the repo’s real ones, so the
// Node majors the tests expect are the ones CI runs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const load = (name) => JSON.parse(readFileSync(new URL(`fixtures/signoff/${name}.json`, import.meta.url), 'utf8'));
export const RULES = load('rules-main');
export const GREEN = load('check-runs-840');
export const NO_CODEQL = load('check-runs-783-before-rebase');
export const RED = load('check-runs-808-red');

export const ROOT = '/repo';
export const GIT_DIR = '/repo/.git';
export const BASE_SHA = 'b'.repeat(40);
/** What refs/remotes/origin/main says: a narrow clone or a fork’s leaves it stale, so signoff never reads it. */
export const STALE_SHA = '5'.repeat(40);
export const BASE_REPO = 'https://github.com/HJeon139/postbox';
export const MERGE_BASE = 'a'.repeat(40);
export const COMMITS = ['c'.repeat(40), 'd'.repeat(40)];
export const NODE22 = '/opt/homebrew/opt/node@22/bin/node';
const CHECK_YML = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');

/**
 * A world where every step passes, unless a test changes it: answers are tried first, each [match, result], match a
 * regular expression against the command line joined by spaces, result a { code, out } or a function of argv and options.
 * @param {{ runs?: typeof GREEN, prHead?: string, answers?: [RegExp, any][], nodeVersion?: string }} [o]
 */
export function world(o = {}) {
  const runs = o.runs ?? GREEN;
  /** @type {Map<string, string>} */
  const files = new Map([[`${ROOT}/.github/workflows/check.yml`, CHECK_YML]]);
  files.set(NODE22, '');
  const w = {
    head: runs.head,
    files,
    calls: /** @type {{ argv: string[], o: any }[]} */ ([]),
    lines: /** @type {string[]} */ ([]),
    timers: /** @type {Set<() => void>} */ (new Set()),
    clock: 0,
    acquired: /** @type {any[]} */ ([]),
    released: 0,
    links: /** @type {string[][]} */ ([]),
    temps: /** @type {string[]} */ ([]),
    removed: /** @type {string[]} */ ([]),
    killed: /** @type {string[]} */ ([]),
    exits: /** @type {{ code: number, released: number, removed: string[], calls: any[] }[]} */ ([]),
    handlers: /** @type {Set<(signal: string) => void>} */ (new Set()),
    handled: 0,
  };
  /** Delivers signal to the script, as Ctrl-C, a kill or a closed terminal would. */
  w.raise = (/** @type {string} */ signal) => {
    for (const fn of w.handlers) fn(signal);
  };
  /** Advances the clock by ms and fires every timer that is set, as a minute passing would. */
  w.tick = (/** @type {number} */ ms) => {
    w.clock += ms;
    for (const fn of w.timers) fn();
  };
  w.d = fakeDeps(w, runs, o);
  return w;
}

/**
 * The deps object of world w: every effect answers from w and the table, and leaves its record in w.
 * @param {any} w @param {typeof GREEN} runs @param {Parameters<typeof world>[0] & {}} o
 */
function fakeDeps(w, runs, o) {
  const { files, calls, lines, timers } = w;
  const table = [...(o.answers ?? []), ...defaults(w.head)];
  return {
    run: async (argv, opts = {}) => {
      calls.push({ argv, o: opts });
      opts.started?.((signal) => w.killed.push(signal));
      const line = argv.join(' ');
      const hit = table.find(([match]) => match.test(line));
      if (!hit) throw new Error(`The fake world has no answer for: ${line}`);
      return typeof hit[1] === 'function' ? hit[1](argv, opts, w) : hit[1];
    },
    gh: (args) => ghAnswer(args, runs, o.prHead ?? w.head),
    now: () => w.clock,
    every: (ms, fn) => {
      w.every = ms;
      timers.add(fn);
      return () => timers.delete(fn);
    },
    loadavg: () => [3.5, 3, 2],
    cores: () => 18,
    statfs: () => ({ ffree: 5_000_000 }),
    readFile: (path) => {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return files.get(path);
    },
    writeFile: (path, text) => files.set(path, text),
    list: (dir) => [...new Set([...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0]))],
    exists: (path) => [...files.keys()].some((p) => p === path || p.startsWith(`${path}/`)),
    // Each temporary folder has a name of its own, as mkdtemp makes it, so a test can tell which were removed.
    mkdtemp: (prefix) => {
      w.temps.push(`${prefix}${w.temps.length}`);
      return w.temps.at(-1);
    },
    rm: (path) => w.removed.push(path),
    link: (target, path) => w.links.push([target, path]),
    tmpdir: () => '/tmp',
    home: '/home/me',
    execPath: '/usr/bin/node',
    nodeVersion: o.nodeVersion ?? 'v24.22.1',
    acquire: async (a) => {
      w.acquired.push(a);
      return () => w.released++;
    },
    log: (line) => lines.push(line),
    onSignal: (fn) => {
      w.handled++;
      w.handlers.add(fn);
      return () => w.handlers.delete(fn);
    },
    // What had happened when the script exited: the real exit ends the process there.
    exit: (code) => w.exits.push({ code, released: w.released, removed: [...w.removed], calls: [...calls] }),
  };
}

/** What gh answers, from A2’s recorded fixtures. @param {string[]} args @param {typeof GREEN} runs @param {string} prHead */
function ghAnswer(args, runs, prHead) {
  if (args[0] === 'repo') return { nameWithOwner: 'HJeon139/postbox' };
  if (args[0] === 'pr') return { headRefOid: prHead, baseRefName: 'main', url: `${BASE_REPO}/pull/${args[2]}` };
  if (args[1].includes('/rules/')) return RULES;
  return [{ check_runs: runs.check_runs }];
}

/** Every command passes. @param {string} head @returns {[RegExp, any][]} */
function defaults(head) {
  const ok = (out = '') => ({ code: 0, out });
  return [
    [/^git rev-parse --show-toplevel$/, ok(`${ROOT}\n`)],
    [/^git rev-parse --path-format=absolute --git-common-dir$/, ok(`${GIT_DIR}\n`)],
    [/^git rev-parse HEAD$/, ok(`${head}\n`)],
    [new RegExp(`^git fetch --quiet --no-tags -- ${BASE_REPO} refs/heads/main$`), ok()],
    [/^git rev-parse --verify FETCH_HEAD\^\{commit\}$/, ok(`${BASE_SHA}\n`)],
    [/^git fetch --quiet origin main$/, ok()],
    [/^git rev-parse refs\/remotes\/origin\/main$/, ok(`${STALE_SHA}\n`)],
    // The merge base of HEAD and the fetched base; a stale base has another, so a range from it is told apart.
    [/^git merge-base HEAD /, (argv) => ok(`${argv.at(-1) === BASE_SHA ? MERGE_BASE : '6'.repeat(40)}\n`)],
    [/^git rev-list --reverse /, ok(`${COMMITS.join('\n')}\n`)],
    [/^git diff -z --name-only /, ok('tools/signoff.mjs\0')],
    [/^git (worktree|checkout) /, ok()],
    [/^git merge-tree /, ok(`${'e'.repeat(40)}\n`)],
    [/^git commit-tree /, ok(`${'f'.repeat(40)}\n`)],
    [/^git status --porcelain --untracked-files=all$/, ok()],
    [/node_modules\/\.bin\/biome check/, ok()],
    [/^npm run -s lint:project$/, ok()],
    [new RegExp(`^${NODE22} --version$`), ok('v22.11.0\n')],
    [/^npm run check$/, ok()],
    [/^npx playwright test/, ok()],
  ];
}

/** A gate log as --run-gate writes it, for head, changed by edit. @param {string} head @param {object} [edit] */
export function gateLog(head, edit = {}) {
  const command = (name, argv, env) => ({ name, argv, env, code: 0, ms: 1000 });
  return {
    format: 1,
    writer: 'tools/signoff.mjs',
    head,
    startedAt: '2026-11-26T10:00:00.000Z',
    endedAt: '2026-11-26T10:30:00.000Z',
    clean: true,
    node: { major: 22, version: 'v22.11.0' },
    load: { one: 3.5, cores: 18 },
    specs: [],
    commands: [
      command('check', ['npm', 'run', 'check'], {}),
      command('browser', ['npx', 'playwright', 'test'], { POSTBOX_STREAM_LAG: '' }),
      command('browser, events late', ['npx', 'playwright', 'test'], { POSTBOX_STREAM_LAG: '300' }),
    ],
    ...edit,
  };
}

/** Puts a gate log where signoff reads it. @param {ReturnType<typeof world>} w @param {object} log */
export function putLog(w, log, at = /** @type {any} */ (log).head) {
  w.files.set(join(GIT_DIR, 'signoff', `${at}.json`), JSON.stringify(log));
}
