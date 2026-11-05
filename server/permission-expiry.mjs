// A permission card whose request expired before the person answered it (#721): it stops counting toward “needs you”,
// and the agent that asked is told in its next turn, since the answer its waiting call got went to a call nobody reads
// once the turn has ended. A card left closed while still the need can be dismissed from the page.

import { releaseNeed } from './card-needs.mjs';
import { clip, clipText, httpError } from './helpers.mjs';

/** The statuses that mean nobody can answer the card any more, though nobody turned it down (#120’s host statuses too). */
export const EXPIRED = new Set(['expired', 'ended']);

/**
 * Queues a note for the agent’s next turn that its request expired, and what to do: ask again, naming the request by its
 * summary and its command, since a summary alone can be as plain as “run a command”. Once per card, even when two
 * paths expire it (the turn’s end, then its host’s word), since the card keeps that it was told. None when the person
 * stopped the turn (`stoppedBy`, as on main), or when the agent is archived or being removed: nobody would read it.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {any} [card]  the card, when the caller has it
 */
export function tellExpired(rt, threadId, itemId, card = undefined) {
  const it = card ?? rt.store.pending.items(threadId).find((/** @type {any} */ x) => x.id === itemId);
  if (it?.kind !== 'permission' || it.agentTold || it.stoppedBy) return;
  const se = rt.s.sessions[it.sessionId];
  if (!se || se.archived || se.deleting) return;
  rt.patchItem(threadId, itemId, { agentTold: true });
  rt.tellAgent(it.sessionId, `${requestOf(it)} expired before the person answered it, so it didn’t run. Ask again if you still need it.`);
}

/** How the note names a request: whose, its summary, and its command when the card has one. @param {any} it */
function requestOf(it) {
  const who = it.who ? `Your subagent’s (${it.who}) request` : 'Your request';
  const command = it.detail ? ` (${quoted(it.detail)})` : '';
  return `${who} to ${clip(it.summary, 120)}${command}`;
}

/**
 * A command as the note quotes it: on one line, cut to 120 characters, never rewritten (clip would strip its Markdown,
 * turning `*.log` into `.log`), in a code span whose fence its own backticks can’t close.
 * @param {string} detail
 */
function quoted(detail) {
  const text = clipText(String(detail).replace(/\s+/g, ' ').trim(), 120);
  if (!text.includes('`')) return `\`${text}\``;
  return `\`\` ${text} \`\``;
}

/**
 * A permission card closes, the one way every path does it (#721): the session stops needing the person for it first,
 * so the page redraws the card knowing nothing waits on it; then the card’s patch; then, for an expiry, the note for the
 * agent’s next turn. The release is #633’s releaseNeed: if the card was the need, the next card that waits takes it. The
 * card’s wait is already gone (settlePermission), so the card can’t take the need back before its patch.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {string} sessionId
 * @param {Record<string, any> & { status: string }} patch
 */
export function closeCard(rt, threadId, itemId, sessionId, patch) {
  // 'tool': a turn still running goes on with the tool call this card held.
  releaseNeed(rt, rt.s.sessions[sessionId], itemId, 'tool');
  rt.patchItem(threadId, itemId, patch);
  if (EXPIRED.has(patch.status)) tellExpired(rt, threadId, itemId);
}

/**
 * Dismiss on a card nobody can answer any more: it stops counting toward “needs you”. A backstop for a closed card
 * left as the need; an open card is answered, never dismissed.
 * @param {any} rt @param {string} threadId @param {string} itemId
 */
export function dismissPermission(rt, threadId, itemId) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'permission') throw httpError(409, 'Only a permission card can be dismissed.');
  if (it.status === 'open') throw httpError(409, 'This request is still waiting for your answer: allow it or don’t, rather than dismiss it.');
  // The need goes first, so the page redraws the card, on its patch, without Dismiss.
  releaseNeed(rt, rt.s.sessions[it.sessionId], itemId);
  rt.patchItem(threadId, itemId, { dismissed: true, dismissedAt: Date.now() });
  return { ok: true };
}

/**
 * After a restart, no tool call is waiting any more, so open cards can’t be answered. A card of a turn still on a
 * remote host stays open: the host sends its prompt again, or says it expired (#120).
 */
export function expireStalePermissions(rt) {
  for (const [threadId, items] of Object.entries(rt.s.items))
    for (const it of items)
      if (it.kind === 'permission' && it.status === 'open' && !rt.remote.keepsCard(it)) {
        rt.patchItem(threadId, it.id, { status: 'expired' });
        // Only the note: the need this leaves on the card is #633’s to release. The card is at hand, so no lookup.
        tellExpired(rt, threadId, it.id, { ...it, status: 'expired' });
      }
}
