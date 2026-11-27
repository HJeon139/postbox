// A fake world for tools/signoff.mjs’s tests (#845): git, npm and Biome answer from a table, and GitHub from A2’s
// recorded fixtures (tests/fixtures/signoff).

import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(new URL(`fixtures/signoff/${name}.json`, import.meta.url), 'utf8'));
export const RULES = load('rules-main');
export const GREEN = load('check-runs-840');
export const NO_CODEQL = load('check-runs-783-before-rebase');
export const RED = load('check-runs-808-red');

export const ROOT = '/repo';
export const BASE_SHA = 'b'.repeat(40);
/** What refs/remotes/origin/main says: a narrow clone or a fork’s leaves it stale, so signoff never reads it. */
export const STALE_SHA = '5'.repeat(40);
export const BASE_REPO = 'https://github.com/HJeon139/postbox';
export const MERGE_BASE = 'a'.repeat(40);
export const COMMITS = ['c'.repeat(40), 'd'.repeat(40)];

/**
 * A world where every step passes, unless a test changes it: answers are tried first, each [match, result], match a
 * regular expression against the command line joined by spaces, result a { code, out } or a function of argv and options.
 * @param {{ runs?: typeof GREEN, prHead?: string, answers?: [RegExp, any][] }} [o]
 */
export function world(o = {}) {
  const runs = o.runs ?? GREEN;
  const w = {
    head: runs.head,
    calls: /** @type {{ argv: string[], o: any }[]} */ ([]),
    lines: /** @type {string[]} */ ([]),
    timers: /** @type {Set<() => void>} */ (new Set()),
    clock: 0,
    links: /** @type {string[][]} */ ([]),
    temps: /** @type {string[]} */ ([]),
    removed: /** @type {string[]} */ ([]),
    killed: /** @type {string[]} */ ([]),
    exits: /** @type {{ code: number, removed: string[], calls: any[] }[]} */ ([]),
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
  const { calls, lines, timers } = w;
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
    // Each temporary folder has a name of its own, as mkdtemp makes it, so a test can tell which were removed.
    mkdtemp: (prefix) => {
      w.temps.push(`${prefix}${w.temps.length}`);
      return w.temps.at(-1);
    },
    rm: (path) => w.removed.push(path),
    link: (target, path) => w.links.push([target, path]),
    tmpdir: () => '/tmp',
    log: (line) => lines.push(line),
    onSignal: (fn) => {
      w.handled++;
      w.handlers.add(fn);
      return () => w.handlers.delete(fn);
    },
    // What had happened when the script exited: the real exit ends the process there.
    exit: (code) => w.exits.push({ code, removed: [...w.removed], calls: [...calls] }),
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
    [/^git rev-parse HEAD$/, ok(`${head}\n`)],
    [new RegExp(`^git fetch --quiet --no-tags -- ${BASE_REPO} refs/heads/main$`), ok()],
    [/^git rev-parse --verify FETCH_HEAD\^\{commit\}$/, ok(`${BASE_SHA}\n`)],
    [/^git rev-parse refs\/remotes\/origin\/main$/, ok(`${STALE_SHA}\n`)],
    // The merge base of HEAD and the fetched base; a stale base has another, so a range from it is told apart.
    [/^git merge-base HEAD /, (argv) => ok(`${argv.at(-1) === BASE_SHA ? MERGE_BASE : '6'.repeat(40)}\n`)],
    [/^git rev-list --reverse /, ok(`${COMMITS.join('\n')}\n`)],
    [/^git diff -z --name-only /, ok('tools/signoff.mjs\0')],
    [/^git (worktree|checkout) /, ok()],
    [/^git merge-tree /, ok(`${'e'.repeat(40)}\n`)],
    [/^git commit-tree /, ok(`${'f'.repeat(40)}\n`)],
    [/node_modules\/\.bin\/biome check/, ok()],
    [/^npm run -s lint:project$/, ok()],
  ];
}
