// A newer message from the sender of the message an agent is answering may already wait for it (#694). The agent
// hears of it on its next Postbox tool result (withUrgent), so it can read that one first rather than answer the older
// one. What waits for an agent is its inbox’s entries (server/delivery.mjs), in any thread: one in another thread is
// named with its thread, and a turn that starts while it waits names it in its prompt too (#734). The lookup reads the
// agent’s own entries, so it costs O(messages waiting for this agent), whatever the size of the room.

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

/**
 * What waits for this agent, each with its sender, its own id, the item it was posted as and the thread it waits in, or
 * null for the thread the agent works in: its inbox’s entries (the person’s messages, an agent’s mention or review).
 * @param {any} rt @param {string} sessionId @param {string} threadId  the thread the turn runs in
 */
function waitingFor(rt, sessionId, threadId) {
  return (
    rt.delivery
      .waiting(sessionId)
      .filter((/** @type {any} */ e) => e.from)
      // The person’s own is named without its item, which is posted when it’s sent (#1404), so the note never points
      // at a message they may still remove (AT-6).
      .map((/** @type {any} */ e) => ({
        key: e.id,
        sender: e.from === 'you' ? PERSON : handleOf(e.from),
        itemId: e.from === 'you' ? null : (e.itemId ?? null),
        at: e.at,
        thread: e.threadId === threadId ? null : (rt.s.threads[e.threadId]?.title ?? 'another thread'),
      }))
  );
}

/**
 * The note names the sender and where to read the message, never its words, so Remove still retracts a message the
 * person removes after it was named (AT-6): the agent was told only that something waited, not what it said.
 */
function noteFor(waiting) {
  const after = waiting.thread ? 'it starts a turn of its own after this one' : 'it reaches you when this turn ends';
  const where = waiting.itemId ? `read_message { id: "${waiting.itemId}" } has it` : `${after}, unless it’s removed`;
  const thread = waiting.thread ? ` in “${waiting.thread}”` : '';
  return `[Postbox] A newer message from ${waiting.sender} is waiting for you${thread}; ${where}.`;
}

/**
 * Notes naming each message from one of the turn’s senders that waits for the agent, was sent once the turn had
 * started, and wasn’t named yet in this turn. One sent in the same millisecond counts: the turn had already taken
 * what it answers. Anything sent earlier was folded into the turn, superseded by a newer wake, or skipped with Send
 * now. `turn` is the one that made the call: if Stop or Send now replaced it while the tool ran, the call’s result
 * names nothing, and the turn now running hears of the message on its own next result. Costs O(messages waiting for
 * this agent), whatever the size of the room.
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
  const fresh = waitingFor(rt, sessionId, turn.threadId).filter(isNewAndUnnamed);
  const named = fresh.slice(0, MOST_NOTES);
  for (const w of named) turn.namedWaiting.add(w.key);
  const more = fresh.length - named.length;
  const notes = named.map(noteFor);
  if (more) notes.push(`[Postbox] ${more} more newer ${more === 1 ? 'message is' : 'messages are'} waiting for you; the next result names them.`);
  return notes;
}

/**
 * What a turn’s prompt says as it starts (#734): each message from a sender of its entries that waits in another thread
 * and is newer than that sender’s newest the turn takes. One in the turn’s own thread waits behind its entries and
 * reaches it next; a tool result names one sent once the turn started (newerFromSender).
 * @param {any} rt @param {string} sessionId @param {string} threadId @param {any[]} taken  the entries the turn takes
 * @returns {string[]}
 */
export function newerElsewhere(rt, sessionId, threadId, taken) {
  /** @type {Map<string, number>} each sender’s newest message the turn takes */
  const newest = new Map();
  for (const e of taken) {
    if (!e.from) continue;
    const sender = e.from === 'you' ? PERSON : handleOf(e.from);
    newest.set(sender, Math.max(newest.get(sender) ?? 0, e.at ?? 0));
  }
  if (!newest.size) return [];
  const newer = waitingFor(rt, sessionId, threadId).filter((w) => w.thread && newest.has(w.sender) && (w.at ?? 0) > (newest.get(w.sender) ?? 0));
  return newer.map(noteFor);
}
