// An Antigravity agent’s own git worktree (#1709). Each turn writes Postbox’s plugin into the agent’s folder, so two
// turns in one folder can’t run at once (antigravity-cli.mjs’s FolderQueue). Agents without a folder of their own all
// shared the project’s folder, so they waited behind each other. Decided by the person on 23 November 2026: each
// agent gets its own worktree. So an agent with no folder of its own, in a project whose folder is in a git
// repository, works in a worktree of that repository made for it on its first turn: a branch of its own,
// `postbox/<project id>-<handle>`, started from the project’s current commit, in Postbox’s data folder:
//
//   <data>/worktrees/<project id>/<persona id>-<repo>/     the worktree, kept across turns and restarts; <repo> is
//                                                           a hash of the repository's folder
//
// If the project’s folder is below the repository’s top, the agent works in the same folder within its worktree. Its
// changes land on its branch, not in the project’s folder, until they’re merged. Files the repository doesn’t track,
// such as node_modules, .env and build output, aren’t in it. An agent that ran in the project’s folder before starts
// its agy conversation over once, since agy keeps a conversation per folder. Every git command runs with an
// argument array and with the repository’s hooks and filters off (ledger-git.mjs’s runGit), so making a worktree runs
// nothing the repository’s config names.
//
// Everywhere else the folder is as it was (folder.mjs’s agentFolder): an agent with its own folder, a project with no
// folder, one not in a git repository, or one with no commit yet. So is a worktree git refuses (a branch checked out
// elsewhere), and the server log says why. Turns in one folder still take turns there: one agent’s turns in two
// conversations, and every turn in a folder that isn’t in git.

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { storedFolder } from '../folder-path.mjs';
import { runGit } from '../ledger-git.mjs';
import { agentFolder } from './folder.mjs';

/** @typedef {(cwd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} Git */

/** An id as one folder’s name: anything but letters, digits, _ and - replaced, as setup.mjs names memory folders. @param {string} v */
const folderName = (v) => String(v).replace(/[^\w-]/g, '_');

/** Where agents’ worktrees go: `worktrees` in Postbox’s data folder, beside the workspaces at workRoot. @param {string} workRoot */
export const worktreesRootFor = (workRoot) => join(dirname(workRoot), 'worktrees');

/**
 * The branch an agent’s worktree is on: its project’s and its own, so two projects in one repository don’t share one.
 * Handles and ids are letters, digits, - and _, which a branch name takes as they are.
 * @param {{ handle: string }} persona @param {{ id?: string }} project
 */
export const branchFor = (persona, project) => `postbox/${folderName(project.id ?? 'project')}-${persona.handle}`;

/** How long a worktree add may take: it checks out every file, which a large repository needs time for. */
const ADD_TIMEOUT_MS = 5 * 60_000;
/** How long git may take for these arguments: a worktree add gets ADD_TIMEOUT_MS, anything else runGit’s own. @param {string[]} args */
export const gitTimeoutFor = (args) => (args.includes('worktree') && args.includes('add') ? { timeoutMs: ADD_TIMEOUT_MS } : {});
/** git as Postbox runs it (ledger-git.mjs): an argument array, the repository’s hooks and filters off. @type {Git} */
const defaultGit = (cwd, args) => runGit(cwd, args, gitTimeoutFor(args));

/** Worktrees being made now, by folder, so two turns starting at once make one. @type {Map<string, Promise<{ dir: string } | { why: string }>>} */
const making = new Map();

/**
 * The folder an Antigravity agent works in: its own worktree of the project’s repository (above), else the folder
 * every backend uses (agentFolder).
 * @param {{ id?: string, handle: string, folder?: string|null }} persona
 * @param {{ id?: string, folder?: string|null } | null | undefined} project
 * @param {string} workRoot
 * @param {{ git?: Git, log?: (line: string) => void }} [o]
 * @returns {Promise<string>}
 */
export async function agentWorktree(persona, project, workRoot, { git = defaultGit, log = (l) => console.error(l) } = {}) {
  const shared = () => agentFolder(persona, project, workRoot);
  if (storedFolder(persona) || !project?.folder || !project.id) return shared();
  const top = await git(project.folder, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (top.code !== 0) return shared();
  // A repository with no commit yet would give an empty worktree, without the project’s files.
  if ((await git(project.folder, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) return shared();
  const [repo = '', line = ''] = top.stdout.split('\n');
  // Where the project’s folder sits below the repository’s top, as git prints it: `apps/web/`, or empty.
  const prefix = line.trim().replace(/\/+$/, '');
  // Keyed by the repository too, so a project pointed at another one gets a worktree of that one.
  const which = createHash('sha256').update(repo.trim()).digest('hex').slice(0, 8);
  const dir = join(worktreesRootFor(workRoot), folderName(project.id), `${folderName(persona.id || persona.handle)}-${which}`);
  const made = making.get(dir) ?? worktree(git, project.folder, dir, branchFor(persona, project));
  making.set(dir, made);
  const ready = await made.finally(() => making.get(dir) === made && making.delete(dir));
  if ('dir' in ready) return prefix ? agentFolder({ ...persona, folder: join(ready.dir, prefix) }, project, workRoot) : ready.dir;
  log(
    `Postbox couldn’t make a worktree for @${persona.handle} in ${project.folder} (${ready.why}), so it works in the project’s folder and waits for other Antigravity turns there.`,
  );
  return shared();
}

/**
 * The worktree at dir, made if it isn’t there: on its branch if that exists, else on a new one from HEAD. Git’s reason
 * when it refuses, with nothing made.
 * @param {Git} git @param {string} repo @param {string} dir @param {string} branch
 * @returns {Promise<{ dir: string } | { why: string }>}
 */
async function worktree(git, repo, dir, branch) {
  const state = await stateOf(dir);
  if (state === 'finished') return { dir };
  // One git didn’t finish making (a Postbox stopped mid-add) can hold no agent’s work, since no turn ever ran there: it
  // goes, through git and then from disk. Any other folder there is left as it is, since it may hold an agent’s work;
  // git refuses to add over it, and the log says so.
  if (state === 'unfinished') await removeWorktree(git, repo, dir);
  const there = state !== 'unfinished' && (await exists(dir));
  await mkdir(dirname(dir), { recursive: true });
  // A worktree whose folder was deleted is still registered, and git refuses to add one there until it’s pruned.
  await git(repo, ['worktree', 'prune']);
  const has = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  // Submodules aren't fetched: that could reach the network with the repository's own ssh command.
  const add = ['-c', 'submodule.recurse=false', 'worktree', 'add'];
  const added = await git(repo, has ? [...add, dir, branch] : [...add, '-b', branch, dir]);
  if (added.code === 0) return { dir };
  // An add git stopped (its timeout) or refused may have made the folder, even its .git, and checked out part of it.
  // Only a folder this add made goes, through git and then from disk, so the next turn can make it whole.
  if (!there) await removeWorktree(git, repo, dir);
  const lines = added.stderr.trim().split('\n');
  // Git prints progress before its reason, which starts `fatal:`.
  return { why: (lines.find((l) => l.startsWith('fatal:')) ?? lines[0])?.slice(0, 200) || `git exited with ${added.code}` };
}

/** Whether a path is there. @param {string} path */
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * A worktree folder’s state: finished, with its .git naming a folder under the repository’s .git/worktrees and git’s
 * marker for one still being made (a `locked` file there) gone; unfinished, with that marker still there; else none.
 * @param {string} dir @returns {Promise<'finished' | 'unfinished' | 'none'>}
 */
async function stateOf(dir) {
  try {
    const admin = /^gitdir:\s*(.+)$/m.exec(await readFile(join(dir, '.git'), 'utf8'))?.[1]?.trim();
    if (!admin) return 'none';
    return (await exists(join(resolve(dir, admin), 'locked'))) ? 'unfinished' : 'finished';
  } catch {
    return 'none';
  }
}

/**
 * Removes a worktree Postbox made, through git and then from disk. Git removes a worktree it locked while making it
 * only when told to force twice.
 * @param {Git} git @param {string} repo @param {string} dir
 */
async function removeWorktree(git, repo, dir) {
  await git(repo, ['worktree', 'remove', '--force', '--force', dir]);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * The project’s folder to add to a turn that runs in cwd (agy’s --add-dir), or null for an agent in its own worktree,
 * which works there rather than in the shared folder.
 * @param {string} cwd @param {{ folder?: string|null } | null | undefined} project @param {string} workRoot
 */
export const sharedFolder = (cwd, project, workRoot) =>
  resolve(cwd).startsWith(`${resolve(worktreesRootFor(workRoot))}${sep}`) ? null : (project?.folder ?? null);
