// The broker’s files in a turn folder (#120): tools.jsonl and prompts.jsonl appended in order, start.json and the
// exit record read, and whether a turn’s shim may call. broker.mjs’s header says what’s written down when.

import { promises as fsp } from 'node:fs';
import { FILE_MODE, TURN_FILES, validateStartRecord } from '../../../shared/remote-protocol.mjs';
import { STOPPED_TEXT } from './broker-state.mjs';

/** @typedef {import('./broker-state.mjs').Broker} Broker */

export const exists = (path) =>
  fsp.lstat(path).then(
    () => true,
    () => false,
  );
/**
 * Appends one record to a turn’s tools.jsonl or prompts.jsonl, in order. It rejects if the append fails, after logging
 * it, so a call or prompt is acknowledged only once it’s on disk; a failed append doesn’t hold up the next one.
 * @param {Broker} b @param {string} turn @param {'tools' | 'prompts'} which @returns {Promise<void>}
 */
export function record(b, turn, which, rec) {
  const path = b.p.turn(turn, TURN_FILES[which]);
  const line = `${JSON.stringify({ ...rec, at: rec.at ?? b.now() })}\n`;
  const next = (b.appends.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(() => fsp.appendFile(path, line, { mode: FILE_MODE }))
    .catch((e) => {
      b.log(`Couldn’t record ${rec.op} in ${path}: ${e.message}`);
      throw e;
    });
  b.appends.set(path, next);
  const done = () => {
    if (b.appends.get(path) === next) b.appends.delete(path);
  };
  next.then(done, done);
  return next;
}
/** A record nothing waits on: a failure is logged by record, and the state in memory still holds. @param {Broker} b */
export const note = (b, turn, which, rec) => record(b, turn, which, rec).catch(() => {});
/** A record as a promise of '' once it’s on disk, or the error’s message. @param {Broker} b */
export const written = (b, turn, which, rec) =>
  record(b, turn, which, rec).then(
    () => '',
    (e) => e.message,
  );
/** What the shim hears when a call or prompt couldn’t be written down. @param {string} what @param {Error} e */
export const unrecorded = (what, e) =>
  `Postbox’s daemon on this host couldn’t write down ${what}, so it wasn’t ${what.startsWith('this permission') ? 'shown' : 'sent to Postbox'}: ${e.message}. Try again.`;
/** Writes a file atomically, mode 0600. @param {Broker} b */
export const writeAtomic = async (b, path, text) => {
  const tmp = `${path}.${process.pid}.b${++b.ids}.tmp`;
  await fsp.writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' });
  await fsp.rename(tmp, path);
};
/** start.json, if the turn is one the daemon started. @param {Broker} b @param {string} turn */
export const startOf = async (b, turn) => {
  try {
    const r = validateStartRecord(JSON.parse(await fsp.readFile(b.p.turn(turn, TURN_FILES.start), 'utf8')));
    return r.ok ? r.msg : null;
  } catch {
    return null;
  }
};
/** @param {Broker} b @param {string} turn */
export const ended = (b, turn) => exists(b.p.turn(turn, TURN_FILES.exit));

/**
 * What a turn’s shim may do: '' if it may call, else why not, with the error code.
 * @param {Broker} b @param {string} turn @returns {Promise<{ code: string, text: string } | null>}
 */
export async function refusal(b, turn) {
  if (!(await startOf(b, turn))) return { code: 'no-turn', text: `There’s no turn ${turn} on this host.` };
  if (b.stopping.has(turn) || b.interrupted(turn) || (await ended(b, turn))) return { code: 'turn-ended', text: STOPPED_TEXT };
  return null;
}
