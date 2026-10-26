// The start lock and daemon.pid (daemon.mjs’s header, steps 2 and 3, #120): the folder an attach or install holds
// while it starts a daemon or replaces a version’s folder, the file a daemon holds for its life, and the break locks
// that let one stale lock be removed at a time.

import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DIR_MODE, FILE_MODE } from '../../../shared/remote-protocol.mjs';
import { BREAK_STALE_MS, EXIT, LOCK_STALE_MS, PID_BREAK_STALE_MS } from './daemon-constants.mjs';
import { LOCK_OWNER, lockOwnerLive, parseLockOwner } from './proc.mjs';

/**
 * @typedef {{ bootId: () => string | null, startTime: (pid: number) => number | null, sameProcess: (r: any) => boolean, paused?: () => void }} LockProc
 *   proc.mjs’s, for the start lock’s and daemon.pid’s owner records. paused, tests only: called while a breaker holds
 *   its break lock, between finding the lock stale and removing it, as a suspended process would be.
 */

/**
 * This process’s start lock owner record (proc.mjs, “The start lock’s owner”): its PID, boot ID and start time, or its
 * PID alone where those can’t be read, as the install script writes it without /proc.
 * @param {LockProc} proc
 */
export function ownerRecord(proc) {
  const [bootId, startTime] = [proc.bootId(), proc.startTime(process.pid)];
  return JSON.stringify(bootId === null || startTime === null ? { pid: process.pid } : { pid: process.pid, bootId, startTime });
}

/**
 * Takes the start lock, a folder in ~/.postbox-remote/locks, with `me` as its owner record: true if it’s taken. One
 * that’s held is broken if it’s stale (lockStale), and taken at once; one that isn’t is waited for (the caller tries
 * again), whether an attach or an install (install.mjs) holds it.
 * @param {string} lock @param {string} me @param {() => number} now @param {LockProc} proc
 */
export function takeLock(lock, me, now, proc) {
  mkdirSync(dirname(lock), { recursive: true, mode: DIR_MODE });
  for (let tries = 0; tries < 2; tries++) {
    try {
      mkdirSync(lock, { mode: DIR_MODE });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockStale(lock, now, proc) && breakLock(lock, me, now, proc)) continue;
      return false;
    }
    // Written beside it and renamed in, so a reader never sees half a record.
    const tmp = `${lock}/.${LOCK_OWNER}.${process.pid}`;
    try {
      writeFileSync(tmp, me, { mode: FILE_MODE });
      renameSync(tmp, `${lock}/${LOCK_OWNER}`);
    } catch (e) {
      rmSync(lock, { recursive: true, force: true });
      throw e;
    }
    return true;
  }
  return false;
}

/**
 * Whether a held start lock (or break lock) is stale: its owner is gone, or it has had no owner record for `grace`
 * (LOCK_STALE_MS for a start lock). False if it’s gone meanwhile.
 * @param {string} lock @param {() => number} now @param {LockProc} proc @param {number} [grace]
 */
function lockStale(lock, now, proc, grace = LOCK_STALE_MS) {
  let text;
  try {
    text = readFileSync(`${lock}/${LOCK_OWNER}`, 'utf8');
  } catch {
    try {
      return now() - statSync(lock).mtimeMs > grace;
    } catch {
      return false;
    }
  }
  return !(/** @type {boolean} */ (lockOwnerLive(parseLockOwner(text), { sameProcess: proc.sameProcess })));
}

/**
 * Removes a stale start lock under `<lock>.break` (holdBreak), judging it once more there: of two attaches (or an
 * install) that both found it stale, the second then finds the fresh lock the first made, and leaves it. True if it
 * removed the lock.
 * @param {string} lock @param {string} me @param {() => number} now @param {LockProc} proc
 */
function breakLock(lock, me, now, proc) {
  const brk = `${lock}.break`;
  try {
    if (!holdBreak(brk, me, now, proc, BREAK_STALE_MS)) return false;
  } catch {
    return false;
  }
  try {
    if (!lockStale(lock, now, proc)) return false;
    proc.paused?.();
    const aside = `${lock}.stale.${process.pid}`;
    rmSync(aside, { recursive: true, force: true });
    renameSync(lock, aside);
    rmSync(aside, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    dropLock(brk, me);
  }
}

/**
 * Takes a break lock (`<start lock>.break`, daemon.pid.break), held for one stale lock’s removal: a folder holding
 * its owner record, `me`, as the start lock does. It’s made whole beside its name, with the record in it, and renamed
 * in, which fails while one is there, so it’s never seen without a record. One that’s held is broken only if it’s
 * stale (lockStale, with `grace` for one with no record): its breaker died, or its record is garbled. Its age alone
 * never breaks it, so a breaker suspended between its check and its removal keeps it, and nobody else removes a lock
 * meanwhile. Broken one way only: renamed aside, judged once more there, and put back if it’s live after all (one
 * just taken by another that found the same stale one), so two that both found it stale can’t remove a live one.
 * True if it’s taken; throws if it can’t be made at all.
 * @param {string} brk @param {string} me @param {() => number} now @param {LockProc} proc @param {number} grace
 */
function holdBreak(brk, me, now, proc, grace) {
  const take = () => {
    const tmp = `${brk}.new.${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    try {
      mkdirSync(tmp, { mode: DIR_MODE });
      writeFileSync(`${tmp}/${LOCK_OWNER}`, me, { mode: FILE_MODE });
      renameSync(tmp, brk);
      return true;
    } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'ENOTEMPTY') return false;
      throw e;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
  if (take()) return true;
  if (!lockStale(brk, now, proc, grace)) return false;
  const aside = `${brk}.gone.${process.pid}`;
  rmSync(aside, { recursive: true, force: true });
  try {
    renameSync(brk, aside);
  } catch {
    return false;
  }
  if (!lockStale(aside, now, proc, grace)) {
    try {
      renameSync(aside, brk);
    } catch {}
  }
  rmSync(aside, { recursive: true, force: true });
  return take();
}

/**
 * Drops the start lock (or a break lock), only while its owner record is still `me`: one broken and taken by another
 * (say, after this process was suspended past a check) is theirs, and stays. Renamed aside first, so it’s never seen
 * without a record.
 * @param {string} lock @param {string} me
 */
export function dropLock(lock, me) {
  try {
    if (readFileSync(`${lock}/${LOCK_OWNER}`, 'utf8') !== me) return;
    const aside = `${lock}.free.${process.pid}`;
    rmSync(aside, { recursive: true, force: true });
    renameSync(lock, aside);
    rmSync(aside, { recursive: true, force: true });
  } catch {}
}

/**
 * Takes daemon.pid for this process’s life (the header, step 3): `held` with a release that removes it only while
 * it’s still ours, or why not and the exit code.
 * @param {string} dir @param {LockProc} proc
 * @returns {{ held: true, release: () => void } | { held: false, why: string, code: number }}
 */
export function takeDaemonLock(dir, proc) {
  const file = `${dir}/daemon.pid`;
  const me = { pid: process.pid, bootId: proc.bootId(), startTime: proc.startTime(process.pid) };
  if (me.bootId === null || me.startTime === null)
    return { held: false, why: 'Couldn’t read this process’s boot ID and start time, so the daemon can’t take its lock; exiting.', code: EXIT.software };
  const text = JSON.stringify(me);
  // Written whole beside it, then linked into place, which fails if daemon.pid is there: another serve never reads
  // a half-written one.
  const tmp = `${file}.${process.pid}.${++lockTries}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: FILE_MODE });
  } catch (e) {
    return { held: false, why: `Couldn’t write ${tmp}: ${e.message}`, code: EXIT.software };
  }
  let busy = false;
  try {
    for (let tries = 0; tries < 20; tries++) {
      const r = tryDaemonLock(file, tmp, text, proc);
      if (r === 'busy') busy = true;
      else if (r === 'broken') busy = false;
      else if (r !== 'again') return r;
    }
    return {
      held: false,
      why: busy ? `Couldn’t take ${file}: another serve held ${file}.break throughout; exiting.` : `Couldn’t take ${file}: it kept changing; exiting.`,
      code: EXIT.unavailable,
    };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/**
 * @typedef {{ held: true, release: () => void } | { held: false, why: string, code: number }} DaemonLock
 */

/**
 * One try at daemon.pid: linked into place, or held by a live daemon, or stale and removed (breakDaemonLock). The lock
 * or why not, else what to do next: `again`, or `busy` and `broken` from breakDaemonLock.
 * @param {string} file @param {string} tmp @param {string} text @param {LockProc} proc
 * @returns {DaemonLock | 'again' | 'busy' | 'broken'}
 */
function tryDaemonLock(file, tmp, text, proc) {
  try {
    linkSync(tmp, file);
    let released = false;
    return {
      held: true,
      release() {
        if (released) return;
        released = true;
        try {
          if (readFileSync(file, 'utf8') === text) unlinkSync(file);
        } catch {}
      },
    };
  } catch (e) {
    if (e.code !== 'EEXIST') return { held: false, why: `Couldn’t make ${file}: ${e.message}`, code: EXIT.software };
  }
  const seen = readLockRecord(file);
  if (seen === null) return 'again';
  if (proc.sameProcess(seen.record)) return { held: false, why: `Daemon ${seen.record.pid} already serves this version; exiting.`, code: EXIT.ok };
  return breakDaemonLock(file, text, seen, proc);
}

/**
 * Removes a stale daemon.pid under daemon.pid.break, held with this serve’s record as the start lock’s break lock is
 * (holdBreak), and only if it’s still the one just read, so a serve that found it stale a moment before another
 * replaced it can’t remove the new one. `busy` while another serve is removing it, `broken` once this one has had its
 * turn, or why it can’t.
 * @param {string} file @param {string} text @param {{ text: string }} seen @param {LockProc} proc
 * @returns {DaemonLock | 'busy' | 'broken'}
 */
function breakDaemonLock(file, text, seen, proc) {
  const brk = `${file}.break`;
  try {
    if (!holdBreak(brk, text, Date.now, proc, PID_BREAK_STALE_MS)) {
      // Another serve is removing it; that takes a moment.
      pause(10);
      return 'busy';
    }
  } catch (e) {
    return { held: false, why: `Couldn’t make ${brk}: ${e.message}`, code: EXIT.software };
  }
  try {
    if (readLockRecord(file)?.text === seen.text) {
      proc.paused?.();
      unlinkSync(file);
    }
  } catch {
  } finally {
    dropLock(brk, text);
  }
  return 'broken';
}
/** Counts takeDaemonLock’s calls, so each one’s temporary file is its own. */
let lockTries = 0;
/** Waits without returning to the event loop, as long as one stale lock’s removal takes. @param {number} ms */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * daemon.pid’s text and record, or null if it’s missing. Text that isn’t a record reads as a dead process’s, so it’s
 * stale (daemon.pid is linked into place whole, so it isn’t one being written).
 * @param {string} file @returns {{ text: string, record: { pid: number, bootId: string, startTime: number } } | null}
 */
function readLockRecord(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const r = JSON.parse(text);
    if (r && Number.isSafeInteger(r.pid) && typeof r.bootId === 'string' && Number.isSafeInteger(r.startTime)) return { text, record: r };
  } catch {}
  return { text, record: { pid: 0, bootId: '', startTime: -1 } };
}
