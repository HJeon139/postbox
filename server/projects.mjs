// Projects the person adds in Settings: a name and an existing folder. Moved out of server/index.mjs.

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { httpError } from './helpers.mjs';
import { newId } from './store.mjs';

/** @param {any} store @param {{ name?: string, folder?: string }} body */
export async function createProject(store, body) {
  const folder = resolve(String(body.folder ?? ''));
  const st = await stat(folder).catch(() => null);
  if (!st?.isDirectory()) throw httpError(422, 'That folder doesn’t exist. Pick an existing folder for the project.');
  const p = { id: newId('pr'), name: String(body.name || 'New project').slice(0, 80), folder };
  store.emit('project', p);
  return p;
}
