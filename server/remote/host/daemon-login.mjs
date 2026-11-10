// The daemon’s login PATH (login-path.mjs, #672, #474): the login shell is asked once per daemon start, at the first
// hello, and the programs are found on its PATH first. A turn whose harness isn’t found asks it again, since the
// person may have installed the CLI since: at most once per REPROBE_GAP_MS (#1084), so a host without it doesn’t start
// a login shell for every turn. Each turn runs with the merged PATH, unless the laptop sends one; when the login shell
// failed, a turn’s PATH is the daemon’s own, as before.

import { dirname } from 'node:path';
import { REMOTE_LIMITS } from '../../../shared/remote-protocol.mjs';
import { REPROBE_GAP_MS } from './daemon-constants.mjs';
import { mergePath } from './login-path.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon */

/** The login shell’s PATH entries, asked for once per daemon start. @param {Daemon} d @returns {Promise<string[]>} */
async function loginEntries(d) {
  d.loginProbe ??= d.probeLoginPath().then((r) => {
    d.loginPath = r;
  });
  await d.loginProbe;
  return d.loginPath?.ok ? d.loginPath.entries : [];
}

/** Finds the programs, the login shell’s PATH first (programs.mjs), into d.programs. @param {Daemon} d */
export async function findWithLogin(d) {
  const loginPath = await loginEntries(d);
  d.programs = await d.findPrograms({ home: d.home, settings: d.settings, loginPath });
}

/**
 * Asks the login shell again and finds the programs again, when a turn’s harness wasn’t found. One runs at a time, and
 * a call meanwhile waits for it. Once it settles, the next may start REPROBE_GAP_MS after it started, on the daemon’s
 * monotonic clock (#1084): a call inside that gap uses what it found, so a CLI installed since is found, and a host
 * without it doesn’t start a login shell for every turn.
 * @param {Daemon} d
 */
export async function reprobe(d) {
  const recent = d.reprobeAt !== null && d.mono() - d.reprobeAt < REPROBE_GAP_MS;
  if (!d.reprobed && !recent) {
    d.reprobeAt = d.mono();
    d.reprobed = probeAgain(d).finally(() => {
      d.reprobed = null;
    });
  }
  await d.reprobed;
}

/** One re-probe: the login shell asked again, then the programs found on its PATH. @param {Daemon} d */
async function probeAgain(d) {
  await loginEntries(d);
  // A re-probe that fails keeps the first probe’s PATH: losing it would lose every CLI found there, for good.
  const again = await d.probeLoginPath();
  if (again.ok || !d.loginPath?.ok) d.loginPath = again;
  await findWithLogin(d);
}

/** What the welcome says of the login PATH: how many entries and how long, never the entries. @param {Daemon} d */
export function welcomeLoginPath(d) {
  const r = d.loginPath;
  if (!r) return { ok: false, why: 'the login shell wasn’t asked.' };
  return r.ok ? { ok: true, entries: r.entries.length, ms: Math.round(r.ms) } : { ok: false, why: r.why.slice(0, REMOTE_LIMITS.messageChars) };
}

/**
 * A turn’s start.env: PATH is the merged one, under the laptop’s variables, so a PATH it sends wins. None when the
 * login shell failed, or start.env is at its limit of variables.
 * @param {Daemon} d @param {Record<string, string>} env  the start message’s
 */
export function turnEnv(d, env) {
  if (!d.loginPath?.ok || Object.hasOwn(env, 'PATH') || Object.keys(env).length >= REMOTE_LIMITS.envVars) return env;
  // The folder of the Node the daemon runs on comes after the login shell’s entries: on a host whose profile doesn’t put
  // a version manager’s Node on PATH, an agent still finds the one Postbox runs on, past what the terminal finds, on
  // purpose (#672). A profile’s own Node, earlier on PATH, still wins.
  const nodeDir = dirname(d.programs?.node?.path ?? process.execPath);
  const first = d.loginPath.entries.includes(nodeDir) ? d.loginPath.entries : [...d.loginPath.entries, nodeDir];
  return { PATH: mergePath(first, d.env.PATH, REMOTE_LIMITS.envValueBytes), ...env };
}
