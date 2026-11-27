// The custom agent a local Kiro turn writes (#1864): agents/postbox-<handle>-<8 hex>.json in the turn’s Kiro home, with
// Postbox’s MCP URL for that conversation and its guide (kiro-cli.mjs). The turn removes it in a finally as it ends. A
// Postbox killed mid-turn (SIGKILL, a crash, a power loss) never runs that finally, and the file stayed: with your own
// Kiro setup, a dead agent in your kiro-cli agent list, a new one each turn. So each file is noted before it’s written,
// in kiro-agents.json in Postbox’s data folder, beside its work root (which holds only the agents’ folders), and
// dropped once it’s gone, and as Postbox starts, before any turn, every one still noted is removed, if it’s still the
// file the turn wrote: a note keeps a hash of its text, whose MCP URL carries the turn’s own token. Only a file named as
// Postbox names one, in an agents folder that isn’t a link, is ever removed, so the person’s other agents, and whatever a
// link at agents leads to, are never touched.

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const FILE = 'kiro-agents.json';
/** The name kiro-cli.mjs gives a turn’s agent: postbox-, the handle’s letters, digits, _ and -, and 8 hex. */
const OURS = /^postbox-[A-Za-z0-9_-]*-[0-9a-f]{8}\.json$/;
/** The record, beside the work root. @param {string} root  the work root */
const recordIn = (root) => join(dirname(root), FILE);
/** Whether a path is a turn’s agent file, by its name and its folder’s. @param {string} file */
const isOurs = (file) => OURS.test(basename(file)) && basename(dirname(file)) === 'agents';

/** The hash a note keeps of an agent file’s text. @param {string} text */
const hashOf = (text) => createHash('sha256').update(text).digest('hex');
/** @typedef {{ file: string, sha256: string }} Note */

/** Per work root, the last change to its record, so turns change it one at a time. */
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

/** The files noted, or none for a record that’s missing or can’t be read. @param {string} root @returns {Promise<Note[]>} */
async function noted(root) {
  try {
    const notes = JSON.parse(await readFile(recordIn(root), 'utf8'));
    return Array.isArray(notes) ? notes.filter((n) => typeof n?.file === 'string' && typeof n?.sha256 === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether the file is still the one noted, by its text. @param {Note} note */
const stillOurs = (note) =>
  readFile(note.file, 'utf8').then(
    (text) => hashOf(text) === note.sha256,
    () => false,
  );

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
  await change(root, (notes) => [...notes.filter((n) => n.file !== resolve(file)), { file: resolve(file), sha256: hashOf(text) }]);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/**
 * Removes a turn’s agent file, and drops its note once it’s gone: one that couldn’t be removed stays noted.
 * @param {string} file @param {string} root  the work root
 */
export async function removeKiroAgent(file, root) {
  await rm(file, { force: true }).catch(() => {});
  if (await gone(file)) await change(root, (notes) => notes.filter((n) => n.file !== resolve(file))).catch(() => {});
}

/**
 * Removes every agent file still noted, as Postbox starts, that is still the file its turn wrote. A path that isn’t a
 * turn’s agent file, one whose text isn’t the noted one, or one in an agents folder that’s a link, is dropped from the
 * record and left; a failure is logged, and stays noted for the next start. @param {string} root  the work root
 */
export async function sweepKiroAgents(root) {
  const notes = await noted(root);
  if (!notes.length) return;
  /** @type {Note[]} */
  const left = [];
  for (const note of notes) {
    if (!isOurs(note.file) || (await gone(note.file)) || !(await stillOurs(note))) continue;
    // A link at agents would lead the removal into another folder: it’s never followed.
    if ((await lstat(dirname(note.file)).catch(() => null))?.isSymbolicLink()) {
      console.error(`Postbox left ${note.file} as it is: its agents folder is a link.`);
      continue;
    }
    /** @type {unknown} */
    let why = null;
    await rm(note.file, { force: true }).catch((e) => {
      why = e;
    });
    if (await gone(note.file)) continue;
    const reason = why instanceof Error ? why.message : 'it’s still there';
    console.error(
      `Postbox couldn’t remove the Kiro agent a stopped turn left at ${note.file} (${reason}). It tries again at the next start; you can delete the file yourself.`,
    );
    left.push(note);
  }
  // Cleaning up never stops Postbox from starting: a record it can’t rewrite is tried again at the next start.
  await change(root, () => left).catch((e) =>
    console.error(
      `Postbox couldn’t update ${recordIn(root)} (${e instanceof Error ? e.message : e}). Check that Postbox can write to its data folder; it tries again at the next start.`,
    ),
  );
}
