// A turn’s warning, before it starts on a host, that the host’s sign-in may have run out (the design, “Sign-in stays
// the host’s”): what turns-start.mjs’s prepare() shows before it hands the turn to the host.

import { BACKEND_NAMES } from '../../shared/agent-facts.mjs';
import { LOGIN_COMMANDS } from '../../shared/remote-protocol.mjs';
import { signInCheck } from './turns-resume.mjs';
import { abortError } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/**
 * A sign-in that’s run out shows before the turn, not at its first model request (the design, “Sign-in stays the
 * host’s”). It’s a warning, never a refusal: the check may be wrong, and the person decides. The start waits only for
 * signInCheck, as before #1608. It asks the host now whether the turn’s harness is signed in, without waiting, and
 * decides the warning when the answer comes (warnFrom): a sign-out names the command to run there, else a failed
 * signInCheck warns as before, so the two never give two notices.
 * @param {RemoteTurns} rts @param {any} turn @param {any} ctx @param {any} se @param {any} host
 */
export async function warnSignIn(rts, turn, ctx, se, host) {
  const check = await signInCheck(rts, turn.remote.hostId);
  if (ctx.signal.aborted) throw abortError();
  void signInsNow(rts, turn.remote.hostId)
    .then((now) => {
      if (!ctx.signal.aborted) warnFrom(rts, turn, se, host, ctx.persona?.backend, check, now);
    })
    .catch((/** @type {any} */ e) => console.error(`The sign-in warning before a turn on ${host.name} failed: ${e?.message}`));
}

/**
 * The host’s answer now, over the session the turn runs on, so a sign-in the person fixed since is heard (#1608); null
 * when there’s no asking or it fails, which warns of no sign-out. Never rejects: nothing waits on it to catch one.
 * @param {RemoteTurns} rts @param {string} hostId @returns {Promise<any>}
 */
function signInsNow(rts, hostId) {
  try {
    return Promise.resolve(rts.hosts?.signInsNow?.(hostId) ?? null).catch(() => null);
  } catch {
    return Promise.resolve(null); // an asking that throws as it’s called is one that failed: no sign-out heard
  }
}

/**
 * The one warning for a turn, once the host has answered: its harness signed out, else a failed signInCheck.
 * @param {RemoteTurns} rts @param {any} turn @param {any} se @param {any} host @param {string | undefined} harness
 * @param {any} check @param {any} now
 */
function warnFrom(rts, turn, se, host, harness, check, now) {
  if (signedOut(now, harness)) {
    const name = BACKEND_NAMES[harness] ?? harness;
    rts.rt.threads.notify(
      'blocking',
      se,
      `${name} on ${host.name} isn’t signed in`,
      `${host.name} says ${name} there isn’t signed in, so @${se.handle}’s turn there may stop with “Sign-in needed”. Run “${LOGIN_COMMANDS[harness]}” on ${host.name}, then carry on.`,
      turn.threadId,
    );
    return;
  }
  if (check && !check.ok)
    rts.rt.threads.notify(
      'blocking',
      se,
      `Sign-in on ${host.name} may have run out`,
      `The host’s sign-in check failed${check.code === null ? '' : ` (exit code ${check.code})`}, so @${se.handle}’s turn there may stop with “Sign-in needed”. Sign in on the host, then carry on.`,
      turn.threadId,
    );
}

/**
 * Whether the host’s answer says the harness isn’t signed in: only a plain signed-out counts, never unknown.
 * @param {any} signIns @param {string | undefined} harness
 */
function signedOut(signIns, harness) {
  if (!harness || !Object.hasOwn(LOGIN_COMMANDS, harness)) return false;
  return signIns?.harnesses?.some((/** @type {any} */ h) => h.name === harness && h.state === 'signed-out') === true;
}
