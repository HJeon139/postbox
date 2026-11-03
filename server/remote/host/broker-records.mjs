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
/** Why a closed broker refuses a write: what the call or prompt that needed it is told. */
export const CLOSING = 'the daemon on this host is closing';

/**
 * Runs one write to a file after the writes to it before, and keeps it in b.appends until it settles, so the broker’s
 * close waits for it (inFlight). A closed broker starts none: its close waits for every write started before it, and
 * nothing lands after it in a folder the caller then removes (#426), except a write `held` under a claim, which the
 * close waits for until it is released. A failed write doesn’t hold up the next one.
 * @param {Broker} b @param {string} path @param {() => Promise<void>} write @param {boolean} [held]
 * @returns {Promise<void>}
 */
function chain(b, path, write, held = false) {
  if (b.closed && !held) return Promise.reject(new Error(CLOSING));
  const next = (b.appends.get(path) ?? Promise.resolve()).catch(() => {}).then(write);
  b.appends.set(path, next);
  const done = () => {
    if (b.appends.get(path) === next) b.appends.delete(path);
  };
  next.then(done, done);
  return next;
}
/**
 * Appends one record to a turn’s tools.jsonl or prompts.jsonl, in order. It rejects if the append fails, after logging
 * it, so a call or prompt is acknowledged only once it’s on disk; a closed broker refuses it without logging. `held`:
 * written under a claim (a reply record), which the close waits for.
 * @param {Broker} b @param {string} turn @param {'tools' | 'prompts'} which @param {any} rec @param {boolean} [held]
 * @returns {Promise<void>}
 */
export function record(b, turn, which, rec, held = false) {
  const path = b.p.turn(turn, TURN_FILES[which]);
  const line = `${JSON.stringify({ ...rec, at: rec.at ?? b.now() })}\n`;
  return chain(
    b,
    path,
    () =>
      b.io.appendFile(path, line, { mode: FILE_MODE }).catch((/** @type {Error} */ e) => {
        b.log(`Couldn’t record ${rec.op} in ${path}: ${e.message}`);
        throw e;
      }),
    held,
  );
}
/** A record nothing waits on: a failure is logged by record, and the state in memory still holds. @param {Broker} b */
export const note = (b, turn, which, rec) => record(b, turn, which, rec).catch(() => {});
/** A record as a promise of '' once it’s on disk, or the error’s message. @param {Broker} b @param {boolean} [held] as record’s */
export const written = (b, turn, which, rec, held = false) =>
  record(b, turn, which, rec, held).then(
    () => '',
    (e) => e.message,
  );
/** What the shim hears when a call or prompt couldn’t be written down. @param {string} what @param {Error} e */
export const unrecorded = (what, e) =>
  `Postbox’s daemon on this host couldn’t write down ${what}, so it wasn’t ${what.startsWith('this permission') ? 'shown' : 'sent to Postbox'}: ${e.message}. Try again.`;
/** Writes a file atomically, mode 0600, in the file’s order of writes, as a record is (chain). @param {Broker} b @param {string} path @param {string} text */
export const writeAtomic = (b, path, text) =>
  chain(b, path, async () => {
    const tmp = `${path}.${process.pid}.b${++b.ids}.tmp`;
    await fsp.writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' });
    await fsp.rename(tmp, path);
  });
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
