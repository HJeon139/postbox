// A turn’s reply in parts (segments): the part its words and steps go to now, made when the turn first needs one.
// A UI tool call or a block ends a part, so the turn’s next words start another below it. Words after a boundary (the
// part’s steps before its first words, or a step after its words) also start one when anything was posted below the
// part, so a reply sits where it was written, not where its agent began; words that follow words stay together.
// The turn’s steps are kept on its first part, its record, and each says the part it shows in (placeStep), so the steps
// after a post below the reply show below it too, with the words they led to. replySegment moved from
// server/runtime.mjs; its caller is adapterContext (server/turn-context.mjs).

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
  if (id !== open) moveUnplaced(rt, turn, id);
  turn.unplaced = [];
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

/**
 * Where a new step of the agent’s own shows: the part it writes in now, after that part’s words so far. A step taken
 * once something was posted below that part waits for the next one: the words it leads to start a part at the end
 * (wordsSegment), and the step moves there, before them (moveUnplaced). With no more words, it stays where it is.
 * `part` is left out for the first part, which holds every step.
 * @param {any} rt @param {any} turn @param {string} id  the step’s id
 */
export function placeStep(rt, turn, id) {
  const part = turn.lastSegment ?? turn.first;
  if (part && rt.store.pending.items(turn.threadId).at(-1)?.id !== part) (turn.unplaced ??= []).push(id);
  return { ...(part && part !== turn.first ? { part } : {}), at: turn.partWords[part] ?? 0 };
}

/** The steps that waited for a new part move to it, before its words. @param {any} rt @param {any} turn @param {string} part */
function moveUnplaced(rt, turn, part) {
  for (const id of turn.unplaced ?? []) {
    const i = turn.steps.findIndex((s) => s.id === id);
    if (i < 0) continue;
    turn.steps[i] = { ...turn.steps[i], part, at: 0 };
    rt.store.emit('item.patch', { threadId: turn.threadId, id: turn.first, activityStep: { id, part, at: 0 } });
  }
}
