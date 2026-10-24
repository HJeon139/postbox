// Where Postbox keeps the person’s own data (#90): conversations, attachments, agents’ workspaces and the media their
// apps show, in ~/.postbox. POSTBOX_HOME moves it, and --data still wins. A project’s own data stays in the project,
// under <project>/.postbox/ (#47).
//
// Before this, a clone kept everything in its data/ folder, inside the source tree. A clone that has conversations
// there keeps using it, and says so, until the person moves it with --move-data. Postbox never moves it unasked.
//
// Every clone, worktree and installed copy now shares one default folder, so a run claims it with a lock: a second
// Postbox on the same folder would append to the same log, and delete segments the first is still writing.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readdir, readlink, rename, rm, rmdir, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** The person’s Postbox folder: POSTBOX_HOME, else ~/.postbox. */
export const postboxHome = (env = process.env, home = homedir()) => (env.POSTBOX_HOME ? resolve(env.POSTBOX_HOME) : join(home, '.postbox'));

const STORE_FILE = /^(store\.json|snapshot\.json|events-\d+\.jsonl)$/;
const LOCK = 'postbox.lock';

/**
 * Where a clone’s telemetry lives (designs/telemetry-persona.md, R11): a folder of its own in the person’s Postbox
 * folder, keyed by the clone’s data folder as the file system finds it (through links, case-folded where names are),
 * never the clone’s data/, which is often inside the folder its agents work in.
 */
export function cloneTelemetry(dataDir, home = postboxHome()) {
  let p = resolve(dataDir);
  try {
    p = realpathSync(p);
  } catch {}
  if (['darwin', 'win32'].includes(process.platform)) p = p.toLowerCase();
  return join(home, `telemetry-clone-${createHash('sha256').update(p).digest('hex').slice(0, 12)}`);
}
const CLONE_ROOT = /^telemetry-clone-[0-9a-f]{12}$/;

/** After a move: this clone’s telemetry joins <to>/telemetry, conversation by conversation; the others go back. */
async function carryClones(aside, to, own) {
  for (const n of await readdir(aside)) {
    if (n !== basename(own)) {
      await rename(join(aside, n), join(to, n));
      continue;
    }
    await mkdir(join(to, 'telemetry'), { recursive: true, mode: 0o700 });
    for (const conv of await readdir(join(aside, n))) await rename(join(aside, n, conv), join(to, 'telemetry', conv)).catch(() => {});
    await rm(join(aside, n), { recursive: true, force: true });
  }
  await rmdir(aside).catch(() => {});
}

/** Whether a folder, or the folder a link leads to, holds conversations: an event log or a snapshot. */
export function holdsStore(dir) {
  try {
    return readdirSync(dir).some((n) => STORE_FILE.test(n));
  } catch {
    return false;
  }
}

/** Whether two paths lead to the same folder, through links. */
function sameFolder(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The data folder a run uses, and why: --data, else POSTBOX_HOME when it’s set, else a clone’s data/ that holds
 * conversations, else ~/.postbox. A data/ that leads to the person’s Postbox folder (the link --move-data leaves) is
 * that folder.
 * @param {{ data?: string, root: string, env?: NodeJS.ProcessEnv, home?: string }} opts  data: --data; root: the clone or installed package
 * @returns {{ dataDir: string, from: 'flag'|'clone'|'home', home: string }}  home: the person’s Postbox folder
 */
export function dataFolder({ data, root, env = process.env, home = homedir() }) {
  const own = postboxHome(env, home);
  if (data) return { dataDir: resolve(data), from: 'flag', home: own };
  const clone = join(root, 'data');
  if (!env.POSTBOX_HOME && holdsStore(clone) && !sameFolder(clone, own)) return { dataDir: clone, from: 'clone', home: own };
  return { dataDir: own, from: 'home', home: own };
}

/** Whether a process is running. EPERM means it is, as someone else. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Claims a data folder for this process, or throws when another running Postbox holds it. A lock left by a run that
 * died is taken over.
 * @param {string} dataDir
 * @returns {() => void}  releases it
 */
export function lockData(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, LOCK);
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return () => rmSync(lock, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const other = Number(readFileSync(lock, 'utf8'));
      if (alive(other) && other !== process.pid)
        throw new Error(`Another Postbox (process ${other}) is using ${dataDir}. Stop it first, or start this one with --data <another folder>.`);
      rmSync(lock, { force: true });
    }
  }
  throw new Error(`Couldn’t claim ${dataDir}: ${lock} keeps coming back.`);
}

/**
 * Moves a clone’s data/ to the person’s Postbox folder, when they ask (--move-data). A link is left in its place:
 * conversations recorded some folders by their full path (the demo’s project), and those still lead to the same
 * files. Refuses while a Postbox runs on it, when the Postbox folder already has files (rather than mixing two
 * stores), and when either is a link or inside the other.
 * @param {{ root: string, env?: NodeJS.ProcessEnv, home?: string }} opts
 * @returns {Promise<{ from: string, to: string, leftover: string|null }>}  leftover: the original, when the copy to
 *   another disk couldn’t remove it
 */
export async function moveData({ root, env = process.env, home = homedir() }) {
  const from = join(root, 'data');
  const to = postboxHome(env, home);
  if (sameFolder(from, to)) throw new Error(`${from} already leads to ${to}, so there’s nothing to move.`);
  const link = await readlink(from).catch(() => null);
  if (link) throw new Error(`${from} is a link to ${link}, so Postbox won’t move it. Move that folder yourself, or keep using it with --data.`);
  if (!holdsStore(from)) throw new Error(`There’s nothing to move: ${from} holds no conversations.`);
  const inside = (a, b) => {
    const r = relative(b, a);
    return r !== '' && !r.startsWith('..') && !isAbsolute(r);
  };
  if (inside(to, from) || inside(from, to)) throw new Error(`${to} and ${from} are inside one another, so Postbox can’t move one into the other.`);
  if (await readlink(to).catch(() => null)) throw new Error(`${to} is a link. Set POSTBOX_HOME to the folder it leads to, and run this again.`);
  const all = await readdir(to).catch(() => null);
  // Clones’ telemetry folders are Postbox’s own, not the person’s files: set aside for the move, then this clone’s
  // recordings join the moved data’s telemetry/, and every other clone’s goes back.
  const clones = (all ?? []).filter((n) => CLONE_ROOT.test(n));
  const there = all?.filter((n) => !CLONE_ROOT.test(n));
  if (there?.length)
    throw new Error(`${to} already has files in it, so Postbox won’t mix the two. Move them aside first, or keep using ${from} with --data ${from}.`);
  const aside = `${to}.clones`;
  // Named before the move, while data/ is still itself: after it, data/ is a link to the new folder.
  const own = cloneTelemetry(from, to);
  if (clones.length) await mkdir(aside, { recursive: true });
  for (const n of clones) await rename(join(to, n), join(aside, n));
  const release = lockData(from);
  /** @type {string|null} */
  let leftover = null;
  try {
    if (there) await rmdir(to);
    await mkdir(dirname(to), { recursive: true });
    try {
      await rename(from, to);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      // The home folder is on another disk. The copy goes beside it and is renamed into place once whole, so a copy cut
      // short never looks like a store; the original is set aside only after that, and removed last.
      const partial = `${to}.partial`;
      await rm(partial, { recursive: true, force: true });
      await cp(from, partial, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      await rename(partial, to);
      const old = `${from}.moved`;
      await rename(from, old);
      await rm(old, { recursive: true }).catch(() => {
        leftover = old;
      });
    }
  } catch (e) {
    release();
    throw e;
  }
  // The lock moved with the folder.
  rmSync(join(to, LOCK), { force: true });
  await symlink(to, from);
  if (clones.length) await carryClones(aside, to, own);
  return { from, to, leftover };
}
