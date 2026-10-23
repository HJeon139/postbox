// Files an agent names for an app (#54): its code (codePath) and data files, read from its own folders under the
// same limits as an inline call. Each is a Runtime method’s body, with the instance first, as in server/apps.mjs.

import { realpath, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { LIMITS, limitText } from '../shared/limits.mjs';
import { readCapped } from './read-capped.mjs';

/** A data file of an app’s version, stored by its hash (#54). @typedef {{ name: string, sha256: string, size: number }} AppFile */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A file an agent named that Postbox can’t use; its message goes back to the agent. */
export class AgentFileError extends Error {}

// ── Files an agent names (#54) ─────────────────────────────────────────────────────

/** The folders an agent works in: its own (where it starts), the project’s, and any added for the conversation. */
export async function agentFolders(rt, sessionId) {
  const se = rt.session(sessionId);
  const persona = rt.personaFor(se);
  const project = rt.s.projects[rt.s.threads[se.threadId]?.projectId] ?? null;
  const adapter = rt.adapters.get(persona?.backend);
  const own = adapter?.folderFor ? await adapter.folderFor(persona, project) : persona?.folder || project?.folder || null;
  return [...new Set([own, project?.folder, ...(se.addDirs ?? [])].filter(Boolean))];
}

/**
 * Reads a file an agent named for an app: a path in one of its folders (relative to its own), followed through
 * links, so a link can’t reach outside them. Larger than max bytes is refused before it’s read.
 * @param {any} rt  the Runtime @param {string} sessionId @param {unknown} path @param {number} max @param {string} what  how the error names it
 */
export async function agentFile(rt, sessionId, path, max, what) {
  if (typeof path !== 'string' || !path.trim()) throw new AgentFileError(`${what} needs a path to a file in your folder.`);
  const folders = await rt.agentFolders(sessionId);
  if (!folders.length) throw new AgentFileError(`You have no folder to read ${what} from. Send it inline instead.`);
  const real = await realpath(resolve(folders[0], path)).catch(() => null);
  if (!real) throw new AgentFileError(`There’s no file at ${path} (${what}).`);
  const roots = await Promise.all(folders.map((f) => realpath(f).catch(() => null)));
  if (!roots.some((r) => r && (real === r || real.startsWith(r + sep))))
    throw new AgentFileError(`${path} is outside your folders, so Postbox didn’t read it (${what}).`);
  const st = await stat(real);
  if (!st.isFile()) throw new AgentFileError(`${path} isn’t a file (${what}).`);
  const over = () => new AgentFileError(`${path} is over the limit for ${what}.`);
  if (st.size > max) throw over();
  const buf = await readCapped(real, max);
  if (!buf) throw over();
  return buf;
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
