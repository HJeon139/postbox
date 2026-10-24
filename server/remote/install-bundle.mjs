// What an install ships (install.mjs, whose header is the design): every file under server/remote/host/ and what it
// imports, transitively, with a package.json, each file’s SHA-256 in the manifest, packed in a minimal ustar.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPaths } from '../../shared/remote-protocol.mjs';
import { checkHostPath } from '../../shared/remote-settings.mjs';

/** The repo’s top folder, whose layout the host’s copy keeps. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The manifest’s name, at the top of the version’s folder. */
export const MANIFEST = 'manifest.sha256';
/** The node-path file’s name, at the top of the version’s folder (the launcher reads it). */
export const NODE_PATH_FILE = 'node-path';
/** A shipped file’s path: plain ASCII parts, so it fits a ustar name and a manifest line, and no shell splits it. */
const SHIP_PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

// A static import or re-export at the start of a line: import '…', import … from '…', export * from '…' or
// export { … } from '…'. The names between may span lines. Comments start with // or *, so one isn’t matched.
const SPECIFIERS = /^\s*(?:import\s*(?:[\w$*{}\s,]+?\s*from\s*)?|export\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*)['"]([^'"]+)['"]/gm;

/**
 * The host code’s files: every regular file under server/remote/host/, whatever its name (the `host` launcher has no
 * extension), and everything they import, transitively, starting also from the tool list the shim serves
 * (shared/mcp-tools.mjs) and the protocol (shared/remote-protocol.mjs). Each file is read and scanned for imports;
 * shared/catalog.mjs imports ./urls.mjs, so the first level isn’t enough. `problems` lists anything that mustn’t ship:
 * a file outside shared/ or server/remote/host/, a bare package import, something under the folder that isn’t a
 * regular file or a folder (a symlink could lead anywhere), or a name a ustar header or a manifest line can’t carry.
 * @param {string} [root]  the repo’s top folder
 * @returns {{ files: string[], problems: string[] }} files: relative to root, with /, sorted
 */
export function hostFiles(root = ROOT) {
  const host = join(root, 'server', 'remote', 'host');
  const allowed = [join(root, 'shared') + sep, host + sep];
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const start = [join(root, 'shared', 'mcp-tools.mjs'), join(root, 'shared', 'remote-protocol.mjs')];
  if (existsSync(host))
    for (const f of readdirSync(host, { recursive: true, encoding: 'utf8' })) {
      const path = join(host, f);
      const st = lstatSync(path);
      if (st.isFile()) start.push(path);
      else if (!st.isDirectory()) problems.push(`${relative(root, path)} isn’t a regular file or a folder`);
    }
  const checked = new Set();
  const queue = [...start];
  while (queue.length) {
    const file = /** @type {string} */ (queue.shift());
    if (checked.has(file)) continue;
    checked.add(file);
    const rel = relative(root, file);
    if (!allowed.some((dir) => file.startsWith(dir))) {
      problems.push(`${rel} is outside shared/ and server/remote/host/`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`${rel} doesn’t exist`);
      continue;
    }
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIERS)) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) queue.push(resolve(dirname(file), spec));
      else problems.push(`${rel} imports the package “${spec}”`);
    }
  }
  const files = [...checked]
    .filter((f) => allowed.some((dir) => f.startsWith(dir)) && existsSync(f))
    .map((f) => relative(root, f).split(sep).join('/'))
    .sort();
  for (const f of files) if (!SHIP_PATH_RE.test(f) || f.length > 100) problems.push(`${f} isn’t a name the install can carry`);
  return { files, problems };
}

/**
 * The files that ship, read, with the manifest and the tar.
 * @param {{ version: string, nodePath?: string | null, root?: string, mtime?: number }} o
 *   nodePath: the host’s nodePath setting, which goes in as node-path. mtime: seconds since the epoch, for each entry.
 * @returns {{ files: { path: string, data: Buffer, mode: number }[], manifest: string, tar: Buffer }}
 */
export function bundle({ version, nodePath = null, root = ROOT, mtime = Math.floor(Date.now() / 1000) }) {
  checkVersion(version);
  const { files: paths, problems } = hostFiles(root);
  if (problems.length) throw new Error(`Postbox’s host code can’t ship as it is: ${problems.join('; ')}.`);
  if (!paths.length) throw new Error('Postbox found none of its host code to install.');
  const files = paths.map((path) => {
    const full = join(root, ...path.split('/'));
    // The launcher is the one program run by name; everything else is read by node.
    return { path, data: readFileSync(full), mode: statSync(full).mode & 0o100 ? 0o700 : 0o600 };
  });
  const pkg = `${JSON.stringify({ name: 'postbox', version, private: true, type: 'module' }, null, 2)}\n`;
  files.push({ path: 'package.json', data: Buffer.from(pkg), mode: 0o600 });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = files.map((f) => `${sha256(f.data)}  ${f.path}\n`).join('');
  const entries = [...files, { path: MANIFEST, data: Buffer.from(manifest), mode: 0o600 }];
  if (nodePath !== null && nodePath !== undefined) {
    const c = checkHostPath(nodePath, 'nodePath');
    if (!c.ok) throw new TypeError(c.error);
    entries.push({ path: NODE_PATH_FILE, data: Buffer.from(`${c.value}\n`), mode: 0o600 });
  }
  return { files, manifest, tar: ustar(entries, mtime) };
}

/** @param {Buffer} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * A ustar archive of regular files (POSIX.1-1988’s format, as pax(1) describes it): a 512-byte header per file, its
 * data padded to 512 bytes, then two zero blocks. Names are ASCII and at most 100 bytes (hostFiles checks), owners
 * are 0 with no names, and parent folders aren’t entries: tar makes them, under the host’s umask.
 * @param {{ path: string, data: Buffer, mode: number }[]} entries @param {number} mtime
 */
export function ustar(entries, mtime) {
  const blocks = [];
  for (const e of entries) {
    if (!SHIP_PATH_RE.test(e.path) || e.path.length > 100) throw new TypeError(`${e.path} can’t be a ustar name.`);
    const h = Buffer.alloc(512);
    /** @param {string} s @param {number} at @param {number} len */
    const put = (s, at, len) => h.write(s, at, len, 'ascii');
    /** An octal field: digits, zero-padded, then NUL. @param {number} n @param {number} len */
    const oct = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`;
    put(e.path, 0, 100);
    put(oct(e.mode, 8), 100, 8);
    put(oct(0, 8), 108, 8); // uid
    put(oct(0, 8), 116, 8); // gid
    put(oct(e.data.length, 12), 124, 12);
    put(oct(mtime, 12), 136, 12);
    h.fill(0x20, 148, 156); // the checksum counts its own field as spaces
    put('0', 156, 1); // a regular file
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A version the host’s paths and a shell can both take, else a TypeError. @param {string} version */
export function checkVersion(version) {
  hostPaths('/', version);
  // hostPaths allows letters, digits, . + and -; checked again here, since a shell reads it.
  if (!/^[A-Za-z0-9.+-]+$/.test(version)) throw new TypeError(`“${version}” isn’t a version Postbox installs.`);
  return version;
}
