// One store per data folder (#508’s storage design, “The data-folder lock”): load() takes an exclusive lock file there,
// naming the process holding it (its pid and start time) and a token only this store knows, so two stores can’t
// interleave their lines in one log, whatever started them. The command line claims a folder too (server/home.mjs,
// lockData, for bin/postbox.mjs), but a store opened by anything else (a tool, a test) bypasses that; this lock is the
// one that counts. A second store in the same process is refused too: the pid is alive, and it’s another writer.
//
// A lock is STALE when its process is gone, or when the pid is alive but started at another time (the number was
// reused). It’s taken over under a takeover mutex, a folder made exclusively beside it: the starter holding the mutex
// reads the lock again, moves it aside only if it is still the stale one it found (not a live lock another starter made
// meanwhile), and only then creates its own lock exclusively. So of two Postboxes that find the same lock stale, exactly
// one wins; the other’s next try meets a live lock (gpt’s finding on 1a: a rename made on a stale observation could move
// the winner’s live lock). A mutex left by a starter that died is taken after TAKEOVER_MS. close() releases a lock only
// when the file still carries this store’s token: a lock another store took over meanwhile is left alone.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { sameToken } from './helpers.mjs';

export const LOCK = 'store.lock';

/** @typedef {{ alive?: (pid: number) => boolean, started?: (pid: number) => Promise<number | null> }} Probe */
/** @typedef {{ path: string, token: string }} Lock */

/** Whether a process is running: a signal of 0 checks without sending one, and EPERM means it’s there but not ours. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const OWN_START = Math.round(Date.now() - process.uptime() * 1000);

/**
 * When a process started, in a unit that only has to agree between the writer of a lock and its reader: on Linux the
 * start field of /proc/<pid>/stat (clock ticks since boot, fixed for the process’s life); elsewhere, known only for this
 * process (the clock, to the millisecond), and null for another, which then counts as live while its pid is.
 * @param {typeof import('node:fs/promises')} io @param {number} pid @returns {Promise<number | null>}
 */
async function started(io, pid) {
  if (process.platform === 'linux') {
    const stat = await io.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
    const after = stat ? stat.lastIndexOf(')') : -1; // the command name, in parentheses, may hold spaces
    const fields = !stat || after < 0 ? [] : stat.slice(after + 2).split(' ');
    return fields.length > 20 ? Number(fields[19]) : null;
  }
  return pid === process.pid ? OWN_START : null;
}

/**
 * What a lock file says: this store’s shape, or an older lock holding only the pid; null when the file is gone.
 * @returns {Promise<{ pid: number, started: number | null, token?: string } | null>}
 */
async function readLock(io, path) {
  const text = await io.readFile(path, 'utf8').catch(() => null); // gone between two steps: the next try finds out
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return { pid: Number(parsed.pid), started: parsed.started ?? null, token: parsed.token };
  } catch {
    // not JSON: a lock written as a bare pid, below
  }
  return { pid: Number(text), started: null };
}

/**
 * Takes the folder’s lock for this process, or rejects naming the folder and the pid holding it.
 * @param {typeof import('node:fs/promises')} io @param {string} dir @param {Probe} [probe]  stands in for the process table
 * @returns {Promise<Lock>} what unlockStore takes
 */
export async function lockStore(io, dir, probe = {}) {
  const isAlive = probe.alive ?? alive;
  const startOf = probe.started ?? ((pid) => started(io, pid));
  const path = join(dir, LOCK);
  const mine = { pid: process.pid, started: await startOf(process.pid), token: randomBytes(8).toString('hex') };
  for (let tries = 0; tries < 3; tries++) {
    try {
      await io.writeFile(path, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
      return { path, token: mine.token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = await readLock(io, path);
      if (!holder) continue;
      if (isAlive(holder.pid) && (await sameStart(holder, startOf)))
        throw new Error(`Another Postbox store (process ${holder.pid}) holds ${dir}. Stop it first, or use another data folder.`);
      await takeOver(io, path, holder);
    }
  }
  throw new Error(`Couldn’t claim ${dir}: ${path} keeps coming back.`);
}

const TAKEOVER_MS = 10_000; // a takeover mutex older than this was left by a starter that died mid-way

/** Whether the holder’s process is the one that wrote the lock: start times unknown on either side are taken as the same. */
async function sameStart(holder, startOf) {
  if (holder.started === null) return true;
  const now = await startOf(holder.pid);
  return now === null || now === holder.started;
}

/**
 * Moves a stale lock aside, under the takeover mutex (the header): only while the lock is still the one found stale.
 * Returns once the lock is gone or was found to be another starter’s live one; the caller’s next try tells which.
 * @param {typeof import('node:fs/promises')} io @param {string} path @param {{ pid: number, token?: string }} stale
 */
async function takeOver(io, path, stale) {
  const taking = `${path}.taking`;
  for (let tries = 0; tries < 200; tries++) {
    try {
      await io.mkdir(taking);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const left = await io.stat(taking).catch(() => null);
      if (left && Date.now() - left.mtimeMs > TAKEOVER_MS) {
        // Its maker died mid-takeover. Moved aside under a unique name before it goes, so of two starters that find it
        // stale only one removes it; the other’s rename finds nothing, and it waits for the mutex the first makes next.
        const gone = `${taking}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
        await io.rename(taking, gone).then(
          () => io.rm(gone, { recursive: true, force: true }),
          () => {},
        );
      } else await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    try {
      const now = await readLock(io, path);
      const same = now && now.pid === stale.pid && (stale.token ? sameToken(stale.token, now.token) : !now.token);
      if (same) {
        const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
        await io.rename(path, aside).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
        await io.rm(aside, { force: true });
      }
    } finally {
      await io.rm(taking, { recursive: true, force: true });
    }
    return;
  }
  throw new Error(`Couldn’t take over the stale lock at ${path}: another start keeps ${taking}.`);
}

/**
 * Releases a lock this store holds: the file goes only while it still carries this store’s token.
 * @param {typeof import('node:fs/promises')} io @param {Lock | null} lock
 */
export async function unlockStore(io, lock) {
  if (!lock) return;
  const holder = await readLock(io, lock.path);
  if (holder?.token && sameToken(lock.token, holder.token)) await io.rm(lock.path, { force: true });
}
