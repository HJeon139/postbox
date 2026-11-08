// Files an agent names for an app (#54): its code (codePath) and data files, read from its own folders under the
// same limits as an inline call. Each is a Runtime method’s body, with the instance first, as in server/apps.mjs.

import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { LIMITS, limitText } from '../shared/limits.mjs';
import { workFolder } from './adapters/folder.mjs';
import { readCappedFrom } from './read-capped.mjs';
import { requestAdapter } from './remote/placement.mjs';

/** A data file of an app’s version, stored by its hash (#54). @typedef {{ name: string, sha256: string, size: number }} AppFile */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A file an agent named that Postbox can’t use; its message goes back to the agent. */
export class AgentFileError extends Error {}

// ── Files an agent names (#54) ─────────────────────────────────────────────────────

/** The folders an agent works in: its own (where it starts), the project’s, and any added for the conversation. */
export async function agentFolders(rt, sessionId) {
  const se = rt.session(sessionId);
  const persona = rt.personaFor(se);
  const project = rt.s.projects[rt.s.threads[se.threadId]?.projectId] ?? null;
  const adapter = requestAdapter(rt, se.handle, persona);
  const own = await workFolder(adapter, persona, project);
  return [...new Set([own, project?.folder, ...(se.addDirs ?? [])].filter(Boolean))];
}

/** Whether a path is one of the folders or under one. @param {(string | null)[]} roots @param {string} p */
const insideAny = (roots, p) => roots.some((r) => r && (p === r || p.startsWith(r + sep)));

/**
 * How a checked file is opened (#780): never through a link at the end of its path, so one swapped in after the
 * check fails with ELOOP (EMLINK on some BSDs), and never waiting on a FIFO swapped in for it, as
 * server/remote/host/broker-files.mjs opens one. Neither flag changes how a regular file reads.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Whether the file open is still the one checked at real (#780): real still resolves to itself, in the folders, and
 * names the very file open (device and inode). A folder on its path swapped for a link fails one or the other.
 * @param {import('node:fs').BigIntStats} opened @param {string} real @param {(string | null)[]} roots
 */
async function stillThere(opened, real, roots) {
  const now = await realpath(real).catch(() => null);
  if (now !== real || !insideAny(roots, now)) return false;
  const at = await lstat(real, { bigint: true }).catch(() => null);
  return !!at && at.dev === opened.dev && at.ino === opened.ino;
}

/**
 * Reads a file an agent named for an app: a path in one of its folders (relative to its own), followed through
 * links, so a link can’t reach outside them. The file is opened once, checked again, and read from what was opened,
 * so a link swapped in meanwhile isn’t followed (#780). Larger than max bytes is refused before it’s read.
 * A hard link in the folders to a file outside them is read, as any file there is (#828): it has no path outside to
 * check, the agent runs as the same user and could copy that file in, and show_app’s files have always read one.
 * The boundary is the folders’ paths, not where a file’s bytes first came from.
 * @param {any} rt  the Runtime @param {string} sessionId @param {unknown} path @param {number} max @param {string} what  how the error names it
 * @param {{ afterCheck?: () => unknown, afterOpen?: () => unknown, beforeRead?: () => unknown }} [hooks]  for tests:
 *   each runs at its step (after the path’s check, after the open, before the read), so a test can swap a file there
 */
export async function agentFile(rt, sessionId, path, max, what, hooks = {}) {
  if (typeof path !== 'string' || !path.trim()) throw new AgentFileError(`${what} needs a path to a file in your folder.`);
  const folders = await rt.agentFolders(sessionId);
  if (!folders.length) throw new AgentFileError(`You have no folder to read ${what} from. Send it inline instead.`);
  const named = resolve(folders[0], path);
  const real = await realpath(named).catch(() => null);
  if (!real) throw new AgentFileError(`There’s no file at ${path} (${what}).`);
  const roots = await Promise.all(folders.map((f) => realpath(f).catch(() => null)));
  if (!insideAny(roots, real)) {
    // A path in the folders that resolves outside them goes through a link there.
    const how = insideAny([...folders.map((f) => resolve(f)), ...roots], named) ? 'leads' : 'is';
    throw new AgentFileError(`${path} ${how} outside your folders, so Postbox didn’t read it (${what}).`);
  }
  await hooks.afterCheck?.();
  const changed = () => new AgentFileError(`${path} changed while Postbox read it, so Postbox didn’t read it (${what}). Try again once it’s settled.`);
  const fh = await open(real, OPEN_FLAGS).catch((e) => {
    throw e.code === 'ELOOP' || e.code === 'EMLINK' ? changed() : e;
  });
  try {
    await hooks.afterOpen?.();
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) throw new AgentFileError(`${path} isn’t a file (${what}).`);
    const over = () => new AgentFileError(`${path} is over the limit for ${what}.`);
    if (st.size > BigInt(max)) throw over();
    if (!(await stillThere(st, real, roots))) throw changed();
    await hooks.beforeRead?.();
    const buf = await readCappedFrom(fh, max);
    if (!buf) throw over();
    return buf;
  } finally {
    await fh.close();
  }
}

/**
 * show_app and update_app as an agent calls them over MCP (#54): code may come from codePath, a file in its folder,
 * and files names data files there for the app to read. Postbox reads both itself, under the same limits as an
 * inline call, and stores the data files with the version. Returns the call’s arguments with code filled in, and
 * the files as Postbox stored them; a call can’t name stored files itself.
 * @param {any} rt  the Runtime @param {string} sessionId @param {any} args
 * @returns {Promise<{ args: any, files?: AppFile[] }>}
 */
export async function appFiles(rt, sessionId, args) {
  const { codePath, files: wanted, ...rest } = args ?? {};
  const out = { ...rest };
  if (codePath !== undefined) {
    if (typeof rest.code === 'string' && rest.code) throw new AgentFileError('Send code or codePath, not both.');
    // A character is at most 4 bytes, so a file within the limit in characters is within 4 times it in bytes.
    out.code = (await rt.agentFile(sessionId, codePath, LIMITS.appCode * 4, 'codePath')).toString('utf8');
    if (out.code.length > LIMITS.appCode)
      throw new AgentFileError(`${codePath} has ${out.code.length.toLocaleString('en-US')} characters; an app’s code is up to ${limitText('appCode')}.`);
  }
  if (wanted === undefined) return { args: out };
  if (!Array.isArray(wanted)) throw new AgentFileError('files is a list: [{ name?, path }].');
  if (wanted.length > LIMITS.appFiles) throw new AgentFileError(`An app carries up to ${limitText('appFiles')} data files.`);
  if (!rt.blobs) throw new AgentFileError('This Postbox can’t store files.');
  /** @type {AppFile[]} */
  const stored = [];
  for (const f of wanted) {
    const path = typeof f === 'string' ? f : f?.path;
    const name = String((typeof f === 'object' && f?.name) || basename(String(path ?? '')));
    if (!FILE_NAME.test(name)) throw new AgentFileError(`“${name}” can’t name a file: use letters, digits and - _ . (up to 64).`);
    if (stored.some((x) => x.name === name)) throw new AgentFileError(`Two files are named “${name}”.`);
    const buf = await rt.agentFile(sessionId, path, LIMITS.appFileBytes, `the file “${name}” (up to ${limitText('appFileBytes')})`);
    const { sha256, size } = await rt.blobs.put(buf);
    stored.push({ name, sha256, size });
  }
  return { args: out, files: stored };
}
