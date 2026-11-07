// A turn’s reply in parts (segments): the part its words and steps go to now, made when the turn first needs one.
// A tool call or a block ends a part, so the turn’s next words start another below it. A turn’s first words after its
// steps also start one when anything was posted below those steps, so a reply sits where it was written, not where
// its agent began; words already started stay together.
// replySegment moved from server/runtime.mjs, turnContext.

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
    rt.putThread({ ...rt.s.threads[turn.threadId], lastSpeaker: turn.sessionId });
  }
  return turn.segment;
}

/**
 * The part the turn’s next words go to. A part that has only steps so far, with anything posted below it meanwhile (a
 * person’s message, another agent’s reply), gets its words in a new part at the end, where they were written; the
 * steps stay on the first part, where the agent began. Once a part has words, the rest of them go there too, whatever
 * is posted meanwhile: a split between two chunks would cut the reply’s words, a mention, or a code fence apart, and
 * two agents writing at once would break each other’s replies into a part per chunk.
 * @param {any} rt @param {any} turn @param {any} se0
 */
export function wordsSegment(rt, turn, se0) {
  const open = turn.segment;
  if (open && turn.wordsIn !== open && rt.store.pending.items(turn.threadId).at(-1)?.id !== open) rt.closeSegment(turn);
  const id = replySegment(rt, turn, se0);
  // The part these words went to: its next words follow them there.
  turn.wordsIn = id;
  return id;
}
