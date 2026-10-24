// Blocks the person acts in, and an agent’s updates to the blocks it showed: the person’s answer (act), when the
// agent has read it (answerDelivered, #123), update_block, and its refusal over an answer the agent hasn’t read
// (unreadAnswer). Moved out of server/runtime.mjs; Runtime keeps one-line methods that call these.

import { ASKING, followsConversation, validateBlock } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { LIMITS } from '../shared/limits.mjs';
import { formatDuration } from '../shared/text.mjs';
import { clip, clipText, httpError } from './helpers.mjs';
import { keepReviewThreads } from './review-comments.mjs';
import { resolveToolAsk } from './tool-ask.mjs';

export const CATCH_UP_CHARS = 16000;

/** @param {number} [revision]  the revision of the block the person answered, as their page showed it (#123) */
export function act(rt, threadId, itemId, action, values, revision) {
  const it = rt.store.item(threadId, itemId);
  if (!it) throw httpError(404, 'That block doesn’t exist any more.');
  if (it.kind === 'hop') return rt.resolveHop(threadId, itemId, action === 'confirm');
  if (it.kind === 'proposal') return rt.resolveProposal(threadId, itemId, action);
  if (it.kind === 'permission') return rt.resolvePermission(threadId, itemId, action, values);
  if (it.kind === 'denial') return rt.resolveDenial(threadId, itemId, action);
  if (it.kind === 'appsend') return rt.resolveAppSend(threadId, itemId, action);
  if (it.kind === 'toolask') return resolveToolAsk(rt, threadId, itemId, action);
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
  // read: whether the agent has had the answer in a turn yet. Until then an update can’t reopen the block.
  if (locks)
    rt.patchItem(threadId, itemId, {
      answered: true,
      answer: { action, values: r.event.values, voice: r.voice, at: Date.now(), revision: current, read: false },
      ...(dismissed ? { closed: { by: 'person', at: Date.now() } } : {}),
    });
  rt.addItem(threadId, { kind: 'voice', text: r.voice, blockItemId: itemId });
  const se = rt.s.sessions[it.sessionId];
  if (se?.needs?.itemId === itemId) rt.updateSession(se.id, { needs: null, state: rt.turns.has(se.id) ? se.state : 'idle' });
  if (se) rt.deliver(se.id, { kind: 'event', event: r.event, blockItemId: itemId }, { threadId });
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
export function updateBlock(rt, sessionId, { block }, { turn, se, threadId, endSegment }) {
  if (block && typeof block === 'object' && Object.hasOwn(block, 'withdraw')) return withdraw(rt, sessionId, block, { se, threadId });
  const v = validateBlock(block, { imageOrigins: rt.config.imageOrigins });
  if (!v.ok) return { ok: false, message: `The update was invalid and wasn’t applied: ${v.errors.join(' ')}` };
  const { where, existing } = shownBy(rt, sessionId, v.block.id, threadId(), se());
  if (!existing) return notShown(rt, sessionId, v.block.id);
  if (existing.block.type !== v.block.type) return { ok: false, message: 'An update can’t change a block’s type.' };
  const now = Date.now();
  // An update that sets outcome reports a result, not a question (#94): it goes under the person’s answer, the
  // block stays answered, and nobody is asked again. The question they answered stays as they saw it.
  if (typeof v.block.outcome === 'string') {
    // Nor under a dismissal: the person said the block isn’t needed, so there’s no answer to report on.
    if (existing.closed?.by === 'person' || (existing.closed && !existing.answer))
      return { ok: false, message: `${existing.answer ? 'The person dismissed' : 'You withdrew'} ${v.block.id}, so it has no answer to report on.` };
    if (!existing.answer)
      return {
        ok: false,
        message: OUTCOME_LATER(v.block.id, 'The update wasn’t applied.'),
      };
    // Nor over an answer the agent hasn’t read (#123): it can’t know what came of an answer it hasn’t seen, and
    // “Deleted.” could land under a Cancel.
    if (existing.answer?.read === false) return rt.unreadAnswer(sessionId, where, existing, true);
    const { outcome, ...asked } = v.block;
    const keys = new Set([...Object.keys(asked), ...Object.keys(existing.block)].filter((k) => k !== 'outcome'));
    const changed = [...keys].some((k) => JSON.stringify(asked[k]) !== JSON.stringify(existing.block[k]));
    rt.patchItem(where, existing.id, { block: { ...existing.block, outcome }, revision: (existing.revision ?? 1) + 1, updatedAt: now });
    return {
      ok: true,
      message: `Recorded the outcome under the person’s answer to ${v.block.id}; it stays answered.${changed ? ' Your other changes weren’t applied: an answered block keeps the question the person answered. To ask again, update it without outcome.' : ''}`,
    };
  }
  // Any other update asks again, so it reopens a block you already answered. Not over an answer the agent hasn’t
  // read (#123): the person would see it vanish, and the agent would never learn what it erased.
  if (existing.answered && existing.answer?.read === false) return rt.unreadAnswer(sessionId, where, existing);
  // Another agent’s comments stay on a review its revision leaves them off (#133).
  if (v.block.type === 'review') v.block = keepReviewThreads(existing, v.block);
  /** @type {Record<string, any>} */
  const patch = { block: v.block, answered: false, answer: null, closed: null, revision: (existing.revision ?? 1) + 1, updatedAt: now };
  if (v.block.type === 'progress') Object.assign(patch, stampSteps(existing, v.block, now));
  // Asking again belongs to this turn, so its end shows the person this agent needs them (#69).
  if (ASKING.has(v.block.type) && turn) patch.turnId = turn.id;
  if (!followsConversation(v.block)) {
    rt.patchItem(where, existing.id, patch);
    return { ok: true, message: `Updated block ${v.block.id}.` };
  }
  // It asks again, so it comes to the newest point, where the person will look for it (#92). Text the turn writes
  // next goes after it, when it’s in the turn’s own thread.
  if (where === threadId()) endSegment();
  const moved = rt.bringForward(where, existing.id, { what: 'block', title: blockTitle(v.block) }, patch);
  return { ok: true, message: `Updated block ${v.block.id}${moved ? '; it asks again at the newest point in the conversation' : ''}.` };
}

/**
 * The newest valid block with this id that the session showed: in the thread the turn is in, else in the session’s
 * own, so a block it showed in the conversation can be updated from a turn in a side thread (#110).
 * @param {any} rt @param {string} sessionId @param {string} id @param {string} threadId  where the turn speaks @param {any} se
 */
function shownBy(rt, sessionId, id, threadId, se) {
  const mine = (t) => [...rt.store.items(t)].reverse().find((x) => x.kind === 'block' && x.valid && x.block.id === id && x.sessionId === sessionId);
  const where = mine(threadId) ? threadId : se.threadId;
  return { where, existing: mine(where) };
}

/**
 * Why there’s no block of the session’s with that id. With no forks (#228), a topic thread’s agent is the
 * conversation’s own session, so there’s no longer a block it showed under another session (#216).
 * @param {any} _rt @param {string} _sessionId @param {string} id
 */
function notShown(_rt, _sessionId, id) {
  return { ok: false, message: `There’s no block with id ${id} to update. Use show_block to add it.` };
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
  if (s.needs?.itemId === existing.id) rt.updateSession(s.id, { needs: null, state: rt.turns.has(s.id) ? s.state : 'idle' });
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

/**
 * A progress update’s step times, kept beside the block: startedAt when a step starts running, endedAt when it
 * stops. A step that finishes without a duration gets one from them.
 * @param {any} item  the block as it was  @param {any} block  the update  @param {number} now
 */
function stampSteps(item, block, now) {
  const was = new Map((item.block.steps ?? []).map((s) => [s.id, s.state]));
  /** @type {Record<string, { startedAt?: number, endedAt?: number }>} */
  const times = {};
  const steps = block.steps.map((sent) => {
    const before = was.get(sent.id);
    // Only Postbox marks a step stalled; from the agent, it means still running.
    const s = sent.state === 'stalled' && before !== 'stalled' ? { ...sent, state: 'running' } : sent;
    const t = { ...(item.stepTimes?.[s.id] ?? {}) };
    const going = before === 'running' || before === 'stalled';
    // A step that was running when the block was shown started then.
    if (going) t.startedAt ??= item.at;
    if (s.state === 'running') {
      if (!going) t.startedAt = now;
      delete t.endedAt;
    } else if (going && s.state !== 'pending') t.endedAt = now;
    times[s.id] = t;
    const finished = s.state === 'done' || s.state === 'failed';
    return finished && !s.duration && t.startedAt && t.endedAt ? { ...s, duration: formatDuration(t.endedAt - t.startedAt) } : s;
  });
  return { block: { ...block, steps }, stepTimes: times };
}
