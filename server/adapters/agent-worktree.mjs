// An Antigravity agent’s own git worktree (#1709). Each turn writes Postbox’s plugin into the folder agy starts in, so
// two turns can’t start in one folder (folder-queue.mjs’s FolderQueue). Agents without a folder of their own all
// shared the project’s folder, so they waited behind each other. Decided by the person on 23 November 2026, and again
// on 26 November (#1856): each agent gets its own worktree, shares nothing with other agents, and waits for no
// reason. So an agent with no folder of its own, in a project whose folder is in a git repository with a commit, works
// in a worktree of that repository made for it on its first turn: a branch of its own,
// `postbox/<project id>-<handle>-<persona id>`, started from the project’s current commit, in Postbox’s data folder:
//
//   <data>/worktrees/<project id>/<persona id>-<repo>/     the worktree, kept across turns and restarts; <repo> is
//                                                           a hash of the repository’s folder
//
// If the project’s folder is below the repository’s top, the agent works in the same folder within its worktree. Its
// changes land on its branch, not in the project’s folder, until they’re merged. Files the repository doesn’t track,
// such as node_modules, .env and build output, aren’t in it; the project’s submodules are (agent-submodules.mjs). An
// agent that ran in the project’s folder before starts its agy conversation over once, since agy keeps a conversation
// per folder. Every git command runs with an argument array and with the repository’s hooks and filters off
// (ledger-git.mjs’s runGit), so making a worktree runs nothing the repository’s config names.
//
// Where there’s nothing to make a worktree from (a project folder not in a git repository, or one with no commit
// yet), and where git refuses one (a branch checked out elsewhere), the agent starts in a folder of its own beside
// the project and works in the project’s folder (agent-own-folder.mjs, #1856); a refusal is also logged, told to the
// agent and shown in the room. An agent whose persona names a folder keeps it, and one in a project with no folder
// keeps its workspace (folder.mjs’s agentFolder). So turns wait only where they’d start in one folder: one agent’s
// turns in two conversations, and two personas that name the same folder.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { storedFolder } from '../folder-path.mjs';
import { runGit } from '../ledger-git.mjs';
import { folderName, ownFolderFor } from './agent-own-folder.mjs';
import { addSubmodules } from './agent-submodules.mjs';
import { gitPointer } from './agy-git-dir.mjs';
import { agentFolder } from './folder.mjs';
import { exists, gitsOwnLock, gitsReason, removeWorktree, stateOf } from './worktree-state.mjs';

/** @typedef {(cwd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} Git */

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

/** Worktrees being made now, by folder, so two turns starting at once make one. @type {Map<string, ReturnType<typeof whole>>} */
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
 * Where an Antigravity agent’s turn starts: its own worktree of the project’s repository (above); with nothing to make
 * one from, or one git refused, a folder of its own beside the project (agent-own-folder.mjs), with git’s reason for a
 * refusal; else the folder every backend uses (agentFolder). Never the project’s own folder, where its turns would
 * wait for other agents’.
 * @param {{ id?: string, handle: string, folder?: string|null }} persona
 * @param {{ id?: string, folder?: string|null } | null | undefined} project
 * @param {string} workRoot
 * @param {{ git?: Git, log?: (line: string) => void }} [o]
 * @returns {Promise<{ folder: string, why?: string }>}
 */
export async function agentPlace(persona, project, workRoot, { git = defaultGit, log = (l) => console.error(l) } = {}) {
  // A project in the store always has an id; one without can’t name a folder for the agent.
  if (storedFolder(persona) || !project?.folder || !project.id) return { folder: await agentFolder(persona, project, workRoot) };
  const key = JSON.stringify([workRoot, project.id, project.folder, persona.id || persona.handle]);
  const seen = known.get(key);
  // Its folder below the repository’s top can go with a checkout: then it’s worked out, and made, again.
  if (seen && (await stateOf(seen.dir)) === 'finished' && (await exists(seen.folder))) return { folder: seen.folder };
  const beside = () => agentFolder({ ...persona, folder: ownFolderFor(workRoot, project, persona) }, project, workRoot);
  const top = await git(project.folder, ['rev-parse', '--show-toplevel', '--show-prefix']);
  // Not in a repository, or in one with no commit yet, which would give an empty worktree without the project’s files.
  if (top.code !== 0 || (await git(project.folder, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) return { folder: await beside() };
  const [first = '', line = ''] = top.stdout.split('\n');
  const repo = first.trim();
  // Where the project’s folder sits below the repository’s top, as git prints it: `apps/web/`, or empty.
  const prefix = line.trim().replace(/\/+$/, '');
  // Keyed by the repository too, so a project pointed at another one gets a worktree of that one.
  const which = createHash('sha256').update(repo).digest('hex').slice(0, 8);
  const dir = join(worktreesRootFor(workRoot), folderName(project.id), `${folderName(persona.id || persona.handle)}-${which}`);
  const once = (/** @type {string} */ line) => !logged.has(`${dir}\n${line}`) && logged.add(`${dir}\n${line}`) && log(line);
  const made = making.get(dir) ?? whole(git, { repo, folder: project.folder, dir, branch: branchFor(persona, project) });
  making.set(dir, made);
  const ready = await made.finally(() => making.get(dir) === made && making.delete(dir));
  if ('why' in ready) {
    once(
      `Postbox couldn’t make a worktree for @${persona.handle} in ${project.folder} (${ready.why}), so it starts in a folder of its own and works in the project’s folder.`,
    );
    return { folder: await beside(), why: ready.why };
  }
  for (const s of ready.left) once(`Postbox left the submodule ${s.path} empty in @${persona.handle}’s worktree: ${s.why}.`);
  const folder = prefix ? await agentFolder({ ...persona, folder: join(ready.dir, prefix) }, project, workRoot) : ready.dir;
  known.set(key, { dir: ready.dir, folder });
  return { folder };
}

/**
 * The folder an Antigravity agent’s turn starts in (agentPlace), for whatever asks only where: the permissions panel,
 * the files it names, its `!` commands.
 * @param {Parameters<typeof agentPlace>} args @returns {Promise<string>}
 */
export const agentWorktree = async (...args) => (await agentPlace(...args)).folder;

/**
 * An agent’s worktree with the project’s submodules in it (agent-submodules.mjs), or git’s reason when it refuses the
 * worktree. A submodule that stays empty doesn’t stop the agent working there: `left` names each.
 * @param {Git} git @param {{ repo: string, folder: string, dir: string, branch: string }} o  repo: the repository’s top
 * @returns {Promise<{ dir: string, left: { path: string, why: string }[] } | { why: string }>}
 */
async function whole(git, { repo, folder, dir, branch }) {
  const made = await worktree(git, folder, dir, branch);
  return 'dir' in made ? { dir: made.dir, left: await addSubmodules(git, { repo, dir: made.dir, branch }) } : made;
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
  // Git’s own submodule checkout stays off: it could reach the network with the repository’s own ssh command. Theirs
  // are made after, from the person’s own repositories (agent-submodules.mjs).
  const add = ['-c', 'submodule.recurse=false', 'worktree', 'add'];
  const added = await git(repo, has ? [...add, dir, branch] : [...add, '-b', branch, dir]);
  if (added.code === 0) return { dir };
  // An add git stopped (its timeout) or refused may have made the folder, even its .git, and checked out part of it.
  // Only a folder this add made goes, through git and then from disk, so the next turn can make it whole. With no
  // folder there, git’s record of one still being made goes too (a hard stop mid-add, its folder deleted after), since
  // prune keeps it; a record someone locked stays, as for a locked worktree whose folder they moved.
  if (!there && ((await exists(dir)) || (await gitsOwnLock(git, repo, dir)))) await removeWorktree(git, repo, dir);
  return { why: gitsReason(added) };
}

/**
 * The project’s folder to add to a turn that runs in cwd (agy’s --add-dir), or null for an agent in its own worktree,
 * which works there rather than in the shared folder. An agent that starts in a folder of its own beside the project
 * (agent-own-folder.mjs) is given the project’s folder, where it works.
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
