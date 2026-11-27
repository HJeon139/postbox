// What an agent needs you for, read from its cards (#366; the integrator's review of #608 asked for it, and A1b keeps it,
// designs/508/a1b-asks.md): when one card is answered, the agent needs you for the newest card that still waits, and a
// resolver clears only a need that is its own. `nextNeed` is the one place that decides it.

import { ASKING } from '../shared/catalog.mjs';
import { clip } from '../shared/text.mjs';
import { httpError } from './helpers.mjs';
import { forgetWait } from './turn-transient.mjs';

/** The threads whose cards are the agent's: its own, and the side and topic threads off it, a held one too (#623). */
const threadsOf = (rt, se) => [
  se.threadId,
  ...Object.values(rt.store.pending.threads())
    .filter((t) => t.parentId === se.threadId)
    .map((t) => t.id),
];

/**
 * The need a card makes, or null if it doesn't wait. Wake requests and waiting permission cards wait until
 * answered; asking blocks, refusals and tool requests wait only from the agent's last ended turn, so older ones you
 * moved past stay quiet (#69). `turnIds` are the turns whose cards count (turnsOf); `keep` is a card that still counts
 * whatever its turn (a block a turn you didn't start was waiting on).
 */
function needOf(rt, se, it, threadId, turnIds, keep) {
  const where = rt.sessions.awayFrom(se, threadId);
  if (it.kind === 'hop' && it.fromSessionId === se.id && it.status === 'open')
    return { kind: 'hop', itemId: it.id, text: `@${se.handle} wants to ${it.join ? 'add' : 'wake'} @${it.to}`, ...where };
  if (it.kind === 'permission' && it.sessionId === se.id && it.status === 'open' && rt.permissionWaits.has(it.id))
    return { kind: 'permission', itemId: it.id, text: `@${se.handle} asks to ${it.summary}`, ...where };
  // An AskUserQuestion’s block (#521) needs the person while its call waits, mid-turn too, as a permission card does.
  if (it.kind === 'block' && it.sessionId === se.id && !it.answered && rt.permissionWaits.get(it.id)?.question)
    return { kind: 'block', itemId: it.id, text: it.block.title ?? clip(it.block.prompt ?? it.block.fallback, 120), ...where };
  // A reply that names a person asks them (#1742, server/person-mentions.mjs) until they read it, whatever turn it is
  // from: only their reading, or their writing there, ends it, so neither the agent’s later turns nor another person
  // moving on drops it. It comes after every card of the turns that count. `for` is whom it still waits for; with no
  // one Postbox can name, Sessions’ needFor finds the room’s last person.
  const waits = (/** @type {string} */ id) => !it.asksRead?.includes(id);
  const ask =
    it.kind === 'agent' && it.sessionId === se.id && it.asks && !it.asksSeen
      ? { kind: 'mention', itemId: it.id, text: clip(it.text, 120), ...(it.asks.length ? { for: it.asks.filter(waits) } : {}), ...where }
      : null;
  if (it.sessionId !== se.id || (!turnIds.includes(it.turnId) && it.id !== keep)) return ask;
  // A failed reply waits for its Retry while you haven't moved past its turn, so a wake's release finds it again;
  // one the person dismissed (#883) doesn't.
  if (it.kind === 'agent' && it.status === 'failed' && !it.dismissed) {
    const text = it.error ?? `@${se.handle}’s turn failed.`;
    return { kind: 'failed', itemId: it.id, text, ...where };
  }
  if (it.kind === 'block' && it.valid && ASKING.has(it.block?.type) && !it.answered)
    return { kind: 'block', itemId: it.id, text: it.block.title ?? clip(it.block.prompt ?? it.block.fallback, 120), ...where };
  // A refused call (a denial card) is never a need: the agent has the refusal and works around it, and the card shows
  // what happened (intent.md, principle 8).
  if (it.kind === 'toolask' && it.status === 'open')
    return { kind: 'toolask', itemId: it.id, text: `@${se.handle} asks you to turn on “${it.label}”`, ...where };
  if (it.kind === 'viewask' && it.status === 'open')
    return { kind: 'viewask', itemId: it.id, text: `@${se.handle} asks to see its app: download Chromium?`, ...where };
  return ask;
}

/**
 * Which need comes first when several wait, as the turn's end has always chosen: a permission the running turn is
 * blocked on, then a failed turn (its Retry: only its own release clears it, and no card but a permission, which a
 * running turn is blocked on, replaces it; on main a wake request's card did too), then the last turn's asking block,
 * its tool request, and last the cards that wait until answered (wake requests). Within a kind,
 * the newest. It ranks exactly the kinds a need can have, shared/needs.mjs's NEEDS_KINDS (tests/card-needs-kinds.test.mjs).
 */
export const RANK = Object.freeze({ permission: 0, failed: 1, block: 2, toolask: 4, viewask: 4, hop: 5, mention: 6 });

/** The needs tied to a turn: the person moving on clears them (runtime.mjs, the turn's start). The rest wait until answered. */
export const TURN_TIED = new Set(['failed', 'block', 'toolask', 'viewask']);
/** The needs a turn's own card offers while it runs (offerShown), which a stopped turn takes with it (stoppedNeed). */
const OFFERED_MID_TURN = new Set(['block', 'toolask', 'viewask']);

/**
 * Which turns' asking blocks, refusals and tool requests count, answered here only. A turn that doesn't move on (another
 * agent's wake, a lint pass) keeps the turns whose cards counted when it started (`se.keptTurnIds`, keptTurns): they
 * count mid-turn, at its end and after a restart, until you move on. During a running turn those do, the block it kept
 * (`se.keptId`, nextNeed's `keep`) and the running turn's own cards until it closes (#1748), so a mid-turn release falls
 * back to a form the turn showed; the turn before's don't (#69).
 * Otherwise the last turn too, which the session keeps in the store so a restart keeps it, or, for a session from
 * before it did, the turn of the card being released, which was the need.
 * @param {any} rt @param {any} se @param {any} [released]
 * @returns {string[]}
 */
function turnsOf(rt, se, released = null) {
  const kept = se.keptTurnIds ?? [];
  // The running turn's own cards count too (#1748): an asking block it showed is the need from when it's shown. Not once
  // it is closing (endTurn): its end decides them then, so a failed turn's block doesn't flash before its failure.
  const turn = rt.turns.get(se.id);
  if (turn) return turn.closed ? kept : [turn.id, ...kept];
  const last = se.lastTurnId ? lastCounted(se) : (released?.turnId ?? null);
  return last ? [last, ...kept] : kept;
}

/**
 * The session's last turn, whose cards count, or null when it is the turn you stopped (`se.stoppedTurnId`, stoppedNeed):
 * a stopped turn's cards wait quietly until answered or asked again, after another card's answer, a restart or another
 * agent's wake too (#1928). The one rule turnsOf and keptTurns read. @param {any} se @returns {string | null}
 */
function lastCounted(se) {
  return se.lastTurnId && se.lastTurnId !== se.stoppedTurnId ? se.lastTurnId : null;
}

/**
 * The block a turn that didn't move on kept (`se.keptId`), in whichever of the agent's threads it is, as nextNeed
 * counts it mid-turn: the turn's end found it only in the turn's own thread, so a block in a topic thread stopped being
 * the need once another agent's wake in the conversation ended (#647). Read pending, as the need it decides.
 * @param {any} rt @param {any} se @returns {any}
 */
export function keptBlock(rt, se) {
  if (!se.keptId) return null;
  for (const threadId of threadsOf(rt, se)) {
    const it = rt.store.pending.item(threadId, se.keptId);
    if (it) return it;
  }
  return null;
}

/**
 * The turns a starting turn that doesn't move on keeps (runtime.mjs, the turn's start, where it already runs): of the
 * last turn and the turns kept before, those with a turn-tied card of the agent's still open, so the list holds only
 * turns still asking you something, however many wakes come between. One pass over the agent's threads' items, as
 * nextNeed makes.
 * @param {any} rt @param {any} se  the session as it was before the turn started @returns {string[]}
 */
export function keptTurns(rt, se) {
  const counting = new Set([lastCounted(se), ...(se.keptTurnIds ?? [])].filter(Boolean));
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
  for (const threadId of threadsOf(rt, se))
    for (const it of rt.store.pending.items(threadId)) {
      const need = needOf(rt, se, it, threadId, turnIds, keep);
      if (!need) continue;
      const at = it.at ?? 0;
      if (comesFirst(need, at, best)) best = { at, need, it };
    }
  return best?.need ?? null;
}

/**
 * A new card offers itself as the agent’s need: it takes it when none is set, when it is the card that already is the
 * need, or when it ranks first by `challengerWins`, as nextNeed chooses (#711). Otherwise it
 * waits, and a release reaches it. Every setter goes through here, so which card shows doesn’t depend on whether it was
 * set or released. A failed turn still sets its need directly: it ends the turn, as the turn’s end does. A current need
 * of a kind RANK doesn’t list is kept, never replaced by default.
 * @param {any} rt @param {any} se @param {any} need @param {string} state  the session's state if it takes the need
 * @returns {boolean} whether it took the need
 */
export function offerNeed(rt, se, need, state) {
  // The current need as held writes leave it: one set a moment ago, behind a held commit, is the one to beat (#623).
  if (!takesNeed(rt, rt.store.pending.session(se.id) ?? se, need)) return false;
  rt.sessions.update(se.id, { needs: need, state });
  return true;
}

/**
 * An asking block an agent just showed (#1748), or a tool or view request it raised (#1868): it is the agent’s need from
 * now, not only from its turn’s end, so the top bar counts it while the turn runs on. The session keeps its state.
 * @param {any} rt @param {any} caller  the session, as the caller read it @param {any} it  the block's item @param {string} threadId
 */
function offerShown(rt, caller, it, threadId) {
  // Only the running turn's own: a block shown with no turn (an older one, re-shown) waits quietly, as on main (#69).
  const turn = rt.turns.get(caller.id);
  if (!turn || turn.closed || it.turnId !== turn.id) return;
  // The session as written: the state it keeps may be held behind a commit, and the caller's copy is the published one (#623).
  const se = rt.store.pending.session(caller.id) ?? caller;
  const need = needOf(rt, se, it, threadId, [turn.id], null);
  if (need) offerNeed(rt, se, need, se.state);
}

/**
 * A turn you stopped (turn-stop.mjs): its own asking blocks, tool requests and view requests wait quietly (#1748, #1868),
 * as a stopped turn's form did before #1748, and the count agrees with the idle agent. The session records the turn, in
 * the store, so they stay quiet after another card is answered and after a restart (#1928, lastCounted); a need one of
 * them made mid-turn goes. Stop closes the turn without its end (endTurn), which otherwise decides the turn's cards. A
 * shutdown's stop raises no turn.stopping, so a restart counts that turn's cards, as an interrupted turn's.
 * @param {any} rt @param {any} turn
 */
function stoppedNeed(rt, turn) {
  rt.sessions.update(turn.sessionId, { stoppedTurnId: turn.id });
  // The session as written, as the stop's own write may be held behind a commit (#623).
  const se = rt.store.pending.session(turn.sessionId);
  const need = se?.needs;
  // A need names its thread only when it's away from the agent's own (awayFrom).
  if (!OFFERED_MID_TURN.has(need?.kind) || rt.store.pending.item(need.threadId ?? se.threadId, need.itemId)?.turnId !== turn.id) return;
  // What's left is what waited before it: turnsOf's, which leaves this turn out now, and the block the turn kept, which
  // runningKeep doesn't give, as the turn has left rt.turns.
  rt.sessions.update(se.id, { needs: nextNeed(rt, se, { keep: se.keptId ?? null }) });
}

/**
 * A card shown or withdrawn moves the need (raised on the bus): a withdrawn block is released, and an asking block shown
 * or asked again (#1748), or a tool or view request raised or asked again (#1868), is offered. A stopped turn drops the
 * need its own block or request made.
 * @param {any} rt
 */
export function blockNeeds(rt) {
  rt.bus.on('block.withdrawn', ({ se, itemId }) => releaseNeed(rt, se, itemId));
  rt.bus.on('block.asking', ({ se, item, threadId }) => offerShown(rt, se, item, threadId));
  rt.bus.on('turn.stopping', ({ turn }) => stoppedNeed(rt, turn));
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
 * A card was answered or retired. If the agent's need is that card, it falls back to the next card that waits. Any
 * other need is left alone.
 * @param {any} rt @param {any} caller  the session, as the caller read it @param {string} itemId
 * @param {string} [busy]  the state while a turn runs: a permission's release passes 'tool', since the tool call it
 *   held goes on; others keep the session's state
 * @param {{ turnIds?: string[] }} [o]  which turns' cards count, when it isn't turnsOf's answer: Retry passes none,
 *   since the retried turn starts at once and its end decides them
 */
export function releaseNeed(rt, caller, itemId, busy, { turnIds } = {}) {
  // The session as it is now, held writes included: a caller may hold a copy from before an await, each patch makes a
  // new one, and a need or a state written behind a held commit is the one to release (#623).
  const se = caller && (rt.store.pending.session(caller.id) ?? rt.s.sessions[caller.id]);
  if (!se || se.needs?.itemId !== itemId) return;
  const released = rt.store.pending.items(se.needs.threadId ?? se.threadId).find((/** @type {any} */ x) => x.id === itemId);
  const need = nextNeed(rt, se, turnIds === undefined ? { released } : { released, turnIds });
  rt.sessions.update(se.id, { needs: need, state: rt.turns.has(se.id) ? (busy ?? se.state) : stateFor(need) });
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
  rt.threads.patchItem(threadId, itemId, { dismissed: true });
  // Dismissed, it isn’t tried again on its own either (#1713).
  if (rt.store.pending.session(it.sessionId)?.autoRetry?.itemId === itemId) forgetWait(rt, it.sessionId);
  releaseNeed(rt, rt.s.sessions[it.sessionId], itemId);
  return { ok: true };
}
