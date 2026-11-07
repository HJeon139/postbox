// A turn’s reply in parts (segments): the part its words and steps go to now, made when the turn first needs one.
// A tool call or a block ends a part, so the turn’s next words start another below it. Moved from
// server/runtime.mjs, turnContext.

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
