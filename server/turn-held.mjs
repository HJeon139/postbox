// The record of a turn that died, kept on its failed reply when the reply has no words of its own, so the person sees
// what it held instead of an empty message (designs/rooms-at-scale.md, “Live state”; shared/held-words.mjs draws it).
// Handles and ids only: whom it answered and which message, never the message’s text. It rides on the reply item, a
// public key, as every item’s fields do.

/** At most this many of what a turn took, and of the jobs it left, are kept: the line names a few, not a list. */
const MOST = 5;

/**
 * What the turn held when it failed: the entries it took (from whom, and the item each came from), how many steps of
 * its own it took and the last one, and its background jobs still running after its end settled them.
 * @param {any} rt @param {any} se @param {any} turn
 * @returns {import('../shared/held-words.mjs').Held}
 */
export function heldBy(rt, se, turn) {
  const took = rt.delivery
    .takenBy(se.id, turn.id)
    .slice(0, MOST)
    .map((/** @type {any} */ e) => ({ ...(e.from ? { from: e.from } : {}), ...(e.itemId ? { itemId: e.itemId } : {}) }));
  const own = (turn.steps ?? []).filter((/** @type {any} */ s) => !s.who && s.kind !== 'thought' && s.kind !== 'said');
  const jobs = (rt.s.sessions[se.id]?.jobs ?? [])
    .filter((/** @type {any} */ j) => j.state === 'running')
    .slice(0, MOST)
    .map((/** @type {any} */ j) => String(j.label ?? 'Background job').slice(0, 80));
  return { took, steps: own.length, last: own.length ? String(own.at(-1).label).slice(0, 80) : null, jobs };
}
