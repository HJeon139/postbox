// Postbox’s `check` (daemon.mjs’s header, #120): the host’s sign-in check, run one at a time and answered `checked`.

import { SIGN_IN_CHECK_MS } from '../../../shared/remote-protocol.mjs';
import { fail, send } from './daemon-reply.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/**
 * `check`: runs the host’s signInCheck, the one the driver’s hello sent (HOST_ENFORCED), and answers `checked`.
 * It runs as an argument list (spawn’s program and arguments, never a shell), with no stdin and its output
 * discarded, in the home folder and the daemon’s environment, and is killed at SIGN_IN_CHECK_MS. It isn’t awaited,
 * so the connection’s other messages go on while it runs. Checks run one at a time, so the `checked` answers come
 * in the order the checks did.
 * @param {Daemon} d @param {Conn} c
 */
export function check(d, c) {
  const argv = d.settings.signInCheck;
  if (!Array.isArray(argv) || !argv.length)
    return fail(c, 'no-check', 'This host has no signInCheck in its settings, so there’s no sign-in check to run.', 'check');
  d.checks = d.checks.then(async () => {
    const r = await runCheck(d, argv);
    send(c, 'checked', { ok: r.code === 0, code: r.code, at: d.now() });
  });
}
/** @param {Daemon} d @param {string[]} argv @returns {Promise<{ code: number | null }>} */
function runCheck(d, argv) {
  return new Promise((resolve) => {
    let done = false;
    /** @type {any} */
    let child = null;
    let timer = null;
    /** @param {number | null} code @param {string} [why] */
    const finish = (code, why) => {
      if (done) return;
      done = true;
      if (timer) d.timers.clearTimeout(timer);
      d.checking.delete(child);
      if (why) d.log(`The sign-in check ${argv[0]} ${why}`);
      resolve({ code });
    };
    try {
      child = d.spawn(argv[0], argv.slice(1), { cwd: d.home, env: d.env, stdio: ['ignore', 'ignore', 'ignore'], shell: false });
    } catch (e) {
      return finish(null, `couldn’t start: ${e.message}`);
    }
    d.checking.add(child);
    child.on('error', (e) => finish(null, `couldn’t start: ${e.message}`));
    child.on('exit', (code, signal) => finish(signal ? null : code, signal ? `ended on ${signal}.` : undefined));
    timer = d.timers.setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(null, `didn’t finish within ${Math.round(SIGN_IN_CHECK_MS / 1000)} s, so it was stopped.`);
    }, SIGN_IN_CHECK_MS);
  });
}
