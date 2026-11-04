// Keeping a host’s Postbox up to date (#464-b2a; designs/464-keep-updated.md, “How it works”): with the person’s standing consent for a
// host (install-record.mjs’s keepUpdated), a 127 from its launcher, meaning this Postbox’s version isn’t there,
// installs that version once, with the same commands and checks as the person’s Install… (install.mjs).
//
// - maybeUpdate(m, id, failure): hosts-links.mjs’s follow() calls it (through m.onFailure) for each link failure,
//   before any other listener. It’s synchronous up to putting the install in m.updating, so a caller that hears the
//   same failure finds it there, and it never throws: an error is the host’s status’s update.error, and nothing
//   installs.
// - One install at a time per host: m.updating holds each install under way, the person’s or this rule’s, as
//   { done, abort }. done never rejects: it resolves to { ok: true, result } or { ok: false, failure }. abort stops its
//   ssh (close()).
// - The record says started before ssh runs, and how it ended after; no record, no install. A version is tried once
//   until another version is tried after it (install-record.mjs’s isTried).
// - Exit 75 (another attach or install holds the version’s lock) is noted busy, and the host connects once more.

import { sameToken } from '../helpers.mjs';
import { connectNow, dropLink } from './hosts-links.mjs';
import { hostOf, tokenOf, update } from './hosts-status.mjs';
import { installHost } from './install.mjs';
import { changeRecord, isTried, noteRecordError, recordOf } from './install-record.mjs';
import { SshFailure } from './ssh-failures.mjs';

/**
 * @typedef {import('./hosts-status.mjs').Manager} Manager
 * @typedef {Awaited<ReturnType<typeof installHost>>} InstallResult
 * @typedef {{ ok: true, result: InstallResult } | { ok: false, failure: any }} InstallOutcome
 * @typedef {{ done: Promise<InstallOutcome>, abort: AbortController }} Updating
 * @typedef {import('./install-record.mjs').InstallEntry} InstallEntry
 */

/** The installer’s exit when another attach or install holds this version’s lock (install-script.mjs). */
const BUSY_EXIT = 75;

/**
 * Puts a job in m.updating at once, as the host’s one install under way, and runs it in the next microtask. Its entry
 * goes once it settles.
 * @param {Manager} m @param {string} id @param {(signal: AbortSignal) => Promise<InstallResult>} job @returns {Updating}
 */
export function track(m, id, job) {
  const abort = new AbortController();
  /** @type {Updating} */
  const entry = { abort, done: /** @type {any} */ (null) };
  m.updating.set(id, entry);
  const settled = (/** @type {InstallOutcome} */ outcome) => {
    if (m.updating.get(id) === entry) m.updating.delete(id);
    return outcome;
  };
  entry.done = Promise.resolve()
    .then(() => job(abort.signal))
    .then(
      (result) => settled({ ok: true, result }),
      (failure) => settled({ ok: false, failure }),
    );
  return entry;
}

/**
 * Installs this Postbox on the host (install.mjs’s installHost) and keeps its token; a link made with another token
 * is replaced. It then connects, for its welcome, and for a turn or a prompt that waited for the install. A host
 * removed meanwhile keeps nothing here.
 * @param {Manager} m @param {string} id @param {AbortSignal} [signal] @returns {Promise<InstallResult>}
 */
export async function installNow(m, id, signal) {
  const host = hostOf(m, id);
  const r = await installHost({
    host,
    version: m.version,
    dataDir: m.dataDir,
    ...(m.spawn ? { spawn: m.spawn } : {}),
    setTimer: m.setTimer,
    clearTimer: m.clearTimer,
    ...(signal ? { signal } : {}),
  });
  if (!m.getHost(id)) return r;
  m.tokens.set(id, r.token);
  const e = m.links.get(id);
  if (e && !sameToken(e.token, r.token)) dropLink(m, id);
  update(m, id);
  connectNow(m, id).catch(() => {});
  return r;
}

/**
 * The rule, for one failure of the host’s link. Starts an install only for a launcher that exited 127, with the
 * consent on, a token here, the host still configured, this version not tried, and no install under way. Never throws.
 * @param {Manager} m @param {string} id @param {any} failure
 */
export function maybeUpdate(m, id, failure) {
  try {
    if (failure?.kind !== 'not-installed' || failure.detail?.code !== 127) return;
    const record = recordOf(m, id);
    if (!record.keepUpdated || isTried(record, m.version)) return;
    if (m.updating.has(id)) return;
    // A host being removed isn’t installed on first: Remove connects to stop its turns, and a 127 then is no consent to install.
    if (m.removals.has(id)) return;
    if (!m.getHost(id)) return;
    if (!tokenOf(m, id)) return;
    const entry = track(m, id, (signal) => autoInstall(m, id, signal));
    entry.done.then((outcome) => afterBusy(m, id, outcome));
  } catch (e) {
    noteError(m, id, `Postbox couldn’t check whether to install by itself (${e?.code ?? e?.name ?? 'error'}).`);
  }
}

/** Notes an error on the host’s status, and says so; never throws. @param {Manager} m @param {string} id @param {string} error */
function noteError(m, id, error) {
  try {
    noteRecordError(m, id, error);
    update(m, id);
  } catch {}
}

/**
 * After a busy install, the host connects once more: the other Postbox may have installed it.
 * @param {Manager} m @param {string} id @param {InstallOutcome} outcome
 */
function afterBusy(m, id, outcome) {
  if (outcome.ok || m.closed || outcome.failure?.detail?.code !== BUSY_EXIT) return;
  connectNow(m, id).catch(() => {});
}

/**
 * The automatic install: the record says started, for this version, before ssh runs; then how it ended. One stopped
 * by Postbox closing leaves it started.
 * @param {Manager} m @param {string} id @param {AbortSignal} signal @returns {Promise<InstallResult>}
 */
async function autoInstall(m, id, signal) {
  const tried = { version: m.version, at: m.now(), outcome: 'started' };
  await noteStarted(m, id, tried);
  let result;
  try {
    if (signal.aborted) throw new SshFailure('failed', 'Postbox closed before the install started.', 'Install it from here once Postbox is running again.');
    result = await installNow(m, id, signal);
  } catch (e) {
    if (!signal.aborted && !m.closed) await noteEnd(m, id, tried, e?.detail?.code === BUSY_EXIT ? 'busy' : 'failed');
    throw e;
  }
  await noteEnd(m, id, tried, result.installed ? 'installed' : 'present');
  return result;
}

/**
 * Writes the try before the install; a write that fails, or a host gone, stops it there.
 * @param {Manager} m @param {string} id @param {{ version: string, at: number, outcome: string }} tried
 */
async function noteStarted(m, id, tried) {
  let wrote = false;
  try {
    await changeRecord(m, id, (was) => {
      if (!m.getHost(id)) return null;
      wrote = true;
      return { keepUpdated: was.keepUpdated, installs: [tried, ...was.installs] };
    });
  } catch (e) {
    const why = `Postbox couldn’t note the install in its data folder (${e?.code ?? 'error'}), so it didn’t install by itself. Install it from here.`;
    noteError(m, id, why);
    throw new SshFailure('failed', why, 'Install it from here.');
  }
  if (!wrote) throw new SshFailure('failed', 'That host doesn’t exist. It may have been removed.', 'Add it again to install there.');
  update(m, id);
}

/**
 * Rewrites the try with how it ended, on the record as the writes before left it; skipped for a host gone.
 * @param {Manager} m @param {string} id @param {{ version: string, at: number, outcome: string }} tried @param {string} outcome
 */
async function noteEnd(m, id, tried, outcome) {
  const ended = { version: tried.version, at: tried.at, outcome };
  try {
    await changeRecord(m, id, (was) => {
      if (!m.getHost(id)) return null;
      return { keepUpdated: was.keepUpdated, installs: withEnded(was.installs, tried, ended) };
    });
  } catch (e) {
    noteError(m, id, `Postbox couldn’t note how its install ended in its data folder (${e?.code ?? 'error'}).`);
    return;
  }
  update(m, id);
}

/**
 * The tries with this one’s started entry replaced by how it ended, or the ended entry added first when the started
 * one is gone (a record rewritten meanwhile).
 * @param {InstallEntry[]} installs @param {InstallEntry} tried @param {InstallEntry} ended @returns {InstallEntry[]}
 */
function withEnded(installs, tried, ended) {
  const isThisTry = (/** @type {InstallEntry} */ i) => i.version === tried.version && i.at === tried.at && i.outcome === 'started';
  const at = installs.findIndex(isThisTry);
  if (at === -1) return [ended, ...installs];
  const replaced = [...installs];
  replaced[at] = ended;
  return replaced;
}

/**
 * Sets the person’s standing consent for the host, rewriting its record whole (one that couldn’t be read starts over).
 * @param {Manager} m @param {string} id @param {boolean} on @returns {Promise<void>}
 */
export async function setKeepUpdated(m, id, on) {
  if (typeof on !== 'boolean') throw new TypeError('keepUpdated is true or false.');
  hostOf(m, id);
  await changeRecord(m, id, (was) => ({ keepUpdated: on, installs: was.installs }));
  update(m, id);
  // A host already stopped on a 127 hears no more failures by itself (wake() skips a stopped link), so turning the
  // consent on connects once, and the rule sees that attempt’s failure.
  if (on && m.links.get(id)?.link.state === 'stopped') connectNow(m, id).catch(() => {});
}
