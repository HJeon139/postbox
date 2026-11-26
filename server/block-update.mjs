// An agent’s updates to the blocks it showed (update_block), and the person’s answers it has read: when an answer is
// read (answerDelivered, #123), and update_block’s refusal over one it hasn’t (unreadAnswer). Moved out of
// server/blocks.mjs, which keeps the person’s answer (act).

import { withShape } from '../shared/block-examples.mjs';
import { updateKind } from '../shared/block-updates.mjs';
import { ASKING, followsConversation, validateBlock } from '../shared/catalog.mjs';
import { LIMITS } from '../shared/limits.mjs';
import { clip, clipText, echoedId } from './helpers.mjs';
import { stampSteps } from './progress-steps.mjs';
import { echoedAuthors, ownedAuthors } from './review-authors.mjs';
import { revisedFiles } from './review-files.mjs';
import { revisedReview } from './review-person.mjs';

export const CATCH_UP_CHARS = 16000;

/**
 * An answer is read once its event starts one of the agent’s turns (#123). While the agent works, the event waits
 * in its turn’s queue, and until it’s delivered, update_block can’t reopen the block over it.
 * @param {string} threadId @param {any} message  a message starting a turn
 */
export function answerDelivered(apps, threadId, message) {
  if (message.kind !== 'event' || !message.blockItemId) return;
  const it = apps.store.item(threadId, message.blockItemId);
  if (it?.answer?.read === false && it.answer.revision === message.event.revision)
    apps.threads.patchItem(threadId, it.id, { answer: { ...it.answer, read: true } });
}

/**
 * Reopening an answered review keeps a receipt of that answer: what it was, for which revision, and when, so the person
 * can see it was for an earlier revision and answer this one (#518). The review hides it once they answer again.
 * @param {any} existing  the block item being updated
 */
function priorAnswerOf(existing) {
  // Only a review draws it (app/js/review-receipt.mjs), so only a review keeps it.
  const a = existing.answered && existing.block.type === 'review' ? existing.answer : null;
  if (!a) return {};
  return { priorAnswer: { action: a.action, ...(a.values?.verdict ? { verdict: a.values.verdict } : {}), revision: a.revision ?? 1, at: a.at } };
}

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
  const said = `${outcome ? 'The outcome wasn’t recorded: you haven’t read the answer it reports on.' : 'The update wasn’t applied.'} The person answered revision ${a.revision ?? 1} of ${it.block.id} at ${at}: ${what}. Their answer stays on screen.`;
  // Only an answer the refusal can give whole is settled: past the cut, it still comes whole at the turn's end.
  const fits = full.length <= CATCH_UP_CHARS;
  const waited = settleWaiting(apps, sessionId, it, fits);
  if (waited && !fits)
    return { ok: false, message: `${said} It reaches you whole when this turn ends: read it, ${outcome ? 'then record the outcome' : 'then update'}.` };
  apps.threads.patchItem(threadId, it.id, { answer: { ...a, read: true } });
  const why = waited ? 'It was waiting for this turn to end, and comes here instead' : 'It didn’t reach you in a turn';
  const whole =
    it.block.type !== 'review' && full.length <= 300 ? 'that’s the whole answer' : `here it is in full: ${a.action} ${clipText(full, CATCH_UP_CHARS)}`;
  return { ok: false, message: `${said} ${why}, so ${whole}. Read it, ${outcome ? 'then record the outcome' : 'then update'}.` };
}

/**
 * Settles what still carries an unread answer to the agent, once update_block’s refusal has given it whole (#1810), so
 * no later turn gives it again: its waiting entry in the agent’s inbox (designs/rooms-at-scale.md, “What an entry
 * is”), and a message holding its event behind the live turn, with the entry taken for it. Both are delivered, as a
 * turn’s end delivers what it took. Returns whether anything waited; with `settle` false it only says so, for an answer
 * too long to give whole here.
 * @param {string} sessionId @param {any} it  the answered block item @param {boolean} [settle]
 */
function settleWaiting(apps, sessionId, it, settle = true) {
  // The answer itself, not a correction of one of its comments the person sent since (review-correct.mjs): that one
  // still comes, as the refusal gives only the answer (#1810).
  const answer = (/** @type {any} */ m) => m?.event?.action !== 'correct';
  const entries = apps.delivery.waiting(sessionId).filter((e) => e.source === 'answer' && e.itemId === it.id && answer(e.message));
  const list = apps.running.turnOf(sessionId)?.pending ?? [];
  const carrying = list.filter((/** @type {any} */ p) => p.message.blockItemId === it.id && answer(p.message));
  const held = carrying.length > 0;
  if (held && settle) {
    list.splice(0, list.length, ...list.filter((/** @type {any} */ p) => !carrying.includes(p)));
    // The entry a turn took for it, whose turn now never starts: left taken, a restart would give it again.
    for (const p of carrying.filter((x) => typeof x.message.turnId === 'string'))
      entries.push(...apps.delivery.takenBy(sessionId, p.message.turnId).filter((e) => e.itemId === it.id && answer(e.message)));
  }
  if (!settle) return held || entries.length > 0;
  if (entries.length) apps.delivery.deliveredNow(entries);
  return held || entries.length > 0;
}

/**
 * update_block { block }, for the session’s turn. Its closure in Runtime.toolsFor read turn, se(), threadId() and
 * endSegment(), so they come as parameters.
 */
/**
 * @param {{ files?: import('./review-files.mjs').ReviewFile[], held?: boolean }} [given]  a review’s images, read for this
 *   update (#780); held is set once the item holds them, so keptIfShown keeps their blobs (#828)
 */
export function updateBlock(apps, sessionId, { block }, { turn, se, threadId, endSegment }, given = {}) {
  const kind = updateKind(block);
  if (kind === 'withdraw') return withdraw(apps, sessionId, block, { se, threadId });
  if (kind === 'outcome') return recordOutcome(apps, sessionId, block, { se, threadId });
  const v = validateBlock(echoedAuthors(block), { imageOrigins: apps.config.imageOrigins });
  if (!v.ok) return { ok: false, message: `The update was invalid and wasn’t applied: ${withShape(v.errors, block)}` };
  const { where, existing: found } = shownBy(apps, sessionId, v.block.id, threadId(), se());
  if (!found) return notShown(apps, sessionId, v.block.id);
  if (found.block.type !== v.block.type) return { ok: false, message: 'An update can’t change a block’s type.' };
  const now = Date.now();
  // Any other update asks again, so it reopens a block you already answered. Not over an answer the agent hasn’t
  // read (#123): the person would see it vanish, and the agent would never learn what it erased.
  if (found.answered && found.answer?.read === false) return unreadAnswer(apps, sessionId, where, found);
  // The person’s and other agents’ threads stay on a review, and its agent comments only as itself (#133, #1143).
  const { existing, reviews, note, ...revised } = revisedReview(found, v.block);
  v.block = revised.block;
  if (v.block.type === 'review') {
    const kept = validateBlock(v.block, { imageOrigins: apps.config.imageOrigins });
    if (!kept.ok) return { ok: false, message: `The update wasn’t applied: with the reviewers’ threads it leaves out, which stay, ${kept.errors.join(' ')}` };
  }
  // One that changes only what the person can’t see (its fallback), or only whether a review’s threads are resolved
  // (#901), asks nothing new, so an answered block stays answered, and an outcome can follow (#286).
  const { files, newFiles } = reviewImages(v.block, existing, given.files);
  if (existing.answered && !newFiles) {
    const differ = unseenAware(v.block, existing.block).filter((k) => k !== 'outcome');
    if (differ.length > 0 && !existing.closed && differ.every((k) => UNSEEN.has(k) || k === STATUS)) {
      if (differ.length) apps.threads.patchItem(where, existing.id, { block: { ...v.block, outcome: existing.block.outcome }, updatedAt: now, ...reviews });
      // The images are the ones it already holds (no newFiles), so their blobs stay.
      if (given.files) given.held = true;
      return {
        ok: true,
        message: `${differ.length ? `Updated the ${differ.join(', ')} of ${v.block.id}` : `Nothing in ${v.block.id} changed`}; it stays answered, since nothing the person would answer changed. To ask again, change what it asks.${note}`,
      };
    }
  }
  const kept = ASKING.has(v.block.type) && !existing.answered && !newFiles ? keptWaiting(apps, where, existing, v.block, now) : null;
  if (kept) {
    if (given.files) given.held = true;
    return { ...kept, message: kept.message + note };
  }
  /** @type {Record<string, any>} */
  const patch = { block: v.block, answered: false, answer: null, closed: null, revision: (existing.revision ?? 1) + 1, updatedAt: now, ...files, ...reviews };
  Object.assign(patch, priorAnswerOf(existing));
  if (v.block.type === 'progress') Object.assign(patch, stampSteps(existing, v.block, now));
  // Asking again belongs to this turn, so its end shows the person this agent needs them (#69).
  if (ASKING.has(v.block.type) && turn) patch.turnId = turn.id;
  // Both ways below write the patch, and with it the images, onto the item (#828).
  if (given.files) given.held = true;
  if (!followsConversation(v.block)) {
    apps.threads.patchItem(where, existing.id, patch);
    return { ok: true, message: `Updated block ${v.block.id}.${note}` };
  }
  // It asks again, so it comes to the newest point, where the person will look for it (#92). Text the turn writes
  // next goes after it, when it’s in the turn’s own thread.
  if (where === threadId()) endSegment();
  const moved = apps.threads.bringForward(where, existing.id, { what: 'block', title: blockTitle(v.block) }, patch);
  return { ok: true, message: `Updated block ${v.block.id}${moved ? '; it asks again at the newest point in the conversation' : ''}.${note}` };
}

/**
 * A review’s images on an update (#780): the update’s list, or the last revision’s, with what it replaces kept for
 * the diff, and whether the person sees a different list. Not a review: nothing to keep.
 * @param {any} block @param {any} existing @param {import('./review-files.mjs').ReviewFile[] | undefined} given
 */
function reviewImages(block, existing, given) {
  if (block.type !== 'review') return { files: null, newFiles: false };
  const files = revisedFiles(existing, given);
  return { files, newFiles: JSON.stringify(files.files) !== JSON.stringify(existing.files ?? []) };
}

// What a block holds that the person never sees: changing it alone doesn’t ask again (#286).
const UNSEEN = new Set(['fallback', 'version']);

/**
 * #593: an update to a block that asks and still waits, which changes nothing the person would answer (only what they can’t
 * see, or whether a review’s threads are resolved, which shows at once), is written in place. A new revision would
 * refuse their answer as stale and mark “Changes since you looked” over an empty diff. A withdrawn or dismissed block
 * counts as answered, so an update to it asks again, as before.
 * Returns the tool’s reply, or null when the update asks again.
 * @param {any} apps @param {string} where @param {any} existing @param {any} block @param {number} now
 */
function keptWaiting(apps, where, existing, block, now) {
  const differ = unseenAware(block, existing.block);
  if (!differ.every((k) => UNSEEN.has(k) || k === STATUS)) return null;
  if (!differ.length) return { ok: true, message: `Nothing in ${block.id} changed, so it still waits on the person as it was.` };
  apps.threads.patchItem(where, existing.id, { block, updatedAt: now });
  return { ok: true, message: `Updated the ${differ.join(', ')} of ${block.id}; it still waits on the person as it was, since nothing they’d answer changed.` };
}
const STATUS = 'threads’ status';
/** Whether two lists of review threads differ only in their status. @param {any[]} [a] @param {any[]} [b] */
const sameThreads = (a = [], b = []) => JSON.stringify(a.map(({ status, ...t }) => t)) === JSON.stringify(b.map(({ status, ...t }) => t));
/**
 * The keys that differ between two blocks, with a change to the threads’ status alone named STATUS, which the person
 * sees at once and doesn’t answer (#593, #901). @param {Record<string, any>} block @param {Record<string, any>} was
 */
const unseenAware = (block, was) => changedKeys(block, was).map((k) => (k === 'threads' && sameThreads(block.threads, was.threads) ? STATUS : k));

/** The keys whose values differ between two blocks. @param {Record<string, any>} a @param {Record<string, any>} b */
const changedKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

/**
 * update_block with outcome reports a result, not a question (#94): it goes under the person’s answer, the block
 * stays answered, and nobody is asked again. { id, outcome } is enough: the rest is the block the person answered,
 * and any other field sent is only compared with it, to say it wasn’t applied (#330).
 * @param {any} apps @param {string} sessionId @param {Record<string, any>} block
 * @param {{ se: () => any, threadId: () => string }} at
 */
function recordOutcome(apps, sessionId, block, { se, threadId }) {
  const id = String(block.id ?? '');
  const { where, existing } = shownBy(apps, sessionId, id, threadId(), se());
  if (!existing) return notShown(apps, sessionId, id);
  if (block.type !== undefined && block.type !== existing.block.type) return { ok: false, message: 'An update can’t change a block’s type.' };
  // An old review’s off-rule authors read as its agent’s (#1143), so its outcome isn’t refused for them.
  const owned = ownedAuthors(existing).block;
  const v = validateBlock({ ...owned, outcome: block.outcome }, { imageOrigins: apps.config.imageOrigins });
  if (!v.ok) return { ok: false, message: `The update was invalid and wasn’t applied: ${v.errors.join(' ')}` };
  // Nor under a dismissal: the person said the block isn’t needed, so there’s no answer to report on.
  if (existing.closed?.by === 'person' || (existing.closed && !existing.answer))
    return { ok: false, message: `${existing.answer ? 'The person dismissed' : 'You withdrew'} ${id}, so it has no answer to report on.` };
  if (!existing.answer) return { ok: false, message: OUTCOME_LATER(id, 'The update wasn’t applied.') };
  // Nor over an answer the agent hasn’t read (#123): it can’t know what came of an answer it hasn’t seen, and
  // “Deleted.” could land under a Cancel.
  if (existing.answer?.read === false) return unreadAnswer(apps, sessionId, where, existing, true);
  const { id: _id, outcome, revision: _revision, ...sent } = block;
  const differ = Object.keys(sent).filter((k) => JSON.stringify(sent[k]) !== JSON.stringify(existing.block[k]));
  // Not a new revision: the draft the person answered is unchanged, and an answered block can’t be answered again.
  apps.threads.patchItem(where, existing.id, { block: { ...owned, outcome }, updatedAt: Date.now() });
  return {
    ok: true,
    message: `Recorded the outcome under the person’s answer to ${id}; it stays answered.${differ.length ? ` Your other changes (${differ.join(', ')}) weren’t applied: an answered block keeps the question the person answered. To ask again, update it without outcome.` : ''}`,
  };
}

/**
 * The newest valid block with this id that the session showed: in the thread the turn is in, else in the session’s
 * own, so a block it showed in the conversation can be updated from a turn in a side thread (#110).
 * @param {any} apps @param {string} sessionId @param {string} id @param {string} threadId  where the turn speaks @param {any} se
 */
function shownBy(apps, sessionId, id, threadId, se) {
  const mine = (t) => [...apps.store.pending.items(t)].reverse().find((x) => x.kind === 'block' && x.valid && x.block.id === id && x.sessionId === sessionId);
  const where = mine(threadId) ? threadId : se.threadId;
  return { where, existing: mine(where) };
}

/**
 * Why there’s no block of the session’s with that id. With no forks (#228), a topic thread’s agent is the
 * conversation’s own session, so there’s no longer a block it showed under another session (#216).
 * @param {any} _apps @param {string} _sessionId @param {string} id
 */
function notShown(_apps, _sessionId, id) {
  return { ok: false, message: `There’s no block with id ${echoedId(id)} to update. Use show_block to add it.` };
}

/**
 * update_block { block: { id, withdraw } }: the agent closes a block that asks, answered or not, and says why (#106).
 * It stops waiting on the person and reads as closed, with who closed it and why. Nothing is deleted: the block keeps
 * what it asked, and any answer.
 * @param {any} apps @param {string} sessionId @param {any} block @param {{ se: () => any, threadId: () => string }} at
 */
function withdraw(apps, sessionId, block, { se, threadId }) {
  const id = String(block.id ?? '');
  const reason = typeof block.withdraw === 'string' ? block.withdraw.trim() : '';
  if (!reason || reason.length > LIMITS.outcome)
    return { ok: false, message: `withdraw is why you’re closing the block, as text up to ${LIMITS.outcome} characters: the person reads it on the block.` };
  const { where, existing } = shownBy(apps, sessionId, id, threadId(), se());
  if (!existing) return notShown(apps, sessionId, id);
  if (!ASKING.has(existing.block.type)) return { ok: false, message: `${id} doesn’t ask anything, so there’s nothing to withdraw. Update it instead.` };
  if (existing.closed)
    return { ok: false, message: `${id} is already closed: ${existing.closed.by === 'person' ? 'the person dismissed it' : 'you withdrew it'}.` };
  // Not over an answer the agent hasn’t read (#123): it would close a block without knowing what the person said.
  if (existing.answer?.read === false) return unreadAnswer(apps, sessionId, where, existing);
  const s = se();
  apps.threads.patchItem(where, existing.id, { answered: true, closed: { by: 'agent', handle: s.handle, reason, at: Date.now() } });
  // It no longer waits on the person, so its agent doesn’t need them for it (card-needs.mjs listens).
  apps.bus.emit('block.withdrawn', { se: s, itemId: existing.id });
  return { ok: true, message: `Withdrew block ${id}. The person sees it closed, with your reason, and it no longer waits on them.` };
}

/** How an agent’s history tells a closed block (#106): who closed it, and why. @param {any} it */
export const closedText = (it) =>
  it.closed.by === 'person'
    ? 'The person dismissed it.'
    : `${it.answer ? `The person answered: ${it.answer.voice}. ` : ''}@${it.closed.handle} withdrew it: ${it.closed.reason}`;

/** What a block’s stub calls it once it moved (#92): its title, or the start of what it asks. @param {any} b */
export const blockTitle = (b) => clip(String(b.title ?? b.statement ?? b.prompt ?? b.fallback ?? b.id).replace(/\s+/g, ' '), 80);

/** Why an outcome was refused on a block nobody has answered yet (#94). @param {string} id @param {string} what */
export const OUTCOME_LATER = (id, what) =>
  `${what} outcome reports the result of the person’s answer, and ${id} hasn’t been answered yet. Send the block without outcome, and set outcome with update_block once they’ve answered.`;
