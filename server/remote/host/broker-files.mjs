// Files in the agent’s folder on the host (#120): show_app’s and update_app’s codePath and files, which Postbox can’t
// read, read by the daemon’s broker before the call crosses. broker.mjs’s header says why each file is checked
// twice.

import { constants as fsConstants, promises as fsp } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { LIMITS, limitText } from '../../../shared/limits.mjs';
import { count } from './broker-state.mjs';

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** @typedef {{ ok: true, args: Record<string, any> } | { ok: false, text: string }} Prepared */

/** Whether a real path is the folder or under it. @param {string} root @param {string} real */
const inside = (root, real) => real === root || real.startsWith(root === sep ? root : root + sep);
/**
 * How a checked file is opened: never through a link at the end of its path (one swapped in after the check fails
 * with ELOOP), and never waiting on a FIFO swapped in for it. Neither flag changes how a regular file reads.
 */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Whether the file an open descriptor reads is in the folder, found from the descriptor, not the path, so a folder on
 * the path swapped for a link after the check is caught too. Linux’s /proc/self/fd names the file itself. Without
 * /proc (macOS), the path is resolved again and must still be in the folder and be the very file opened (device and
 * inode): a swap before the open makes it name another file, or one outside.
 * @param {import('node:fs/promises').FileHandle} fh @param {string} root @param {string} real
 */
async function openedInside(fh, root, real) {
  const named = await fsp.readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
  if (named !== null) return inside(root, named);
  const now = await fsp.realpath(real).catch(() => null);
  if (!now || !inside(root, now)) return false;
  const [a, b] = await Promise.all([fh.stat({ bigint: true }), fsp.lstat(now, { bigint: true })]);
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Reads a file the agent named, in its folder on the host, followed through links so a link can’t reach outside it.
 * server/runtime.mjs’s agentFile, with one folder. The agent can change its folder while this runs, so the path is
 * checked, then the file opened is checked again (openedInside), and what’s read comes from that open file.
 * @param {string} folder @param {unknown} path @param {number} max @param {string} what
 * @param {{ beforeOpen?: (real: string) => unknown }} [hooks]  for tests: beforeOpen runs between the check and the open
 * @returns {Promise<{ ok: true, buf: Buffer } | { ok: false, text: string }>}
 */
async function folderFile(folder, path, max, what, hooks = {}) {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, text: `${what} needs a path to a file in your folder.` };
  const root = await fsp.realpath(folder).catch(() => null);
  if (!root) return { ok: false, text: `Your folder on this host, ${folder}, isn’t there, so Postbox couldn’t read ${what}.` };
  const real = await fsp.realpath(resolve(folder, path)).catch(() => null);
  if (!real) return { ok: false, text: `There’s no file at ${path} (${what}).` };
  const outside = { ok: /** @type {const} */ (false), text: `${path} is outside your folder, so Postbox didn’t read it (${what}).` };
  if (!inside(root, real)) return outside;
  const over = { ok: /** @type {const} */ (false), text: `${path} is over the limit for ${what}.` };
  let fh;
  try {
    await hooks.beforeOpen?.(real);
    fh = await fsp.open(real, OPEN_FLAGS);
    if (!(await openedInside(fh, root, real))) return outside;
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, text: `${path} isn’t a file (${what}).` };
    if (st.size > max) return over;
    // A file still being written can grow after the stat, so the read itself stops one byte past the limit.
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, max + 1 - total));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > max) return over;
    }
    return { ok: true, buf: Buffer.concat(chunks, total) };
  } catch (e) {
    // ELOOP: the file became a link after the check.
    if (e.code === 'ELOOP') return outside;
    return { ok: false, text: `Couldn’t read ${path} (${what}): ${e.message}` };
  } finally {
    await fh?.close();
  }
}

/**
 * show_app’s and update_app’s codePath and files, read from the agent’s folder: server/runtime.mjs’s appFiles, except
 * that the files go in the call as base64 for Postbox to store.
 * @param {string} folder @param {Record<string, any>} args @param {{ beforeOpen?: (real: string) => unknown }} [hooks]  for tests
 * @returns {Promise<Prepared>}
 */
export async function inlineAppFiles(folder, args, hooks = {}) {
  const { codePath, files: wanted, ...rest } = args;
  /** @type {Record<string, any>} */
  const out = { ...rest };
  if (codePath !== undefined) {
    if (typeof rest.code === 'string' && rest.code) return { ok: false, text: 'Send code or codePath, not both.' };
    // A character is at most 4 bytes, so a file within the limit in characters is within 4 times it in bytes.
    const r = await folderFile(folder, codePath, LIMITS.appCode * 4, 'codePath', hooks);
    if (!r.ok) return r;
    out.code = r.buf.toString('utf8');
    if (out.code.length > LIMITS.appCode)
      return { ok: false, text: `${codePath} has ${count(out.code.length)} characters; an app’s code is up to ${limitText('appCode')}.` };
  }
  if (wanted === undefined) return { ok: true, args: out };
  if (!Array.isArray(wanted)) return { ok: false, text: 'files is a list: [{ name?, path }].' };
  if (wanted.length > LIMITS.appFiles) return { ok: false, text: `An app carries up to ${limitText('appFiles')} data files.` };
  /** @type {{ name: string, base64: string }[]} */
  const files = [];
  for (const f of wanted) {
    const path = typeof f === 'string' ? f : f?.path;
    const name = String((typeof f === 'object' && f?.name) || basename(String(path ?? '')));
    if (!FILE_NAME.test(name)) return { ok: false, text: `“${name}” can’t name a file: use letters, digits and - _ . (up to 64).` };
    if (files.some((x) => x.name === name)) return { ok: false, text: `Two files are named “${name}”.` };
    const r = await folderFile(folder, path, LIMITS.appFileBytes, `the file “${name}” (up to ${limitText('appFileBytes')})`, hooks);
    if (!r.ok) return r;
    files.push({ name, base64: r.buf.toString('base64') });
  }
  out.files = files;
  return { ok: true, args: out };
}
