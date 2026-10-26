// What Postbox’s Antigravity hook approves on its own in Auto, so Auto asks about as rarely as Claude Code’s does.
// agy’s own auto mode isn’t offered to every account (“--mode auto is not available for this account”; agy 1.4.5 to
// 1.4.7 logged “rollout flag off” on every run here), and a hook’s allow only hands the call on to agy’s policy
// (antigravity.google/docs/hooks), so in Auto Postbox decides here and everything else becomes a card:
// - a command whose every part (splitCommand) is a routine one: a read (ls, cat, grep, find without -exec or
//   -delete…), local git (status, diff, log, add, commit without --amend…), gh that reads (issue list, pr view…),
//   npm test or npm run, or mkdir, touch, cp or mv, with every path it names inside the agent’s folders and none of
//   Antigravity’s own files. A word the reader can’t be sure of ($, `, a redirect other than to /dev/null, a
//   subshell) makes it a card. npm test, npm run and git run what the folder holds (its scripts, git’s hooks and
//   config), so in Auto an agent can run code it wrote in its folders without a card, as Claude Code’s Auto runs
//   npm test;
// - a web search, and a fetch of a public http(s) address with no query, which is where a fetch could carry data out;
// - an MCP tool outside Postbox that doesn’t write, by the names the write guard knows (#112, server/write-guard.mjs).

import { join, resolve, sep } from 'node:path';
import { splitCommand } from '../../shared/command-chains.mjs';
import { isWriteCall } from '../write-guard.mjs';

const READS = new Set([
  ...['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'tree', 'file', 'stat', 'du', 'df'],
  ...['which', 'whoami', 'uname', 'date', 'echo', 'printf', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'comm', 'jq'],
  ...['basename', 'dirname', 'realpath', 'readlink', 'nl', 'true', 'false', 'test', '[', 'cd', 'find'],
]);
const WRITES = new Set(['mkdir', 'touch', 'cp', 'mv']);
const GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'add', 'commit']);
// gh subcommands that only read (gh api can write, so it isn’t one); gh’s writes are the write guard’s (#112).
const GH = new Set([
  'issue list',
  'issue view',
  'pr list',
  'pr view',
  'pr diff',
  'pr checks',
  'pr status',
  'repo view',
  'run list',
  'run view',
  'release list',
  'release view',
]);
// git branch and git remote only list with these.
const GIT_LISTS = new Set(['-a', '-r', '-v', '-vv', '--all', '--list', '--remotes', '--show-current', '--verbose']);
// Flags that run another program or delete: find’s -exec and -delete, rg’s --pre, git commit’s --amend.
const RUNS = /^(?:-exec|-execdir|-ok|-okdir|-delete|--pre(?:=|$)|--amend$)/;
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
 * Whether a word, read as a path, stays in the agent’s folders. Every word is read as one, a grep pattern or an echo
 * too: one that starts at / or ~, or climbs out with .., makes the command a card. A glob only in the last segment,
 * and none for a write, since it could match a link that leads out.
 */
function staysIn(word, { roots, cwd, home, isProtected, realTarget, write, climbs }) {
  let p = word;
  if (p.startsWith('-')) {
    const at = p.includes('=') ? p.indexOf('=') + 1 : p.search(/[/~]/);
    if (at <= 0) return true;
    p = p.slice(at);
  }
  if (p.startsWith('~')) {
    if (p !== '~' && !p.startsWith('~/')) return false;
    p = join(home, p.slice(1));
  }
  const segments = p.split('/');
  if (GLOB.test(p) && (write || segments.slice(0, -1).some((s) => GLOB.test(s)))) return false;
  if (climbs && segments.includes('..')) return false;
  const abs = resolve(cwd, p);
  const real = realTarget(abs, cwd);
  return Boolean(real) && roots.some((r) => inside(real, r)) && !isProtected(abs);
}

/** Whether one command, as words, is a routine one (see the top of this file). @param {string[]} w @param {any} where */
function routineWords(w, where) {
  const [cmd, ...args] = w;
  if (!cmd || args.some((a) => RUNS.test(a))) return false;
  // A bare cd goes home, and cd - to wherever the shell was before.
  if (cmd === 'cd' && (args.length !== 1 || args[0] === '-')) return false;
  let write = WRITES.has(cmd);
  if (cmd === 'git') {
    const [sub, ...rest] = args;
    if (sub === 'branch' || sub === 'remote') return rest.every((a) => GIT_LISTS.has(a));
    if (!GIT.has(sub)) return false;
    write = true;
  } else if (cmd === 'gh') {
    if (!GH.has(`${args[0]} ${args[1]}`)) return false;
  } else if (cmd === 'npm') {
    if (!(args[0] === 'test' || args[0] === 't' || args[0] === 'ls' || ((args[0] === 'run' || args[0] === 'run-script') && args[1]))) return false;
  } else if (!READS.has(cmd) && !write) return false;
  return args.every((a) => staysIn(a, { ...where, write }));
}

/**
 * Whether Postbox runs this command without a card in Auto: every part routine, every path in the agent’s folders.
 * @param {string} command
 * @param {{ roots: string[], cwd: string, home: string, isProtected: (p: string) => boolean, realTarget: (p: string, base: string) => string|null }} where
 */
export function routineCommand(command, where) {
  const parts = splitCommand(command).map(words);
  if (!parts.length || parts.some((w) => !w?.length)) return false;
  const climbs = parts.some((w) => w?.[0] === 'cd');
  return parts.every((w) => routineWords(/** @type {string[]} */ (w), { ...where, climbs }));
}

/** Whether a fetch can go without a card: a public http(s) address, with no sign-in or query in it. */
export function publicFetch(url) {
  try {
    const u = new URL(String(url));
    const local = /^(?:localhost|.*\.localhost|\[.*\]|\d+\.\d+\.\d+\.\d+)$/i.test(u.hostname);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !local;
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
    case 'search_web':
      return true;
    case 'read_url_content':
      return publicFetch(args.Url ?? args.url);
    case 'list_resources':
    case 'read_resource':
      return true;
    case 'call_mcp_tool': {
      const server = String(args.ServerName ?? '');
      const tool = String(args.ToolName ?? '');
      return Boolean(server && tool) && !isWriteCall(`mcp__${server}__${tool}`, args.Arguments ?? {});
    }
    default:
      return false;
  }
}
