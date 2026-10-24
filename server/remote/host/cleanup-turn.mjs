// One turn’s cleanup (cleanup.mjs’s header, #120): its files at the end, its logs once acked, the cap, and its folder
// past logRetention, with the agent file a turn’s start wrote.

import { promises as fsp } from 'node:fs';
import { FILE_MODE, TURN_FILES, validateRunnerRecord } from '../../../shared/remote-protocol.mjs';
import {
  ACK_FILE,
  AGENT_RECORD,
  KEEP,
  LOGS,
  lstat,
  newest,
  readAck,
  readJson,
  START_GRACE_MS,
  sha256,
  sizeOf,
  turnDir,
  unlink,
  writeAtomic,
} from './cleanup-files.mjs';

/** @typedef {import('./cleanup-files.mjs').Cleanup} Cleanup @typedef {import('./cleanup-files.mjs').Swept} Swept */
/** @typedef {import('./cleanup-files.mjs').TurnState} TurnState */

/** @param {Cleanup} cl @param {string} dir @returns {Promise<{ state: TurnState, version: string | null }>} */
async function stateOf(cl, dir) {
  if (await lstat(`${dir}/${TURN_FILES.exit}`)) return { state: 'ended', version: null };
  const rec = validateRunnerRecord(await readJson(`${dir}/${TURN_FILES.runner}`));
  if (rec.ok) return { state: (await cl.sameProcess(rec.msg)) ? 'running' : 'interrupted', version: rec.msg.version };
  // No runner.json yet: a turn being started, or one whose runner never got going.
  return { state: cl.now() - (await newest(dir)) < START_GRACE_MS ? 'starting' : 'interrupted', version: null };
}

// ── The agent file ──

/**
 * Removes the agent file a turn wrote, if it still holds what was written (by its hash), then the record. No other
 * turn shares it: writeAgentFile never writes over a file that’s there.
 * @param {Cleanup} cl @param {string} turn @param {string} dir
 */
export async function dropAgentFile(cl, turn, dir) {
  const rec = await readJson(`${dir}/${AGENT_RECORD}`);
  if (!rec || typeof rec.path !== 'string' || !rec.path.startsWith('/') || !rec.path.endsWith('.json') || typeof rec.sha256 !== 'string') {
    if (rec !== undefined) await unlink(cl, `${dir}/${AGENT_RECORD}`);
    return;
  }
  const st = await lstat(rec.path);
  if (st?.isFile()) {
    const text = await fsp.readFile(rec.path).catch(() => null);
    if (text && sha256(text) === rec.sha256) await unlink(cl, rec.path);
    else cl.log(`Turn ${turn}’s agent file ${rec.path} has changed since the daemon wrote it, so it stays.`);
  }
  await unlink(cl, `${dir}/${AGENT_RECORD}`);
}

// ── A turn ──

/**
 * One turn’s cleanup: its files at the end, its logs once acked, the cap, and its folder past logRetention.
 * @param {Cleanup} cl @param {string} turn @param {Swept} done
 * @returns {Promise<{ state: TurnState, version: string | null } | null>}
 */
export async function tidy(cl, turn, done) {
  const dir = await turnDir(cl, turn);
  if (!dir) return null;
  const st = await stateOf(cl, dir);
  const { logRetention, logMaxBytes } = cl.settings();
  if (st.state !== 'running' && st.state !== 'starting' && cl.now() - (await newest(dir)) > logRetention) {
    await dropAgentFile(cl, turn, dir);
    await fsp.rm(dir, { recursive: true, force: true });
    cl.capped.delete(turn);
    done.folders.push(turn);
    cl.log(`Deleted turn ${turn}’s folder: nothing in it changed for ${Math.round(logRetention / 3_600_000)} h (logRetention).`);
    return st;
  }
  await emptyErr(cl, turn, dir, logMaxBytes, done);
  if (st.state === 'running') {
    await capRunning(cl, turn, dir, logMaxBytes, done);
    return st;
  }
  if (st.state !== 'ended') return st;
  await tidyEnded(cl, turn, dir, done);
  return st;
}

/** err.log over the cap, in any state: emptied, since nothing reads it by offset. @param {Cleanup} cl @param {string} turn @param {string} dir @param {number} logMaxBytes @param {Swept} done */
async function emptyErr(cl, turn, dir, logMaxBytes, done) {
  const err = `${dir}/${TURN_FILES.err}`;
  const errSize = await sizeOf(err);
  if (errSize > logMaxBytes) {
    await fsp.truncate(err, 0).catch((e) => cl.log(`Couldn’t empty ${err}: ${e.message}`));
    await fsp.appendFile(err, `postbox daemon: err.log passed logMaxBytes (${logMaxBytes} bytes) at ${errSize} bytes and was emptied.\n`, {
      mode: FILE_MODE,
    });
    done.emptied.push(turn);
  }
}

/** A running turn’s logs over the cap stop it, once (cleanup.mjs’s header). @param {Cleanup} cl @param {string} turn @param {string} dir @param {number} logMaxBytes @param {Swept} done */
async function capRunning(cl, turn, dir, logMaxBytes, done) {
  const err = `${dir}/${TURN_FILES.err}`;
  const over = [];
  for (const f of [TURN_FILES.out, TURN_FILES.in]) {
    const size = await sizeOf(`${dir}/${f}`);
    if (size > logMaxBytes) over.push(`${f} is ${size} bytes`);
  }
  if (over.length && !cl.capped.has(turn)) {
    cl.capped.add(turn);
    const text = `Turn ${turn} was stopped: ${over.join(' and ')}, over this host’s logMaxBytes (${logMaxBytes} bytes). A log can’t be cut while the turn writes it.`;
    cl.log(text);
    await fsp.appendFile(err, `postbox daemon: ${text}\n`, { mode: FILE_MODE }).catch(() => {});
    await cl.stopTurn(turn);
    cl.onCap(turn, text);
    done.capped.push(turn);
  }
}

/** Ended: the turn’s own files go, and its logs once Postbox has acked all of out.jsonl. @param {Cleanup} cl @param {string} turn @param {string} dir @param {Swept} done */
async function tidyEnded(cl, turn, dir, done) {
  await dropAgentFile(cl, turn, dir);
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    // A .tmp is a file being written whole (a snapshot that came late, say); it’s left to the folder’s retention.
    if (KEEP.has(name) || name.endsWith('.tmp')) continue;
    const f = await lstat(`${dir}/${name}`);
    if (f && !f.isDirectory()) await unlink(cl, `${dir}/${name}`);
  }
  const outSize = await sizeOf(`${dir}/${TURN_FILES.out}`);
  const acked = (await readAck(cl, turn)) ?? 0;
  const there = await Promise.all(LOGS.map((f) => lstat(`${dir}/${f}`)));
  if (acked >= outSize && there.some(Boolean)) {
    if (!(await lstat(`${dir}/${ACK_FILE}`))) await writeAtomic(cl, `${dir}/${ACK_FILE}`, `${outSize}\n`);
    for (const f of LOGS) await unlink(cl, `${dir}/${f}`);
    done.logs.push(turn);
  }
}
