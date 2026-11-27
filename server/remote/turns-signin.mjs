// A turn’s warning, before it starts on a host, that the host’s sign-in may have run out (the design, “Sign-in stays
// the host’s”): what turns-start.mjs’s prepare() shows before it hands the turn to the host.

import { signInCheck } from './turns-resume.mjs';
import { abortError } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/**
 * A sign-in that’s run out shows before the turn, not at its first model request (the design, “Sign-in stays the
 * host’s”). It’s a warning: the check may be wrong, and the person decides.
 * @param {RemoteTurns} rts @param {any} turn @param {any} ctx @param {any} se @param {any} host
 */
export async function warnSignIn(rts, turn, ctx, se, host) {
  const check = await signInCheck(rts, turn.remote.hostId);
  if (ctx.signal.aborted) throw abortError();
  if (check && !check.ok)
    rts.rt.threads.notify(
      'blocking',
      se,
      `Sign-in on ${host.name} may have run out`,
      `The host’s sign-in check failed${check.code === null ? '' : ` (exit code ${check.code})`}, so @${se.handle}’s turn there may stop with “Sign-in needed”. Sign in on the host, then carry on.`,
      turn.threadId,
    );
}
