// Postbox’s `signins` (shared/remote-protocol.mjs, #1608): whether each harness this host has is signed in, asked of
// its own CLI and answered `signed`. Postbox asks after each welcome, so the person learns of a sign-in that ran out
// when the host connects, not when a turn fails there.

import { turnEnv } from './daemon-login.mjs';
import { send } from './daemon-reply.mjs';
import { STATUS_COMMANDS, STATUS_OUTPUT_CHARS } from './harness-signin.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */
/** @typedef {import('./harness-signin.mjs').SignIn} SignIn */

/** How long a status command may run before it’s stopped and its harness reads as unknown. */
export const SIGN_IN_STATUS_MS = 15_000;
/** How long an answer is kept, so welcomes close together run each command once. */
export const SIGN_IN_KEEP_MS = 60_000;

/**
 * `signins`: runs the status command of each harness the last hello found, at once, and answers `signed` with one
 * entry each. It isn’t awaited, so the connection’s other messages, a turn’s start among them, go on while they run.
 * @param {Daemon} d @param {Conn} c
 */
export function signins(d, c) {
  const found = (d.programs?.harnesses ?? []).filter((h) => h.path && Object.hasOwn(STATUS_COMMANDS, h.name));
  void Promise.all(found.map((h) => kept(d, h.name, /** @type {string} */ (h.path)))).then((harnesses) => send(c, 'signed', { harnesses }));
}

/**
 * The harness’s sign-in, from an answer kept for this program less than SIGN_IN_KEEP_MS ago (or still under way), or
 * from a new run.
 * @param {Daemon} d @param {string} name @param {string} path @returns {Promise<SignIn>}
 */
function kept(d, name, path) {
  const key = `${name}\n${path}`;
  const hit = d.signIns.get(key);
  if (hit && d.mono() - hit.at < SIGN_IN_KEEP_MS) return hit.answer;
  const answer = runStatus(d, name, path);
  d.signIns.set(key, { at: d.mono(), answer });
  // Only a sign-in is kept: a sign-out or unknown is asked again next time, so a sign-in the person fixed is heard at
  // once (#1608).
  void answer.then((a) => {
    if (a.state !== 'signed-in' && d.signIns.get(key)?.answer === answer) d.signIns.delete(key);
  });
  return answer;
}

/**
 * Runs the harness’s status command as an argument list (no shell), with no stdin, in the home folder with a turn’s
 * environment, and reads how it ended. Its output stays here: only what harness-signin.mjs reads of it is returned.
 * Killed at SIGN_IN_STATUS_MS, and with the daemon (d.checking).
 * @param {Daemon} d @param {string} name @param {string} path @returns {Promise<SignIn>}
 */
function runStatus(d, name, path) {
  const cmd = STATUS_COMMANDS[name];
  return new Promise((resolve) => {
    let done = false;
    /** @type {any} */
    let child = null;
    let timer = null;
    let stdout = '';
    /** @param {Omit<SignIn, 'name'>} signIn @param {string} [why] */
    const finish = (signIn, why) => {
      if (done) return;
      done = true;
      if (timer) d.timers.clearTimeout(timer);
      d.checking.delete(child);
      if (why) d.log(`${name}’s sign-in status ${why}`);
      resolve({ name, ...signIn });
    };
    const options = { cwd: d.home, env: { ...d.env, ...turnEnv(d, {}) }, stdio: ['ignore', cmd.reads ? 'pipe' : 'ignore', 'ignore'], shell: false };
    try {
      child = d.spawn(path, cmd.args, options);
    } catch (e) {
      return finish({ state: 'unknown' }, `couldn’t start: ${e.message}`);
    }
    d.checking.add(child);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (/** @type {string} */ b) => {
      if (stdout.length < STATUS_OUTPUT_CHARS) stdout += b;
    });
    child.on('error', (/** @type {Error} */ e) => finish({ state: 'unknown' }, `couldn’t start: ${e.message}`));
    child.on('close', (/** @type {number | null} */ code, /** @type {string | null} */ signal) =>
      finish(
        signal ? { state: 'unknown' } : cmd.read({ exit: code, stdout: stdout.slice(0, STATUS_OUTPUT_CHARS) }),
        signal ? `ended on ${signal}.` : undefined,
      ),
    );
    timer = d.timers.setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {} // Already gone: it reads as unknown all the same.
      finish({ state: 'unknown' }, `didn’t finish within ${Math.round(SIGN_IN_STATUS_MS / 1000)} s, so it was stopped.`);
    }, SIGN_IN_STATUS_MS);
  });
}
