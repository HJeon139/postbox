// Moving a clone’s data/ into the person’s Postbox folder when clones’ telemetry folders are already there
// (designs/telemetry-persona.md, R11; server/home.mjs, moveData). Those folders are Postbox’s own, not the person’s
// files, so they don’t block the move, and they stay where they are. The data goes in beside them, entry by entry, from
// a staging folder on the same disk; this clone’s own telemetry then joins the moved telemetry/. Everything is checked
// before anything moves, every rename throws, and a failure puts back what had moved. Nothing is ever deleted to make
// room: a name that’s taken stops the move before it starts.

import { lstatSync, readdirSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const CLONE_ROOT = /^telemetry-clone-[0-9a-f]{12}$/;
const isDir = (p) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};
const entries = (p) => (isDir(p) ? readdirSync(p) : []);

/**
 * Puts back clones’ folders an earlier version of the move left set aside in <to>.clones, so a retry starts clean.
 * @param {string} to
 */
export async function restoreAside(to) {
  const aside = `${to}.clones`;
  if (!isDir(aside)) return;
  for (const n of await readdir(aside)) {
    if (entries(to).includes(n)) throw new Error(`${join(aside, n)} and ${join(to, n)} both exist. Look at both, keep one, and run this again.`);
    await mkdir(to, { recursive: true });
    await rename(join(aside, n), join(to, n));
  }
  await rmdir(aside);
}

/**
 * What the move would do, checked before anything moves: refuses a name that’s taken, a staging folder an earlier
 * move left, or a clone folder that isn’t a folder of conversations.
 * @param {{ from: string, to: string, own: string }} o  own: this clone’s telemetry folder
 * @returns {{ carry: string[] }}  the conversations this clone’s telemetry folder holds
 */
export function planCloneMove({ from, to, own }) {
  if (isDir(`${to}.incoming`)) throw new Error(`${to}.incoming is left from a move that stopped. Look at it, move it aside, and run this again.`);
  const taken = entries(to);
  const clash = entries(from).filter((n) => taken.includes(n));
  if (clash.length) throw new Error(`${to} and ${from} both have ${clash.join(', ')}, so Postbox won’t mix the two.`);
  if (!taken.includes(basename(own))) return { carry: [] };
  if (!isDir(own)) throw new Error(`${own} isn’t a folder. Move it aside, and run this again.`);
  const carry = entries(own);
  const odd = carry.filter((c) => !isDir(join(own, c)));
  if (odd.length) throw new Error(`${own} holds ${odd.join(', ')}, which aren’t conversations’ folders. Move them aside, and run this again.`);
  const into = entries(join(from, 'telemetry'));
  const both = carry.filter((c) => into.includes(c));
  if (both.length) throw new Error(`${own} and ${join(from, 'telemetry')} both hold ${both.join(', ')}. Keep one of each, and run this again.`);
  if (entries(from).includes('telemetry') && !isDir(join(from, 'telemetry'))) throw new Error(`${join(from, 'telemetry')} isn’t a folder.`);
  return { carry };
}

/**
 * Moves the data in beside the clones’ folders, and this clone’s telemetry into its telemetry/. On a failure, what had
 * moved goes back, and the error says what happened.
 * @param {{ from: string, to: string, own: string, carry: string[] }} o
 * @returns {Promise<{ leftover: string|null }>}  leftover: the original, when a copy from another disk couldn’t remove it
 */
export async function moveBesideClones({ from, to, own, carry }) {
  const staging = `${to}.incoming`;
  let copied = false;
  try {
    await rename(from, staging);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // Another disk: a copy beside the home folder; the original stays until the copy is all in place.
    await cp(from, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    copied = true;
  }
  /** @type {string[]} */
  const moved = [];
  try {
    for (const n of await readdir(staging)) {
      await rename(join(staging, n), join(to, n));
      moved.push(n);
    }
    await rmdir(staging);
  } catch (e) {
    for (const n of moved.reverse()) await rename(join(to, n), join(staging, n));
    if (copied) await rm(staging, { recursive: true, force: true });
    else await rename(staging, from);
    throw e;
  }
  /** @type {string|null} */
  let leftover = null;
  if (copied) {
    await rename(from, `${from}.moved`);
    await rm(`${from}.moved`, { recursive: true }).catch(() => {
      leftover = `${from}.moved`;
    });
  }
  await carryOwn({ to, own, carry });
  return { leftover };
}

/** This clone’s conversations into <to>/telemetry, each by a rename that throws; its folder goes only once empty. */
async function carryOwn({ to, own, carry }) {
  if (!carry.length && !isDir(own)) return;
  await mkdir(join(to, 'telemetry'), { recursive: true, mode: 0o700 });
  for (const c of carry) await rename(join(own, c), join(to, 'telemetry', c));
  await rmdir(own);
}
