// The record of a turn that died, kept on its reply when the reply has no words of its own, so the person sees what
// it held instead of an empty message (designs/rooms-at-scale.md, “Live state”; shared/held-words.mjs words it). Whom
// it answered, by handle or “you”, never a message’s text. It rides on the reply item, a public key, as every item’s
// fields do. A failed turn’s record is built at its end; a turn a restart or a store outage cut off, from what its
// reply kept.

/** At most this many of what a turn took, and of its jobs, are kept: the line names a few, not a list. */
const MOST = 5;
/** A label’s length as the person reads it. */
const LONGEST = 80;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** A label kept to LONGEST characters as they’re read, never splitting one, such as an emoji. @param {unknown} text */
export function clip(text) {
  let out = '';
  let n = 0;
  for (const { segment } of graphemes.segment(String(text))) {
    if (n++ === LONGEST) break;
    out += segment;
  }
  return out;
}

/**
 * The record: whom the entries came from, how many steps of its own the turn took and its last, and its background
 * jobs as its end leaves them, still running (one the person kept) or stopped with it.
 * @param {any[]} took  the entries it took @param {any[]} steps @param {any[]} running @param {any[]} stopped
 * @returns {import('../shared/held-words.mjs').Held}
 */
function record(took, steps, running, stopped) {
  // The agent’s own steps: not a subagent’s, a thought or narration.
  const own = steps.filter((s) => !s.who && s.kind !== 'thought' && s.kind !== 'said');
  const labels = (/** @type {any[]} */ jobs) => jobs.slice(0, MOST).map((j) => clip(j.label ?? 'Background job'));
  return {
    took: took.slice(0, MOST).map((e) => (e.from ? { from: e.from } : {})),
    steps: own.length,
    last: own.length ? clip(own.at(-1).label) : null,
    running: labels(running),
    stopped: labels(stopped),
  };
}

/**
 * What a failed turn held, at its end. Its jobs are this turn’s only, as its end settles them right after
 * (settleJobs, server/turn-stop.mjs): one the person kept runs on, and every other one stops with the turn.
 * @param {any} rt @param {any} se @param {any} turn
 */
export function heldBy(rt, se, turn) {
  const jobs = (rt.s.sessions[se.id]?.jobs ?? []).filter((/** @type {any} */ j) => j.turnId === turn.id && j.state === 'running');
  return record(
    rt.delivery.takenBy(se.id, turn.id),
    turn.steps ?? [],
    jobs.filter((/** @type {any} */ j) => j.kept),
    jobs.filter((/** @type {any} */ j) => !j.kept),
  );
}

/**
 * What a reply a restart or a store outage cut off held, from what was kept: the steps its reply holds and the entries
 * its turn took. Its jobs aren’t known then, so they’re left out. Nothing for a reply with words of its own, or with no
 * turn to read. @param {any} rt @param {any} it @returns {{ held?: import('../shared/held-words.mjs').Held }}
 */
export function heldOfCutOff(rt, it) {
  if (String(it.text ?? '').trim() || !it.sessionId || !it.turnId) return {};
  return { held: record(rt.delivery.takenBy(it.sessionId, it.turnId), it.activity?.steps ?? [], [], []) };
}
