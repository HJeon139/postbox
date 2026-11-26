// The commit at the end of an Antigravity turn in an agent’s own worktree (#1709): what the turn left, on its branch,
// for the person to merge (the person’s decision of 26 November 2026).

import { access, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { runGit } from '../ledger-git.mjs';
import { branchFor, gitTimeoutFor, sharedFolder, worktreesRootFor } from './agent-worktree.mjs';

/** @typedef {import('./agent-worktree.mjs').Git} Git */

/** git as Postbox runs it (ledger-git.mjs): an argument array, the repository’s hooks and filters off. @type {Git} */
const defaultGit = (cwd, args) => runGit(cwd, args, gitTimeoutFor(args));

/** Whether a path is there. @param {string} path */
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Commits what a turn left in an agent’s own worktree, on its branch, so its work reaches the person and the other
 * agents as a commit whether or not it could commit itself (#1709, the person’s decision of 26 November 2026: an agent
 * without Shell would otherwise need a card for every `git commit`). Through runGit, so the repository’s hooks don’t
 * run, and unsigned. The agent is its author, and Postbox its committer, for this commit only.
 *
 * Only in the worktree Postbox made, on the agent’s own branch: git runs in that worktree’s record in the project’s
 * repository, found from the repository itself, with that record and the worktree named outright, never found through
 * anything in the agent’s folders. Nothing for a turn in the project’s shared folder, one that changed nothing, one on
 * another branch or none, or a worktree whose record sets core.worktree. Returns whether it committed.
 * @param {string} cwd @param {{ id?: string, handle: string }} persona
 * @param {{ id?: string, folder?: string|null } | null | undefined} project @param {string} workRoot
 * @param {{ git?: Git, log?: (line: string) => void }} [o]
 */
export async function commitTurn(cwd, persona, project, workRoot, { git = defaultGit, log = (l) => console.error(l) } = {}) {
  if (!project?.folder || sharedFolder(cwd, project, workRoot)) return false;
  const place = await recordOf(git, cwd, project.folder, workRoot);
  const refuse = (/** @type {string} */ why) => {
    log(`Postbox didn’t commit @${persona.handle}’s work in ${cwd}: ${why}, so it stays uncommitted.`);
    return false;
  };
  if (!place) return refuse('its worktree isn’t one the project’s repository lists');
  const g = (/** @type {string[]} */ args) => git(place.admin, ['--git-dir', place.admin, '--work-tree', place.top, ...args]);
  if ((await g(['config', '--get', 'core.worktree'])).code === 0) return refuse('its worktree’s record names another folder to work in');
  const head = await g(['symbolic-ref', '-q', 'HEAD']);
  if (head.stdout.trim() !== `refs/heads/${branchFor(persona, project)}`) return refuse('it isn’t on its own branch');
  // A repository nested in it: reading or adding it starts git inside that repository, whose own config the agent
  // wrote. One the index already holds is a gitlink, refused before the status could read it, as it would whatever
  // git’s config says when the agent’s .gitmodules asks it to.
  const tracked = await g(['ls-files', '--stage']);
  if (tracked.code !== 0 || /^160000 /m.test(tracked.stdout)) return refuse('it holds a repository of its own');
  // Every untracked file, whatever status.showUntrackedFiles says, or a turn that only made files commits nothing.
  // Unquoted (-z), so a new nested repository shows as a folder whatever its name.
  const changed = await g(['status', '--porcelain', '-z', '--untracked-files=all']);
  const entries = changed.stdout.split('\0').filter(Boolean);
  if (changed.code !== 0 || entries.length === 0) return false;
  // A conflict, or a merge, rebase or cherry-pick the agent left half done, would be committed as resolved, markers
  // and all. A conflict shows in the status itself, whatever left it (a stash pop leaves no file to see it by).
  const conflicted = entries.some((l) => /^(?:DD|AU|UD|UA|DU|AA|UU) /.test(l));
  const midway = (await inProgress(g, place.admin)) ?? (conflicted ? 'conflict' : null);
  if (midway) return refuse(`a ${midway} is in progress there`);
  if (entries.some((l) => l.startsWith('?? ') && l.endsWith('/'))) return refuse('it holds a repository of its own');
  const added = await g(['add', '-A']);
  // Unsigned: signing would run gpg.program, a program from the repository’s or the person’s config, and could wait
  // on a passphrase. And no automatic maintenance, whose gc can prune the repository’s worktrees, the person’s own.
  const identity = ['-c', 'user.name=Postbox', '-c', 'user.email=postbox@postbox.invalid', '-c', 'commit.gpgSign=false'];
  const quiet = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  const author = `--author=@${persona.handle} <${persona.handle}@postbox.invalid>`;
  const made = added.code === 0 ? await g([...identity, ...quiet, 'commit', '-q', author, '-m', `@${persona.handle}’s work at the end of a turn`]) : added;
  if (made.code === 0) return true;
  return refuse(`git refused (${made.stderr.trim().split('\n').at(-1) || `it exited with ${made.code}`})`);
}

/**
 * The worktree holding cwd, at its top under Postbox’s worktrees folder, and its record in the project’s repository:
 * the folder under that repository’s worktrees whose gitdir names it. From the project’s folder, outside the agent’s.
 * @param {Git} git @param {string} cwd @param {string} folder @param {string} workRoot
 * @returns {Promise<{ top: string, admin: string } | null>}
 */
async function recordOf(git, cwd, folder, workRoot) {
  const root = resolve(worktreesRootFor(workRoot));
  const [project, entry] = relative(root, resolve(cwd)).split(sep);
  if (!project || !entry || project === '..') return null;
  const top = await realpath(join(root, project, entry)).catch(() => null);
  const common = await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!top || common.code !== 0) return null;
  const records = join(common.stdout.trim(), 'worktrees');
  for (const name of await readdir(records).catch(() => [])) {
    const gitdir = await readFile(join(records, name, 'gitdir'), 'utf8').catch(() => '');
    // Relative to the record, when git writes relative paths (worktree.useRelativePaths).
    if (gitdir.trim() && resolve(join(records, name), gitdir.trim()) === join(top, '.git')) return { top, admin: join(records, name) };
  }
  return null;
}

/** What git leaves half done in a worktree, by the file it keeps while it’s under way. */
const MIDWAY = {
  MERGE_HEAD: 'merge',
  CHERRY_PICK_HEAD: 'cherry-pick',
  REVERT_HEAD: 'revert',
  'rebase-merge': 'rebase',
  'rebase-apply': 'rebase or am',
  BISECT_START: 'bisect',
};

/**
 * Which operation is half done in the worktree, or null. @param {(args: string[]) => ReturnType<Git>} git  git pinned
 * to the worktree @param {string} cwd  where it runs, which a relative --git-path is from
 */
async function inProgress(git, cwd) {
  const names = Object.keys(MIDWAY);
  const paths = await git(['rev-parse', ...names.flatMap((n) => ['--git-path', n])]);
  if (paths.code !== 0) return 'git operation';
  const lines = paths.stdout.split('\n');
  for (const [i, name] of names.entries()) if (lines[i] && (await exists(resolve(cwd, lines[i])))) return MIDWAY[/** @type {keyof typeof MIDWAY} */ (name)];
  return null;
}
