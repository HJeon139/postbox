// A turn’s reply in parts (segments): the part its words and steps go to now, made when the turn first needs one.
// A UI tool call or a block ends a part, so the turn’s next words start another below it. Words after a boundary (the
// part’s steps before its first words, or a step after its words) also start one when anything was posted below the
// part, so a reply sits where it was written, not where its agent began; words that follow words stay together.
// replySegment moved from server/runtime.mjs, turnContext.

import { updateThread } from './thread-write.mjs';
import { replyMarks } from './turn-marks.mjs';

/**
 * The id of the part the turn writes to now, made at the end of its thread if it has none.
 * @param {any} rt  the runtime @param {any} turn @param {any} se0  the session as the turn started
 */
export function replySegment(rt, turn, se0) {
  if (!turn.segment) {
    const it = rt.addItem(turn.threadId, {
      kind: 'agent',
      sessionId: turn.sessionId,
      personaId: se0.personaId,
      handle: se0.handle,
      turnId: turn.id,
      text: '',
      status: 'streaming',
      activity: turn.first ? null : { steps: [...turn.steps] },
      ...replyMarks(turn),
    });
    // The text before a tool call or a block is finished; only the newest segment shows the caret.
    if (turn.lastSegment) rt.patchItem(turn.threadId, turn.lastSegment, { status: 'done' });
    turn.segment = it.id;
    turn.lastSegment = turn.openSegment = it.id; // openSegment: the one still streaming, by its id (closeSegment)
    if (!turn.first) turn.first = it.id;
    if (turn.said) turn.said += '\n\n';
    updateThread(rt, turn.threadId, { lastSpeaker: turn.sessionId });
  }
  return turn.segment;
}

/**
 * The part the turn’s next words go to. They start a new part at the end, where they were written, when anything was
 * posted below the open part meanwhile (a person’s message, another agent’s reply) and they’d follow a boundary: the
 * part has only steps so far, or a step came after its last words, such as a Read or a Bash call. The steps stay on
 * the first part, where the agent began. Words that follow words go to the same part, whatever is posted meanwhile: a
 * split between two chunks would cut the reply’s words, a mention, or a code fence apart, and two agents writing at
 * once would break each other’s replies into a part per chunk.
 * @param {any} rt @param {any} turn @param {any} se0
 */
export function wordsSegment(rt, turn, se0) {
  const open = turn.segment;
  const boundary = turn.wordsIn !== open || turn.stepAfterWords;
  if (open && boundary && rt.store.pending.items(turn.threadId).at(-1)?.id !== open) rt.closeSegment(turn);
  const id = replySegment(rt, turn, se0);
  // The part these words went to: its next words follow them there, until a step comes between.
  turn.wordsIn = id;
  turn.stepAfterWords = false;
  return id;
}

/**
 * A step the turn took itself: after words in its open part, it’s a boundary its next words may start a new part at.
 * A subagent’s step (one with a `who`) isn’t called here: it runs beside the agent’s writing, so the agent’s words can
 * go on mid-sentence after it. @param {any} turn
 */
export function stepTaken(turn) {
  if (turn.segment && turn.wordsIn === turn.segment) turn.stepAfterWords = true;
}
