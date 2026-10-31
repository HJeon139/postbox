// One store per data folder (#508’s storage design, “The data-folder lock”): load() takes an exclusive lock file there,
// naming the process holding it (its pid and start time) and a token only this store knows, so two stores can’t
// interleave their lines in one log, whatever started them. The command line claims a folder too (server/home.mjs,
// lockData, for bin/postbox.mjs), but a store opened by anything else (a tool, a test) bypasses that; this lock is the
// one that counts. A second store in the same process is refused too: the pid is alive, and it’s another writer.
//
// A lock is STALE when its process is gone, or when the pid is alive but started at another time (the number was
// reused). It’s taken over under a takeover mutex, a file made exclusively beside it that names its maker: the starter
// holding the mutex reads the lock again, moves it aside only if it is still the stale one it found (not a live lock
// another starter made meanwhile), and only then creates its own lock exclusively. So of two Postboxes that find the
// same lock stale, exactly one wins; the other waits for the mutex while its maker lives, then meets a live lock (gpt’s
// findings on 1a: a rename made on a stale observation could move the winner’s live lock, and a mutex removed for its
// age could belong to a paused, living maker). A mutex whose maker is gone is never removed by Postbox: the start
// refuses and names the file. close() releases a lock only when the file still carries this store’s token: a lock
// another store took over meanwhile is left alone.

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
 * Publishes a record as a file that never exists half-written: the bytes go to a file of their own first, which is then
 * linked under `path` (atomic, and EEXIST when something is there), so a reader finds the whole record or no file
 * (gpt’s finding on 1a: a file created first and filled after read as an empty, “dead” holder meanwhile).
 */
async function publish(io, path, record) {
  const draft = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.new`;
  await io.writeFile(draft, JSON.stringify(record), { mode: 0o600 });
  try {
    await io.link(draft, path);
  } finally {
    await io.rm(draft, { force: true });
  }
}

/**
 * What a lock file says: this store’s shape, or an older lock holding only a positive pid; null when the file is gone;
 * `ambiguous` when it holds anything else (empty, cut short, not a pid), which proves nothing about its maker.
 * @returns {Promise<{ pid: number, started: number | null, token?: string, ambiguous?: false } | { ambiguous: true } | null>}
 */
async function readLock(io, path) {
  const text = await io.readFile(path, 'utf8').catch(() => null); // gone between two steps: the next try finds out
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.pid) && parsed.pid > 0)
      return { pid: parsed.pid, started: parsed.started ?? null, token: parsed.token };
  } catch {
    // not JSON: a lock written as a bare pid, below
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 && /^\d+$/.test(text.trim()) ? { pid, started: null } : { ambiguous: true };
}

const AMBIGUOUS_TRIES = 20; // reads of a lock that says nothing readable, 10 ms apart, before the start refuses

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
  let unreadable = 0;
  for (let tries = 0; tries < 3 + AMBIGUOUS_TRIES; tries++) {
    try {
      await publish(io, path, mine);
      return { path, token: mine.token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = await readLock(io, path);
      if (!holder) continue;
      if (holder.ambiguous) {
        // Unreadable contents prove nothing: not a dead holder. Waited out briefly (a legacy writer mid-step), then refused.
        if (++unreadable >= AMBIGUOUS_TRIES)
          throw new Error(
            `The lock at ${path} is unreadable, so Postbox can’t tell whether another store holds ${dir}. If none is running on it, remove the file and start again.`,
          );
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      if (isAlive(holder.pid) && (await sameStart(holder, startOf)))
        throw new Error(
          `Another Postbox store (process ${holder.pid}) holds ${dir}. Stop it first, or use another data folder. If no Postbox is running on it, remove ${path} and start again.`,
        );
      await takeOver(io, path, holder, isAlive, startOf);
    }
  }
  throw new Error(`Couldn’t claim ${dir}: ${path} keeps coming back.`);
}

/** Whether the holder’s process is the one that wrote the lock: start times unknown on either side are taken as the same. */
async function sameStart(holder, startOf) {
  if (holder.started === null) return true;
  const now = await startOf(holder.pid);
  return now === null || now === holder.started;
}

const TAKEOVER_WAIT_MS = 5_000; // how long a starter waits for another’s takeover before it gives up

/**
 * Moves a stale lock aside, under the takeover mutex (the header): a file beside the lock, made exclusively, naming
 * its maker like the lock does. Only while the lock is still the one found stale. Returns once the lock is gone or was
 * found to be another starter’s live one; the caller’s next try tells which. A mutex whose maker is alive is waited
 * for, as long as it takes up to TAKEOVER_WAIT_MS: a paused maker is still a maker, and age proves nothing (gpt’s
 * finding on 1a). A mutex whose maker is gone is never removed here: the start refuses, naming the file, since nothing
 * can tell a dead maker’s leftovers from a live one’s mid-step without an atomic compare, and a wrong guess admits two
 * writers.
 * @param {typeof import('node:fs/promises')} io @param {string} path @param {{ pid: number, token?: string }} stale
 * @param {(pid: number) => boolean} isAlive @param {(pid: number) => Promise<number | null>} startOf
 */
async function takeOver(io, path, stale, isAlive, startOf) {
  const taking = `${path}.taking`;
  const me = { pid: process.pid, started: await startOf(process.pid), token: randomBytes(8).toString('hex') };
  const until = Date.now() + TAKEOVER_WAIT_MS;
  for (;;) {
    try {
      await publish(io, taking, me);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const maker = await readLock(io, taking);
      if (!maker) continue; // removed between the write and the read: try again
      if (maker.ambiguous)
        throw new Error(`The takeover file ${taking} is unreadable. If no Postbox is running on this data folder, remove it and start again.`);
      if (!(isAlive(maker.pid) && (await sameStart(maker, startOf))))
        throw new Error(
          `A Postbox start (process ${maker.pid}) stopped while taking over the lock on this data folder. If no Postbox is running on it, remove ${taking} and start again.`,
        );
      if (Date.now() > until)
        throw new Error(`Another Postbox start (process ${maker.pid}) is taking over ${path} and hasn’t finished. Wait for it, or stop it first.`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  try {
    const now = await readLock(io, path);
    const same = now && !now.ambiguous && now.pid === stale.pid && (stale.token ? sameToken(stale.token, now.token) : !now.token);
    if (same) {
      const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
      await io.rename(path, aside).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
      await io.rm(aside, { force: true });
    }
  } finally {
    const maker = await readLock(io, taking);
    if (maker && !maker.ambiguous && maker.token && sameToken(me.token, maker.token)) await io.rm(taking, { force: true }); // only this start’s
  }
}

/**
 * Releases a lock this store holds: the file goes only while it still carries this store’s token.
 * @param {typeof import('node:fs/promises')} io @param {Lock | null} lock
 */
export async function unlockStore(io, lock) {
  if (!lock) return;
  const holder = await readLock(io, lock.path);
  if (holder && !holder.ambiguous && holder.token && sameToken(lock.token, holder.token)) await io.rm(lock.path, { force: true });
}
