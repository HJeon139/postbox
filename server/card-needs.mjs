// What an agent needs you for, read from its cards (#366; the stopgap the integrator's review of #608 asked for, until
// A1b derives needs from open records): when one card is answered, the agent needs you for the newest card that still
// waits, and a resolver clears only a need that is its own. `nextNeed` is the one place that decides it, and the one
// function A1b replaces.

import { ASKING } from '../shared/catalog.mjs';
import { clip } from '../shared/text.mjs';
import { APP_SEND_LIMIT } from './apps.mjs';

/** The threads whose cards are the agent's: its own, and the side and topic threads off it. */
const threadsOf = (rt, se) => [
  se.threadId,
  ...Object.values(rt.s.threads)
    .filter((t) => t.parentId === se.threadId)
    .map((t) => t.id),
];

const messages = (n) => (n === 1 ? '1 message' : `${n} messages`);

/**
 * The need a card makes, or null if it doesn't wait. App sends, wake requests and waiting permission cards wait until
 * answered; asking blocks, refusals and tool requests wait only from the agent's last ended turn, so older ones you
 * moved past stay quiet (#69). `keep` is a card that still counts whatever its turn (a block a turn you didn't start
 * was waiting on).
 */
function needOf(rt, se, it, threadId, turnId, keep) {
  const where = rt.awayFrom(se, threadId);
  if (it.kind === 'appsend' && it.sessionId === se.id && it.status === 'open')
    return { kind: 'appsend', itemId: it.id, text: `${it.title} wants to send ${messages(it.events?.length ?? 1)} for you`, ...where };
  if (it.kind === 'hop' && it.fromSessionId === se.id && it.status === 'open')
    return { kind: 'hop', itemId: it.id, text: `@${se.handle} wants to ${it.join ? 'add' : 'wake'} @${it.to}`, ...where };
  if (it.kind === 'permission' && it.sessionId === se.id && it.status === 'open' && rt.permissionWaits.has(it.id))
    return { kind: 'permission', itemId: it.id, text: `@${se.handle} asks to ${it.summary}`, ...where };
  if (it.sessionId !== se.id || (it.turnId !== turnId && it.id !== keep)) return null;
  if (it.kind === 'block' && it.valid && ASKING.has(it.block?.type) && !it.answered)
    return { kind: 'block', itemId: it.id, text: it.block.title ?? clip(it.block.prompt ?? it.block.fallback, 120), ...where };
  if (it.kind === 'denial' && it.status === 'open') return { kind: 'denial', itemId: it.id, text: `A step was refused: ${it.summary}`, ...where };
  if (it.kind === 'toolask' && it.status === 'open')
    return { kind: 'toolask', itemId: it.id, text: `@${se.handle} asks you to turn on “${it.label}”`, ...where };
  return null;
}

/**
 * Which need comes first when several cards wait, as the turn's end has always chosen: a permission the running turn is
 * blocked on, then the last turn's asking block, its refusals, its tool request, and last the cards that wait until
 * answered (app sends, wake requests). Within a kind, the newest card.
 */
const RANK = { permission: 0, block: 1, denial: 2, toolask: 3, appsend: 4, hop: 4 };

/**
 * The card of the agent that comes first among those that still wait for the person, as a `needs` value, or null. It
 * reads pending: its result decides a write, so a card held behind a commit counts (#601).
 * @param {any} rt @param {any} se @param {{ turnId?: string | null, keep?: string | null }} [o]
 */
export function nextNeed(rt, se, { turnId = rt.lastTurn.get(se.id) ?? null, keep = null } = {}) {
  /** @type {{ at: number, need: any } | null} */
  let best = null;
  let refused = 0;
  for (const threadId of threadsOf(rt, se))
    for (const it of rt.store.pending.items(threadId)) {
      const need = needOf(rt, se, it, threadId, turnId, keep);
      if (!need) continue;
      if (need.kind === 'denial') refused++;
      const ahead = !best || RANK[need.kind] < RANK[best.need.kind] || (RANK[need.kind] === RANK[best.need.kind] && (it.at ?? 0) >= best.at);
      if (ahead) best = { at: it.at ?? 0, need };
    }
  // Several refusals are counted, as the turn's end always said.
  if (best?.need.kind === 'denial' && refused > 1) best.need.text = best.need.text.replace(/^A step was refused/, `${refused} steps were refused`);
  return best?.need ?? null;
}

/**
 * A card was answered or retired. If the agent's need is that card, it falls back to the next card that waits, and
 * an app card that becomes the need without ever being notified is notified now. Any other need is left alone.
 * @param {any} rt @param {any} se @param {string} itemId @param {string} [busy]  the state while a turn runs
 */
export function releaseNeed(rt, se, itemId, busy = se?.state) {
  if (!se || se.needs?.itemId !== itemId) return;
  const need = nextNeed(rt, se);
  rt.updateSession(se.id, { needs: need, state: rt.turns.has(se.id) ? busy : need ? 'needs' : 'idle' });
  if (need?.kind === 'appsend') notifyOnce(rt, se, need);
}

/** An app card that waited behind another need was never notified (`notifiedAt: null`); one from before #366 counts as notified. */
function notifyOnce(rt, se, need) {
  const threadId = need.threadId ?? se.threadId;
  const card = rt.store.pending.items(threadId).find((x) => x.id === need.itemId);
  if (card?.notifiedAt !== null) return;
  rt.patchItem(threadId, card.id, { notifiedAt: Date.now() });
  rt.notify('blocking', se, need.text, `Apps send up to ${APP_SEND_LIMIT} a minute in your voice. Allow these, or don’t.`);
}
