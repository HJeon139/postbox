// Cleanup on a remote host (#120, the design’s “Files and cleanup”): what the daemon deletes, and when. Everything it
// deletes is under ~/.postbox-remote, except a Kiro agent file a turn’s start.agentFile put outside it, which goes
// only if it still holds the text the daemon wrote.
//
// - Acks persist. Postbox’s `ack` for a turn is kept in the turn folder’s `.ack` (the offset, 0600, written atomically),
//   so a restarted daemon still knows what Postbox has applied. A file name that starts with a dot is one Postbox can’t
//   send in start.files, so it never collides with one.
// - A turn’s logs (out.jsonl, in.jsonl, err.log) are deleted once it has ended (exit.json) and Postbox has acked all of
//   out.jsonl. The protocol acks out.jsonl only; in.jsonl holds Postbox’s own writes, each confirmed by `written`, and
//   matters only for rebuilding a Codex turn that’s still running, so it goes with out.jsonl. `.ack` stays, holding
//   out.jsonl’s size, so welcome.turns and a `read` still answer for the turn.
// - The turn’s other files go when it ends: the message, the snapshot, any other file start.files carried, and the
//   agent file. exit.json, runner.json, start.json and `.ack` stay, as do prompts.jsonl and tools.jsonl (the broker’s
//   queue for Postbox, which may still owe a reply after the turn ends), until the folder goes.
// - A turn folder whose newest file is older than logRetention is deleted whole, acked or not, unless its runner is
//   still running: the runner holds its logs open, and it’s still Postbox’s turn.
// - A log over logMaxBytes. For a running turn, out.jsonl and in.jsonl can’t be cut safely: Postbox addresses lines by
//   byte offset, so truncating would point every offset it holds at other bytes, and deleting a file the harness still
//   has open frees no space until the harness exits. The runner can’t be told to stop writing, either. So the daemon
//   stops the turn, as Stop does, and says why (the log, err.log, and Postbox’s `error`, `internal`, for the turn): a
//   turn that writes that much is broken, and stopping it bounds the disk. Once ended, the log follows the rules above;
//   Postbox may still read what it hasn’t. err.log is different: Postbox never reads it, and the runner opens it
//   O_APPEND, so writes after a truncation land at its new end. One over the cap is emptied, with a line saying so.
// - Versions retire. An older version’s code folder (~/.postbox-remote/<old>/) is deleted by the newest version’s
//   daemon once no turn that version started (runner.json.version) is running, no daemon of it holds daemon.pid, and
//   no attach or install of it holds its start lock (~/.postbox-remote/locks/<old>.lock, hostPaths().lock): one whose
//   owner record names a live process, whatever its age, or one with no record yet, younger than LOCK_FRESH_MS (proc.mjs,
//   “The start lock’s owner”).
// - `remove` deletes ~/.postbox-remote whole, after the daemon has stopped the turns, only if it’s a folder (not a
//   link) whose real path is the real home folder’s .postbox-remote.
//
// Every step runs one at a time (a queue), so an ack and a sweep never race over the same turn. Nothing here follows
// a link: a turn folder that’s a link is skipped, and files are unlinked, never removed recursively, inside one.
//
// This file is the cleanup’s steps as the daemon calls them; one turn’s is cleanup-turn.mjs, ~/.postbox-remote’s and
// its versions’ cleanup-root.mjs, and what they share cleanup-files.mjs.

import { promises as fsp } from 'node:fs';
import { DIR_MODE, FILE_MODE, TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { ACK_FILE, AGENT_RECORD, emptySwept, INSTALLED, lstat, readAck, readJson, serial, sha256, turnDir, unlink, writeAtomic } from './cleanup-files.mjs';
import { daemonHolds, retire, rootProblem } from './cleanup-root.mjs';
import { dropAgentFile, tidy } from './cleanup-turn.mjs';

export { ACK_FILE, AGENT_RECORD, START_GRACE_MS } from './cleanup-files.mjs';
export { compareVersions, LOCK_FRESH_MS } from './cleanup-root.mjs';

/** @typedef {import('./cleanup-files.mjs').Cleanup} Cleanup @typedef {import('./cleanup-files.mjs').Swept} Swept */

/** How often the daemon sweeps: turns, caps and old versions. */
export const SWEEP_MS = 60_000;

/**
 * The cleanup for one daemon. `stopTurn` is the daemon’s Stop without a connection; `onCap` tells Postbox a turn was
 * stopped at the cap. Every step but deletedSize and rootProblem runs on its queue.
 * @param {{ home: string, version: string, paths: ReturnType<typeof import('../../../shared/remote-protocol.mjs').hostPaths>,
 *   now?: () => number, log?: (line: string) => void,
 *   settings: () => { logRetention: number, logMaxBytes: number },
 *   sameProcess: (r: { pid: number, bootId: string, startTime: number }) => boolean | Promise<boolean>,
 *   stopTurn?: (turn: string) => Promise<unknown>, onCap?: (turn: string, text: string) => void }} o
 */
export function createCleanup({ home, version, paths: p, now = Date.now, log = () => {}, settings, sameProcess, stopTurn = async () => {}, onCap = () => {} }) {
  /** @type {Cleanup} */
  const cl = { home, version, p, now, log, settings, sameProcess, stopTurn, onCap, ids: 0, capped: new Set(), linked: new Set(), queue: Promise.resolve() };
  return {
    readAck: (/** @type {string} */ turn) => serial(cl, () => readAck(cl, turn)),
    /** @param {string} turn @param {number} upTo */
    ack: (turn, upTo) => serial(cl, () => ack(cl, turn, upTo)),
    /** @param {string} turn */
    deletedSize: (turn) => deletedSize(cl, turn),
    /** @param {string} turn @param {{ dir: string, name: string, text: string }} file */
    writeAgentFile: (turn, file) => serial(cl, () => writeAgentFile(cl, turn, file)),
    /** Removes a turn’s agent file now: a start that failed after writing it. @param {string} turn */
    dropAgentFile: (turn) =>
      serial(cl, async () => {
        const dir = await turnDir(cl, turn);
        if (dir) await dropAgentFile(cl, turn, dir);
      }),
    /** One turn, as it ends. @param {string} turn */
    turnEnded: (turn) =>
      serial(cl, async () => {
        if (await rootProblem(cl)) return;
        await tidy(cl, turn, emptySwept());
      }),
    sweep: () => serial(cl, () => sweep(cl)),
    /** @param {(pid: number) => void} signal */
    removeAll: (signal) => serial(cl, () => removeAll(cl, signal)),
    rootProblem: () => rootProblem(cl),
  };
}

/**
 * Records Postbox’s ack for a turn, keeping the furthest, then cleans the turn (its logs may go now). Resolves with
 * the offset kept.
 * @param {Cleanup} cl @param {string} turn @param {number} upTo
 */
async function ack(cl, turn, upTo) {
  const had = await readAck(cl, turn);
  const keep = Math.max(had ?? 0, upTo);
  const dir = await turnDir(cl, turn);
  if (dir && (had === null || keep > had)) await writeAtomic(cl, `${dir}/${ACK_FILE}`, `${keep}\n`);
  await tidy(cl, turn, emptySwept());
  return keep;
}

/**
 * The size welcome.turns and `read` give for a turn whose out.jsonl was deleted: the acked size. Null while out.jsonl
 * is there.
 * @param {Cleanup} cl @param {string} turn
 */
async function deletedSize(cl, turn) {
  if (await lstat(cl.p.turn(turn, TURN_FILES.out))) return null;
  if (!(await lstat(cl.p.turn(turn, TURN_FILES.exit)))) return null;
  return readAck(cl, turn);
}

/**
 * Writes start.agentFile to `<dir>/<name>`, 0600 (the folder made 0700 if it’s missing), recording it first so it goes
 * when the turn ends. A file already there is never written over or shared, whatever it holds: it may be the person’s
 * own, so the start fails.
 * @param {Cleanup} cl @param {string} turn @param {{ dir: string, name: string, text: string }} file  dir: the daemon’s, from KIRO_HOME
 */
async function writeAgentFile(cl, turn, { dir, name, text }) {
  const path = `${dir}/${name}`;
  await writeAtomic(cl, cl.p.turn(turn, AGENT_RECORD), JSON.stringify({ path, sha256: sha256(text) }));
  try {
    await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
  } catch (e) {
    await unlink(cl, cl.p.turn(turn, AGENT_RECORD));
    throw new Error(`Couldn’t make the Kiro agents folder ${dir}: ${e.message}`);
  }
  try {
    await fsp.writeFile(path, text, { mode: FILE_MODE, flag: 'wx' });
  } catch (e) {
    await unlink(cl, cl.p.turn(turn, AGENT_RECORD));
    if (e.code === 'EEXIST') throw new Error(`There’s already a file at ${path}, so Postbox won’t replace it. Move it, or rename the persona.`);
    throw e;
  }
}

/** Every turn, then old versions. @param {Cleanup} cl @returns {Promise<Swept>} */
async function sweep(cl) {
  const done = emptySwept();
  const bad = await rootProblem(cl);
  if (bad) {
    cl.log(bad);
    return done;
  }
  /** @type {Map<string, number>} */
  const running = new Map();
  for (const turn of await fsp.readdir(cl.p.turns).catch(() => [])) {
    const st = await tidy(cl, turn, done).catch((e) => {
      cl.log(`Cleaning turn ${turn} failed: ${e.message}`);
      return null;
    });
    if (st?.state === 'running' && st.version) running.set(st.version, (running.get(st.version) ?? 0) + 1);
  }
  await retire(cl, running, done).catch((e) => cl.log(`Retiring old versions failed: ${e.message}`));
  return done;
}

/**
 * For `remove`, once the turns are stopped: every agent file the turns wrote, other versions’ daemons (by `signal`),
 * then ~/.postbox-remote. Throws, deleting nothing, when the root isn’t safe to delete.
 * @param {Cleanup} cl @param {(pid: number) => void} signal  ends another version’s daemon
 */
async function removeAll(cl, signal) {
  const { p } = cl;
  const bad = await rootProblem(cl);
  if (bad) throw new Error(bad);
  for (const turn of await fsp.readdir(p.turns).catch(() => [])) {
    const dir = await turnDir(cl, turn);
    if (dir) await dropAgentFile(cl, turn, dir).catch((e) => cl.log(`Couldn’t remove turn ${turn}’s agent file: ${e.message}`));
  }
  for (const name of await fsp.readdir(p.root).catch(() => [])) {
    if (!INSTALLED.test(name) || name === cl.version) continue;
    const r = await readJson(`${p.root}/${name}/daemon.pid`);
    if (r && (await daemonHolds(cl, `${p.root}/${name}`))) signal(r.pid);
  }
  await fsp.rm(p.root, { recursive: true, force: true });
  cl.log(`Removed ${p.root}.`);
}
