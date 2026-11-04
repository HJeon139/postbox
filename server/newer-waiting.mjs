// A newer message from the sender of the message an agent is answering may already wait for it (#694). The agent
// hears of it on its next Postbox tool result (withUrgent), so it can read that one first rather than answer the older
// one. Only the turn’s own thread is read: a lookup across every thread waits on A3’s queue by recipient (#734).

const PERSON = 'the person';

/** At most this many notes on one result; the rest are counted, so the tool’s own result stays near the top. */
const MOST_NOTES = 3;

/** An agent’s handle as the notes name it, from a `from` that may or may not start with @. */
const handleOf = (from) =>
  `@${String(from ?? '')
    .replace(/^@/, '')
    .toLowerCase()}`;

/** A message’s sender, as the notes name it: @handle for an agent’s, the person for theirs, or null for anything else. */
function senderOfMessage(message) {
  if (message.kind === 'user') return PERSON;
  if (message.kind !== 'agent' || !message.from) return null;
  return handleOf(message.from);
}

/** The messages the turn is answering: a batch’s parts, or its one message. */
const answering = (turn) => {
  const message = turn.asked?.message;
  if (!message) return [];
  return message.messages ?? [message];
};

/** A queued entry’s sender, as senderOfMessage names it: a wake is an agent’s, anything else in the queue is the person’s. */
function senderOfQueued(q) {
  if (q.kind !== 'wake') return PERSON;
  return handleOf(q.from);
}

/** A message that waits on the turn itself, for the turn’s thread: each part of a batch on its own. */
function pendingFor(turn) {
  const out = [];
  // The pending list only grows while the turn runs, so a part’s place in it names it for the rest of the turn.
  for (const [i, entry] of turn.pending.entries()) {
    if ((entry.threadId ?? turn.threadId) !== turn.threadId) continue;
    for (const [j, part] of (entry.message.messages ?? [entry.message]).entries()) {
      const sender = senderOfMessage(part);
      if (!sender) continue;
      const key = part.itemId ?? `pending:${i}:${j}`;
      out.push({ key, sender, itemId: part.itemId ?? null, at: part.at });
    }
  }
  return out;
}

/** What waits for this agent in the turn’s thread, each with its sender, its own id and the item it was posted as. */
function waitingFor(rt, sessionId, turn) {
  const queued = (rt.s.threads[turn.threadId]?.queue ?? [])
    .filter((q) => q.sessionIds.includes(sessionId))
    .map((q) => ({ key: q.id, sender: senderOfQueued(q), itemId: q.itemId ?? null, at: q.at }));
  return [...queued, ...pendingFor(turn)];
}

/**
 * The note names the sender and where to read the message, never its words, so Remove still retracts a message the
 * person removes after it was named (AT-6): the agent was told only that something waited, not what it said.
 */
function noteFor(waiting) {
  const where = waiting.itemId ? `read_message { id: "${waiting.itemId}" } has it` : 'it reaches you when this turn ends, unless it’s removed';
  return `[Postbox] A newer message from ${waiting.sender} is waiting for you; ${where}.`;
}

/**
 * Notes naming each message from one of the turn’s senders that waits in the turn’s thread, was sent once the turn
 * had started, and wasn’t named yet in this turn. One sent in the same millisecond counts: the turn had already taken
 * what it answers. Anything sent earlier was folded into the turn, superseded by a newer wake, or skipped with Send
 * now. `turn` is the one that made the call: if Stop or Send now replaced it while the tool ran, the call’s result
 * names nothing, and the turn now running hears of the message on its own next result. Costs O(messages queued or
 * pending in that thread), whatever the size of the room.
 * @param {any} rt @param {string} sessionId @param {any} turn @returns {string[]}
 */
export function newerFromSender(rt, sessionId, turn) {
  if (!turn || rt.turns?.get(sessionId) !== turn) return [];
  const senders = new Set(answering(turn).map(senderOfMessage).filter(Boolean));
  if (!senders.size) return [];
  turn.namedWaiting ??= new Set();
  const isNewAndUnnamed = (w) => {
    const fromSender = senders.has(w.sender);
    const sinceStart = (w.at ?? 0) >= turn.startedAt;
    return fromSender && sinceStart && !turn.namedWaiting.has(w.key);
  };
  const fresh = waitingFor(rt, sessionId, turn).filter(isNewAndUnnamed);
  const named = fresh.slice(0, MOST_NOTES);
  for (const w of named) turn.namedWaiting.add(w.key);
  const more = fresh.length - named.length;
  const notes = named.map(noteFor);
  if (more) notes.push(`[Postbox] ${more} more newer ${more === 1 ? 'message is' : 'messages are'} waiting for you; the next result names them.`);
  return notes;
}
