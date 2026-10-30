// What a git command does past its words (#296, the review of #562). A request covers `git push` or `git commit` only
// as the command reads, but the repository’s config and hooks change what runs: with remote.origin.mirror = true, a
// bare `git push` deleted the remote’s other branches, a push refspec in config forced an update, and a hook the agent
// wrote runs on any push or commit. So before a git command a request covers runs without a card, Postbox reads the
// agent’s folder and keeps the card when:
// - config changes what a push does, or runs a program (CONFIG, and LOCAL_CONFIG in the repository’s own config,
//   where an agent can write it; the person’s own credential helper or Git LFS filters stay theirs);
// - any hook is there to run, or the hooks are redirected;
// - a push goes to a remote other than origin or one the person named, or a branch they didn’t name, other than the
//   one checked out when that isn’t the default branch.
// git runs with an argument array and GIT_OPTIONAL_LOCKS=0, as Postbox’s other reads of git do.

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { splitCommand } from '../shared/permission-match.mjs';
import { shellWords, tokensOf } from './request-words.mjs';

const run = promisify(execFile);

// Keys that change what a push does or run a program, in any config: the person’s or the repository’s.
const CONFIG =
  /^(?:remote\..+\.(?:push|mirror|pushurl|receivepack)|remote\.pushdefault|branch\..+\.pushremote|url\..+\.(?:insteadof|pushinsteadof)|core\.(?:hookspath|sshcommand|gitproxy)|diff\.external|diff\..+\.(?:textconv|command)|gpg\.program|gpg\..+\.program)$/;
// Keys that run a program, only from the repository’s own config.
const LOCAL_CONFIG = /^(?:filter\..+\.(?:clean|smudge|process)|credential\.(?:.+\.)?helper|core\.(?:pager|editor)|sequence\.editor)$/;
const ALL_KEYS = '^(remote\\.|branch\\..*\\.pushremote|url\\.|core\\.|diff\\.|gpg\\.|push\\.default|filter\\.|credential\\.|sequence\\.editor)';

/** git’s output in the folder, '' when it found nothing (exit 1), or null when it failed. @param {string} folder @param {string[]} args */
async function git(folder, args) {
  try {
    const { stdout } = await run('git', args, { cwd: folder, timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    return stdout.trim();
  } catch (e) {
    return e.code === 1 ? '' : null;
  }
}

/** Why the folder’s git config or hooks keep the card, or null. @param {string} folder */
async function configOrHooks(folder) {
  const lines = await git(folder, ['config', '--show-scope', '--get-regexp', ALL_KEYS]);
  if (lines === null) return 'Postbox couldn’t read the git config';
  for (const line of lines.split('\n').filter(Boolean)) {
    const [scope, rest = ''] = line.split('\t');
    const [key, value = ''] = rest.split(/ (.*)/s);
    if (CONFIG.test(key)) return `git config sets ${key}`;
    if (key === 'push.default' && !['simple', 'current'].includes(value)) return `git config sets push.default to ${value}`;
    if (key === 'core.fsmonitor' && !['true', 'false'].includes(value)) return 'git config runs a program as core.fsmonitor';
    if (scope !== 'global' && scope !== 'system' && LOCAL_CONFIG.test(key)) return `the repository’s git config sets ${key}`;
  }
  const hooks = await git(folder, ['rev-parse', '--git-path', 'hooks']);
  if (hooks === null) return 'it isn’t a git repository';
  const names = await readdir(resolve(folder, hooks)).catch((e) => (e.code === 'ENOENT' ? [] : null));
  if (names === null) return 'Postbox couldn’t read the git hooks';
  const hook = names.find((n) => !n.endsWith('.sample') && !n.startsWith('.'));
  return hook ? `a git hook (${hook}) would run` : null;
}

/**
 * Why a push goes somewhere the person didn’t ask for, or null: the remote must be origin or one they named, and the
 * branch one they named, or the one checked out unless it’s the default branch.
 * @param {string} folder @param {string[]} args  the words after git push @param {Set<string>} named
 */
async function pushTarget(folder, args, named) {
  const [remoteArg, branchArg] = args.filter((w) => !w.startsWith('-'));
  const current = await git(folder, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!current) return 'no branch is checked out';
  const originHead = await git(folder, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  const main = originHead ? originHead.replace(/^origin\//, '') : null;
  let remote = remoteArg;
  let branch = branchArg && branchArg !== 'HEAD' ? branchArg : current;
  if (!remote) {
    // A bare push goes where the branch’s config sends it.
    const to = await git(folder, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']);
    if (!to) return 'the branch has nowhere to push to';
    [remote, branch] = [to.slice(0, to.indexOf('/')), to.slice(to.indexOf('/') + 1)];
  }
  if (remote !== 'origin' && !named.has(remote.toLowerCase())) return `you didn’t name the remote ${remote}`;
  if (named.has(branch.toLowerCase())) return null;
  const isDefault = branch === main || ['main', 'master'].includes(branch);
  return branch === current && !isDefault ? null : `you didn’t name the branch ${branch}`;
}

/**
 * Why a command’s git parts keep the card, or null (see the top of this file).
 * @param {string|null} folder @param {string} command @param {string} named  what the person typed, lowercase
 */
export async function gitOffRequest(folder, command, named) {
  const parts = splitCommand(command)
    .map(shellWords)
    .filter((w) => w[0] === 'git');
  if (!parts.length) return null;
  if (!folder) return 'Postbox doesn’t know the agent’s folder';
  const why = await configOrHooks(folder);
  if (why) return why;
  for (const [, sub, ...args] of parts) {
    const off = sub === 'push' ? await pushTarget(folder, args, tokensOf(named)) : null;
    if (off) return off;
  }
  return null;
}
