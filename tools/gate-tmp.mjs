// The gate’s own temp folder for a run (#797). npm run check runs its test stages with TMPDIR set to a fresh
// pb-gate-<pid>-XXXXXX under the system temp folder and removes it at the end, so whatever the tests leave goes with
// it. A run that’s killed can’t remove its own, so each run first sweeps the folders of earlier ones: a real folder,
// not a link, owned by this user, whose gate process has exited, and, only as a backstop, last changed over an hour ago.
// The pid in a name is the gate’s in its own pid namespace. A pid reused by another process keeps a dead run’s folder
// until that process ends. A run in another namespace (a container sharing this temp folder) names a pid this one
// can’t see, so it looks dead here, and only the hour’s age keeps its folder while it runs. Without a user id
// (Windows) there’s no owner to check, so the sweep doesn’t run.

import * as nodeFs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PREFIX = 'pb-gate-';
export const STALE_MS = 60 * 60 * 1000;
const NAME_RE = /^pb-gate-(\d+)-[A-Za-z0-9]{6}$/;

/**
 * @typedef {{ fs: typeof nodeFs, tmpdir: () => string, pid: number, uid: number | undefined,
 *   kill: (pid: number, signal: number) => unknown, now: () => number, home: string, checkout: string }} Deps
 */

/** @returns {Deps} */
export const defaultDeps = () => ({
  fs: nodeFs,
  tmpdir,
  pid: process.pid,
  uid: process.getuid?.(),
  kill: (pid, signal) => process.kill(pid, signal),
  now: Date.now,
  home: homedir(),
  checkout: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
});

const inside = (/** @type {string} */ dir, /** @type {string} */ parent) => {
  const r = relative(resolve(parent), resolve(dir));
  return r === '' || (!r.startsWith('..') && !r.startsWith('/'));
};

/**
 * Where run folders go: the system temp folder, or /tmp where TMPDIR points inside the checkout or the home folder.
 * Some tests fail when their temp folder is inside a git working tree.
 * @param {Pick<Deps, 'tmpdir' | 'home' | 'checkout'>} d
 */
export function runBase(d) {
  const base = d.tmpdir();
  return inside(base, d.checkout) || inside(base, d.home) ? '/tmp' : base;
}

/** Whether a pid still runs: signal 0 sends nothing, and only ESRCH says it has exited. */
function alive(/** @type {Deps['kill']} */ kill, /** @type {number} */ pid) {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code !== 'ESRCH';
  }
}

/**
 * Gives the owner write access to every real folder under path, so rm can remove a folder a killed test left
 * read-only. It reads each entry with lstat and never chmods or enters a link, which chmod would follow. Files keep
 * their mode: unlinking one needs only its folder’s write bit, and a file hard-linked in from outside shares its
 * mode with the one outside, which lstat can’t tell apart (#815).
 * @param {typeof nodeFs} fs @param {string} path
 */
export function makeWritable(fs, path) {
  const st = fs.lstatSync(path, { throwIfNoEntry: false });
  // The link check is spelled out though the directory check below would also stop a link: keep both, so a later
  // edit to either can’t let chmod or readdir follow one. A folder swapped for a link between this lstat and
  // the chmod or readdir below would be followed; that needs write access inside a 0700 folder of this user’s, so
  // it’s accepted.
  if (!st || st.isSymbolicLink()) return;
  if (!st.isDirectory()) return;
  fs.chmodSync(path, (st.mode & 0o7777) | 0o700);
  for (const name of fs.readdirSync(path)) makeWritable(fs, join(path, name));
}

/** Removes a folder and everything in it; rm with recursive doesn’t follow links. @param {typeof nodeFs} fs @param {string} path */
export function removeAll(fs, path) {
  makeWritable(fs, path);
  fs.rmSync(path, { recursive: true, force: true });
}

/** Whether a temp folder entry is a killed run’s folder that’s safe to remove. @param {Deps} d @param {string} name @param {string} path */
function stale(d, name, path) {
  const m = NAME_RE.exec(name);
  if (!m) return false;
  const st = d.fs.lstatSync(path, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return false;
  if (st.uid !== d.uid) return false;
  if (alive(d.kill, Number(m[1]))) return false;
  return d.now() - st.mtimeMs > STALE_MS;
}

/** Removes the folders earlier runs left, and returns their paths. @param {Deps} d */
export function sweep(d) {
  /** @type {string[]} */
  const removed = [];
  if (d.uid === undefined) return removed;
  const base = runBase(d);
  /** @type {string[]} */
  let names;
  try {
    names = d.fs.readdirSync(base);
  } catch {
    // A temp folder this user can’t list has no leftovers of theirs to find.
    return removed;
  }
  for (const name of names) {
    const path = join(base, name);
    try {
      if (!stale(d, name, path)) continue;
      removeAll(d.fs, path);
      removed.push(path);
    } catch {
      // Another run removed it first, or it can’t be removed: the next run tries again.
    }
  }
  return removed;
}

/** A run’s folder: open() sweeps leftovers and makes a fresh one; list() names what is in it; close() removes it. @param {Deps} [d] */
export function gateRunDir(d = defaultDeps()) {
  return {
    open() {
      sweep(d);
      const path = d.fs.mkdtempSync(join(runBase(d), `${PREFIX}${d.pid}-`));
      return { path, close: () => removeAll(d.fs, path), list: () => d.fs.readdirSync(path) };
    },
  };
}
