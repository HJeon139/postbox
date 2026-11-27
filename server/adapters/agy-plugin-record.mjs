// Where Postbox wrote an Antigravity turn’s plugin (#314). A turn writes .agents/plugins/postbox/ into the agent’s
// folder and removes it in a finally as the turn ends (antigravity-cli.mjs). A Postbox killed mid-turn (SIGKILL, a
// crash, a power loss) never runs that finally, and the plugin stayed: the person’s own agy sessions in that folder
// loaded Postbox’s rules and an MCP URL for a Postbox no longer running, out of git status, as the folder is in
// .git/info/exclude. So each plugin is noted before it’s written, in agy-plugins.json in Postbox’s data folder, beside
// its work root (which holds only the agents’ folders), with a hash of its mcp_config.json, whose MCP URL carries the
// turn’s own token. The note is dropped once the plugin is gone. As Postbox starts, before any turn, each plugin still
// noted is removed, if it’s still the one the turn wrote.
//
// What the sweep leaves:
// - a folder at the noted path whose mcp_config.json isn’t the one noted: another Postbox’s live turn in a shared
//   folder, or one the person put there after the crash;
// - a link where .agents or .agents/plugins goes, which would lead the removal into another folder;
// - a plugin on a disk not mounted at the start: it reads as gone, so its note is dropped, and it stays when the disk
//   comes back;
// - a plugin left by a crash before notes were kept.
// An agy the killed Postbox started runs in its own process group, so it can outlive Postbox until its next write to
// the closed pipe; a start in that window removes the plugin from under it, whose MCP URL is already dead.

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { POSTBOX_SERVER } from './setup.mjs';

/** Where the plugin goes in the agent’s folder. */
export const PLUGIN_DIR = join('.agents', 'plugins', POSTBOX_SERVER);

const FILE = 'agy-plugins.json';
/** The record, beside the work root. @param {string} root  the work root */
const recordIn = (root) => join(dirname(root), FILE);
/** The hash a note keeps of a plugin’s mcp_config.json. @param {string} text */
export const configHash = (text) => createHash('sha256').update(text).digest('hex');

/** @typedef {{ dir: string, sha256: string }} Note */

/** Per work root, the last change to its record, so turns in different folders change it one at a time. */
const chains = new Map();

/** Changes the record: written beside it and renamed, so a crash never leaves half of it. */
function change(/** @type {string} */ root, /** @type {(notes: Note[]) => Note[]} */ fn) {
  const next = (chains.get(root) ?? Promise.resolve()).then(async () => {
    const after = fn(await noted(root));
    await mkdir(dirname(root), { recursive: true });
    const tmp = `${recordIn(root)}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(after)}\n`);
    await rename(tmp, recordIn(root));
  });
  chains.set(
    root,
    next.catch(() => {}),
  );
  return next;
}

/** The plugins noted, or none for a record that’s missing or can’t be read. @param {string} root @returns {Promise<Note[]>} */
async function noted(root) {
  try {
    const notes = JSON.parse(await readFile(recordIn(root), 'utf8'));
    return Array.isArray(notes) ? notes.filter((n) => typeof n?.dir === 'string' && typeof n?.sha256 === 'string') : [];
  } catch {
    return [];
  }
}

/** Notes a plugin folder before it’s written. @param {string} root @param {string} dir @param {string} sha256  configHash of its mcp_config.json */
export const notePlugin = (root, dir, sha256) => change(root, (notes) => [...notes.filter((n) => n.dir !== resolve(dir)), { dir: resolve(dir), sha256 }]);

/** Drops a plugin folder’s note. @param {string} root @param {string} dir */
export const dropPlugin = (root, dir) => change(root, (notes) => notes.filter((n) => n.dir !== resolve(dir)));

/** Whether .agents or .agents/plugins, above a plugin folder, is a link. @param {string} dir */
async function linkAbove(dir) {
  for (const up of [dirname(dir), dirname(dirname(dir))]) if ((await lstat(up).catch(() => null))?.isSymbolicLink()) return true;
  return false;
}

/** Whether a path is gone: only a missing one is, not one that can’t be looked at. @param {string} path */
const gone = (path) =>
  lstat(path).then(
    () => false,
    (/** @type {any} */ e) => e?.code === 'ENOENT',
  );

/**
 * Removes a plugin folder, and the folders above it that held only it; says whether it’s gone, or 'link' when it was
 * left for a link above it. The one removal both a turn and the sweep make. `throughLinks`: a turn removes what it wrote
 * moments before through the same path, so a link above leads where its write went; the sweep, days later perhaps,
 * refuses a link above, which could lead anywhere.
 * @param {string} dir @param {{ throughLinks: boolean }} opts @returns {Promise<boolean | 'link'>}
 */
export async function removePluginFolder(dir, { throughLinks }) {
  if (!throughLinks && (await linkAbove(dir))) return 'link';
  await rm(dir, { recursive: true, force: true });
  for (const up of [dirname(dir), dirname(dirname(dir))]) await rmdir(up).catch(() => {});
  return gone(dir);
}

/** The most a plugin’s mcp_config.json runs to: one server and its URL, well under this. */
const MOST = 64 * 1024;

/**
 * Whether the folder is still the plugin noted, by its mcp_config.json. Read only when that’s a regular file of a sane
 * size, never a link, a FIFO or a device: a read of one could hang Postbox’s start, or never end. @param {Note} note
 */
async function stillOurs(note) {
  const config = join(note.dir, 'mcp_config.json');
  const st = await lstat(config).catch(() => null);
  if (!st?.isFile() || st.size > MOST) return false;
  // A FIFO swapped in between the lstat and the read would still block; that needs a live writer in the agent’s folder
  // as Postbox starts, and isn’t guarded.
  return readFile(config, 'utf8').then(
    (text) => configHash(text) === note.sha256,
    () => false,
  );
}

/**
 * Removes every plugin still noted, as Postbox starts, that is still the one its turn wrote. Only a path that ends in
 * the plugin’s own folder is removed, so a record edited by hand can’t point the removal elsewhere. A plugin that
 * couldn’t be removed is logged and stays noted for the next start; one that isn’t the noted plugin, or has a link
 * above it, is left as it is and its note dropped. @param {string} root
 */
export async function sweepAgyPlugins(root) {
  const notes = await noted(root);
  if (!notes.length) return;
  /** @type {Note[]} */
  const left = [];
  for (const note of notes) {
    if (!note.dir.endsWith(sep + PLUGIN_DIR) || (await gone(note.dir)) || !(await stillOurs(note))) continue;
    const removed = await removePluginFolder(note.dir, { throughLinks: false }).catch(() => false);
    if (removed === 'link') console.error(`Postbox left ${note.dir} as it is: a link stands where the Antigravity plugin’s folders go.`);
    if (removed) continue;
    console.error(
      `Postbox couldn’t remove the Antigravity plugin a stopped turn left at ${note.dir}. It tries again at the next start; you can delete that folder yourself.`,
    );
    left.push(note);
  }
  await change(root, () => left).catch((e) =>
    console.error(
      `Postbox couldn’t update ${recordIn(root)} (${e instanceof Error ? e.message : e}). Check that Postbox can write to its data folder; it tries again at the next start.`,
    ),
  );
}
