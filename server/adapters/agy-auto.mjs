// What Postbox’s Antigravity hook approves on its own in Auto, so Auto asks about as rarely as Claude Code’s does.
// agy’s own auto mode isn’t offered to every account (“--mode auto is not available for this account”; agy 1.4.5 to
// 1.4.7 logged “rollout flag off” on every run here), and a hook’s allow only hands the call on to agy’s policy
// (antigravity.google/docs/hooks), so in Auto Postbox decides here and everything else becomes a card:
// - a command whose every part (splitCommand) is a routine one, with only the options listed for it below, and every
//   path it names inside the agent’s folders and none of Antigravity’s own files: a read (ls, cat, grep, find…),
//   mkdir, touch, cp or mv, git that reads or stages, and gh’s commands that read issues, pull requests and releases. A word the
//   reader can’t be sure of ($, `, a redirect other than to /dev/null, a subshell) makes it a card. So does an option
//   that isn’t listed, since some run a program (git grep -O, sort --compress-program, rg --pre);
// - a fetch of a public http(s) address with no query or fragment. A search, or a fetch with a query or fragment,
//   could carry data out, so it isn’t approved here.
// What these rules leave goes on to Postbox’s permission_prompt: there the reviewer (#416) judges it, and a write outside
// Postbox (gh’s issue and pull request writes, an MCP tool that writes) keeps its card (#112), as in Claude Code’s Auto.
// Nothing routine runs code the agent could have written (#423’s review): npm test and npm run run the folder’s
// scripts, and git commit its hooks, so they ask. git runs only where the folder’s .git is a real folder, which edits
// in Auto can’t change without a card (agy-hook.mjs), so its config can’t name a program git would run (core.fsmonitor,
// diff.external, gpg.program). No MCP tool outside Postbox is approved here: what one does can’t be read from its name.

import { lstatSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { splitCommand } from '../../shared/command-chains.mjs';

/**
 * The options a command may take: short letters on their own, short letters that take a value, long options on their
 * own, long options that take a value, whether -5 is a count, and how many other words it may have.
 * @typedef {{ short: string, valued: string, long: Set<string>, longValued: Set<string>, digits: boolean, most: number }} Spec
 */
const spec = (short = '', valued = '', long = [], longValued = [], { digits = false, most = Infinity } = {}) => ({
  short,
  valued,
  long: new Set(long),
  longValued: new Set(longValued),
  digits,
  most,
});
const GREP = spec('rRnilvcwxoEFHhsqIL', 'eABCm', ['--color'], ['--include', '--exclude', '--exclude-dir', '--color']);
const READS = /** @type {Record<string, Spec>} */ ({
  ls: spec('laAhRrtS1dFp'),
  pwd: spec(),
  cat: spec('n'),
  head: spec('q', 'nc', [], [], { digits: true }),
  tail: spec('q', 'nc', [], [], { digits: true }),
  wc: spec('lwcm'),
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: spec('inwlcFvsS', 'gteABCm', ['--hidden', '--files', '--no-ignore', '--no-heading'], ['--glob', '--type', '--max-count']),
  tree: spec('adf', 'LI'),
  file: spec('b'),
  stat: spec(),
  du: spec('shac', 'd'),
  df: spec('h'),
  which: spec('a'),
  whoami: spec(),
  uname: spec('amsrnv'),
  date: spec('u'),
  echo: spec('n'),
  printf: spec(),
  sort: spec('nrufbhV', 'kt'),
  uniq: spec('cdui', '', [], [], { most: 1 }),
  cut: spec('', 'dfc'),
  tr: spec('ds'),
  diff: spec('uqrNwbBi', 'U'),
  cmp: spec('s'),
  comm: spec('123'),
  basename: spec(),
  dirname: spec(),
  realpath: spec(),
  readlink: spec('f'),
  nl: spec(),
});
const WRITES = /** @type {Record<string, Spec>} */ ({ mkdir: spec('p'), touch: spec(), cp: spec('rRpfn'), mv: spec('fn') });
const GIT = /** @type {Record<string, Spec>} */ ({
  status: spec('sb', '', ['--short', '--branch', '--porcelain']),
  diff: spec('w', 'U', ['--stat', '--cached', '--staged', '--name-only', '--name-status', '--numstat', '--shortstat', '--no-color']),
  log: spec(
    'p',
    'n',
    ['--oneline', '--stat', '--graph', '--all', '--decorate', '--no-merges', '--reverse', '--name-only', '--first-parent'],
    ['--format', '--pretty', '--since', '--until', '--author', '--grep', '--max-count'],
    { digits: true },
  ),
  show: spec('', '', ['--stat', '--oneline', '--name-only', '--name-status'], ['--format', '--pretty']),
  'rev-parse': spec('q', '', ['--abbrev-ref', '--short', '--show-toplevel', '--verify']),
  'ls-files': spec('mdoc', '', ['--others', '--modified', '--deleted', '--cached', '--exclude-standard']),
  blame: spec('w', 'L'),
  grep: spec('nilvwcE', 'e', ['--cached']),
  describe: spec('', '', ['--tags', '--always', '--long', '--dirty']),
  shortlog: spec('sne', '', ['--summary', '--numbered', '--all']),
  add: spec('Auv', '', ['--all', '--update', '--verbose']),
  branch: spec('arv', '', ['--all', '--remotes', '--list', '--show-current', '--verbose'], [], { most: 0 }),
  remote: spec('v', '', ['--verbose'], [], { most: 0 }),
});
// gh’s commands that read issues, pull requests and releases. Its writes aren’t here: they keep their card (#112). gh
// api, which can do anything, isn’t one; nor is --web, which opens a browser. Nor --jq: jq, gh’s included, prints the
// environment with env, tokens and all, and a fetch could carry that out (#423’s review).
const GH_COMMANDS = new Set(
  ['issue list', 'issue view', 'pr list', 'pr view', 'pr diff', 'pr checks', 'pr status', 'repo view', 'run list', 'run view'].concat([
    'release list',
    'release view',
  ]),
);
const GH = spec('c', 'RsLlAaS', ['--comments'], ['--repo', '--state', '--limit', '--json', '--label', '--author', '--assignee', '--search']);
// find’s tests and actions that only look; -exec, -delete and -fprint aren’t among them.
const FIND_FLAGS = new Set(['-print', '-print0', '-not', '-and', '-or', '-o', '-a', '-empty', '-prune', '-depth']);
const FIND_VALUED = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-newer', '-size', '-mtime', '-mmin', '-perm']);
const UNSAFE = new Set(['$', '`', '\\', '<', '>', '(', ')', '{', '}', ';', '&', '|', '!', '\n']);
const GLOB = /[*?[]/;

/**
 * A command part’s words, or null where the reader can’t be sure what the shell would run.
 * @param {string} part @returns {string[]|null}
 */
export function words(part) {
  const text = String(part).replace(/(^|\s)(?:(?:[12]?>|&>)\s*\/dev\/null|2>&1)(?=\s|$)/g, '$1');
  /** @type {string[]} */
  const out = [];
  /** @type {string|null} */
  let cur = null;
  let quote = '';
  for (const ch of text) {
    if (quote === "'") {
      if (ch === "'") quote = '';
      else cur = (cur ?? '') + ch;
    } else if (quote === '"') {
      if (ch === '"') quote = '';
      else if (ch === '$' || ch === '`' || ch === '\\') return null;
      else cur = (cur ?? '') + ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur ??= '';
    } else if (UNSAFE.has(ch)) return null;
    else if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else cur = (cur ?? '') + ch;
  }
  if (quote) return null;
  if (cur !== null) out.push(cur);
  return out;
}

const inside = (target, dir) => target === dir || target.startsWith(`${dir}${sep}`);
/**
 * Whether a path is in a .git folder, where an edit could name a program for git to run. Without case: macOS’s file
 * system ignores it, so .GIT/config is .git/config there (#423’s review).
 */
export const inGit = (p) =>
  String(p)
    .split(/[\\/]/)
    .some((s) => s.toLowerCase() === '.git');

/**
 * Whether a word, read as a path, stays in the agent’s folders. Every operand and option value is read as one, a grep
 * pattern or an echo too: one that starts at / or ~, or climbs out with .., makes the command a card. A glob only in
 * the last segment, and none for a write, since it could match a link that leads out; a write never into .git.
 */
function staysIn(word, { roots, cwd, home, isProtected, realTarget }, write) {
  let p = word;
  if (p.startsWith('~')) {
    if (p !== '~' && !p.startsWith('~/')) return false;
    p = join(home, p.slice(1));
  }
  const segments = p.split('/');
  if (GLOB.test(p) && (write || segments.slice(0, -1).some((s) => GLOB.test(s)))) return false;
  const abs = resolve(cwd, p);
  const real = realTarget(abs, cwd);
  if (!real || !roots.some((r) => inside(real, r)) || isProtected(abs)) return false;
  return !(write && (inGit(abs) || inGit(real)));
}

/**
 * Whether a command’s arguments use only the options its spec lists, with every value and operand staying in the
 * agent’s folders. `--` ends the options.
 * @param {string[]} args @param {Spec} s @param {(w: string) => boolean} ok
 */
function optionsOk(args, s, ok) {
  let operands = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return args.slice(i + 1).every(ok) && operands + args.length - i - 1 <= s.most;
    if (a.startsWith('--')) {
      const [name, value] = a.split(/=(.*)/s);
      if (value !== undefined ? !s.longValued.has(name) || !ok(value) : !s.long.has(name) && !(s.longValued.has(name) && ok(args[++i] ?? ''))) return false;
    } else if (a.startsWith('-') && a.length > 1) {
      if (s.digits && /^-\d+$/.test(a)) continue;
      for (let k = 1; k < a.length; k++) {
        if (s.valued.includes(a[k])) {
          if (!ok(k + 1 < a.length ? a.slice(k + 1) : (args[++i] ?? ''))) return false;
          break;
        }
        if (!s.short.includes(a[k])) return false;
      }
    } else if (!ok(a) || ++operands > s.most) return false;
  }
  return true;
}

/** find: paths first, then only the tests in FIND_FLAGS and FIND_VALUED, every value staying in the folders. */
function findOk(args, ok) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FIND_VALUED.has(a)) {
      if (!ok(args[++i] ?? '')) return false;
    } else if (!FIND_FLAGS.has(a) && (a.startsWith('-') || !ok(a))) return false;
  }
  return true;
}

/** Whether the agent’s folder has a real .git folder, so git reads no config the agent could have written. */
function realGitDir(cwd) {
  try {
    return lstatSync(join(cwd, '.git')).isDirectory();
  } catch {
    return false; // no .git: git would look elsewhere, so it asks
  }
}

/** Whether one command, as words, is a routine one (see the top of this file). @param {string[]} w @param {any} where */
function routineWords(w, where) {
  const [cmd, ...args] = w;
  const read = (x) => staysIn(x, where, false);
  const write = (x) => staysIn(x, where, true);
  if (cmd === 'find') return findOk(args, read);
  if (Object.hasOwn(READS, cmd)) return optionsOk(args, READS[cmd], read);
  if (Object.hasOwn(WRITES, cmd)) return optionsOk(args, WRITES[cmd], write);
  if (cmd === 'gh') return GH_COMMANDS.has(`${args[0]} ${args[1]}`) && optionsOk(args.slice(2), GH, read);
  if (cmd === 'git') return Object.hasOwn(GIT, args[0]) && realGitDir(where.cwd) && optionsOk(args.slice(1), GIT[args[0]], args[0] === 'add' ? write : read);
  return false;
}

/**
 * Whether Postbox runs this command without a card in Auto: every part routine, every path in the agent’s folders.
 * @param {string} command
 * @param {{ roots: string[], cwd: string, home: string, isProtected: (p: string) => boolean, realTarget: (p: string, base: string) => string|null }} where
 */
export function routineCommand(command, where) {
  const parts = splitCommand(command).map(words);
  if (!parts.length || parts.some((w) => !w?.length)) return false;
  return parts.every((w) => routineWords(/** @type {string[]} */ (w), where));
}

/**
 * Whether a fetch can go without a card: a public http(s) address, with no sign-in, query or fragment in it, and not
 * this computer. A query or fragment could carry data out, so it goes on to the reviewer.
 */
export function publicFetch(url) {
  try {
    const u = new URL(String(url));
    const local = /^(?:localhost|.*\.localhost|\[.*\]|\d+\.\d+\.\d+\.\d+)$/i.test(u.hostname);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !u.hash && !local;
  } catch {
    return false; // not an address at all: the person sees it on a card
  }
}

/**
 * Whether Auto runs this Antigravity tool call without a card. File reads and edits keep the hook’s own rules.
 * @param {string} name @param {any} args
 * @param {{ roots: string[], cwd: string, home: string, isProtected: (p: string) => boolean, realTarget: (p: string, base: string) => string|null }} where
 */
export function autoAllows(name, args, where) {
  switch (name) {
    case 'run_command':
      return routineCommand(String(args.CommandLine ?? ''), where);
    case 'read_url_content':
      return publicFetch(args.Url ?? args.url);
    case 'list_resources':
    case 'read_resource':
      return true;
    default:
      return false;
  }
}
