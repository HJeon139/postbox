// Agents waking agents, in the conversation where the person reads (#372): the wake limit, who answers for a persona
// in a topic thread or an old side thread (its one session in the conversation: no forks, #228), the card that asks to
// add an agent the conversation doesn’t have, and the lines of side threads from before #372. Functions take the
// Runtime first (architecture.md, “What a move may change”).

import { HANDLE, HANDLE_SHAPE, HOP_LIMIT } from '../shared/limits.mjs';
import { clip, httpError, tooLongToSend } from './helpers.mjs';
import { arrival } from './queue-batch.mjs';
import { roomChainLimit } from './room-chain-limit.mjs';
import { newId } from './store.mjs';
import { pendingThreads, updateThread } from './thread-write.mjs';
import { askToAdd, askToWake, closeHop, closeOwnCard, dropHeld, retireStale } from './wake-cards.mjs';

export { resolveHop } from './wake-cards.mjs';
// The server’s default chain limit, 1,000 unless POSTBOX_CHAIN_LIMIT sets another; a room can set its own (#1035), which
// roomChainLimit reads.
export { HOP_LIMIT, roomChainLimit };

// ── Agents waking agents ───────────────────────────────────────────────────────────

/** What a wake from a summary's turn is told (#225): one text, whichever tool it came through. */
export const SUMMARY_WAKES_NO_ONE = 'A summary for the conversation wakes no one: finish it, and the person decides the rest.';

/**
 * An agent wakes another (#110, #228, #372): by an @-mention in what it said (itemId, that message) or by wake_agent. It
 * reaches the persona’s one session in the conversation, which answers there; a busy one takes the wake when its turn
 * ends, as any message to a busy agent waits. A persona the conversation doesn’t have needs the
 * person: a card asks to add it. After the room’s chain limit of wakes in a row without you (1,000 unless the person set
 * another, #1035), the next one waits for your confirm.
 */

export function agentWake(
  rt,
  fromSessionId,
  handle,
  text,
  { confirmed = false, replyIn = undefined, fromTurnId = rt.turns.get(fromSessionId)?.id, itemId = null, prose = false } = {},
) {
  // Checked here, not in each tool, so no path that wakes from a turn gets around it (#225, #637). The turn is the one the
  // call came from: Allow on a card wakes from the turn that asked, after a summary may have started.
  const live = rt.turns.get(fromSessionId);
  if (live?.summarizeTo && live.id === fromTurnId) return { ok: false, message: SUMMARY_WAKES_NO_ONE };
  const from = rt.s.sessions[fromSessionId];
  const p = rt.personaByHandle(handle);
  if (!from || !p) return { ok: false, message: `There’s no agent called @${handle}.` };
  // Archived, it can’t be answered: a reply would have nowhere to go.
  if (from.archived) return { ok: false, message: 'Your session is archived, so it can’t wake anyone.' };
  // The conversation: every session lives in one. A fork from before #228 wakes from the conversation it came from.
  // Read pending, as every thread this decides on: its hop count decides the limit, behind a held commit too (#796).
  const parent = rt.store.pending.thread(rt.lineage(from.threadId).at(-1));
  const target = rt.sessionsIn(parent.id).find((x) => x.personaId === p.id && !x.archived);
  if (target?.id === from.id) return { ok: false, message: `@${p.handle} is you: just carry on.` };
  // Where the waker speaks now: a topic thread it’s in, else the conversation. Agents talk where the person reads,
  // never in a side thread of their own (#372); a turn still in an old side thread hands off in the conversation.
  const back = replyIn === undefined ? replyInOf(rt, from) : replyIn;
  const backKind = back && rt.store.pending.thread(back)?.kind; // a topic open_topic just opened may still be held
  const at = backKind === 'topic' ? back : parent.id;
  // Told before any card, so a wake that waits for Allow still tells it (Allow carries no side thread).
  if (backKind === 'side') sideThreadsGone(rt, from);
  // A card keeps the mention’s message, so Allow wakes from it rather than posting it again.
  const card = { text, replyIn: at === parent.id ? null : at, fromTurnId, itemId };
  if (!target) return askToAdd(rt, from, parent, p, card, { prose });
  // No limit between two agents (#492): the room shows the chain’s count, with a hint to Stop past CHAIN_HINT.
  if (!confirmed && (parent.hops ?? 0) >= roomChainLimit(rt, parent.id)) return askToWake(rt, from, parent, p, card);
  const hop = (parent.hops ?? 0) + 1;
  updateThread(rt, parent.id, { hops: hop });
  // A mention is already the waker’s message there, so the wake’s number in the chain (#114) goes on the
  // turn’s first item: it marks the turn, not necessarily the paragraph with the mention. One message can wake several
  // agents, so each wake’s number is kept (wakes); hop stays the first. wake_agent’s message is posted as the waker’s.
  const said = itemId ? rt.store.pending.item(at, itemId) : null;
  if (said) rt.patchItem(at, said.id, { hop: said.hop ?? hop, wakes: [...(said.wakes ?? (said.hop ? [said.hop] : [])), hop] });
  const it =
    said ??
    rt.addItem(at, { kind: 'agent', sessionId: from.id, personaId: from.personaId, handle: from.handle, text, status: 'done', hop, wakes: [hop], fromTurnId });
  rt.recordAgentMessage(from.id, 'to', p.handle, text);
  rt.recordAgentMessage(target.id, 'from', from.handle, text);
  // The woken agent answers from its session in the conversation (#110). Busy, it takes the wake when its turn ends,
  // from the queue where it was sent, where the person sees it and can cancel it (#228).
  const waits = rt.busyFor(target.id);
  const wake = wakeEntry(from, target, text, it.id);
  if (waits) updateThread(rt, at, (t) => ({ queue: [...(t.queue ?? []), wake] }));
  else deliverWake(rt, at, wake);
  // itemId: the message the wake went out as, so a turn’s further mentions reuse it rather than post it again.
  return { ok: true, itemId: it.id, message: waits ? `Woke @${p.handle}: it’s busy, so it answers when its current turn ends.` : `Woke @${p.handle}.` };
}

/**
 * A wake as its thread’s queue keeps it, for an agent that’s busy, or delivered at once: who sent it, the message it
 * went out as, and when it arrived (`seq`, the order a tie on the clock keeps, queue-batch.mjs).
 * @param {any} from  the waking session @param {any} target  the woken one @param {string} text @param {string} itemId
 */
function wakeEntry(from, target, text, itemId) {
  return { id: newId('q'), kind: 'wake', from: from.handle, fromSessionId: from.id, text, itemId, sessionIds: [target.id], at: Date.now(), seq: arrival() };
}

/** An agent whose turn runs in a side thread from before #372 is told, once, that hand-offs happen in the conversation. */
function sideThreadsGone(rt, se) {
  if (se.toldSideThreadsGone) return;
  rt.updateSession(se.id, { toldSideThreadsGone: true });
  rt.tellAgent(se.id, 'Side threads are gone: agents hand off in the conversation now, where the person reads (#372). This side thread gets no new wakes.');
}

/** The thread a session’s turn speaks in now, when that isn’t its own (a topic or side thread); else null. */
const replyInOf = (rt, se) => {
  const at = rt.turns.get(se.id)?.threadId;
  return at && at !== se.threadId ? at : null;
};

/**
 * A wake reaches its agent: at once, or from the queue of the thread it was sent in (drainQueue, Send now). One whose agent was
 * archived meanwhile isn’t delivered, and the waker hears so at its next turn.
 * @param {any} rt @param {string} threadId  where the wake was sent @param {any} q  the wake
 */
export function deliverWake(rt, threadId, q) {
  const target = rt.s.sessions[q.sessionIds[0]];
  const from = rt.s.sessions[q.fromSessionId];
  const live = from && !from.archived && !from.deleting ? from : null;
  if (!target || target.archived || target.deleting) {
    const why = target?.deleting ? 'removed' : 'archived';
    if (live) rt.tellAgent(live.id, `Your message to @${target?.handle ?? 'an agent'} (“${clip(q.text, 120)}”) wasn’t delivered: its session was ${why}.`);
    return;
  }
  // No reply-back (#372): the reply posts where the wake was, and wakes the waker only if it @-mentions it.
  rt.deliver(target.id, { kind: 'agent', from: `@${q.from}`, text: q.text, itemId: q.itemId }, { threadId });
  retireStale(rt, threadId, target, `@${q.from} woke it`);
}

/**
 * When the last agent working in a conversation ends its turn with nothing left to answer, the chain of wakes has ended,
 * as when an agent acks a hand-off without waking anyone, so its count starts again (#492): separate chains don’t add up
 * to the chain limit. A wake waiting on a card keeps it, until you answer the card.
 * @param {any} rt @param {string} threadId  where the turn that ended spoke
 */
export function endChain(rt, threadId) {
  const conv = rt.lineage(threadId).at(-1);
  if (!rt.store.pending.thread(conv)?.hops) return;
  if (rt.sessionsIn(conv).some((se) => rt.turns.has(se.id) || rt.exiting.has(se.id))) return;
  const threads = pendingThreads(rt).filter((t) => rt.lineage(t.id).at(-1) === conv);
  if (threads.some((t) => (t.queue ?? []).some((q) => q.kind === 'wake'))) return;
  if (rt.store.pending.items(conv).some((x) => x.kind === 'hop' && x.status === 'open')) return;
  updateThread(rt, conv, { hops: 0 });
}

/**
 * The person stopped an agent, or archived it (#228): wakes queued for it are dropped, since a queued wake mustn’t undo
 * a Stop, and each waker hears at its next turn that its message went unanswered.
 * @param {any} rt @param {any} se  the agent @param {string} [how]  what happened to it
 */
export function dropWakes(rt, se, how = 'stopped') {
  dropHeld(rt, se, how);
  // Archived or removed, it can't answer for its own card; stopped, it can, and the person still may (#693).
  if (how !== 'stopped') closeOwnCard(rt, se, how);
  for (const t of pendingThreads(rt)) {
    const mine = (t.queue ?? []).filter((q) => q.kind === 'wake' && q.sessionIds.includes(se.id));
    if (!mine.length) continue;
    const gone = new Set(mine.map((q) => q.id));
    updateThread(rt, t.id, (now) => ({ queue: (now.queue ?? []).filter((q) => !gone.has(q.id)) }));
    for (const q of mine)
      if (rt.s.sessions[q.fromSessionId] && !rt.s.sessions[q.fromSessionId].archived && q.fromSessionId !== se.id)
        rt.tellAgent(q.fromSessionId, `@${se.handle} was ${how} before it answered your message (“${clip(q.text, 120)}”). Wake it again if you still need it.`);
  }
}

/** wake_agent { handle, message }, the tool, for the session rt.toolsFor made it for. A summary’s turn wakes no one (#225, agentWake). */
export function wakeAgent(rt, sessionId, { handle, message }) {
  const text = String(message ?? '');
  const to = String(handle ?? '')
    .trim()
    .replace(/^@/, '');
  const tooLong = tooLongToSend('A message to another agent', text);
  if (tooLong) return tooLong;
  // Checked before the lookup, whose refusal names the handle: it never echoes what isn’t one (#650).
  if (!HANDLE.test(to)) return { ok: false, message: `That isn’t an agent’s handle: ${HANDLE_SHAPE}.` };
  return rt.agentWake(sessionId, to, text);
}

/**
 * Who answers for a persona in a side or topic thread (#110, #228): its one session in the conversation. A persona the
 * conversation doesn’t have joins it when you @-mention it there, as adding it would.
 * @param {any} side  the side or topic thread @param {string} personaId @param {string} by  the handle that woke it, or 'you'
 */
export function sideSession(rt, side, personaId, by) {
  const conv = rt.lineage(side.id).at(-1);
  const had = rt.sessionsIn(conv).find((x) => x.personaId === personaId);
  if (had?.archived) throw httpError(409, `@${had.handle}’s session is archived. Restore it first.`);
  const where = side.kind === 'topic' ? 'a topic thread' : 'a side thread';
  return (
    had ??
    rt.ensureSession(conv, personaId, {
      brief: by === 'you' ? `You were @-mentioned in ${where} of this conversation.` : `@${by} woke you in ${where} of this conversation.`,
      joined: { by, in: side.id },
    })
  );
}

/**
 * Who answers in a side or topic thread when you write without an @-mention: the agent that spoke there last, else the
 * one it started with, else (a topic thread from before #228, whose fork never spoke) the agent its fork was of.
 * @param {any} rt @param {any} t
 */
export function threadPersona(rt, t) {
  const last = rt.s.sessions[t.lastSpeaker];
  const first = rt.s.sessions[t.members?.[0]];
  return (last && rt.persona(last.personaId)) ?? rt.personaByHandle(t.woke ?? t.pair?.split('|')[1] ?? '') ?? (first && rt.persona(first.personaId)) ?? null;
}

/**
 * Forks are gone (#228): each conversation has one session per agent. At startup, every session that is a fork (of a
 * topic thread, or of a busy session), or that lives in a topic or side thread rather than its conversation (a wake or
 * a mention made one there before), is retired, once: archived for good. Its thread keeps its messages, and a new
 * message there goes to the conversation’s session. Returns how many it retired.
 */
export function archiveForks(rt) {
  if (rt.s.settings.forksArchived) return 0;
  const inThread = (se) => ['topic', 'side'].includes(rt.s.threads[se.threadId]?.kind);
  const forks = Object.values(rt.s.sessions).filter((x) => (x.forkOf || inThread(x)) && !x.retiredFork && !x.deleting);
  const gone = new Set(forks.map((x) => x.id));
  for (const se of forks) {
    rt.stop(se.id, { silent: true });
    // Retired, not just archived: restored, it would be a session no message reaches, since its agent answers in the
    // conversation now. So Archived doesn’t list it, and Restore leaves it. One already archived keeps when it was.
    rt.updateSession(se.id, { archived: true, retiredFork: true, state: 'idle', needs: null, archivedAt: se.archivedAt ?? Date.now() });
  }
  // What waited for them goes with them: a message queued for one, and a wake card one of them is waiting on.
  for (const t of pendingThreads(rt)) {
    if (t.queue?.some((q) => q.sessionIds.some((id) => gone.has(id))))
      updateThread(rt, t.id, (now) => ({
        queue: now.queue.map((q) => ({ ...q, sessionIds: q.sessionIds.filter((id) => !gone.has(id)) })).filter((q) => q.sessionIds.length),
      }));
    for (const it of rt.store.pending.items(t.id))
      if (it.kind === 'hop' && it.status === 'open' && gone.has(it.fromSessionId)) closeHop(rt, t.id, it, 'retired');
  }
  rt.store.emit('settings', { forksArchived: true });
  return forks.length;
}

/**
 * The side thread's line in the conversation: how many messages it holds, as the side thread shows them, and when the
 * last one came (#130). Yours and each wake count one each, and an agent's turn counts one however many items it
 * posted (blocks split a reply). addItem calls it for every message there.
 */
export function bumpSideLink(rt, sideThreadId) {
  const side = rt.s.threads[sideThreadId];
  if (side?.kind !== 'side') return;
  const link = rt.store.pending.items(side.parentId).find((x) => x.kind === 'sidelink' && x.sideThreadId === side.id);
  if (!link) return;
  // A turn that failed or was stopped before it said anything left an empty placeholder: not a message.
  const said = rt.store.pending.items(side.id).filter((x) => x.kind === 'user' || (x.kind === 'agent' && (x.text || x.status === 'streaming')));
  rt.patchItem(side.parentId, link.id, { count: new Set(said.map((x) => x.turnId ?? x.id)).size, lastAt: said.at(-1)?.at ?? link.at });
}

export function recordAgentMessage(rt, sessionId, dir, other, text) {
  const se = rt.s.sessions[sessionId];
  if (!se) return;
  rt.updateSession(sessionId, { agentMessages: [{ dir, other, text: clip(text, 120), at: Date.now() }, ...se.agentMessages].slice(0, 6) });
}
