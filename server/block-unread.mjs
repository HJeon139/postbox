// update_block’s refusal over an answer the agent hasn’t read (unreadAnswer, #123), and how much of it the refusal
// gives whole (CATCH_UP_CHARS, which a catch-up keeps to as well). Moved out of server/block-update.mjs.

import { clipText } from './helpers.mjs';

export const CATCH_UP_CHARS = 16000;

/**
 * update_block’s refusal over an answer the agent hasn’t read: the answer stays on screen, and the reply carries the
 * whole answer and counts as reading it, so the agent can update once it has. If the answer still waits for the agent
 * (behind its turn, or in its inbox), it’s settled there, so it reaches the agent once, in this reply (#1810). If it no
 * longer waits (a stopped or failed turn, or a restart, dropped it), the reply is all that’s left of it.
 * @param {string} sessionId @param {string} threadId @param {any} it  the answered block item
 * @param {boolean} [outcome]  the update set outcome: it reports on an answer the agent can’t know yet
 */
export function unreadAnswer(apps, sessionId, threadId, it, outcome = false) {
  const a = it.answer;
  const at = new Date(a.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const n = Array.isArray(a.values?.comments) ? a.values.comments.length : 0;
  const full = JSON.stringify(a.values ?? {});
  const what =
    a.action === 'dismiss'
      ? 'they dismissed it'
      : it.block.type === 'review'
        ? `${a.values?.verdict}${n ? `, ${n} comment${n === 1 ? '' : 's'}` : ''}`
        : `${a.action} ${clipText(full, 300)}`;
  const then = outcome ? 'then record the outcome' : 'then update';
  const said = `${outcome ? 'The outcome wasn’t recorded: you haven’t read the answer it reports on.' : 'The update wasn’t applied.'} The person answered revision ${a.revision ?? 1} of ${it.block.id} at ${at}: ${what}. Their answer stays on screen.`;
  // Only an answer the refusal can give whole is settled: past the cut, it still comes whole at the turn’s end. A host
  // turn’s update_block is queued, so its agent never reads this reply in the call (shared/remote-protocol-constants.mjs,
  // TOOL_ROUTES): its answer comes at the turn’s end too. So does a confirm’s, whose own turn is what lets the command it
  // shows run without a card (write-intent.mjs, requestOf).
  const settles = full.length <= CATCH_UP_CHARS && !apps.running.turnOf(sessionId)?.remote && it.block.type !== 'confirm';
  const waited = stillWaits(apps, sessionId, it);
  if (waited && !settles) return { ok: false, message: `${said} It reaches you when this turn ends: read it, ${then}.` };
  if (waited) settleWaiting(apps, sessionId, it);
  apps.threads.patchItem(threadId, it.id, { answer: { ...a, read: true } });
  const why = waited ? 'It was waiting for this turn to end, and comes here instead' : 'It didn’t reach you in a turn';
  const whole =
    it.block.type !== 'review' && full.length <= 300 ? 'that’s the whole answer' : `here it is in full: ${a.action} ${clipText(full, CATCH_UP_CHARS)}`;
  return { ok: false, message: `${said} ${why}, so ${whole}. Read it, ${then}.` };
}

/**
 * The answer itself, not a correction of one of its comments the person sent since (review-correct.mjs): that one
 * still comes, as the refusal gives only the answer (#1810).
 * @param {any} m
 */
const answer = (m) => m?.event?.action !== 'correct';
/** A message that carries the answer to this block. @param {any} it  the answered block item */
const carriesAnswer = (it) => (/** @type {any} */ m) => m?.blockItemId === it.id && answer(m);
/** Its answer’s entries waiting in the agent’s inbox (designs/rooms-at-scale.md, “What an entry is”). */
const waitingEntries = (apps, sessionId, it) =>
  apps.delivery.waiting(sessionId).filter((/** @type {any} */ e) => e.source === 'answer' && e.itemId === it.id && answer(e.message));

/**
 * Whether an unread answer still waits for the agent: its entry in the agent’s inbox, or a message holding its event
 * behind the live turn.
 * @param {string} sessionId @param {any} it  the answered block item
 */
function stillWaits(apps, sessionId, it) {
  const carries = carriesAnswer(it);
  const queued = (apps.running.turnOf(sessionId)?.pending ?? []).some((/** @type {any} */ p) => carries(p.message));
  return queued || waitingEntries(apps, sessionId, it).length > 0;
}

/**
 * Settles what still carries an unread answer to the agent, once update_block’s refusal has given it whole (#1810), so
 * no later turn gives it again: Turns takes its message out of the live turn’s queue, and its entries, waiting or taken
 * for that message’s turn, are delivered, as a turn’s end delivers what it took.
 * @param {string} sessionId @param {any} it  the answered block item
 */
function settleWaiting(apps, sessionId, it) {
  const entries = waitingEntries(apps, sessionId, it);
  // The entry a turn took for it, whose turn now never starts: left taken, a restart would give it again. A turn that
  // takes an answer takes it alone (Delivery.take), so all it took is the answer’s.
  for (const p of apps.turns.takeQueued(sessionId, carriesAnswer(it))) entries.push(...apps.delivery.takenBy(sessionId, p.message.turnId));
  if (entries.length) apps.delivery.deliveredNow(entries);
}
