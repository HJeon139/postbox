// A turn that ends with no reply (#485). A Claude Code turn of about 45 minutes ended with its report as the text after
// its last command, and Postbox posted the reply as an item with no text: the report reached no one, and the room
// worked on as if it hadn’t been sent. Whatever the backend did, such a turn is never posted as an empty message. It
// ends as a failed reply that says so, with Retry, keeping the turn’s last raw lines for diagnosis, and the agent hears
// of it at its next turn.

/**
 * The turns that owe a reply: a message from the person or from another agent. Others may end quietly: an event (a
 * block answered or dismissed, a review, an app’s send), a scheduled wake, a lint pass or an app check.
 */
const ASKED = new Set(['user', 'agent']);

/**
 * Postbox’s tools that answer no one: they read, ask, or keep something for later (a wake, a term). A turn that called
 * nothing else still owes its reply.
 */
const READS = new Set(['read_conversation', 'read_message', 'corpus_search', 'permission_prompt', 'schedule_wake', 'cancel_wake', 'define_term']);

/**
 * Marks a turn that answered through one of Postbox’s tools that act, such as a reaction or a term, which leave no
 * item of the turn’s own. server/mcp.mjs and a host’s calls (remote/turns-tools.mjs) both call it.
 * @param {any} turn  the turn the call came from, or null @param {string} name @param {any} r  the tool’s result
 */
export function noteAnswer(turn, name, r) {
  if (turn && !READS.has(name) && (r?.ok !== false || r?.waiting)) turn.answered = true;
}

/**
 * Whether a turn that owes a reply ended with none: no text, no call that acted (noteAnswer), and nothing else of its
 * own in the thread (a block, an app, a card, a message it sent another agent, which carries fromTurnId).
 * @param {any} turn @param {any[]} items  the thread’s
 */
export function endedWithoutReply(turn, items) {
  if (!ASKED.has(turn.kind) || turn.slash || turn.said.trim() || turn.answered) return false;
  return !items.some((it) => (it.turnId === turn.id || it.fromTurnId === turn.id) && (it.kind !== 'agent' || it.text?.trim()));
}

/**
 * The failure an empty turn ends with: what the person reads, and the turn’s raw ending, which the failed reply keeps.
 * The agent is told too, at its next turn.
 * @param {any} rt @param {any} se @param {any} turn
 */
export function emptyReply(rt, se, turn) {
  rt.tellAgent(
    se.id,
    'Your last turn in this conversation ended without a reply: nothing you wrote reached it, so no one read your answer. If you meant to report something, say it again now.',
  );
  return Object.assign(new Error(`@${se.handle}’s turn ended without a reply.`), {
    rawEnding: { backend: rt.personaFor(se)?.backend ?? null, lines: [...(turn.rawTail ?? [])] },
  });
}
