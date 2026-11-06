// The laptop’s record of a host’s automatic installs (#464-b2a; hosts-update.mjs is the rule that reads it): one file
// per host, `<data>/remote-installs/<host id>`, 0600 in a 0700 folder, `{ keepUpdated, installs }`. keepUpdated is the
// person’s standing consent to install this Postbox’s version there by itself; installs are the tries, newest first,
// at most MAX_INSTALLS, each `{ version, at, outcome }`. No older Postbox reads this folder, so a rollback forgets the
// consent rather than refusing a host setting it doesn’t know.
//
// The read is strict and fails closed: anything but a regular file holding exactly that shape is no consent, with
// the current version counted as tried (refused), so nothing installs by itself until the person saves the consent
// again. Each host’s record is read once and kept in m.installRecords; every write to it, the consent’s and an
// install’s, goes through one promise chain per host (m.recordWrites), and each applies its change to the record as
// the write before it left it, so neither overwrites the other.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { VERSION_RE } from '../../shared/remote-protocol-checks.mjs';
import { HOST_ID_RE } from './install-token.mjs';

/** The laptop’s folder of install records, under Postbox’s data folder. */
export const INSTALLS_DIR = 'remote-installs';
/** How many tries a record keeps, newest first. */
export const MAX_INSTALLS = 16;
/** The largest record file read: 16 entries are about 1.3 KB, so anything near this isn’t one Postbox wrote. */
export const MAX_RECORD_BYTES = 8192;
/** What an install’s entry can say: started, before ssh runs; then how it ended. */
export const OUTCOMES = Object.freeze(['started', 'installed', 'present', 'reinstalled', 'busy', 'failed']);
/** What the host’s status says when its record couldn’t be read. */
export const UNREADABLE = 'Postbox couldn’t read its note of installs on this host, so it won’t install by itself.';

/**
 * @typedef {{ version: string, at: number, outcome: string }} InstallEntry
 * @typedef {{ keepUpdated: boolean, installs: InstallEntry[] }} InstallRecord  as it is on disk
 * @typedef {InstallRecord & { refused?: boolean, error?: string }} KeptRecord
 *   as m.installRecords keeps it. refused: the file couldn’t be read, so this version counts as tried. error: why,
 *   or why the last write failed, or why an automatic install failed, for the host’s status; never a token. An
 *   installer’s error can name a path on this computer, as Install… already shows it.
 * @typedef {{ dataDir: string, installRecords: Map<string, KeptRecord>, recordWrites: Map<string, Promise<unknown>> }} RecordState
 */

/** The host’s record file. @param {string} dataDir @param {string} hostId */
export function recordFile(dataDir, hostId) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('Postbox’s data folder is needed to keep a host’s installs.');
  if (typeof hostId !== 'string' || !HOST_ID_RE.test(hostId)) throw new TypeError(`“${String(hostId).slice(0, 80)}” isn’t a host ID.`);
  return join(dataDir, INSTALLS_DIR, hostId);
}

/** Whether a value is a plain object with exactly these keys. @param {unknown} v @param {string[]} keys */
function hasExactly(v, keys) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}

/** @param {any} e @returns {e is InstallEntry} */
function isEntry(e) {
  if (!hasExactly(e, ['version', 'at', 'outcome'])) return false;
  const versionOk = typeof e.version === 'string' && VERSION_RE.test(e.version) && !e.version.includes('..');
  return versionOk && Number.isFinite(e.at) && OUTCOMES.includes(e.outcome);
}

/** The record in a file’s text, or null when it isn’t exactly a record. @param {string} text @returns {InstallRecord | null} */
export function parseRecord(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!hasExactly(v, ['keepUpdated', 'installs']) || typeof v.keepUpdated !== 'boolean') return null;
  if (!Array.isArray(v.installs) || v.installs.length > MAX_INSTALLS || !v.installs.every(isEntry)) return null;
  return { keepUpdated: v.keepUpdated, installs: v.installs };
}

/** A record that couldn’t be read: no consent, and this version tried. @param {string} error @returns {KeptRecord} */
const refusedRecord = (error) => ({ keepUpdated: false, installs: [], refused: true, error });

/**
 * Reads the host’s record from disk, synchronously, as the rule needs it in the failure’s own tick. Never throws.
 * @param {string} dataDir @param {string} hostId @returns {KeptRecord}
 */
function readRecord(dataDir, hostId) {
  try {
    const file = recordFile(dataDir, hostId);
    // O_NOFOLLOW covers only the file itself, so the folder must be a real one too, not a link to elsewhere.
    if (!isRealFolder(dirname(file))) return refusedRecord(UNREADABLE);
    const text = readSmallFile(file);
    const record = text === null ? null : parseRecord(text);
    return record ?? refusedRecord(UNREADABLE);
  } catch (e) {
    if (e?.code === 'ENOENT') return { keepUpdated: false, installs: [] };
    return refusedRecord(`${UNREADABLE} (${e?.code ?? 'error'})`);
  }
}

/** Whether a path is a folder itself, not a link to one; a missing one throws ENOENT. @param {string} dir */
function isRealFolder(dir) {
  return lstatSync(dir).isDirectory();
}

/**
 * A regular file’s text, read in the failure’s own tick, at most MAX_RECORD_BYTES of it; null for anything but a
 * regular file, or for a file far larger than any record Postbox writes, refused unread. It’s opened once and checked
 * on what was opened: a symbolic link fails the open (ELOOP), and a FIFO opens without waiting for a writer, so
 * neither can swap the file or block the read. Throws for a file that isn’t there (ENOENT) and other errors opening it.
 * @param {string} file @returns {string | null}
 */
function readSmallFile(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RECORD_BYTES) return null;
    const buf = Buffer.alloc(MAX_RECORD_BYTES);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * The host’s record as this Postbox keeps it: read on first use, then as the last write left it. No file is no
 * consent. Never throws for the file; throws only for a state with no map to keep it in.
 * @param {RecordState} m @param {string} hostId @returns {KeptRecord}
 */
export function recordOf(m, hostId) {
  const kept = m.installRecords.get(hostId);
  if (kept) return kept;
  const read = readRecord(m.dataDir, hostId);
  m.installRecords.set(hostId, read);
  return read;
}

/** Writes the file as storeToken writes a token: 0600, in a 0700 folder, a temporary file and then a rename. */
async function writeRecordFile(/** @type {string} */ file, /** @type {InstallRecord} */ record) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // chmod follows a link, so a folder that’s a link to elsewhere is refused rather than changed.
  if (!isRealFolder(dir)) throw Object.assign(new Error('The install records’ folder isn’t a real folder.'), { code: 'ENOTDIR' });
  await chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Runs a step after every write to this host’s record before it, and keeps the chain short: it’s dropped once its
 * last step settles. Resolves or rejects as the step does; the chain itself never rejects.
 * @template T @param {RecordState} m @param {string} hostId @param {() => Promise<T>} step @returns {Promise<T>}
 */
function afterWrites(m, hostId, step) {
  const before = m.recordWrites.get(hostId) ?? Promise.resolve();
  const result = before.then(step);
  const tail = result.catch(() => {});
  m.recordWrites.set(hostId, tail);
  tail.then(() => {
    if (m.recordWrites.get(hostId) === tail) m.recordWrites.delete(hostId);
  });
  return result;
}

/**
 * Changes the host’s record: change() is given the record as the writes before it left it, and returns the new one,
 * or null to write nothing. Resolves with the record kept, once it’s on disk; rejects when it couldn’t be written,
 * leaving the kept record as it was.
 * @param {RecordState} m @param {string} hostId @param {(was: KeptRecord) => InstallRecord | null} change
 * @returns {Promise<KeptRecord>}
 */
export function changeRecord(m, hostId, change) {
  return afterWrites(m, hostId, async () => {
    const was = recordOf(m, hostId);
    const next = change(was);
    if (!next) return was;
    const record = { keepUpdated: next.keepUpdated, installs: next.installs.slice(0, MAX_INSTALLS) };
    await writeRecordFile(recordFile(m.dataDir, hostId), record);
    m.installRecords.set(hostId, record);
    return record;
  });
}

/**
 * Notes why the host’s record couldn’t be read or written, for its status, on the record kept (not on disk).
 * @param {RecordState} m @param {string} hostId @param {string} error
 */
export function noteRecordError(m, hostId, error) {
  const kept = m.installRecords?.get(hostId);
  if (kept) m.installRecords.set(hostId, { ...kept, error });
}

/**
 * Removes the host’s record, after every write before it, as removing the host does, so a later host with the same
 * ID starts with no consent.
 * @param {RecordState} m @param {string} hostId @returns {Promise<void>}
 */
export function removeRecord(m, hostId) {
  return afterWrites(m, hostId, async () => {
    await rm(recordFile(m.dataDir, hostId), { force: true });
    m.installRecords.delete(hostId);
  });
}

/**
 * Whether this version was tried here: the newest entry is this version’s, so no other version came after it. A record
 * that couldn’t be read never reaches this: it holds no consent (refusedRecord), and the rule stops on that first.
 * @param {KeptRecord} record @param {string} version
 */
export function isTried(record, version) {
  return record.installs[0]?.version === version;
}

/**
 * What the host’s status says of its automatic installs: the newest entry, and why the record couldn’t be read or
 * written. null with neither. Never a token; the error can name a path on this computer (noteFailed).
 * @param {KeptRecord} record
 * @returns {{ version: string | null, at: number | null, outcome: string | null, error?: string } | null}
 */
export function updateOf(record) {
  const newest = record.installs[0];
  if (!newest && !record.error) return null;
  return updateFields({ ...newest, error: record.error });
}

/**
 * An automatic install as the host’s status carries it, field by field, for updateOf here and for the page’s copy
 * (host-status.mjs). Never a token; the error can name a path on this computer. @param {any} u
 * @returns {{ version: string | null, at: number | null, outcome: string | null, error?: string } | null}
 */
export function updateFields(u) {
  if (!u) return null;
  const said = { version: u.version ?? null, at: u.at ?? null, outcome: u.outcome ?? null };
  return typeof u.error === 'string' ? { ...said, error: u.error } : said;
}
