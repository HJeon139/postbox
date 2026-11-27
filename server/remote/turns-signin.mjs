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
  const check = await signInCheck(rts, turn.remote.hostId);
  if (ctx.signal.aborted) throw abortError();
  const harness = ctx.persona?.backend;
  if (signedOut(rts, turn.remote.hostId, harness)) {
    const name = BACKEND_NAMES[harness] ?? harness;
    rts.rt.threads.notify(
      'blocking',
      se,
      `${name} on ${host.name} isn’t signed in`,
      `When ${host.name} last said, ${name} there wasn’t signed in, so @${se.handle}’s turn there may stop with “Sign-in needed”. Run “${LOGIN_COMMANDS[harness]}” on ${host.name}, then carry on.`,
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

/**
 * Whether the host’s last answer says the harness isn’t signed in: only a plain signed-out counts, never unknown.
 * @param {RemoteTurns} rts @param {string} hostId @param {string | undefined} harness
 */
function signedOut(rts, hostId, harness) {
  if (!harness || !Object.hasOwn(LOGIN_COMMANDS, harness)) return false;
  const signIns = rts.hosts?.status?.(hostId)?.signIns;
  return signIns?.harnesses?.some((/** @type {any} */ h) => h.name === harness && h.state === 'signed-out') === true;
}
