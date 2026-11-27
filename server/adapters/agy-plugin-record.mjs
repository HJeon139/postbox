// Where Postbox wrote an Antigravity turn’s plugin (#314). A turn writes .agents/plugins/postbox/ into the agent’s
// folder and removes it in a finally as the turn ends (antigravity-cli.mjs). A Postbox killed mid-turn (SIGKILL, a
// crash, a power loss) never runs that finally, and the plugin stayed: the person’s own agy sessions in that folder
// loaded Postbox’s rules and an MCP URL for a Postbox no longer running, out of git status, as the folder is in
// .git/info/exclude. So each plugin is noted before it’s written, in agy-plugins.json beside Postbox’s work root (its
// data folder: the work root holds only the agents’ folders), and dropped once it’s removed, and as Postbox starts,
// before any turn, every one still noted is removed.

import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const FILE = 'agy-plugins.json';
/** The record, beside the work root. @param {string} root  the work root */
const recordIn = (root) => join(dirname(root), FILE);
/** The plugin folder’s own path under an agent’s folder, as agy-plugin.mjs’s PLUGIN_DIR names it. */
const TAIL = join('.agents', 'plugins', 'postbox');

/** Per work root, the last change to its record, so turns in different folders change it one at a time. */
const chains = new Map();

/** Changes the record: written beside it and renamed, so a crash never leaves half of it. */
function change(/** @type {string} */ root, /** @type {(dirs: string[]) => string[]} */ fn) {
  const next = (chains.get(root) ?? Promise.resolve()).then(async () => {
    const dirs = await noted(root);
    const after = fn(dirs);
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

/** The plugin folders noted, or none for a record that’s missing or can’t be read. @param {string} root */
async function noted(root) {
  try {
    const dirs = JSON.parse(await readFile(recordIn(root), 'utf8'));
    return Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** Notes a plugin folder before it’s written. @param {string} root @param {string} dir */
export const notePlugin = (root, dir) => change(root, (dirs) => (dirs.includes(resolve(dir)) ? dirs : [...dirs, resolve(dir)]));

/** Drops a plugin folder once it’s removed. @param {string} root @param {string} dir */
export const dropPlugin = (root, dir) => change(root, (dirs) => dirs.filter((d) => d !== resolve(dir)));

/**
 * Removes every plugin still noted, as Postbox starts, and the folders above it that held only it. Only a path that
 * ends in the plugin’s own folder is removed, so a record edited by hand can’t point the removal elsewhere. A failure
 * is logged, and the path stays noted for the next start. @param {string} root
 */
export async function sweepAgyPlugins(root) {
  const dirs = await noted(root);
  if (!dirs.length) return;
  const left = [];
  for (const dir of dirs) {
    if (!dir.endsWith(sep + TAIL)) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      for (const up of [dirname(dir), dirname(dirname(dir))]) await rmdir(up).catch(() => {});
    } catch (e) {
      console.error(
        `Postbox couldn’t remove the Antigravity plugin a stopped turn left in ${dirname(dirname(dirname(dir)))}: ${e instanceof Error ? e.message : e}`,
      );
      left.push(dir);
    }
  }
  await change(root, () => left);
}
