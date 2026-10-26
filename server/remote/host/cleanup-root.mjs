// ~/.postbox-remote itself (cleanup.mjs’s header, #120): whether it’s safe to clean, and the older versions in it
// that retire.

import { promises as fsp } from 'node:fs';
import { hostPaths, REMOTE_DIR } from '../../../shared/remote-protocol.mjs';
import { INSTALLED, lstat, readJson } from './cleanup-files.mjs';
import { LOCK_OWNER, lockOwnerLive, parseLockOwner } from './proc.mjs';

/** @typedef {import('./cleanup-files.mjs').Cleanup} Cleanup @typedef {import('./cleanup-files.mjs').Swept} Swept */

/** A start lock with no owner record yet, younger than this, is one an attach or install just made (daemon.mjs’s LOCK_STALE_MS). */
export const LOCK_FRESH_MS = 30_000;

/** Compares two installed versions, such as 0.9.0 and 0.10.0. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// ── Versions ──

/** Whether a version’s daemon.pid names a live daemon. @param {Cleanup} cl @param {string} code */
export async function daemonHolds(cl, code) {
  const r = await readJson(`${code}/daemon.pid`);
  if (!r || !Number.isSafeInteger(r.pid) || typeof r.bootId !== 'string' || !Number.isSafeInteger(r.startTime)) return false;
  return Boolean(await cl.sameProcess(r));
}

/** Whether a version’s start lock is held: its owner is live, or it has no owner record yet and is fresh. @param {Cleanup} cl @param {string} lock */
async function lockHeld(cl, lock) {
  const st = await lstat(lock);
  if (!st) return false;
  const text = await fsp.readFile(`${lock}/${LOCK_OWNER}`, 'utf8').catch(() => null);
  if (text === null) return cl.now() - st.mtimeMs < LOCK_FRESH_MS;
  return Boolean(await lockOwnerLive(parseLockOwner(text), { sameProcess: cl.sameProcess }));
}

/**
 * Deletes older versions’ code folders that nothing uses, if this is the newest version installed.
 * @param {Cleanup} cl @param {Map<string, number>} running  turns running, by the version that started them
 * @param {Swept} done
 */
export async function retire(cl, running, done) {
  const { p, version } = cl;
  /** @type {string[]} */
  const versions = [];
  for (const name of await fsp.readdir(p.root).catch(() => [])) {
    if (!INSTALLED.test(name)) continue;
    if ((await lstat(`${p.root}/${name}`))?.isDirectory()) versions.push(name);
  }
  if (!INSTALLED.test(version) || versions.some((v) => compareVersions(v, version) > 0)) return;
  for (const v of versions.filter((x) => compareVersions(x, version) < 0)) {
    const code = `${p.root}/${v}`;
    const why = running.get(v)
      ? `${running.get(v)} of its turns still running`
      : (await daemonHolds(cl, code))
        ? 'its daemon still running'
        : (await lockHeld(cl, hostPaths(cl.home, v).lock))
          ? 'an attach or install holding its start lock'
          : '';
    if (why) {
      done.skipped.push(v);
      continue;
    }
    await fsp.rm(code, { recursive: true, force: true });
    done.retired.push(v);
    cl.log(`Retired version ${v}: deleted ${code}.`);
  }
}

// ── The root ──

/** Why ~/.postbox-remote isn’t safe to clean, or '' if it is (or isn’t there). @param {Cleanup} cl */
export async function rootProblem(cl) {
  const { p, home } = cl;
  const st = await lstat(p.root);
  if (!st) return '';
  if (st.isSymbolicLink() || !st.isDirectory()) return `${p.root} isn’t a folder (it’s a link or a file), so Postbox won’t delete anything in it.`;
  let realHome;
  let realRoot;
  try {
    realHome = await fsp.realpath(home);
    realRoot = await fsp.realpath(p.root);
  } catch (e) {
    return `Couldn’t resolve ${p.root}: ${e.message}`;
  }
  if (realRoot !== `${realHome === '/' ? '' : realHome}/${REMOTE_DIR}`)
    return `${p.root} resolves to ${realRoot}, which isn’t ${REMOTE_DIR} in the home folder, so Postbox won’t delete it.`;
  const turns = await lstat(p.turns);
  if (turns && !turns.isDirectory()) return `${p.turns} isn’t a folder (it’s a link or a file), so Postbox won’t delete anything in it.`;
  return '';
}
