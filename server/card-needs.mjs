// What an agent needs you for, read from its cards (#366; the integrator's review of #608 asked for it, and A1b keeps it,
// designs/508/a1b-asks.md): when one card is answered, the agent needs you for the newest card that still waits, and a
// resolver clears only a need that is its own. `nextNeed` is the one place that decides it.

import { ASKING } from '../shared/catalog.mjs';
import { clip } from '../shared/text.mjs';
import { APP_SEND_LIMIT } from './app-send-limits.mjs';
import { httpError } from './helpers.mjs';

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
 * moved past stay quiet (#69). `turnIds` are the turns whose cards count (turnsOf); `keep` is a card that still counts
 * whatever its turn (a block a turn you didn't start was waiting on).
 */
function needOf(rt, se, it, threadId, turnIds, keep) {
  const where = rt.awayFrom(se, threadId);
  if (it.kind === 'appsend' && it.sessionId === se.id && it.status === 'open')
    return { kind: 'appsend', itemId: it.id, text: `${it.title} wants to send ${messages(it.events?.length ?? 1)} for you`, ...where };
  if (it.kind === 'hop' && it.fromSessionId === se.id && it.status === 'open')
    return { kind: 'hop', itemId: it.id, text: `@${se.handle} wants to ${it.join ? 'add' : 'wake'} @${it.to}`, ...where };
  if (it.kind === 'permission' && it.sessionId === se.id && it.status === 'open' && rt.permissionWaits.has(it.id))
    return { kind: 'permission', itemId: it.id, text: `@${se.handle} asks to ${it.summary}`, ...where };
  if (it.sessionId !== se.id || (!turnIds.includes(it.turnId) && it.id !== keep)) return null;
  // A failed reply waits for its Retry while you haven't moved past its turn, so a wake's release finds it again;
  // one the person dismissed (#883) doesn't.
  if (it.kind === 'agent' && it.status === 'failed' && !it.dismissed) {
    const text = it.error ?? `@${se.handle}’s turn failed.`;
    return { kind: 'failed', itemId: it.id, text, ...where };
  }
  if (it.kind === 'block' && it.valid && ASKING.has(it.block?.type) && !it.answered)
    return { kind: 'block', itemId: it.id, text: it.block.title ?? clip(it.block.prompt ?? it.block.fallback, 120), ...where };
  if (it.kind === 'denial' && it.status === 'open') return { kind: 'denial', itemId: it.id, text: `A step was refused: ${it.summary}`, ...where };
  if (it.kind === 'toolask' && it.status === 'open')
    return { kind: 'toolask', itemId: it.id, text: `@${se.handle} asks you to turn on “${it.label}”`, ...where };
  if (it.kind === 'viewask' && it.status === 'open')
    return { kind: 'viewask', itemId: it.id, text: `@${se.handle} asks to see its app: download Chromium?`, ...where };
  return null;
}

/**
 * Which need comes first when several wait, as the turn's end has always chosen: a permission the running turn is
 * blocked on, then a failed turn (its Retry: only its own release clears it, and no card but a permission, which a
 * running turn is blocked on, replaces it; on main a wake request's card did too), then the last turn's asking block,
 * its refusals, its tool request, and last the cards that wait until answered (app sends, wake requests). Within a kind,
 * the newest. It ranks exactly the kinds a need can have, shared/needs.mjs's NEEDS_KINDS (tests/card-needs-kinds.test.mjs).
 */
export const RANK = Object.freeze({ permission: 0, failed: 1, block: 2, denial: 3, toolask: 4, viewask: 4, appsend: 5, hop: 5 });

/** The needs tied to a turn: the person moving on clears them (runtime.mjs, the turn's start). The rest wait until answered. */
export const TURN_TIED = new Set(['failed', 'block', 'denial', 'toolask']);

/**
 * Which turns' asking blocks, refusals and tool requests count, answered here only. A turn that doesn't move on (another
 * agent's wake, a lint pass) keeps the turns whose cards counted when it started (`se.keptTurnIds`, keptTurns): they
 * count mid-turn, at its end and after a restart, until you move on. During a running turn only those do, and the block
 * it kept (`se.keptId`, nextNeed's `keep`): its own end decides its own cards, and main's mid-turn release left no need.
 * Otherwise the last turn too, which the session keeps in the store so a restart keeps it, or, for a session from
 * before it did, the turn of the card being released, which was the need.
 * @param {any} rt @param {any} se @param {any} [released]
 * @returns {string[]}
 */
function turnsOf(rt, se, released = null) {
  const kept = se.keptTurnIds ?? [];
  if (rt.turns.has(se.id)) return kept;
  const last = se.lastTurnId ?? released?.turnId ?? null;
  return last ? [last, ...kept] : kept;
}

/**
 * The turns a starting turn that doesn't move on keeps (runtime.mjs, the turn's start, where it already runs): of the
 * last turn and the turns kept before, those with a turn-tied card of the agent's still open, so the list holds only
 * turns still asking you something, however many wakes come between. One pass over the agent's threads' items, as
 * nextNeed makes.
 * @param {any} rt @param {any} se  the session as it was before the turn started @returns {string[]}
 */
export function keptTurns(rt, se) {
  const counting = new Set([se.lastTurnId, ...(se.keptTurnIds ?? [])].filter(Boolean));
  const asking = new Set();
  for (const threadId of threadsOf(rt, se))
    for (const it of rt.store.pending.items(threadId)) {
      if (!counting.has(it.turnId) || asking.has(it.turnId)) continue;
      if (TURN_TIED.has(needOf(rt, se, it, threadId, [it.turnId], null)?.kind)) asking.add(it.turnId);
    }
  return [...counting].filter((id) => asking.has(id));
}

/**
 * The card of the agent that comes first among those that still wait for the person, as a `needs` value, or null. It
 * reads pending: its result decides a write, so a card held behind a commit counts (#601). The turn's end passes its
 * own turn and the block it kept; a release passes the released card, for `turnsOf`, and a running turn's kept block
 * counts by default.
 * @param {any} rt @param {any} se @param {{ turnIds?: string[], keep?: string | null, released?: any }} [o]
 */
export function nextNeed(rt, se, o = {}) {
  const released = o.released ?? null;
  const turnIds = o.turnIds ?? turnsOf(rt, se, released);
  const keep = o.keep === undefined ? runningKeep(rt, se) : o.keep;
  /** @type {{ at: number, need: any, it: any } | null} */
  let best = null;
  let refused = 0;
  for (const threadId of threadsOf(rt, se))
    for (const it of rt.store.pending.items(threadId)) {
      const need = needOf(rt, se, it, threadId, turnIds, keep);
      if (!need) continue;
      if (need.kind === 'denial') refused++;
      const at = it.at ?? 0;
      if (comesFirst(need, at, best)) best = { at, need, it };
    }
  // Several refusals are counted, as the turn's end always said.
  if (best?.need.kind === 'denial' && refused > 1) best.need.text = `${refused} steps were refused: ${best.it.summary}`;
  // Typed again: TypeScript 7 can narrow it to never after the line above, though a card may have set it.
  const found = /** @type {{ at: number, need: any, it: any } | null} */ (best);
  return found?.need ?? null;
}

/**
 * A new card offers itself as the agent’s need: it takes it when none is set, when it is the card that already is the
 * need (an app card’s new count), or when it ranks first by `challengerWins`, as nextNeed chooses (#711). Otherwise it
 * waits, and a release reaches it. Every setter goes through here, so which card shows doesn’t depend on whether it was
 * set or released. A failed turn still sets its need directly: it ends the turn, as the turn’s end does. A current need
 * of a kind RANK doesn’t list is kept, never replaced by default.
 * @param {any} rt @param {any} se @param {any} need @param {string} state  the session's state if it takes the need
 * @returns {boolean} whether it took the need
 */
export function offerNeed(rt, se, need, state) {
  if (!takesNeed(rt, se, need)) return false;
  rt.updateSession(se.id, { needs: need, state });
  return true;
}

/**
 * Whether an offered need takes the agent’s current one (offerNeed). Both cards’ times are read from pending; when
 * either card isn’t there, rank alone decides, as before #711. On equal rank, a card that loses only for being older
 * still takes the need when the current need’s card no longer waits (designs/508/a1b-asks.md, R8), so a dead need never
 * keeps a live card from being flagged. @param {any} rt @param {any} se @param {any} need @returns {boolean}
 */
function takesNeed(rt, se, need) {
  const cur = se.needs;
  if (!cur) return true;
  if (need.itemId === cur.itemId) return true;
  if (!Object.hasOwn(RANK, cur.kind)) return false;
  const offeredCard = rt.store.pending.item(need.threadId ?? se.threadId, need.itemId);
  const curThreadId = cur.threadId ?? se.threadId;
  const curCard = rt.store.pending.item(curThreadId, cur.itemId);
  if (!offeredCard || !curCard) return RANK[need.kind] <= RANK[cur.kind];
  const offered = { kind: need.kind, at: offeredCard.at ?? 0 };
  const current = { kind: cur.kind, at: curCard.at ?? 0 };
  if (challengerWins(offered, current)) return true;
  if (RANK[need.kind] !== RANK[cur.kind]) return false;
  const curWaits = needOf(rt, se, curCard, curThreadId, [], null) !== null;
  return !curWaits;
}

/**
 * Which of two of an agent’s cards comes first, the one decision nextNeed’s `comesFirst`, the restart’s `keptOrNext`
 * and `offerNeed` all make (#711): the lower RANK wins; on equal rank the challenger wins unless it is older, so a tie
 * on time goes to the challenger.
 * @param {{ kind: string, at: number }} challenger  the card read later, `next`, or the card offered
 * @param {{ kind: string, at: number }} incumbent  the best so far, or the current need
 * @returns {boolean} whether the challenger comes first
 */
export function challengerWins(challenger, incumbent) {
  const challengerRank = RANK[challenger.kind];
  const incumbentRank = RANK[incumbent.kind];
  if (challengerRank < incumbentRank) return true;
  if (challengerRank > incumbentRank) return false;
  if (challenger.at < incumbent.at) return false;
  return true;
}

/**
 * A card was answered or retired. If the agent's need is that card, it falls back to the next card that waits, and
 * an app card that becomes the need without ever being notified is notified now. Any other need is left alone.
 * @param {any} rt @param {any} caller  the session, as the caller read it @param {string} itemId
 * @param {string} [busy]  the state while a turn runs: a permission's release passes 'tool', since the tool call it
 *   held goes on; others keep the session's state
 * @param {{ turnIds?: string[] }} [o]  which turns' cards count, when it isn't turnsOf's answer: Retry passes none,
 *   since the retried turn starts at once and its end decides them
 */
export function releaseNeed(rt, caller, itemId, busy = caller?.state, { turnIds } = {}) {
  // The session as it is now: a caller may hold a copy from before an await, and each patch makes a new one.
  const se = caller && rt.s.sessions[caller.id];
  if (!se || se.needs?.itemId !== itemId) return;
  const released = rt.store.pending.items(se.needs.threadId ?? se.threadId).find((/** @type {any} */ x) => x.id === itemId);
  const need = nextNeed(rt, se, turnIds === undefined ? { released } : { released, turnIds });
  rt.updateSession(se.id, { needs: need, state: rt.turns.has(se.id) ? busy : stateFor(need) });
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

/** The session's state for a need it settles on, with no turn running: a failed turn shows Retry. @param {any} need */
export function stateFor(need) {
  if (!need) return 'idle';
  if (need.kind === 'failed') return 'failed';
  return 'needs';
}

/** The block a running turn that didn't move on kept (`se.keptId`), which counts mid-turn; none otherwise. */
function runningKeep(rt, se) {
  if (!rt.turns.has(se.id)) return null;
  return se.keptId ?? null;
}

/**
 * Whether a card’s need comes before the best so far, by `challengerWins`: the card read later is the challenger.
 * @param {any} need @param {number} at @param {{ at: number, need: any } | null} best
 */
function comesFirst(need, at, best) {
  if (!best) return true;
  return challengerWins({ kind: need.kind, at }, { kind: best.need.kind, at: best.at });
}

/**
 * Dismiss a failed reply (#883): the person won't retry it, so it stops being a need, keeps its error text and its
 * `failed` status (Retry still works on it), and nothing runs. Its need goes to whatever else waits, as when a card is
 * answered: the failed turn's own asks count, since no new turn starts to decide them, unlike Retry. A second Dismiss,
 * from a double click or another tab, changes nothing.
 * @param {any} rt @param {string} threadId @param {string} itemId
 */
export function dismissFailed(rt, threadId, itemId) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind === 'agent' && it.status === 'retried') throw httpError(409, 'It was already retried; reload to see it.');
  if (it?.kind !== 'agent' || it.status !== 'failed') throw httpError(409, 'Only a failed reply can be dismissed.');
  if (it.dismissed) return { ok: true };
  rt.patchItem(threadId, itemId, { dismissed: true });
  releaseNeed(rt, rt.s.sessions[it.sessionId], itemId);
  return { ok: true };
}
