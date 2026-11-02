// Which messages in a transcript name their speaker: a line with the agent’s ring, its handle and the time.

// A reply replaced by its replay (#120: a turn on a host attached again after a restart) shows nothing, so the replay
// after it names its speaker.
const speaker = (it) =>
  it.kind === 'user' ? 'you' : (it.kind === 'agent' && it.status !== 'replaced') || it.kind === 'block' || it.kind === 'proposal' ? `s:${it.sessionId}` : null;
// One turn’s items share a sender line; a later turn of the same agent gets its own, and so does a wake it sent from
// another turn (its fromTurnId) (#135). An item from before turns were kept, or no turn made, goes with the one before.
const turnOf = (it) => it.turnId ?? it.fromTurnId;
const sameTurn = (a, b) => !turnOf(a) || !turnOf(b) || turnOf(a) === turnOf(b);

/** Whether a message names its speaker, given the one before it. */
export const namesSpeaker = (it, prev) => !(prev && speaker(prev) && speaker(prev) === speaker(it) && prev.kind !== 'voice' && sameTurn(prev, it));
