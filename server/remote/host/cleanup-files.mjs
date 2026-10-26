// What cleanup.mjs’s steps share (#120): the cleanup’s state, its queue, the turn files it keeps, and the file
// operations it does them with. Nothing here follows a link (cleanup.mjs’s header).

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { FILE_MODE, TURN_FILES } from '../../../shared/remote-protocol.mjs';

/** Where a turn’s ack is kept: Postbox’s `ack.upTo`, as decimal text. */
export const ACK_FILE = '.ack';
/** Where a turn’s agent file is recorded: { path, sha256 } of what the daemon wrote. */
export const AGENT_RECORD = '.agent-file.json';
/** A folder with no runner.json yet, younger than this, may be a turn the daemon is starting. */
export const START_GRACE_MS = 60_000;

/** A turn folder’s files that stay once the turn has ended, until the folder goes. */
export const KEEP = new Set([
  TURN_FILES.out,
  TURN_FILES.in,
  TURN_FILES.err,
  TURN_FILES.exit,
  TURN_FILES.runner,
  TURN_FILES.start,
  TURN_FILES.prompts,
  TURN_FILES.tools,
  ACK_FILE,
  AGENT_RECORD,
]);
export const LOGS = [TURN_FILES.out, TURN_FILES.in, TURN_FILES.err];
/** An installed version’s folder name (paths.mjs’s rule). */
export const INSTALLED = /^\d+\.\d+\.\d+$/;

/** @typedef {'running' | 'starting' | 'ended' | 'interrupted'} TurnState */
/**
 * What a sweep did, for the log and the tests.
 * @typedef {{ folders: string[], logs: string[], capped: string[], emptied: string[], retired: string[], skipped: string[] }} Swept
 */
/**
 * One daemon’s cleanup: createCleanup’s options, and its state. capped: turns stopped at the cap, so each is stopped
 * once. linked: turn folders already said to be links, so the log says it once. queue: the steps, one at a time.
 * @typedef {{ home: string, version: string, p: ReturnType<typeof import('../../../shared/remote-protocol.mjs').hostPaths>,
 *   now: () => number, log: (line: string) => void, settings: () => { logRetention: number, logMaxBytes: number },
 *   sameProcess: (r: { pid: number, bootId: string, startTime: number }) => boolean | Promise<boolean>,
 *   stopTurn: (turn: string) => Promise<unknown>, onCap: (turn: string, text: string) => void,
 *   ids: number, capped: Set<string>, linked: Set<string>, queue: Promise<unknown> }} Cleanup
 */

/** @returns {Swept} */
export const emptySwept = () => ({ folders: [], logs: [], capped: [], emptied: [], retired: [], skipped: [] });

export const sha256 = (/** @type {string | Buffer} */ v) => createHash('sha256').update(v).digest('hex');

/** Runs one step after the others. @template T @param {Cleanup} cl @param {() => Promise<T>} fn @returns {Promise<T>} */
export function serial(cl, fn) {
  const next = cl.queue.then(fn, fn);
  cl.queue = next.catch(() => {});
  return next;
}

export const lstat = (/** @type {string} */ path) => fsp.lstat(path).catch(() => null);
export const sizeOf = async (/** @type {string} */ path) => (await lstat(path))?.size ?? 0;
export const readJson = async (/** @type {string} */ path) => {
  try {
    return JSON.parse(await fsp.readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
};
/** Unlinks a file; one that’s already gone is fine. @param {Cleanup} cl @param {string} path */
export const unlink = (cl, path) =>
  fsp.unlink(path).catch((e) => {
    if (e.code !== 'ENOENT') cl.log(`Couldn’t delete ${path}: ${e.message}`);
  });
/** @param {Cleanup} cl @param {string} path @param {string} text */
export const writeAtomic = async (cl, path, text) => {
  const tmp = `${path}.${process.pid}.${++cl.ids}.tmp`;
  await fsp.writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' });
  await fsp.rename(tmp, path);
};

/** A turn’s folder, if it’s a real folder under turns/ (not a link, and a turn ID). @param {Cleanup} cl @param {string} turn */
export async function turnDir(cl, turn) {
  let dir;
  try {
    dir = cl.p.turn(turn);
  } catch {
    return null;
  }
  const st = await lstat(dir);
  if (!st) return null;
  if (!st.isDirectory()) {
    if (st.isSymbolicLink() && !cl.linked.has(turn)) {
      cl.linked.add(turn);
      cl.log(`${dir} is a link, not a folder, so cleanup leaves it alone.`);
    }
    return null;
  }
  return dir;
}

/** The newest change in a folder: its own and each entry’s mtime. @param {string} dir */
export async function newest(dir) {
  let t = (await lstat(dir))?.mtimeMs ?? 0;
  for (const name of await fsp.readdir(dir).catch(() => [])) t = Math.max(t, (await lstat(`${dir}/${name}`))?.mtimeMs ?? 0);
  return t;
}

/** The offset Postbox has acked for a turn, or null if it never has. @param {Cleanup} cl @param {string} turn */
export async function readAck(cl, turn) {
  try {
    const text = await fsp.readFile(cl.p.turn(turn, ACK_FILE), 'utf8');
    return /^\d{1,16}\n?$/.test(text) ? Number(text.trim()) : null;
  } catch {
    return null;
  }
}
