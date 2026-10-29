// Where Postbox keeps the person’s own data (#90): conversations, attachments, agents’ workspaces and the media their
// apps show, in ~/.postbox. POSTBOX_HOME moves it, and --data still wins. A project’s own data stays in the project,
// under <project>/.postbox/ (#47).
//
// Before this, a clone kept everything in its data/ folder, inside the source tree. A clone that has conversations
// there keeps using it, and says so, until the person moves it with --move-data. Postbox never moves it unasked.
//
// Every clone, worktree and installed copy now shares one default folder, so a run claims it with a lock: a second
// Postbox on the same folder would append to the same log, and delete segments the first is still writing.

import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readdir, readlink, rename, rm, rmdir, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** The person’s Postbox folder: POSTBOX_HOME, else ~/.postbox. */
export const postboxHome = (env = process.env, home = homedir()) => (env.POSTBOX_HOME ? resolve(env.POSTBOX_HOME) : join(home, '.postbox'));

// The old store’s files, or the same renamed once imported into Redis (server/store-import.mjs).
const STORE_FILE = /^(store\.json|snapshot\.json|events-\d+\.jsonl)(\.migrated)?$/;
const LOCK = 'postbox.lock';

/**
 * Whether a folder, or the folder a link leads to, holds conversations: the store’s Redis data (its append-only files,
 * server/redis-supervisor.mjs), or the old store’s event log or snapshot, imported (*.migrated) or not. The import
 * renames the old files, so without the Redis data a clone’s data/ would stop counting once Postbox ran on it (review
 * finding 4 on #525).
 */
export function holdsStore(dir) {
  const list = (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };
  return list(dir).some((n) => STORE_FILE.test(n)) || list(join(dir, 'redis', 'data', 'appendonly')).length > 0;
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
  const there = await readdir(to).catch(() => null);
  if (there?.length)
    throw new Error(`${to} already has files in it, so Postbox won’t mix the two. Move them aside first, or keep using ${from} with --data ${from}.`);
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
  return { from, to, leftover };
}
