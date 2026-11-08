// Projects the person adds in Settings: a name and an existing folder, and the repository a push they ask for goes
// to. Creating one moved out of server/index.mjs.

import { realpath, stat } from 'node:fs/promises';
import { fullPath } from './folder-path.mjs';
import { httpError } from './helpers.mjs';
import { isPushUrl } from './push-on-request.mjs';
import { newId } from './store.mjs';

/**
 * Makes a project at an existing folder, kept by its real path (symbolic links resolved), so a check that a path is
 * inside the project compares it plainly.
 * @param {any} store @param {{ name?: string, folder?: unknown }} body
 */
export async function createProject(store, body) {
  const written = fullPath(body.folder);
  const folder = await realpath(written).catch(() => null);
  const st = folder ? await stat(folder).catch(() => null) : null;
  if (!folder || !st?.isDirectory()) throw httpError(422, 'That folder doesn’t exist. Pick an existing folder for the project.');
  const p = { id: newId('pr'), name: String(body.name || 'New project').slice(0, 80), folder };
  store.emit('project', p);
  return p;
}

/**
 * The repository a push the person asks for goes to (#296), which they set on the project: Postbox makes that push
 * itself, and never reads where to push from the agent’s .git/config, which the agent can change. Empty clears it.
 * @param {any} store @param {string} id @param {unknown} url
 */
export function setPushUrl(store, id, url) {
  const p = store.state.projects[id];
  if (!p) throw httpError(404, 'That project doesn’t exist any more.');
  const clean = typeof url === 'string' ? url.trim() : '';
  if (clean && !isPushUrl(clean))
    throw httpError(422, 'That isn’t a repository Postbox can push to. Use an https or ssh URL, git@host:owner/name, or a folder path on this computer.');
  const { pushUrl: _, ...rest } = p;
  const next = clean ? { ...rest, pushUrl: clean } : rest;
  store.emit('project', next);
  return next;
}
