// Blocks the person acts in: the person’s answer (act), and the cards it dispatches to the code that answers each.
// An agent’s updates to the blocks it showed, and when it has read an answer, are in server/block-update.mjs.

import { ASKING } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { answerQuestion, lateAnswer, waitingQuestion } from './ask-question.mjs';
import { blockTitle } from './block-update.mjs';
import { releaseNeed } from './card-needs.mjs';
import { httpError, refuseRetired } from './helpers.mjs';
import { REACT } from './reactions.mjs';
import { resolveToolAsk } from './tool-ask.mjs';
import { resolveViewAsk } from './view-app/consent.mjs';
import { stopRequested } from './write-intent.mjs';

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
  if (action === REACT) return rt.threads.toggleReaction(threadId, itemId, values?.emoji);
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
  refuseRetired(rt.s.sessions[it.sessionId]);
  // A review’s comments become the person’s threads on it, in the one write that records the answer (#1143).
  const theirs = locks && !dismissed ? rt.apps.personAnswer(it, r.event, current) : null;
  const ev = theirs?.event ?? r.event;
  // An AskUserQuestion’s block (#521): the answer is its call’s result, so the agent has it now, and no event goes.
  const asked = waitingQuestion(rt, itemId);
  // read: whether the agent has had the answer in a turn yet. Until then an update can’t reopen the block.
  if (locks)
    rt.threads.patchItem(threadId, itemId, {
      answered: true,
      answer: { action, values: ev.values, voice: r.voice, at: Date.now(), revision: current, read: asked },
      ...theirs?.patch,
      ...(dismissed ? { closed: { by: 'person', at: Date.now() } } : {}),
    });
  rt.threads.addItem(threadId, { kind: 'voice', text: r.voice, blockItemId: itemId });
  const se = rt.s.sessions[it.sessionId];
  releaseNeed(rt, se, itemId);
  // A question whose call has gone gets its answer as an event, with its question and labels in words (#521).
  const event = it.question ? { ...ev, question: lateAnswer(it.block, r.event.values, dismissed) } : ev;
  if (asked) answerQuestion(rt, itemId, dismissed ? null : r.event.values);
  else if (se) rt.deliver(se.id, { kind: 'event', event, blockItemId: itemId }, { threadId });
  return { ok: true, voice: r.voice };
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
