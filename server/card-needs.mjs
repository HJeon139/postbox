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
 * Which need comes first when several wait, as the turn's end has always chosen: a permission the running turn is
 * blocked on, then a failed turn (its Retry: only its own release clears it, and no card but a permission, which a
 * running turn is blocked on, replaces it, as on main), then the last turn's asking block, its refusals, its tool
 * request, and last the cards that wait until answered (app sends, wake requests). Within a kind, the newest. Every kind
 * a need can have is listed; tests/card-needs-kinds.test.mjs checks the kinds its scan of server/ finds.
 */
export const RANK = Object.freeze({ permission: 0, failed: 1, block: 2, denial: 3, toolask: 4, appsend: 5, hop: 5 });

/** The needs tied to a turn: the person moving on clears them (runtime.mjs, the turn's start). The rest wait until answered. */
export const TURN_TIED = new Set(['failed', 'block', 'denial', 'toolask']);

/**
 * Which turn's asking blocks, refusals and tool requests count, answered here only. During a
 * running turn none do, except the block a turn that doesn't move on kept (`se.keptId`, nextNeed's `keep`): its end
 * decides them, and main's mid-turn release left no need. Otherwise the last ended turn,
 * which the session keeps in the store so a restart keeps it, or, for a session from before it did, the turn of the
 * card being released, which was the need.
 * @param {any} rt @param {any} se @param {any} [released]
 */
function turnOf(rt, se, released = null) {
  if (rt.turns.has(se.id)) return null;
  return se.lastTurnId ?? released?.turnId ?? null;
}

/**
 * The card of the agent that comes first among those that still wait for the person, as a `needs` value, or null. It
 * reads pending: its result decides a write, so a card held behind a commit counts (#601). The turn's end passes its
 * own turn and the block it kept; a release passes the released card, for `turnOf`, and a running turn's kept block
 * counts by default.
 * @param {any} rt @param {any} se @param {{ turnId?: string | null, keep?: string | null, released?: any }} [o]
 */
export function nextNeed(rt, se, { released = null, turnId = turnOf(rt, se, released), keep = rt.turns.has(se.id) ? (se.keptId ?? null) : null } = {}) {
  /** @type {{ at: number, need: any, it: any } | null} */
  let best = null;
  let refused = 0;
  for (const threadId of threadsOf(rt, se))
    for (const it of rt.store.pending.items(threadId)) {
      const need = needOf(rt, se, it, threadId, turnId, keep);
      if (!need) continue;
      if (need.kind === 'denial') refused++;
      const ahead = !best || RANK[need.kind] < RANK[best.need.kind] || (RANK[need.kind] === RANK[best.need.kind] && (it.at ?? 0) >= best.at);
      if (ahead) best = { at: it.at ?? 0, need, it };
    }
  // Several refusals are counted, as the turn's end always said.
  if (best?.need.kind === 'denial' && refused > 1) best.need.text = `${refused} steps were refused: ${best.it.summary}`;
  return best?.need ?? null;
}

/**
 * A new card offers itself as the agent's need: it takes it when none is set, or when it ranks ahead of the current
 * need or the same (the newest within a rank comes first, as in nextNeed). Otherwise it waits, and a release reaches
 * it. Every setter goes through here, so which card shows doesn't depend on whether it was set or released. A failed
 * turn still sets its need directly: it ends the turn, as the turn's end does. A current need of a kind RANK doesn't
 * list is kept, never replaced by default.
 * @param {any} rt @param {any} se @param {any} need @param {string} state  the session's state if it takes the need
 * @returns {boolean} whether it took the need
 */
export function offerNeed(rt, se, need, state) {
  const cur = se.needs;
  if (cur && !(RANK[need.kind] <= RANK[cur.kind])) return false;
  rt.updateSession(se.id, { needs: need, state });
  return true;
}

/**
 * A card was answered or retired. If the agent's need is that card, it falls back to the next card that waits, and
 * an app card that becomes the need without ever being notified is notified now. Any other need is left alone.
 * @param {any} rt @param {any} caller  the session, as the caller read it @param {string} itemId
 * @param {string} [busy]  the state while a turn runs: a permission's release passes 'tool', since the tool call it
 *   held goes on; others keep the session's state
 * @param {{ turnId?: string | null }} [o]  which turn's cards count, when it isn't turnOf's answer: Retry passes null,
 *   since the retried turn starts at once and its end decides them
 */
export function releaseNeed(rt, caller, itemId, busy = caller?.state, { turnId } = {}) {
  // The session as it is now: a caller may hold a copy from before an await, and each patch makes a new one.
  const se = caller && rt.s.sessions[caller.id];
  if (!se || se.needs?.itemId !== itemId) return;
  const released = rt.store.pending.items(se.needs.threadId ?? se.threadId).find((/** @type {any} */ x) => x.id === itemId);
  const need = nextNeed(rt, se, turnId === undefined ? { released } : { released, turnId });
  rt.updateSession(se.id, { needs: need, state: rt.turns.has(se.id) ? busy : need ? 'needs' : 'idle' });
  noticeNeed(rt, se, need);
}

/**
 * Whoever sets an agent's need calls this after: an app card that becomes the need without ever having been notified
 * (it waited behind another need) is notified now. The release and the turn's end both set needs.
 * @param {any} rt @param {any} se @param {any} need
 */
export function noticeNeed(rt, se, need) {
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
