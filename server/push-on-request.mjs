// A push the person asked for, done by Postbox itself (#296). The review of #562 found every check of an agent’s own
// `git push` had a way past it: the push does what the repository’s config, hooks and remotes say (a mirror, a push
// refspec, insteadOf, origin’s URL set elsewhere, a pre-push hook), and the agent can change all of them with calls
// Postbox never sees. So Postbox decides by consequence and performs it:
// - the consequence is one sentence: commit <sha> lands on branch <b> of the project’s repository, with no force. The
//   repository is the one the person set on the project in Settings, never anything in .git/config;
// - Postbox reads the branch and the commit from the files in .git (HEAD, the branch’s ref), and never runs git in
//   the agent’s repository, so nothing configured there runs;
// - it pushes from an empty repository of its own that borrows the agent’s objects (objects/info/alternates), with no
//   system, global or local config, no hooks, nothing from the environment but PATH and the SSH agent, and the
//   person’s own gh as the credential helper: Postbox never sees a token;
// - then it reads the branch back from the remote, and the line in the conversation says what happened.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { splitCommand } from '../shared/permission-match.mjs';
import { shellWords, tokensOf } from './request-words.mjs';

const run = promisify(execFile);
const PUSH_TIMEOUT_MS = 60000;

// A branch name Postbox will push to: no .., //, @{, a leading - or ., or a trailing . / or .lock.
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\/\.)[A-Za-z0-9_][A-Za-z0-9._/-]*(?<![./])(?<!\.lock)$/;
const SHA = /^[0-9a-f]{40}$/;
const PUSH_FLAGS = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose']);

/**
 * The push a command asks for, or null: a lone `git push`, `git push origin`, or `git push [-u] origin <branch>`. A
 * chain, another remote, a refspec or any other flag gets the card.
 * @param {string} command @returns {{ branch: string|null } | null}
 */
export function pushOf(command) {
  const parts = splitCommand(String(command ?? ''));
  if (parts.length !== 1) return null;
  const [git, sub, ...rest] = shellWords(parts[0]);
  if (git !== 'git' || sub !== 'push' || rest.some((w) => w.startsWith('-') && !PUSH_FLAGS.has(w))) return null;
  const [remote, branch, ...more] = rest.filter((w) => !w.startsWith('-'));
  if (more.length || (remote !== undefined && remote !== 'origin')) return null;
  if (branch === undefined || branch === 'HEAD') return { branch: null };
  return BRANCH.test(branch) ? { branch } : null;
}

/**
 * A repository Postbox may push to, as the person sets it on a project: an https or ssh URL, git@host:path, or a
 * path on this computer. Never an ext:: or other transport, an option (it never starts with -), or a space.
 * @param {unknown} url
 */
export const isPushUrl = (url) =>
  typeof url === 'string' && url.length <= 500 && !/\s/.test(url) && /^(?:https:\/\/[^/]+\/\S+|ssh:\/\/\S+|[\w.-]+@[\w.-]+:[^-]\S*|\/\S+)$/.test(url);

/** The repository’s git folders, found by walking up from the agent’s folder: its own (HEAD) and the shared one. */
async function gitDirs(folder) {
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    const dotgit = join(dir, '.git');
    const st = await stat(dotgit).catch(() => null);
    if (st?.isDirectory()) return { own: dotgit, common: dotgit };
    if (st?.isFile()) {
      // A worktree: .git names its folder, whose commondir names the shared one.
      const own = /^gitdir: (.+)$/m.exec(await readFile(dotgit, 'utf8'))?.[1];
      if (!own) return null;
      const ownDir = resolve(dir, own.trim());
      const common = (await readFile(join(ownDir, 'commondir'), 'utf8').catch(() => '')).trim();
      return { own: ownDir, common: common ? resolve(ownDir, common) : ownDir };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** A branch’s commit, from its file or packed-refs. @param {string} common @param {string} branch */
async function branchSha(common, branch) {
  const ref = `refs/heads/${branch}`;
  const loose = (await readFile(join(common, ref), 'utf8').catch(() => '')).trim();
  if (loose) return SHA.test(loose) ? loose : null;
  const packed = await readFile(join(common, 'packed-refs'), 'utf8').catch(() => '');
  const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
  const sha = line?.split(' ')[0];
  return sha && SHA.test(sha) ? sha : null;
}

/**
 * What a push would do, read from the files in .git, never by running git there: the branch (the one named, or the
 * one checked out) and its commit. Null when it can’t be read for sure.
 * @param {string} folder @param {{ branch: string|null }} push
 * @returns {Promise<{ branch: string, current: string|null, sha: string, objects: string } | null>}
 */
export async function pushPlan(folder, push) {
  const dirs = folder ? await gitDirs(folder) : null;
  if (!dirs) return null;
  const head = (await readFile(join(dirs.own, 'HEAD'), 'utf8').catch(() => '')).trim();
  const current = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  const branch = push.branch ?? current;
  if (!branch || !BRANCH.test(branch)) return null;
  const sha = await branchSha(dirs.common, branch);
  return sha ? { branch, current, sha, objects: join(dirs.common, 'objects') } : null;
}

/**
 * git with nothing the agent could have set: no system, global or local config (the repository is Postbox’s own), no
 * hooks, and the person’s gh for credentials. Only PATH and the SSH agent come from the environment.
 * @param {string} home  an empty folder of Postbox’s @param {string[]} args
 */
async function cleanGit(home, args) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    // gh reads its sign-in from the person’s own config folder; Postbox passes the folder, never a token.
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gh'),
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
  };
  const config = [
    'core.hooksPath=/dev/null',
    'credential.helper=',
    'credential.helper=!gh auth git-credential',
    'protocol.allow=never',
    'protocol.https.allow=always',
    'protocol.ssh.allow=always',
    'protocol.file.allow=always',
    'push.recurseSubmodules=no',
    'submodule.recurse=false',
  ].flatMap((c) => ['-c', c]);
  const { stdout } = await run('git', [...config, ...args], { env, cwd: home, timeout: PUSH_TIMEOUT_MS });
  return stdout.trim();
}

/** The remote’s default branch, from the remote itself, or null. @param {string} home @param {string} url */
export async function defaultBranch(home, url) {
  const out = await cleanGit(home, ['ls-remote', '--symref', url, 'HEAD']).catch(() => '');
  return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1] ?? null;
}

/**
 * Postbox’s own push: <sha> to refs/heads/<branch> of <url>, with no force, from an empty bare repository that
 * borrows the agent’s objects. Then it reads the branch back from the remote.
 * @param {{ url: string, branch: string, sha: string, objects: string }} p
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function runPush({ url, branch, sha, objects }) {
  if (!isPushUrl(url) || !BRANCH.test(branch) || !SHA.test(sha)) return { ok: false, error: 'the push wasn’t one Postbox can make' };
  const home = await mkdtemp(join(tmpdir(), 'pb-push-'));
  try {
    const repo = join(home, 'repo.git');
    await cleanGit(home, ['init', '-q', '--bare', '--template=', repo]);
    await writeFile(join(repo, 'objects', 'info', 'alternates'), `${objects}\n`);
    await cleanGit(home, ['--git-dir', repo, 'cat-file', '-e', `${sha}^{commit}`]);
    await cleanGit(home, ['--git-dir', repo, 'push', '--no-verify', '--porcelain', url, `${sha}:refs/heads/${branch}`]);
    const there = await cleanGit(home, ['ls-remote', url, `refs/heads/${branch}`]);
    if (there.split('\t')[0] !== sha) return { ok: false, error: `the remote’s ${branch} isn’t at ${sha.slice(0, 7)} after the push` };
    return { ok: true };
  } catch (e) {
    const said = String(e.stderr ?? e.message ?? e)
      .split('\n')
      .filter((l) => l.trim() && !/^(?:To |Done)/.test(l))
      .slice(-2)
      .join(' ');
    return { ok: false, error: said.slice(0, 300) || 'git failed' };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * What a push the person may have asked for would do, or null for the card: the project’s repository, which the
 * person set in Settings, and the branch and commit from .git. A branch they didn’t name must be the one checked
 * out, and never the remote’s default branch.
 * @param {{ folder: string|null, url: unknown, push: { branch: string|null }, named: string }} o
 */
export async function pushConsequence({ folder, url, push, named }) {
  if (!folder || !isPushUrl(url)) return null;
  const plan = await pushPlan(folder, push);
  if (!plan) return null;
  if (!tokensOf(named).has(plan.branch.toLowerCase())) {
    if (plan.branch !== plan.current) return null;
    const home = await mkdtemp(join(tmpdir(), 'pb-push-'));
    const main = await defaultBranch(home, String(url)).finally(() => rm(home, { recursive: true, force: true }));
    if (!main || main === plan.branch) return null;
  }
  return { ...plan, url, sentence: `commit ${plan.sha.slice(0, 7)} lands on branch ${plan.branch} of ${url}, with no force` };
}

/**
 * What the agent is told once Postbox pushed in its place: its own git push didn’t run, and needn’t.
 * @param {{ sha: string, branch: string, url: string }} p
 */
export const pushedMessage = (p) =>
  `Postbox pushed this for you, as the person asked: commit ${p.sha.slice(0, 7)} is now on branch ${p.branch} of ${p.url}. Your own git push didn’t run, so don’t run it again. Your remote-tracking branch isn’t updated; git fetch updates it.`;
