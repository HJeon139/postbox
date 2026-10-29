// Who owns a data folder’s Redis, and what a start does with one already running (#508’s requirements, SR-6; design,
// “Store security”, “Ownership and leftovers”). Each start records its owner in <data>/redis/owner.json (0600): the
// Postbox process’s pid, and the password of the owner user, which may only PING and SHUTDOWN. The next start reads it:
//
// - nothing answers on the socket: there’s no leftover, and the start goes on;
// - the recorded Postbox is this process: its own earlier child, which it shuts down as its owner;
// - the recorded Postbox is another live process: that Postbox’s Redis, or a pid reused since; either way it’s left
//   alone and the start refuses, naming the process;
// - the recorded Postbox is gone: a leftover from a crash, shut down as its owner, waiting a bounded time for it to go;
// - anything else (no record, or the socket answers but not to the owner’s password): ambiguous, refused.
//
// Postbox never signals a pid it didn’t start: a leftover goes only by SHUTDOWN from someone who knows its owner’s
// password, which only a process that can read the data folder has.
//
// That check alone races: two Postboxes starting at once could both find nothing on the socket, then both write the
// config and start a Redis on the same append-only files (review finding SR-6 on #525). So a start first claims the
// data folder’s Redis (claimRedis), and holds the claim from before that check until its supervisor stops.

import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RedisClient } from './redis-client.mjs';
import { bootId, startTime } from './remote/host/proc.mjs';

/** How long each probe of a leftover may take, and how long it gets to exit. */
const PROBE_MS = 2000;
const EXIT_MS = 5000;

/** fn, or null once ms pass. @template T @param {Promise<T>} p @param {number} ms @returns {Promise<T | null>} */
const within = (p, ms) => {
  let t;
  return Promise.race([p.finally(() => clearTimeout(t)), new Promise((ok) => (t = setTimeout(() => ok(null), ms)))]);
};

/** Whether a process is alive. @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // someone else’s process: alive
  }
}

/** Whether something accepts a connection on the socket. @param {string} path */
async function answers(path) {
  const c = await within(
    new RedisClient({ path }).connect().catch(() => null),
    PROBE_MS,
  );
  c?.close();
  return !!c;
}

/**
 * Clears the way for a start: shuts down this data folder’s leftover Redis when it’s safely its own, and resolves
 * with null; or resolves with why it can’t tell, or another live Postbox owns it, for the start to refuse.
 * @param {{ dataDir: string, socket: string }} o
 * @returns {Promise<string | null>}
 */
export async function clearLeftover({ dataDir, socket }) {
  if (!(await answers(socket))) return null;
  const owner = await readFile(join(dataDir, 'redis', 'owner.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  const pid = Number(owner?.pid);
  if (!owner || !Number.isInteger(pid) || pid <= 0 || typeof owner.secret !== 'string')
    return 'Something already answers on its socket, and Postbox can’t tell whose it is. Stop any other Postbox using this data folder, then Retry.';
  if (pid !== process.pid && alive(pid))
    return `Another Postbox (process ${pid}) runs it, or did and that process number is in use again. Stop that process if it’s a Postbox using this data folder, then Retry.`;
  const c = await within(
    new RedisClient({ path: socket, user: 'owner', password: owner.secret }).connect().catch(() => null),
    PROBE_MS,
  );
  if (!c) return 'Something answers on its socket, but not as this data folder’s Redis. Stop any other Postbox using this data folder, then Retry.';
  await within(
    c.call('SHUTDOWN').catch(() => {}),
    PROBE_MS,
  ); // the connection closes as it exits
  c.close();
  for (const end = Date.now() + EXIT_MS; Date.now() < end; ) {
    if (!(await answers(socket))) return null;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return `The Redis an earlier Postbox left running didn’t stop within ${EXIT_MS / 1000} s of being asked. Stop it, then Retry.`;
}

// Claims: <data>/redis/claims/<pid>-<random>, one file per supervisor that wants the data folder’s Redis, holding its
// pid and, where the system gives them, its boot ID and start time. Each is written whole beside its name and linked
// into place, so nobody reads half of one. A claim takes effect only once its writer has listed the folder and found no
// other live claim: of two starts, whichever lists second sees the first’s claim, which was made before the first
// listed, so they can’t both go on. When both see each other, both take theirs back and try again after a random wait;
// one that still finds another after that refuses. Nothing is ever removed but a claim of one’s own, or one whose
// process is gone (a crashed Postbox’s): a dead process’s claim never comes back to life, so removing it can’t race.
// No lock file is replaced, so there’s no stale-lock takeover to get wrong (server/home.mjs’s lockData has that
// window, and the store is reached without it: tests, scripts and any embedding call the supervisor directly).

const CLAIM_TRIES = 8;
/** Claims this process holds, by name: another supervisor here on the same folder is live too. */
const mine = new Set();
/** This process’s boot ID and start time, read once. @type {{ bootId: string | null, startTime: number | null } | undefined} */
let self;

/** Whether a claim’s process still runs: its pid is alive and, where both were read, its boot and start time match. */
function claimLive(r) {
  const pid = Number(r?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return false;
  if (typeof r.startTime === 'number') {
    const st = startTime(pid);
    if (st !== null && st !== r.startTime) return false; // the pid is in use again, by another process
  }
  if (typeof r.bootId === 'string') {
    const b = bootId();
    if (b !== null && b !== r.bootId) return false;
  }
  return true;
}

/**
 * The pids of the live claims in a claims folder other than `name`; claims of processes that are gone are removed.
 * @param {string} dir @param {string} name
 */
function liveClaims(dir, name) {
  /** @type {number[]} */
  const live = [];
  for (const n of readdirSync(dir)) {
    if (n === name || n.startsWith('.')) continue;
    /** @type {any} */
    let r = null;
    try {
      r = JSON.parse(readFileSync(join(dir, n), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') continue;
    }
    if (Number(r?.pid) === process.pid ? mine.has(n) : claimLive(r)) live.push(Number(r.pid));
    else
      try {
        unlinkSync(join(dir, n));
      } catch {}
  }
  return live;
}

/**
 * Claims a data folder’s Redis for this supervisor: resolves with a release once no other live process claims it, or
 * with why not, for the start to refuse as owned.
 * @param {string} dataDir
 * @returns {Promise<{ release: () => void, why?: undefined } | { why: string, release?: undefined }>}
 */
export async function claimRedis(dataDir) {
  const dir = join(dataDir, 'redis', 'claims');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  self ??= { bootId: bootId(), startTime: startTime(process.pid) };
  const name = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const path = join(dir, name);
  const tmp = join(dir, `.${name}`);
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, ...self }), { mode: 0o600, flag: 'wx' });
  /** @type {number[]} */
  let others = [];
  let held = false;
  try {
    for (let t = 0; t < CLAIM_TRIES; t++) {
      if (t) await new Promise((ok) => setTimeout(ok, 20 + Math.random() * 100));
      linkSync(tmp, path);
      mine.add(name);
      others = liveClaims(dir, name);
      if (!others.length) {
        held = true;
        let released = false;
        return {
          release() {
            if (released) return;
            released = true;
            mine.delete(name);
            try {
              unlinkSync(path);
            } catch {}
          },
        };
      }
      mine.delete(name);
      unlinkSync(path);
    }
  } finally {
    // A claim that didn’t take, through an error too, never stays behind.
    if (!held && mine.delete(name))
      try {
        unlinkSync(path);
      } catch {}
    try {
      unlinkSync(tmp);
    } catch {}
  }
  const pid = others[0];
  return {
    why:
      pid === process.pid
        ? 'This Postbox already runs it, from another part of this process. Stop that first, then Retry.'
        : `Another Postbox (process ${pid}) runs it, or is starting it. Stop that process if it’s a Postbox using this data folder, then Retry.`,
  };
}
