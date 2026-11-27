// The custom agent a local Kiro turn writes (#1864): agents/postbox-<handle>-<8 hex>.json in the turn’s Kiro home, with
// Postbox’s MCP URL for that conversation and its guide (kiro-cli.mjs). The turn removes it in a finally as it ends. A
// Postbox killed mid-turn (SIGKILL, a crash, a power loss) never runs that finally, and the file stayed: with your own
// Kiro setup, a dead agent in your kiro-cli agent list, a new one each turn. So each file is noted before it’s written,
// in kiro-agents.json beside Postbox’s work root (its data folder: the work root holds only the agents’ folders), and
// dropped once it’s gone, and as Postbox starts, before any turn, every one still noted is removed. Only a file named as
// Postbox names one, in an agents folder, is ever removed, so the person’s other agents are never touched.

import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const FILE = 'kiro-agents.json';
/** The name kiro-cli.mjs gives a turn’s agent: postbox-, the handle’s letters, digits, _ and -, and 8 hex. */
const OURS = /^postbox-[A-Za-z0-9_-]*-[0-9a-f]{8}\.json$/;
/** The record, beside the work root. @param {string} root  the work root */
const recordIn = (root) => join(dirname(root), FILE);
/** Whether a path is a turn’s agent file, by its name and its folder’s. @param {string} file */
const isOurs = (file) => OURS.test(basename(file)) && basename(dirname(file)) === 'agents';

/** Per work root, the last change to its record, so turns change it one at a time. */
const chains = new Map();

/** Changes the record: written beside it and renamed, so a crash never leaves half of it. */
function change(/** @type {string} */ root, /** @type {(files: string[]) => string[]} */ fn) {
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

/** The files noted, or none for a record that’s missing or can’t be read. @param {string} root */
async function noted(root) {
  try {
    const files = JSON.parse(await readFile(recordIn(root), 'utf8'));
    return Array.isArray(files) ? files.filter((f) => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether a file is gone: only a missing one is, not one that can’t be looked at. @param {string} file */
const gone = (file) =>
  lstat(file).then(
    () => false,
    (/** @type {any} */ e) => e?.code === 'ENOENT',
  );

/**
 * Writes a turn’s agent file, its folder made if need be, noted first beside the work root.
 * @param {string} file @param {string} text @param {string} root  the work root
 */
export async function writeKiroAgent(file, text, root) {
  await change(root, (files) => (files.includes(resolve(file)) ? files : [...files, resolve(file)]));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/**
 * Removes a turn’s agent file, and drops its note once it’s gone: one that couldn’t be removed stays noted.
 * @param {string} file @param {string} root  the work root
 */
export async function removeKiroAgent(file, root) {
  await rm(file, { force: true }).catch(() => {});
  if (await gone(file)) await change(root, (files) => files.filter((f) => f !== resolve(file))).catch(() => {});
}

/**
 * Removes every agent file still noted, as Postbox starts. A path that isn’t a turn’s agent file is dropped from the
 * record, not removed; a failure is logged, and stays noted for the next start. @param {string} root  the work root
 */
export async function sweepKiroAgents(root) {
  const files = await noted(root);
  if (!files.length) return;
  const left = [];
  for (const file of files) {
    if (!isOurs(file)) continue;
    await rm(file, { force: true }).catch(() => {});
    if (await gone(file)) continue;
    console.error(`Postbox couldn’t remove the Kiro agent a stopped turn left at ${file}. It tries again at the next start.`);
    left.push(file);
  }
  await change(root, () => left);
}
