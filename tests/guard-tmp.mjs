// Part of tests/guard.mjs (#823): a test writes temp files only under its run’s own temp folder, TMPDIR, which the
// gate removes at the end (tools/gate-tmp.mjs). A fixed path such as /tmp/pb-test-kiro-home outlives the run, and a
// run as another user then fails on it, so a write anywhere else under the system temp folder fails the test instead.
// It only applies where the run has a temp folder of its own (the gate’s pb-gate-*): with TMPDIR the system temp
// folder itself, there’s nothing to tell them apart.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Whether `path` is `dir` or inside it. */
const within = (/** @type {string} */ path, /** @type {string} */ dir) => {
  const r = relative(dir, path);
  return r === '' || (!r.startsWith('..') && !r.startsWith('/'));
};

/**
 * Where tempDir() makes a folder outside the run’s temp folder (a socket’s path that wouldn’t fit there): each is a
 * fresh mkdtemp name, which the helper removes, so writes under it are allowed.
 * @type {Set<string>}
 */
const helperPrefixes = new Set();

/** Lets writes under paths starting `prefix` (a root joined with tempDir’s prefix) through. @param {string} prefix */
export function allowHelperPrefix(prefix) {
  helperPrefixes.add(resolve(prefix));
}

/**
 * Whether a write to `path` lands under the system temp folder (the one holding `runTemp`, or /tmp) but outside
 * `runTemp` and outside the folders tempDir() made.
 * @param {string} path
 * @param {string} runTemp
 */
export function outsideRunTemp(path, runTemp) {
  const target = resolve(path);
  const run = resolve(runTemp);
  if (within(target, run)) return false;
  if ([...helperPrefixes].some((prefix) => target.startsWith(prefix))) return false;
  return within(target, dirname(run)) || within(target, '/tmp');
}

/** A path argument as a string, or undefined for a file descriptor. */
function pathOf(/** @type {unknown} */ p) {
  if (typeof p === 'string') return p;
  if (p instanceof URL) return fileURLToPath(p);
  if (Buffer.isBuffer(p)) return p.toString();
  return undefined;
}

/** Whether fs.open’s flags can create or change a file. */
export function openWrites(/** @type {unknown} */ flags) {
  if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0;
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return false;
}

/** Each fs function that makes something, and the index of the argument naming what it makes. */
const MAKES = { mkdir: 0, mkdtemp: 0, writeFile: 0, appendFile: 0, createWriteStream: 0, symlink: 1, link: 1, rename: 1, copyFile: 1, cp: 1 };

/**
 * Wraps fs, its sync forms and fs.promises so a write outside `runTemp` under the system temp folder throws.
 * @param {string} runTemp
 */
export function installTmpGuard(runTemp) {
  const refuse = (/** @type {string} */ fn, /** @type {unknown} */ arg) => {
    const path = pathOf(arg);
    if (path === undefined || !outsideRunTemp(path, runTemp)) return;
    throw new Error(`A test tried to ${fn} ${path}, outside its run’s temp folder (${runTemp}). Use tempDir() or os.tmpdir() (#823).`);
  };
  /** Replaces target[fn] with one that calls `before(args)` first. */
  const wrap = (/** @type {any} */ target, /** @type {string} */ fn, /** @type {(args: any[]) => void} */ before) => {
    const original = target[fn];
    if (typeof original !== 'function') return;
    target[fn] = function guarded(/** @type {any[]} */ ...args) {
      before(args);
      return original.apply(this, args);
    };
  };
  for (const [base, at] of Object.entries(MAKES)) {
    const before = (/** @type {any[]} */ args) => refuse(base, args[at]);
    for (const [target, fn] of [
      [fs, base],
      [fs, `${base}Sync`],
      [fs.promises, base],
    ])
      wrap(target, fn, before);
  }
  const beforeOpen = (/** @type {any[]} */ args) => {
    if (openWrites(args[1])) refuse('open', args[0]);
  };
  for (const [target, fn] of [
    [fs, 'open'],
    [fs, 'openSync'],
    [fs.promises, 'open'],
  ])
    wrap(target, fn, beforeOpen);
  syncBuiltinESMExports();
}
