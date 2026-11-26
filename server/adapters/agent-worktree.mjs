// An Antigravity agent’s own git worktree (#1709). Each turn writes Postbox’s plugin into the agent’s folder, so two
// turns in one folder can’t run at once (antigravity-cli.mjs’s FolderQueue). Agents without a folder of their own all
// shared the project’s folder, so they waited behind each other. Decided by the person on 23 November 2026: each
// agent gets its own worktree. So an agent with no folder of its own, in a project whose folder is in a git
// repository, works in a worktree of that repository made for it on its first turn: a branch of its own,
// `postbox/<project id>-<handle>-<persona id>`, started from the project’s current commit, in Postbox’s data folder:
//
//   <data>/worktrees/<project id>/<persona id>-<repo>/     the worktree, kept across turns and restarts; <repo> is
//                                                           a hash of the repository’s folder
//
// If the project’s folder is below the repository’s top, the agent works in the same folder within its worktree. Its
// changes land on its branch, not in the project’s folder, until they’re merged. Files the repository doesn’t track,
// such as node_modules, .env and build output, aren’t in it. An agent that ran in the project’s folder before starts
// its agy conversation over once, since agy keeps a conversation per folder. Every git command runs with an
// argument array and with the repository’s hooks and filters off (ledger-git.mjs’s runGit), so making a worktree runs
// nothing the repository’s config names.
//
// Everywhere else the folder is as it was (folder.mjs’s agentFolder): an agent with its own folder, a project with no
// folder, one not in a git repository, one with no commit yet, or one whose repository has submodules. So is a worktree git refuses (a branch checked out
// elsewhere), and the server log says why. Turns in one folder still take turns there: one agent’s turns in two
// conversations, and every turn in a folder that isn’t in git.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { storedFolder } from '../folder-path.mjs';
import { runGit } from '../ledger-git.mjs';
import { gitPointer } from './agy-git-dir.mjs';
import { agentFolder } from './folder.mjs';

/** @typedef {(cwd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} Git */

/** An id as one folder’s name: anything but letters, digits, _ and - replaced, as setup.mjs names memory folders. @param {string} v */
const folderName = (v) => String(v).replace(/[^\w-]/g, '_');

/** Where agents’ worktrees go: `worktrees` in Postbox’s data folder, beside the workspaces at workRoot. @param {string} workRoot */
export const worktreesRootFor = (workRoot) => join(dirname(workRoot), 'worktrees');

/**
 * The branch an agent’s worktree is on: its project’s and its own, so two projects in one repository don’t share one,
 * and by its id as well as its handle, so a new agent given a deleted one’s handle doesn’t collide with the branch
 * the old worktree still holds. Handles and ids are letters, digits, - and _, which a branch name takes as they are.
 * @param {{ id?: string, handle: string }} persona @param {{ id?: string }} project
 */
export const branchFor = (persona, project) =>
  `postbox/${folderName(project.id ?? 'project')}-${persona.handle}${persona.id ? `-${folderName(persona.id)}` : ''}`;

/** How long a worktree add may take: it checks out every file, which a large repository needs time for. */
const ADD_TIMEOUT_MS = 5 * 60_000;
/** How long git may take for these arguments: a worktree add gets ADD_TIMEOUT_MS, anything else runGit’s own. @param {string[]} args */
export const gitTimeoutFor = (args) => (args.includes('worktree') && args.includes('add') ? { timeoutMs: ADD_TIMEOUT_MS } : {});
/** git as Postbox runs it (ledger-git.mjs): an argument array, the repository’s hooks and filters off. @type {Git} */
const defaultGit = (cwd, args) => runGit(cwd, args, gitTimeoutFor(args));

/** Worktrees being made now, by folder, so two turns starting at once make one. @type {Map<string, Promise<{ dir: string } | { why: string }>>} */
const making = new Map();
/**
 * The folder each agent’s worktree gave for a project’s folder, once made, so the next call (each turn, the
 * permissions panel, each file opened, each `!`) checks only that it’s still whole, with no git run.
 * @type {Map<string, { dir: string, folder: string }>}
 */
const known = new Map();
/** The refusals already logged, by folder and reason, so one is logged once, not at every call. */
const logged = new Set();

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
  const key = JSON.stringify([workRoot, project.id, project.folder, persona.id || persona.handle]);
  const seen = known.get(key);
  // Its folder below the repository’s top can go with a checkout: then it’s worked out, and made, again.
  if (seen && (await stateOf(seen.dir)) === 'finished' && (await exists(seen.folder))) return seen.folder;
  const top = await git(project.folder, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (top.code !== 0) return shared();
  // A repository with no commit yet would give an empty worktree, without the project’s files.
  if ((await git(project.folder, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) return shared();
  // One with submodules keeps the project’s folder too: a worktree holds them empty, and the turn-end commit leaves a
  // worktree with a repository in its index uncommitted (agent-worktree-commit.mjs), so the work would stay there unseen.
  if ((await git(project.folder, ['rev-parse', '--verify', '--quiet', 'HEAD:.gitmodules'])).code === 0) return shared();
  const [repo = '', line = ''] = top.stdout.split('\n');
  // Where the project’s folder sits below the repository’s top, as git prints it: `apps/web/`, or empty.
  const prefix = line.trim().replace(/\/+$/, '');
  // Keyed by the repository too, so a project pointed at another one gets a worktree of that one.
  const which = createHash('sha256').update(repo.trim()).digest('hex').slice(0, 8);
  const dir = join(worktreesRootFor(workRoot), folderName(project.id), `${folderName(persona.id || persona.handle)}-${which}`);
  const made = making.get(dir) ?? worktree(git, project.folder, dir, branchFor(persona, project));
  making.set(dir, made);
  const ready = await made.finally(() => making.get(dir) === made && making.delete(dir));
  if ('dir' in ready) {
    const folder = prefix ? await agentFolder({ ...persona, folder: join(ready.dir, prefix) }, project, workRoot) : ready.dir;
    known.set(key, { dir: ready.dir, folder });
    return folder;
  }
  if (!logged.has(`${dir}\n${ready.why}`)) {
    logged.add(`${dir}\n${ready.why}`);
    log(
      `Postbox couldn’t make a worktree for @${persona.handle} in ${project.folder} (${ready.why}), so it works in the project’s folder and waits for other Antigravity turns there.`,
    );
  }
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
  // A worktree whose folder was deleted is still registered, and git refuses to add one there until its record goes.
  // Only this one’s goes: `worktree prune` would forget every worktree of the repository whose folder is missing, such
  // as the person’s own on a drive that isn’t mounted (#766). Git keeps a record someone locked.
  if (!(await exists(dir))) await git(repo, ['worktree', 'remove', '--force', dir]);
  const has = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  // Submodules aren’t fetched: that could reach the network with the repository’s own ssh command.
  const add = ['-c', 'submodule.recurse=false', 'worktree', 'add'];
  const added = await git(repo, has ? [...add, dir, branch] : [...add, '-b', branch, dir]);
  if (added.code === 0) return { dir };
  // An add git stopped (its timeout) or refused may have made the folder, even its .git, and checked out part of it.
  // Only a folder this add made goes, through git and then from disk, so the next turn can make it whole. With no
  // folder there, git’s record of one still being made goes too (a hard stop mid-add, its folder deleted after), since
  // prune keeps it; a record someone locked stays, as for a locked worktree whose folder they moved.
  if (!there && ((await exists(dir)) || (await gitsOwnLock(git, repo, dir)))) await removeWorktree(git, repo, dir);
  const lines = added.stderr.trim().split('\n');
  // Git prints progress before its reason, which starts `fatal:`.
  return { why: (lines.find((l) => l.startsWith('fatal:')) ?? lines[0])?.slice(0, 200) || `git exited with ${added.code}` };
}

/**
 * Whether git’s record of the worktree at dir holds git’s own marker for one it’s still making (stateOf), read from
 * `worktree list`, which names each by its real path.
 * @param {Git} git @param {string} repo @param {string} dir
 */
async function gitsOwnLock(git, repo, dir) {
  const real = await realpath(dirname(dir)).then(
    (parent) => join(parent, basename(dir)),
    () => dir,
  );
  const listed = (await git(repo, ['worktree', 'list', '--porcelain'])).stdout ?? '';
  return listed.split('\n\n').some((entry) => {
    const lines = entry.split('\n');
    return (lines[0] === `worktree ${real}` || lines[0] === `worktree ${dir}`) && lines.includes('locked initializing');
  });
}

/** Whether a path is there. @param {string} path */
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * A worktree folder’s state: unfinished while git’s marker for one it’s still making is there, a `locked` file in its
 * admin folder that says `initializing` (git writes it so, under the C locale runGit sets); finished, with its .git
 * naming that admin folder, whose HEAD is there, and no such marker; else none. A `locked` file saying anything else is a lock someone set
 * (`git worktree lock`, empty or with its reason) on a worktree that may hold their work: it’s finished, and used. A
 * lock someone set with the reason `initializing` reads as git’s own marker.
 * @param {string} dir @returns {Promise<'finished' | 'unfinished' | 'none'>}
 */
async function stateOf(dir) {
  try {
    const admin = gitPointer(await readFile(join(dir, '.git'), 'utf8'), 'gitdir: ');
    if (!admin) return 'none';
    // Git’s own marker first: an add stopped before it wrote the record’s HEAD is still one to remove and make again.
    const lock = await readFile(join(resolve(dir, admin), 'locked'), 'utf8').catch(() => null);
    if (lock?.trim() === 'initializing') return 'unfinished';
    // Git’s record of it gone (the repository cloned again, or its .git deleted): no worktree git can use.
    return (await exists(join(resolve(dir, admin), 'HEAD'))) ? 'finished' : 'none';
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

/**
 * The folders a turn in cwd gets besides cwd: those it may work in (agy’s --add-dir: the project’s shared folder, unless
 * it’s in its own worktree, and any the person added), and the files and folders it may read with no card (the turn’s
 * attached files, and, in its own worktree, the project’s folder, as before it had one, #1709). Read only, so the
 * repository’s .git there stays outside the folders it may edit (agy-git-dir.mjs).
 * @param {string} cwd @param {{ project?: { folder?: string|null } | null, addDirs?: string[], readFiles?: string[] }} ctx
 * @param {string} workRoot
 */
export function turnFolders(cwd, ctx, workRoot) {
  const shared = sharedFolder(cwd, ctx.project, workRoot);
  const addDirs = [...new Set([shared, ...(ctx.addDirs ?? [])])].filter((d) => d && resolve(d) !== resolve(cwd));
  const reads = [...(ctx.readFiles ?? []), ...(!shared && ctx.project?.folder ? [ctx.project.folder] : [])];
  return { addDirs: /** @type {string[]} */ (addDirs), reads };
}

/**
 * The branch the worktree holding cwd is on now, read from git’s own files with no git run (the agent may have
 * checked out another): empty when it’s on a commit rather than a branch, null when there’s no worktree there.
 * @param {string} cwd @param {string} workRoot
 */
function branchIn(cwd, workRoot) {
  const root = resolve(worktreesRootFor(workRoot));
  for (let dir = resolve(cwd); dir.startsWith(`${root}${sep}`); dir = dirname(dir)) {
    let admin;
    try {
      admin = gitPointer(readFileSync(join(dir, '.git'), 'utf8'), 'gitdir: ');
    } catch {
      continue; // no .git here: the worktree’s top is further up
    }
    if (!admin) return null;
    try {
      const head = readFileSync(join(resolve(dir, admin), 'HEAD'), 'utf8');
      // A repository in git’s reftable format keeps a stub here, `ref: refs/heads/.invalid`: the branch isn’t known.
      if (/^ref: refs\/heads\/\.invalid\s*$/m.test(head)) return null;
      return /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? '';
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Where the note says the worktree is: on the branch it’s on now; on a commit, with Postbox’s branch to check out
 * first; or, when git’s files don’t say, on its own branch, which git names. @param {string|null} now @param {string} made
 */
function on(now, made) {
  // A branch name has no length limit, and agy’s rules file has little room to spare. One git doesn’t say (a reftable
  // repository keeps only a stub, detached or not) isn’t guessed.
  if (now === null || now.length > 100) return 'on its own branch, which `git branch --show-current` names';
  if (now) return `on branch ${now}`;
  return `on a commit, not a branch: check out ${made} before you commit`;
}

/**
 * What an agent in its own worktree is told about where it works (#1709, the person’s decision of 26 November 2026:
 * the person merges an agent’s branch, and the agent says which branch its work is on). Empty for a turn in the
 * project’s shared folder.
 * @param {string} cwd @param {{ id?: string, handle: string }} persona
 * @param {{ id?: string, folder?: string|null } | null | undefined} project @param {string} workRoot
 */
export function worktreeNote(cwd, persona, project, workRoot) {
  if (!project?.folder || sharedFolder(cwd, project, workRoot)) return '';
  // Brief: with the guide and the hook’s notes, agy’s rules file has about 750 characters to spare of its 12,000.
  return [
    '## Where you work',
    '',
    `Your current folder is your own git worktree, ${on(branchIn(cwd, workRoot), branchFor(persona, project))}. The project’s folder, ${project.folder}, is the person’s: read it, but don’t work there. Your work reaches the person and other agents only as commits on your branch, which the person merges; it doesn’t follow their later commits. Postbox commits what you leave at the end of each turn. When you change files, name your branch in your reply.`,
  ].join('\n');
}
