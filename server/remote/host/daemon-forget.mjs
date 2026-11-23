// Postbox’s `forget` (#491): a deleted persona’s memory folder on this host, ~/.postbox-remote/memory/<persona>, is
// removed, and Postbox hears `forgotten`. Claude Code keeps a persona’s auto memory there on a host (setup.mjs’s
// memoryFolder, remote-turn.mjs’s hostMemoryRoot). Nothing else is touched: the folder’s name is the persona’s id as
// memoryFolderName gives it, always one folder under memory/, and memory/ must be a real folder, not a link.

import { promises as fsp } from 'node:fs';
import { memoryFolderName } from '../../../shared/memory-folders.mjs';
import { fail, send } from './daemon-reply.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/** @param {Daemon} d @param {Conn} c @param {{ persona: string }} m */
export async function forget(d, c, m) {
  const memory = `${d.p.root}/memory`;
  let kind;
  try {
    kind = await fsp.lstat(memory);
  } catch (e) {
    // No memory folder at all: nothing of this persona’s is here.
    if (/** @type {any} */ (e).code === 'ENOENT') return void send(c, 'forgotten', { persona: m.persona });
    throw e;
  }
  if (!kind.isDirectory()) return fail(c, 'internal', `${memory} isn’t a folder, so the daemon removed nothing from it. Remove it on the host.`, 'forget');
  await fsp.rm(`${memory}/${memoryFolderName(m.persona)}`, { recursive: true, force: true });
  d.log(`Removed the memory of a deleted agent (${memoryFolderName(m.persona)}).`);
  await send(c, 'forgotten', { persona: m.persona });
}
