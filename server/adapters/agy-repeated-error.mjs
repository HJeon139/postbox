// After one error, agy can end each later turn of the same conversation with that error again, frozen to the second
// (#335: a quota error’s “Resets in 119h36m54s” for 70 minutes). So each turn keeps a fingerprint of the error its
// result reported, with the conversation it was in, in the agent’s backend state: a hash of the whole text, never the
// text, which is public session state and may be longer than anything shown. A turn that succeeds clears it.

import { createHash } from 'node:crypto';

/**
 * Whether this turn’s result error is the one the agent’s last turn in the same conversation reported, and keeps this
 * turn’s for the next. error: the result’s whole error text, or null when the turn succeeded.
 * @param {any} ctx @param {string|null} conversation  agy’s conversation id @param {string|null} error
 */
export function repeatsLastError(ctx, conversation, error) {
  const last = ctx.state?.agyLastError ?? null;
  const now = error === null ? null : { conversation, hash: createHash('sha256').update(error).digest('hex') };
  const same = !!now && !!last && last.conversation === now.conversation && last.hash === now.hash;
  if (!same && (now || last)) {
    if (ctx.state) ctx.state.agyLastError = now;
    ctx.saveState?.({ agyLastError: now });
  }
  return same;
}
