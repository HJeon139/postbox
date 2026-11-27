// The folder an Antigravity agent starts in when there’s nothing to make it a worktree from (#1856): its project’s
// folder isn’t in a git repository, the repository has no commit yet, or git refused the worktree. Each turn writes
// Postbox’s plugin into the folder agy starts in, so two turns can’t start in one folder (folder-queue.mjs). Such an
// agent used to start in the project’s own folder, behind every other Antigravity turn there. The person’s words of
// 26 November 2026: Antigravity agents “must not share resources with other agents and wait for no reason.” So it
// starts in a folder Postbox makes for it alone, in the data folder:
//
//   <data>/agent-folders/<project id>/<persona id>/     kept across turns and restarts
//
// and works in the project’s folder, which the turn is given beside it (agy’s --add-dir, agent-worktree.mjs’s
// turnFolders), as an agent whose persona names a folder of its own does. Its work lands in the project’s folder
// itself, where every other backend’s agents work and where the person already looks: with no commit to branch from
// there’s nothing for git to merge, so a copy would only keep its work from the person and the other agents. Its
// rules say where the project is. Nothing is committed for it.

import { dirname, join, resolve, sep } from 'node:path';
import { cutText } from '../../shared/text-parts.mjs';

/** An id as one folder’s name: anything but letters, digits, _ and - replaced, as setup.mjs names memory folders. @param {string} v */
export const folderName = (v) => String(v).replace(/[^\w-]/g, '_');

/** Where these folders go: `agent-folders` in Postbox’s data folder, beside the workspaces at workRoot. @param {string} workRoot */
export const ownFoldersRootFor = (workRoot) => join(dirname(workRoot), 'agent-folders');

/**
 * The folder an agent starts in for a project it has no worktree of: the project’s and its own, by id, so a new agent
 * given a deleted one’s handle doesn’t start in the old one’s.
 * @param {string} workRoot @param {{ id?: string }} project @param {{ id?: string, handle: string }} persona
 */
export const ownFolderFor = (workRoot, project, persona) =>
  join(ownFoldersRootFor(workRoot), folderName(project.id ?? 'project'), folderName(persona.id || persona.handle));

/**
 * What an agent that starts in such a folder is told about where it works, and, when git refused its worktree, why and
 * what that means for its work. Empty for a turn that starts anywhere else.
 * @param {string} cwd @param {{ folder?: string|null } | null | undefined} project @param {string} workRoot
 * @param {string} [why]  git’s reason for refusing the worktree
 */
export function besideNote(cwd, project, workRoot, why = '') {
  if (!project?.folder || !resolve(cwd).startsWith(`${resolve(ownFoldersRootFor(workRoot))}${sep}`)) return '';
  // Brief, as the worktree’s note is: agy’s rules file has about 750 characters to spare of its 12,000.
  const refused = why
    ? ` Postbox couldn’t make you a git worktree (${cutText(why, 120)}), so your changes there aren’t on a branch of your own and Postbox commits nothing for you: say so in your reply.`
    : '';
  return [
    '## Where you work',
    '',
    `Your current folder is one Postbox made for you alone, so your turns never wait for another agent’s. The project’s folder is ${project.folder}: do the project’s work there, by its full path. Other agents work there at the same time.${refused}`,
  ].join('\n');
}

/**
 * A failed step in the room for a turn whose worktree git refused, so the person sees it where the turn is, not only
 * in the server log. It asks nothing of them: the turn runs, in the project’s folder.
 * @param {{ activity?: (step: any) => void }} ctx @param {{ handle: string }} persona
 * @param {{ folder?: string|null } | null | undefined} project @param {string} [why]  git’s reason; no step without one
 */
export function noWorktreeStep(ctx, persona, project, why) {
  if (!why) return;
  ctx.activity?.({
    id: 'postbox-no-worktree',
    label: 'Postbox couldn’t make this agent’s worktree',
    state: 'failed',
    ms: 0,
    detail: `Git refused a worktree of ${project?.folder} for @${persona.handle}: ${why}. This turn it works in that folder itself, beside the other agents, so its changes aren’t on a branch of its own and Postbox commits nothing for it. Fix what git names, and Postbox tries again at its next turn.`,
  });
}
