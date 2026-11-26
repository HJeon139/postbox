// Which data format a data folder holds (#683). An older Postbox that loaded a folder a newer one wrote couldn’t replay
// the event types it doesn’t know (apply throws on them, shared/state.mjs), so it started without what the newer one had
// logged since its last snapshot, and its next snapshot made that loss permanent. The folder now records the data
// format of the last Postbox to load it, with that Postbox’s version, in `format.json`, and a Postbox whose format is
// older refuses it before it takes the lock, changing nothing in it.
//
// DATA_FORMAT goes up only in a release that adds what an older Postbox can’t replay: a new event type, or a change to
// what a stored event means. Every other release, which is most of them, reads and writes the same format, so a
// checkout a few merges behind, or a release rolled back, still opens the folder its newer sibling did (the owner’s
// decision on #1803, 26 November 2026). tests/store-format-events.json holds each format’s event types, and a test fails
// when EVENTS gains one with DATA_FORMAT where it was. A change to what an event means, no test can see: raise it by
// hand. Reload and Retry read the folder again under the lock this store holds (server/store-retry.mjs), so no other
// Postbox can have opened it since.

import { readFileSync } from 'node:fs';

export const FORMAT_FILE = 'format.json';

/** The data format this Postbox reads and writes. */
export const DATA_FORMAT = 1;

/** This Postbox’s version, from its package.json, for the refusal to name. */
const OURS = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * The format a record names. A record from before formats, which names only a version (#683’s first head), is format
 * 1, the format of every Postbox until then. Null for one that names neither, which only advises.
 * @param {any} rec
 */
function formatOf(rec) {
  if (Number.isInteger(rec?.format) && rec.format >= 1) return rec.format;
  if (rec?.format === undefined && typeof rec?.version === 'string') return 1;
  return null;
}

/** The refusal, naming the version to run when the record has one. @param {unknown} version */
function newerWords(version) {
  const by = typeof version === 'string' ? `Postbox ${version}` : 'a newer Postbox';
  const run = typeof version === 'string' ? `Postbox ${version} or newer` : 'a newer Postbox';
  return `This data folder was last opened by ${by}, which keeps what this older Postbox (${OURS}) can’t read. Run ${run} on it, or start this one with --data <another folder>. Postbox left the folder as it was.`;
}

/**
 * Refuses a folder whose format is newer than this Postbox’s. Reads only. The record only advises: one that’s missing
 * (no Postbox since #683 has loaded the folder), or that can’t be read or read as a format (cut off by a crash, or
 * edited), is read as none, with a warning unless the caller has already warned, and the folder loads as before.
 * @param {{ readFile: Function }} io @param {(name: string) => string} at  a path in the folder
 * @param {(line: string) => void} [warn]
 */
export async function checkFormat(io, at, warn = console.warn) {
  let text;
  try {
    text = await io.readFile(at(FORMAT_FILE), 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return;
    return warn(`Postbox couldn’t read which data format this folder holds (${FORMAT_FILE}: ${e instanceof Error ? e.message : e}), so it loads it as before.`);
  }
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {}
  const format = formatOf(rec);
  if (format === null) return warn(`Postbox couldn’t read which data format this folder holds (${FORMAT_FILE}), so it loads it as before.`);
  if (format <= DATA_FORMAT) return;
  throw Object.assign(new Error(newerWords(rec.version)), { code: 'NEWER_FORMAT' });
}

/**
 * Records this Postbox’s format and version as the last to load the folder, once it holds the lock and has read it,
 * unless the record says so already: written to a temporary file, fsynced, then renamed, as a snapshot is. A failure is
 * a warning, not a failed start: the record only advises.
 * @param {{ readFile: Function, open: Function, rename: Function }} io @param {(name: string) => string} at
 * @param {(line: string) => void} [warn]
 */
export async function recordFormat(io, at, warn = console.warn) {
  const text = `${JSON.stringify({ format: DATA_FORMAT, version: OURS })}\n`;
  if ((await io.readFile(at(FORMAT_FILE), 'utf8').catch(() => null)) === text) return;
  const tmp = at(`${FORMAT_FILE}.${process.pid}.tmp`);
  try {
    const fh = await io.open(tmp, 'w');
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await io.rename(tmp, at(FORMAT_FILE));
  } catch (e) {
    warn(`Postbox couldn’t record its data format in this folder (${FORMAT_FILE}): ${e instanceof Error ? e.message : e}. It tries again at the next start.`);
  }
}
