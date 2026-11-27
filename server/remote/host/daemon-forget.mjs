// Postbox’s `forget` (#491): a deleted persona’s memory on this host is removed, and Postbox hears `forgotten`. Claude
// Code keeps a persona’s auto memory in ~/.postbox-remote/memory/<persona> (setup.mjs’s memoryFolder,
// remote-turn.mjs’s hostMemoryRoot), and an Isolated Kiro persona keeps its memory in its own Kiro home,
// ~/.postbox-remote/kiro-home/<persona> (kiro-cli-remote.mjs’s kiroRemoteEnv, #1661). Nothing else is touched: the
// handler itself refuses any persona that isn’t already a folder name (empty, or with anything memoryFolderName would
// replace), so each recursive removal is always of one folder under memory/ or kiro-home/, never either folder itself,
// whatever the wire check let through; and each of those must be a real folder, not a link.

import { promises as fsp } from 'node:fs';
import { memoryFolderName } from '../../../shared/memory-folders.mjs';
import { REMOTE_LIMITS } from '../../../shared/remote-protocol.mjs';
import { fail, send } from './daemon-reply.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/**
 * @param {Daemon} d @param {Conn} c @param {{ persona: string }} m
 * A refusal names its persona (#1683), so Postbox settles nothing but that one and goes on reading the others.
 */
export async function forget(d, c, m) {
  if (typeof m?.persona !== 'string' || !m.persona || memoryFolderName(m.persona) !== m.persona)
    return fail(c, 'bad-message', 'forget.persona must be the id of a persona: letters, digits, _ and - only.', 'forget');
  const refuse = (/** @type {string} */ code, /** @type {string} */ text) => {
    d.log(`Couldn’t remove the memory of a deleted agent (${m.persona}): ${text}`);
    void send(c, 'error', { code, message: text.slice(0, REMOTE_LIMITS.messageChars), re: 'forget', persona: m.persona });
  };
  for (const parent of ['memory', 'kiro-home']) {
    const why = await removeFrom(`${d.p.root}/${parent}`, m.persona);
    if (why) return refuse('internal', why);
  }
  d.log(`Removed the memory of a deleted agent (${m.persona}).`);
  await send(c, 'forgotten', { persona: m.persona });
}

/**
 * Removes one persona’s folder from a parent under ~/.postbox-remote. A parent that isn’t there holds nothing of it;
 * one that isn’t a real folder is left alone. Returns why it couldn’t, or null.
 * @param {string} parent @param {string} persona  a folder name, as forget checked
 * @returns {Promise<string | null>}
 */
async function removeFrom(parent, persona) {
  let kind;
  try {
    kind = await fsp.lstat(parent);
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return null;
    return `The daemon couldn’t read ${parent}: ${/** @type {any} */ (e).message}.`;
  }
  if (!kind.isDirectory()) return `${parent} isn’t a folder, so the daemon removed nothing from it. Remove it on the host.`;
  try {
    await fsp.rm(`${parent}/${persona}`, { recursive: true, force: true });
  } catch (e) {
    return `The daemon couldn’t remove ${parent}/${persona}: ${/** @type {any} */ (e).message}.`;
  }
  return null;
}
