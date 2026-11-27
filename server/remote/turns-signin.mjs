// A turn’s warning, before it starts on a host, that the host’s sign-in may have run out (the design, “Sign-in stays
// the host’s”): what turns-start.mjs’s prepare() shows before it hands the turn to the host.

import { BACKEND_NAMES } from '../../shared/agent-facts.mjs';
import { LOGIN_COMMANDS } from '../../shared/remote-protocol.mjs';
import { signInCheck } from './turns-resume.mjs';
import { abortError } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/**
 * A sign-in that’s run out shows before the turn, not at its first model request (the design, “Sign-in stays the
 * host’s”). It’s a warning, never a refusal: the check may be wrong, and the person decides. When the host last said
 * the turn’s harness isn’t signed in (#1608), the warning says so and names the command to run there; else a failed
 * signInCheck warns as before.
 * @param {RemoteTurns} rts @param {any} turn @param {any} ctx @param {any} se @param {any} host
 */
export async function warnSignIn(rts, turn, ctx, se, host) {
  const [check, now] = await Promise.all([signInCheck(rts, turn.remote.hostId), signInsNow(rts, turn.remote.hostId)]);
  if (ctx.signal.aborted) throw abortError();
  const harness = ctx.persona?.backend;
  if (signedOut(now, harness)) {
    const name = BACKEND_NAMES[harness] ?? harness;
    rts.rt.threads.notify(
      'blocking',
      se,
      `${name} on ${host.name} isn’t signed in`,
      `${host.name} says ${name} there isn’t signed in, so @${se.handle}’s turn there may stop with “Sign-in needed”. Run “${LOGIN_COMMANDS[harness]}” on ${host.name}, then carry on.`,
      turn.threadId,
    );
  } else if (check && !check.ok)
    rts.rt.threads.notify(
      'blocking',
      se,
      `Sign-in on ${host.name} may have run out`,
      `The host’s sign-in check failed${check.code === null ? '' : ` (exit code ${check.code})`}, so @${se.handle}’s turn there may stop with “Sign-in needed”. Sign in on the host, then carry on.`,
      turn.threadId,
    );
}

/** How long a turn’s start waits for the host to say whether its harness is signed in, before it warns of nothing. */
export const SIGN_IN_TURN_WAIT_MS = 5000;

/**
 * The host’s answer now, over the session the turn runs on, not one before it, so a sign-in the person fixed since is
 * heard (#1608); null when it doesn’t come within SIGN_IN_TURN_WAIT_MS, so a slow host never holds the turn up.
 * @param {RemoteTurns} rts @param {string} hostId @returns {Promise<any>}
 */
function signInsNow(rts, hostId) {
  const asked = rts.hosts?.signInsNow?.(hostId);
  if (!asked) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SIGN_IN_TURN_WAIT_MS);
    timer.unref?.();
    asked.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Whether the host’s answer says the harness isn’t signed in: only a plain signed-out counts, never unknown.
 * @param {any} signIns @param {string | undefined} harness
 */
function signedOut(signIns, harness) {
  if (!harness || !Object.hasOwn(LOGIN_COMMANDS, harness)) return false;
  return signIns?.harnesses?.some((/** @type {any} */ h) => h.name === harness && h.state === 'signed-out') === true;
}
