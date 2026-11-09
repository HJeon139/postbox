// A project’s folder as the folder picker lists it (GET /api/projects/:id/files), moved from server/index.mjs’s start.
// A file’s name is the person’s, as it is on disk, so it isn’t refused; the picker shows it as `shown`, with each
// character that would hide or reorder it marked, and attaches it by its real `path` (#1052).

import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { INVISIBLE } from '../shared/invisible.mjs';
import { httpError } from './helpers.mjs';

/**
 * A name as the picker shows it: each control character, lone surrogate, or character that shows as nothing or
 * reorders text (INVISIBLE, shared/invisible.mjs) is the replacement mark, as the permissions panel marks a hook’s
 * text (server/permission-hooks.mjs). @param {string} name
 */
export const markedName = (name) => name.replace(/[\p{Cc}\p{Cs}]/gu, '\uFFFD').replace(INVISIBLE, '\uFFFD');

/**
 * The entries of a folder in a project, sub relative to its root: never outside it, even through symbolic links.
 * @param {any} project @param {string} sub
 */
export async function listFolder(project, sub) {
  if (!project) throw httpError(404, 'That project doesn’t exist.');
  const root = await realpath(project.folder);
  const target = await realpath(resolve(root, sub)).catch(() => null);
  // The picker can’t leave the project’s folder, even through symbolic links.
  if (!target || (target !== root && !target.startsWith(root + sep))) throw httpError(403, 'That’s outside the project’s folder.');
  const entries = await readdir(target, { withFileTypes: true });
  const list = [];
  for (const e of entries.filter((x) => !x.name.startsWith('.')).slice(0, 500)) {
    const full = join(target, e.name);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    // A symbolic link that leads out of the folder is marked, so the picker says so instead of opening it (#28).
    const to = e.isSymbolicLink() ? await realpath(full).catch(() => null) : null;
    const outside = !!to && to !== root && !to.startsWith(root + sep);
    list.push({ name: e.name, shown: markedName(e.name), path: relative(root, full), dir: s.isDirectory(), size: s.size, ...(outside ? { outside } : {}) });
  }
  list.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const path = relative(root, target);
  return { root: project.folder, path, shownPath: markedName(path), entries: list };
}
