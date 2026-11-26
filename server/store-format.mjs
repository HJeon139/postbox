// Which Postbox last opened a data folder (#683). An older Postbox that loaded a folder a newer one wrote couldn’t
// replay the event types it doesn’t know (apply throws on them, shared/state.mjs), so it started without what the newer
// one had logged since its last snapshot, and its next snapshot made that loss permanent. The folder now records the
// version of the last Postbox to load it, in `format.json`, and an older Postbox refuses it before it takes the lock,
// changing nothing in it. Only an older release refuses: a build of the same version or a newer one (an upgrade, which
// reads what it replaced) loads it as before. A branch older than the release that last opened a shared folder is
// refused too, so its message names --data, for a folder of its own. Reload and Retry read the
// folder again under the lock this store holds (server/store-retry.mjs), so no other Postbox can have opened it since.

import { readFileSync } from 'node:fs';

export const FORMAT_FILE = 'format.json';

/** This Postbox’s version, from its package.json. */
const OURS = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** A version’s numbers, major to patch, or null for anything that isn’t one. @param {unknown} v */
const partsOf = (v) => (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);

/** Whether version a is newer than version b. @param {number[]} a @param {number[]} b */
const newer = (a, b) => {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] > b[i];
};

/**
 * Refuses a folder a newer Postbox last opened. Reads only. The record only advises: one that’s missing (no Postbox
 * since #683 has loaded the folder) or that can’t be read as a version (cut off by a crash, or edited) is read as no
 * record, with a warning for the second, and the folder loads as before.
 * @param {{ readFile: Function }} io @param {(name: string) => string} at  a path in the folder
 * @param {(line: string) => void} [warn]
 */
export async function checkFormat(io, at, warn = console.warn) {
  let text;
  try {
    text = await io.readFile(at(FORMAT_FILE), 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return;
    return warn(
      `Postbox couldn’t read which version last opened this data folder (${FORMAT_FILE}: ${e instanceof Error ? e.message : e}), so it loads it as before.`,
    );
  }
  let version;
  try {
    version = JSON.parse(text)?.version;
  } catch {}
  const was = partsOf(version);
  if (!was) return warn(`Postbox couldn’t read which version last opened this data folder (${FORMAT_FILE}), so it loads it as before.`);
  const ours = partsOf(OURS);
  // A build whose own version isn’t a release’s, which releases never make, can’t say what’s newer.
  if (!ours || !newer(was, ours)) return;
  throw Object.assign(
    new Error(
      `This data folder was last opened by Postbox ${version}, which may have recorded what this older Postbox (${OURS}) can’t read. Run Postbox ${version} or newer on it, or start this one with --data <another folder>. Postbox left the folder as it was.`,
    ),
    { code: 'NEWER_FORMAT' },
  );
}

/**
 * Records this Postbox as the last to load the folder, once it holds the lock and has read it, unless the record says
 * so already: written to a temporary file, fsynced, then renamed, as a snapshot is. A failure is a warning, not a
 * failed start: the record only advises.
 * @param {{ readFile: Function, open: Function, rename: Function }} io @param {(name: string) => string} at
 * @param {(line: string) => void} [warn]
 */
export async function recordFormat(io, at, warn = console.warn) {
  const text = `${JSON.stringify({ version: OURS })}\n`;
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
    warn(`Postbox couldn’t record its version in this data folder (${FORMAT_FILE}): ${e instanceof Error ? e.message : e}. It tries again at the next start.`);
  }
}
