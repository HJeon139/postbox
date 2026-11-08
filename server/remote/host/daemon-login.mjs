// The daemon’s login PATH (login-path.mjs, #672, #474): the login shell is asked once per daemon start, at the first
// hello, and the programs are found on its PATH first. A turn whose harness isn’t found asks it once more, since the
// person may have installed the CLI since: at most one more time per daemon start, so a host without it doesn’t start
// a login shell for every turn. Each turn runs with the merged PATH, unless the laptop sends one; when the login shell
// failed, a turn’s PATH is the daemon’s own, as before.

import { REMOTE_LIMITS } from '../../../shared/remote-protocol.mjs';
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
 * Asks the login shell once more and finds the programs again, when a turn’s harness wasn’t found. Only the first
 * call per daemon start asks; a later one, or one meanwhile, waits for that one.
 * @param {Daemon} d
 */
export async function reprobe(d) {
  d.reprobed ??= (async () => {
    await loginEntries(d);
    d.loginPath = await d.probeLoginPath();
    await findWithLogin(d);
  })();
  await d.reprobed;
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
  return { PATH: mergePath(d.loginPath.entries, d.env.PATH, REMOTE_LIMITS.envValueBytes), ...env };
}
