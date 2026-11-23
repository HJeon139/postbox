// Postbox’s `forget` (#491): a deleted persona’s memory folder on this host, ~/.postbox-remote/memory/<persona>, is
// removed, and Postbox hears `forgotten`. Claude Code keeps a persona’s auto memory there on a host (setup.mjs’s
// memoryFolder, remote-turn.mjs’s hostMemoryRoot). Nothing else is touched: the handler itself refuses any persona
// that isn’t already a folder name (empty, or with anything memoryFolderName would replace), so the recursive removal
// is always of one folder under memory/, never memory/ itself, whatever the wire check let through; and memory/
// must be a real folder, not a link.

import { promises as fsp } from 'node:fs';
import { memoryFolderName } from '../../../shared/memory-folders.mjs';
import { fail, send } from './daemon-reply.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/** @param {Daemon} d @param {Conn} c @param {{ persona: string }} m */
export async function forget(d, c, m) {
  if (typeof m?.persona !== 'string' || !m.persona || memoryFolderName(m.persona) !== m.persona)
    return fail(c, 'bad-message', 'forget.persona must be the id of a persona: letters, digits, _ and - only.', 'forget');
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
  await fsp.rm(`${memory}/${m.persona}`, { recursive: true, force: true });
  d.log(`Removed the memory of a deleted agent (${m.persona}).`);
  await send(c, 'forgotten', { persona: m.persona });
}
