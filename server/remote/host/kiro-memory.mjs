// Kiro keeps memory per Kiro home: memory.mode and memory.reflection are settings in that home’s settings/cli.json, with
// no flag or variable to set them for one run (kiro-cli 2.34.1). An Isolated persona runs with a Kiro home Postbox
// owns, so Postbox turns memory off there before each turn (#479), keeping the home’s other settings: on this computer
// the one every Isolated persona shares (kiro-cli.mjs), and on a host the persona’s own, which the daemon writes
// (daemon-start.mjs). Here, so the host’s daemon runs the same code (install-bundle.mjs ships only shared/ and
// server/remote/host/). Postbox leaves your own Kiro settings alone, so a persona with your setup shares your memory.

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What Kiro’s own `kiro-cli settings memory.mode disabled` writes, one flat key per setting, with reflection too. */
const OFF = Object.freeze({ 'memory.mode': 'disabled', 'memory.reflection': false });

/**
 * Turns memory off in a Kiro home Postbox owns. A settings file that isn’t a JSON object is replaced, since Kiro couldn’t
 * read it either (it refuses an array: “expected a map”). Written through a temporary file of the turn’s own, so two turns
 * starting together never read half of one or rename each other’s, and only the owner can read it, as Kiro writes it.
 * @param {string} home
 * @param {{ refuseLinks?: boolean }} [options]
 */
export async function kiroMemoryOff(home, { refuseLinks = false } = {}) {
  const dir = join(home, 'settings');
  const file = join(dir, 'cli.json');
  try {
    if (refuseLinks) {
      // Check the parent first, so even the inspection of cli.json stays in the isolated home.
      await refuseSymlink(dir);
      await refuseSymlink(file);
    }
    const now = await settingsIn(file);
    if (Object.entries(OFF).every(([k, v]) => now[k] === v)) return;
    // Only you can read the folders it makes: on a host it may be the first to make the persona’s home (#479).
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ ...now, ...OFF }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  } catch (e) {
    throw new Error(
      `Postbox couldn’t turn Kiro’s memory off in ${file} (${/** @type {Error} */ (e).message}), so the turn didn’t start. Check that the folder is yours and writable.`,
      { cause: e },
    );
  }
}

/** @param {string} path */
async function refuseSymlink(path) {
  const entry = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (entry?.isSymbolicLink())
    throw new Error(`The isolated settings path ${path} is a symbolic link. Use a regular directory and file inside the persona’s Kiro home.`);
}

/** A Kiro settings file’s keys: none when it’s missing, or isn’t a JSON object. @param {string} file */
async function settingsIn(file) {
  try {
    const read = JSON.parse(await readFile(file, 'utf8'));
    return read && typeof read === 'object' && !Array.isArray(read) ? read : {};
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT' || e instanceof SyntaxError) return {};
    throw e;
  }
}
