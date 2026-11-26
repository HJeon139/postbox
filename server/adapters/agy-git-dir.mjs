// Where git reads its config from, for Antigravity’s Auto (agy-auto.mjs): routine git runs with no card only where the
// agent can’t have written that config, since a .git/config can name a program git runs (#423).
// - A real .git folder in the agent’s folder: git reads it, and an edit there asks (agy-hook.mjs).
// - A git worktree (#1709): .git is a file naming the main repository’s `.git/worktrees/<name>`, and git reads that
//   repository’s config. It counts only when that folder is real and outside every folder the agent may edit, so the
//   agent can’t have written it; a .git file the agent pointed elsewhere asks.
// Anything else (no .git, a link, a bare repository made of files the agent wrote) asks.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { inside } from './agy-paths.mjs';

/**
 * Whether routine git may run in cwd: its .git is a real folder, or a worktree’s file naming a main repository’s
 * worktree folder outside the agent’s folders.
 * @param {string} cwd @param {string[]} [roots]  the folders the agent may edit
 */
export function ownGitDir(cwd, roots = []) {
  try {
    const dotGit = join(cwd, '.git');
    const kind = lstatSync(dotGit);
    if (kind.isDirectory()) return true;
    if (!kind.isFile()) return false; // a link, say
    const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (!named) return false;
    const admin = realpathSync(resolve(cwd, named));
    // <repository>/.git/worktrees/<name>, made by git worktree add.
    if (basename(dirname(admin)) !== 'worktrees' || !lstatSync(dirname(dirname(admin))).isDirectory()) return false;
    const real = (/** @type {string} */ d) => {
      try {
        return realpathSync(d);
      } catch {
        return resolve(d);
      }
    };
    return !roots.some((r) => inside(admin, real(r)));
  } catch {
    return false; // no .git: git would look elsewhere, so it asks
  }
}
