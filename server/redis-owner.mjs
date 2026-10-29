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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RedisClient } from './redis-client.mjs';

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
