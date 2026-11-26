// The commit at the end of an Antigravity turn in an agent’s own worktree (#1709): what the turn left, on its branch,
// for the person to merge (the person’s decision of 26 November 2026).

import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runGit } from '../ledger-git.mjs';
import { gitTimeoutFor, sharedFolder } from './agent-worktree.mjs';

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
 * run, and unsigned. The agent is its author, and Postbox its committer, for this commit only. Nothing for a turn in the project’s
 * shared folder, or one that changed nothing. Returns whether it committed.
 * @param {string} cwd @param {{ handle: string }} persona
 * @param {{ folder?: string|null } | null | undefined} project @param {string} workRoot
 * @param {{ git?: Git, log?: (line: string) => void }} [o]
 */
export async function commitTurn(cwd, persona, project, workRoot, { git = defaultGit, log = (l) => console.error(l) } = {}) {
  if (!project?.folder || sharedFolder(cwd, project, workRoot)) return false;
  // Every untracked file, whatever status.showUntrackedFiles says, or a turn that only made files commits nothing.
  const changed = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (changed.code !== 0 || !changed.stdout.trim()) return false;
  // A conflict, or a merge, rebase or cherry-pick the agent left half done, would be committed as resolved, markers
  // and all. A conflict shows in the status itself, whatever left it (a stash pop leaves no file to see it by).
  const conflicted = changed.stdout.split('\n').some((l) => /^(?:DD|AU|UD|UA|DU|AA|UU) /.test(l));
  const midway = (await inProgress(git, cwd)) ?? (conflicted ? 'conflict' : null);
  if (midway) {
    log(`Postbox didn’t commit @${persona.handle}’s work in ${cwd}: a ${midway} is in progress there, so it stays uncommitted.`);
    return false;
  }
  const added = await git(cwd, ['add', '-A']);
  // Unsigned: signing would run gpg.program, a program from the repository’s or the person’s config, and could wait
  // on a passphrase.
  // And no automatic maintenance, whose gc can prune the repository’s worktrees, the person’s own included.
  const identity = [
    '-c',
    'user.name=Postbox',
    '-c',
    'user.email=postbox@postbox.invalid',
    '-c',
    'commit.gpgSign=false',
    '-c',
    'maintenance.auto=false',
    '-c',
    'gc.auto=0',
  ];
  const author = `--author=@${persona.handle} <${persona.handle}@postbox.invalid>`;
  const made = added.code === 0 ? await git(cwd, [...identity, 'commit', '-q', author, '-m', `@${persona.handle}’s work at the end of a turn`]) : added;
  if (made.code === 0) return true;
  log(
    `Postbox couldn’t commit @${persona.handle}’s work in ${cwd} (${made.stderr.trim().split('\n').at(-1) || `git exited with ${made.code}`}), so it stays there, uncommitted.`,
  );
  return false;
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

/** Which operation is half done in the worktree at cwd, or null. @param {Git} git @param {string} cwd */
async function inProgress(git, cwd) {
  const names = Object.keys(MIDWAY);
  const paths = await git(cwd, ['rev-parse', ...names.flatMap((n) => ['--git-path', n])]);
  if (paths.code !== 0) return 'git operation';
  const lines = paths.stdout.split('\n');
  for (const [i, name] of names.entries()) if (lines[i] && (await exists(resolve(cwd, lines[i])))) return MIDWAY[/** @type {keyof typeof MIDWAY} */ (name)];
  return null;
}
