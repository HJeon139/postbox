// Blocks the person acts in, and an agent’s updates to the blocks it showed: the person’s answer (act), when the
// agent has read it (answerDelivered, #123), update_block, and its refusal over an answer the agent hasn’t read
// (unreadAnswer). Moved out of server/runtime.mjs; Runtime keeps one-line methods that call these.

import { updateKind } from '../shared/block-updates.mjs';
import { ASKING, followsConversation, validateBlock } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { LIMITS } from '../shared/limits.mjs';
import { answerQuestion, lateAnswer, waitingQuestion } from './ask-question.mjs';
import { releaseNeed } from './card-needs.mjs';
import { clip, clipText, echoedId, httpError, refuseArchived } from './helpers.mjs';
import { stampSteps } from './progress-steps.mjs';
import { REACT, toggleReaction } from './reactions.mjs';
import { revisedFiles } from './review-files.mjs';
import { personAnswer, revisedReview } from './review-person.mjs';
import { resolveToolAsk } from './tool-ask.mjs';
import { resolveViewAsk } from './view-app/consent.mjs';
import { stopRequested } from './write-intent.mjs';

export const CATCH_UP_CHARS = 16000;

/**
 * The items other than blocks that the person acts in, and what each act does: confirm or cancel a hop, answer a
 * proposal, a permission or a denial, an app’s send, a tool or view_app ask, or stop an allowed call.
 * @type {Record<string, (rt: any, threadId: string, itemId: string, action: string, values: any) => any>}
 */
const ANSWERED_BY = {
  hop: (rt, threadId, itemId, action) => rt.resolveHop(threadId, itemId, action === 'confirm'),
  proposal: (rt, threadId, itemId, action) => rt.resolveProposal(threadId, itemId, action),
  permission: (rt, threadId, itemId, action, values) => rt.resolvePermission(threadId, itemId, action, values),
  denial: (rt, threadId, itemId, action) => rt.resolveDenial(threadId, itemId, action),
  appsend: (rt, threadId, itemId, action) => rt.resolveAppSend(threadId, itemId, action),
  toolask: (rt, threadId, itemId, action) => resolveToolAsk(rt, threadId, itemId, action),
  viewask: (rt, threadId, itemId, action) => resolveViewAsk(rt, threadId, itemId, action),
  allowedcall: (rt, threadId, itemId, action) => stopRequested(rt, threadId, itemId, action),
};

/** @param {number} [revision]  the revision of the block the person answered, as their page showed it (#123) */
export function act(rt, threadId, itemId, action, values, revision) {
  const it = rt.store.item(threadId, itemId);
  if (!it) throw httpError(404, 'That block doesn’t exist any more.');
  // A reaction is an act on any message, block or app (#251), and never answers one.
  if (action === REACT) return toggleReaction(rt, threadId, itemId, values?.emoji);
  if (Object.hasOwn(ANSWERED_BY, it.kind)) return ANSWERED_BY[it.kind](rt, threadId, itemId, action, values);
  if (it.kind !== 'block' || !it.valid) throw httpError(409, 'This block can’t be acted on.');
  if (it.closed?.by === 'agent')
    throw httpError(409, `@${it.closed.handle} withdrew this, so it no longer asks. Only a new block, or an update to it, can ask again.`);
  if (it.answered) throw httpError(409, 'You already answered this. Only a new block, or an update to it, can ask again.');
  // Progress, image and code never ask; a card or table action doesn’t lock the block.
  const locks = ASKING.has(it.block.type);
  const current = it.revision ?? 1;
  // An answer is for the revision the person saw. One the agent replaced while they were answering is refused,
  // so an approval never lands on text they didn’t see; their page keeps the draft and shows what changed.
  if (revision !== undefined && !Number.isInteger(revision)) throw httpError(422, 'The revision you answered must be a whole number.');
  if (locks && revision !== undefined && revision !== current)
    throw Object.assign(
      httpError(
        409,
        `This changed while you were answering: you answered revision ${revision}, and it’s now revision ${current}. Look it over, then answer again.`,
      ),
      { code: 'stale' },
    );
  // Dismiss closes a block that asks without answering it (#106), and the agent hears it as the person’s answer.
  const dismissed = locks && action === 'dismiss';
  const r = dismissed ? dismissal(it.block, current) : buildEvent(it.block, action, values, { revision: current });
  if (!r.ok) throw Object.assign(httpError(422, r.error), { fieldErrors: r.fieldErrors });
  refuseArchived(rt, it.sessionId);
  // A review’s comments become the person’s threads on it, in the one write that records the answer (#1143).
  const theirs = locks && !dismissed ? personAnswer(rt, it, r.event, current) : null;
  const ev = theirs?.event ?? r.event;
  // An AskUserQuestion’s block (#521): the answer is its call’s result, so the agent has it now, and no event goes.
  const asked = waitingQuestion(rt, itemId);
  // read: whether the agent has had the answer in a turn yet. Until then an update can’t reopen the block.
  if (locks)
    rt.patchItem(threadId, itemId, {
      answered: true,
      answer: { action, values: ev.values, voice: r.voice, at: Date.now(), revision: current, read: asked },
      ...theirs?.patch,
      ...(dismissed ? { closed: { by: 'person', at: Date.now() } } : {}),
    });
  rt.addItem(threadId, { kind: 'voice', text: r.voice, blockItemId: itemId });
  const se = rt.s.sessions[it.sessionId];
  releaseNeed(rt, se, itemId);
  // A question whose call has gone gets its answer as an event, with its question and labels in words (#521).
  const event = it.question ? { ...ev, question: lateAnswer(it.block, r.event.values, dismissed) } : ev;
  if (asked) answerQuestion(rt, itemId, dismissed ? null : r.event.values);
  else if (se) rt.deliver(se.id, { kind: 'event', event, blockItemId: itemId }, { threadId });
  return { ok: true, voice: r.voice };
}

/**
 * An answer is read once its event starts one of the agent’s turns (#123). While the agent works, the event waits
 * in its turn’s queue, and until it’s delivered, update_block can’t reopen the block over it.
 * @param {string} threadId @param {any} message  a message starting a turn
 */
export function answerDelivered(rt, threadId, message) {
  if (message.kind !== 'event' || !message.blockItemId) return;
  const it = rt.store.item(threadId, message.blockItemId);
  if (it?.answer?.read === false && it.answer.revision === message.event.revision) rt.patchItem(threadId, it.id, { answer: { ...it.answer, read: true } });
}

/**
 * update_block’s refusal over an answer the agent hasn’t read: the answer stays on screen, and the reply says what
 * it was. If its event is no longer waiting for the agent (a stopped or failed turn, or a restart, dropped it), the
 * reply carries the whole answer and counts as reading it, so the block isn’t stuck.
 * @param {string} sessionId @param {string} threadId @param {any} it  the answered block item
 * @param {boolean} [outcome]  the update set outcome: it reports on an answer the agent can’t know yet
 */
export function unreadAnswer(rt, sessionId, threadId, it, outcome = false) {
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
  const waiting = rt.turns.get(sessionId)?.pending.some((p) => p.message.blockItemId === it.id);
  const then = outcome ? 'then record the outcome' : 'then update';
  if (waiting) return { ok: false, message: `${said} It reaches you when this turn ends: read it, ${then}.` };
  rt.patchItem(threadId, it.id, { answer: { ...a, read: true } });
  return {
    ok: false,
    message: `${said} It didn’t reach you in a turn, so ${it.block.type !== 'review' && full.length <= 300 ? 'that’s the whole answer' : `here it is in full: ${a.action} ${clipText(full, CATCH_UP_CHARS)}`}. Read it, ${then}.`,
  };
}

/**
 * update_block { block }, for the session’s turn. Its closure in Runtime.toolsFor read turn, se(), threadId() and
 * endSegment(), so they come as parameters.
 */
/**
 * @param {{ files?: import('./review-files.mjs').ReviewFile[], held?: boolean }} [given]  a review’s images, read for this
 *   update (#780); held is set once the item holds them, so keptIfShown keeps their blobs (#828)
 */
export function updateBlock(rt, sessionId, { block }, { turn, se, threadId, endSegment }, given = {}) {
  const kind = updateKind(block);
  if (kind === 'withdraw') return withdraw(rt, sessionId, block, { se, threadId });
  if (kind === 'outcome') return recordOutcome(rt, sessionId, block, { se, threadId });
  const v = validateBlock(block, { imageOrigins: rt.config.imageOrigins });
  if (!v.ok) return { ok: false, message: `The update was invalid and wasn’t applied: ${v.errors.join(' ')}` };
  const { where, existing: found } = shownBy(rt, sessionId, v.block.id, threadId(), se());
  if (!found) return notShown(rt, sessionId, v.block.id);
  if (found.block.type !== v.block.type) return { ok: false, message: 'An update can’t change a block’s type.' };
  const now = Date.now();
  // Any other update asks again, so it reopens a block you already answered. Not over an answer the agent hasn’t
  // read (#123): the person would see it vanish, and the agent would never learn what it erased.
  if (found.answered && found.answer?.read === false) return rt.unreadAnswer(sessionId, where, found);
  // The person’s and other agents’ threads stay on a review, and its agent comments only as itself (#133, #1143).
  const { existing, reviews, note, ...revised } = revisedReview(found, v.block);
  v.block = revised.block;
  if (v.block.type === 'review') {
    const kept = validateBlock(v.block, { imageOrigins: rt.config.imageOrigins });
    if (!kept.ok) return { ok: false, message: `The update wasn’t applied: with the reviewers’ threads it leaves out, which stay, ${kept.errors.join(' ')}` };
  }
  // One that changes only what the person can’t see (its fallback), or only whether a review’s threads are resolved
  // (#901), asks nothing new, so an answered block stays answered, and an outcome can follow (#286).
  const { files, newFiles } = reviewImages(v.block, existing, given.files);
  if (existing.answered && !newFiles) {
    const differ = unseenAware(v.block, existing.block).filter((k) => k !== 'outcome');
    if (differ.length > 0 && !existing.closed && differ.every((k) => UNSEEN.has(k) || k === STATUS)) {
      if (differ.length) rt.patchItem(where, existing.id, { block: { ...v.block, outcome: existing.block.outcome }, updatedAt: now, ...reviews });
      // The images are the ones it already holds (no newFiles), so their blobs stay.
      if (given.files) given.held = true;
      return {
        ok: true,
        message: `${differ.length ? `Updated the ${differ.join(', ')} of ${v.block.id}` : `Nothing in ${v.block.id} changed`}; it stays answered, since nothing the person would answer changed. To ask again, change what it asks.${note}`,
      };
    }
  }
  const kept = ASKING.has(v.block.type) && !existing.answered && !newFiles ? keptWaiting(rt, where, existing, v.block, now) : null;
  if (kept) {
    if (given.files) given.held = true;
    return { ...kept, message: kept.message + note };
  }
  /** @type {Record<string, any>} */
  const patch = { block: v.block, answered: false, answer: null, closed: null, revision: (existing.revision ?? 1) + 1, updatedAt: now, ...files, ...reviews };
  if (v.block.type === 'progress') Object.assign(patch, stampSteps(existing, v.block, now));
  // Asking again belongs to this turn, so its end shows the person this agent needs them (#69).
  if (ASKING.has(v.block.type) && turn) patch.turnId = turn.id;
  // Both ways below write the patch, and with it the images, onto the item (#828).
  if (given.files) given.held = true;
  if (!followsConversation(v.block)) {
    rt.patchItem(where, existing.id, patch);
    return { ok: true, message: `Updated block ${v.block.id}.${note}` };
  }
  // It asks again, so it comes to the newest point, where the person will look for it (#92). Text the turn writes
  // next goes after it, when it’s in the turn’s own thread.
  if (where === threadId()) endSegment();
  const moved = rt.bringForward(where, existing.id, { what: 'block', title: blockTitle(v.block) }, patch);
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
 * @param {any} rt @param {string} where @param {any} existing @param {any} block @param {number} now
 */
function keptWaiting(rt, where, existing, block, now) {
  const differ = unseenAware(block, existing.block);
  if (!differ.every((k) => UNSEEN.has(k) || k === STATUS)) return null;
  if (!differ.length) return { ok: true, message: `Nothing in ${block.id} changed, so it still waits on the person as it was.` };
  rt.patchItem(where, existing.id, { block, updatedAt: now });
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
 * @param {any} rt @param {string} sessionId @param {Record<string, any>} block
 * @param {{ se: () => any, threadId: () => string }} at
 */
function recordOutcome(rt, sessionId, block, { se, threadId }) {
  const id = String(block.id ?? '');
  const { where, existing } = shownBy(rt, sessionId, id, threadId(), se());
  if (!existing) return notShown(rt, sessionId, id);
  if (block.type !== undefined && block.type !== existing.block.type) return { ok: false, message: 'An update can’t change a block’s type.' };
  const v = validateBlock({ ...existing.block, outcome: block.outcome }, { imageOrigins: rt.config.imageOrigins });
  if (!v.ok) return { ok: false, message: `The update was invalid and wasn’t applied: ${v.errors.join(' ')}` };
  // Nor under a dismissal: the person said the block isn’t needed, so there’s no answer to report on.
  if (existing.closed?.by === 'person' || (existing.closed && !existing.answer))
    return { ok: false, message: `${existing.answer ? 'The person dismissed' : 'You withdrew'} ${id}, so it has no answer to report on.` };
  if (!existing.answer) return { ok: false, message: OUTCOME_LATER(id, 'The update wasn’t applied.') };
  // Nor over an answer the agent hasn’t read (#123): it can’t know what came of an answer it hasn’t seen, and
  // “Deleted.” could land under a Cancel.
  if (existing.answer?.read === false) return rt.unreadAnswer(sessionId, where, existing, true);
  const { id: _id, outcome, revision: _revision, ...sent } = block;
  const differ = Object.keys(sent).filter((k) => JSON.stringify(sent[k]) !== JSON.stringify(existing.block[k]));
  // Not a new revision: the draft the person answered is unchanged, and an answered block can’t be answered again.
  rt.patchItem(where, existing.id, { block: { ...existing.block, outcome }, updatedAt: Date.now() });
  return {
    ok: true,
    message: `Recorded the outcome under the person’s answer to ${id}; it stays answered.${differ.length ? ` Your other changes (${differ.join(', ')}) weren’t applied: an answered block keeps the question the person answered. To ask again, update it without outcome.` : ''}`,
  };
}

/**
 * The newest valid block with this id that the session showed: in the thread the turn is in, else in the session’s
 * own, so a block it showed in the conversation can be updated from a turn in a side thread (#110).
 * @param {any} rt @param {string} sessionId @param {string} id @param {string} threadId  where the turn speaks @param {any} se
 */
function shownBy(rt, sessionId, id, threadId, se) {
  const mine = (t) => [...rt.store.pending.items(t)].reverse().find((x) => x.kind === 'block' && x.valid && x.block.id === id && x.sessionId === sessionId);
  const where = mine(threadId) ? threadId : se.threadId;
  return { where, existing: mine(where) };
}

/**
 * Why there’s no block of the session’s with that id. With no forks (#228), a topic thread’s agent is the
 * conversation’s own session, so there’s no longer a block it showed under another session (#216).
 * @param {any} _rt @param {string} _sessionId @param {string} id
 */
function notShown(_rt, _sessionId, id) {
  return { ok: false, message: `There’s no block with id ${echoedId(id)} to update. Use show_block to add it.` };
}

/**
 * update_block { block: { id, withdraw } }: the agent closes a block that asks, answered or not, and says why (#106).
 * It stops waiting on the person and reads as closed, with who closed it and why. Nothing is deleted: the block keeps
 * what it asked, and any answer.
 * @param {any} rt @param {string} sessionId @param {any} block @param {{ se: () => any, threadId: () => string }} at
 */
function withdraw(rt, sessionId, block, { se, threadId }) {
  const id = String(block.id ?? '');
  const reason = typeof block.withdraw === 'string' ? block.withdraw.trim() : '';
  if (!reason || reason.length > LIMITS.outcome)
    return { ok: false, message: `withdraw is why you’re closing the block, as text up to ${LIMITS.outcome} characters: the person reads it on the block.` };
  const { where, existing } = shownBy(rt, sessionId, id, threadId(), se());
  if (!existing) return notShown(rt, sessionId, id);
  if (!ASKING.has(existing.block.type)) return { ok: false, message: `${id} doesn’t ask anything, so there’s nothing to withdraw. Update it instead.` };
  if (existing.closed)
    return { ok: false, message: `${id} is already closed: ${existing.closed.by === 'person' ? 'the person dismissed it' : 'you withdrew it'}.` };
  // Not over an answer the agent hasn’t read (#123): it would close a block without knowing what the person said.
  if (existing.answer?.read === false) return rt.unreadAnswer(sessionId, where, existing);
  const s = se();
  rt.patchItem(where, existing.id, { answered: true, closed: { by: 'agent', handle: s.handle, reason, at: Date.now() } });
  releaseNeed(rt, s, existing.id);
  return { ok: true, message: `Withdrew block ${id}. The person sees it closed, with your reason, and it no longer waits on them.` };
}

/**
 * The person’s dismissal of a block that asks (#106): an answer with no values.
 * @param {any} block @param {number} revision @returns {{ ok: true, event: any, voice: string }}
 */
const dismissal = (block, revision) => ({
  ok: true,
  event: { blockId: block.id, revision, action: 'dismiss', values: {} },
  voice: `Dismissed: ${blockTitle(block)}`,
});

/** How an agent’s history tells a closed block (#106): who closed it, and why. @param {any} it */
export const closedText = (it) =>
  it.closed.by === 'person'
    ? 'The person dismissed it.'
    : `${it.answer ? `The person answered: ${it.answer.voice}. ` : ''}@${it.closed.handle} withdrew it: ${it.closed.reason}`;

/** What a block’s stub calls it once it moved (#92): its title, or the start of what it asks. @param {any} b */
const blockTitle = (b) => clip(String(b.title ?? b.statement ?? b.prompt ?? b.fallback ?? b.id).replace(/\s+/g, ' '), 80);

/** Why an outcome was refused on a block nobody has answered yet (#94). @param {string} id @param {string} what */
export const OUTCOME_LATER = (id, what) =>
  `${what} outcome reports the result of the person’s answer, and ${id} hasn’t been answered yet. Send the block without outcome, and set outcome with update_block once they’ve answered.`;
