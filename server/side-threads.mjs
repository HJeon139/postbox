// Agents waking agents, in the conversation where the person reads (#372): the wake limit, who answers for a persona
// in a topic thread or an old side thread (its one session in the conversation: no forks, #228), the card that asks to
// add an agent the conversation doesn’t have, and the lines of side threads from before #372. Functions take the
// Runtime first (designs/architecture/code-size.md, “What a move may change”).

import { HOP_LIMIT } from '../shared/limits.mjs';
import { clip, retiredError } from './helpers.mjs';
import { roomChainLimit } from './room-chain-limit.mjs';
import { dropScheduledWake } from './scheduled-wakes.mjs';
import { askToAdd, askToWake, closeOwnCard, dropHeld, retireStale } from './wake-cards.mjs';

export { resolveHop } from './wake-cards.mjs';
// The server’s default chain limit, 1,000 unless POSTBOX_CHAIN_LIMIT sets another; a room can set its own (#1035), which
// roomChainLimit reads.
export { HOP_LIMIT };

// ── Agents waking agents ───────────────────────────────────────────────────────────

/** What a wake from a summary's turn is told (#225): one text, whichever tool it came through. */
export const SUMMARY_WAKES_NO_ONE = 'A summary for the conversation wakes no one: finish it, and the person decides the rest.';

/**
 * An agent wakes another (#110, #228, #372): by an @-mention in what it said (itemId, that message). It
 * reaches the persona’s one session in the conversation, as an entry in its inbox there, which answers there; a busy
 * one takes it when its turn ends. `bounce`: the wake is a reply going back on its own to the agent that woke its writer,
 * not a mention its writer wrote (reply-back.mjs, #1518). A card past the chain limit keeps it, so the note on a
 * wake held there says it’s a reply, and so does the entry, so a turn only such replies woke may end quietly (#1543);
 * otherwise a reply that came back is a mention like any other (#1523). `wake: false` stores it for the end of the waker’s turn to wake (mention-entries.mjs). A persona the
 * conversation doesn’t have needs the person: a card asks to add it. After the room’s chain limit of wakes in a row without you (1,000 unless the person set
 * another, #1035), the next one waits for your confirm.
 */

export function agentWake(
  rt,
  fromSessionId,
  handle,
  text,
  {
    confirmed = false,
    replyIn = undefined,
    fromTurnId = rt.turns.get(fromSessionId)?.id,
    itemId = null,
    prose = false,
    wake = true,
    retryId = undefined,
    bounce = false,
  } = {},
) {
  // Checked here, not in each tool, so no path that wakes from a turn gets around it (#225, #637). The turn is the one the
  // call came from: Allow on a card wakes from the turn that asked, after a summary may have started.
  const live = rt.turns.get(fromSessionId);
  if (live?.summarizeTo && live.id === fromTurnId) return { ok: false, message: SUMMARY_WAKES_NO_ONE };
  const from = rt.s.sessions[fromSessionId];
  const p = rt.personas.byHandle(handle);
  if (!from || !p) return { ok: false, message: `There’s no agent called @${handle}.` };
  // Retired, it can’t be answered: a reply would have nowhere to go.
  if (from.retiredFork) return { ok: false, message: 'Your session was retired, so it can’t wake anyone.' };
  // The conversation: every session lives in one. A fork from before #228 wakes from the conversation it came from.
  // Read pending, as every thread this decides on: its hop count decides the limit, behind a held commit too (#796).
  const parent = rt.store.pending.thread(rt.threads.lineage(from.threadId).at(-1));
  const target = rt.sessions.in(parent.id).find((x) => x.personaId === p.id && !x.retiredFork);
  if (target?.id === from.id) return { ok: false, message: `@${p.handle} is you: just carry on.` };
  // A host turn’s replay after a restart posts a mention it already handed over (#1138’s class): stored once, counted once.
  if (target && retryId && rt.delivery.inbox(target.id).some((/** @type {any} */ e) => e.retryId === retryId)) return { ok: true, itemId };
  // Where the waker speaks now: a topic thread it’s in, else the conversation. Agents talk where the person reads,
  // never in a side thread of their own (#372); a turn still in an old side thread hands off in the conversation.
  const back = replyIn === undefined ? replyInOf(rt, from) : replyIn;
  const backKind = back && rt.store.pending.thread(back)?.kind; // a topic open_topic just opened may still be held
  const at = backKind === 'topic' ? back : parent.id;
  // Told before any card, so a wake that waits for Allow still tells it (Allow carries no side thread).
  if (backKind === 'side') sideThreadsGone(rt, from);
  // A card keeps the mention’s message, so Allow wakes from it rather than posting it again.
  // A bounce keeps its mark on the card, so what is held is told as a reply, not a mention (#1518).
  const card = { text, replyIn: at === parent.id ? null : at, fromTurnId, itemId, ...(bounce ? { bounce } : {}) };
  if (!target) return askToAdd(rt, from, parent, p, card, { prose });
  // No limit between two agents (#492): the room shows the chain’s count, with a hint to Stop past CHAIN_HINT.
  if (!confirmed && (parent.hops ?? 0) >= roomChainLimit(rt, parent.id)) return askToWake(rt, from, parent, p, card);
  const hop = (parent.hops ?? 0) + 1;
  rt.threads.patch(parent.id, { hops: hop });
  // A mention is already the waker’s message there, so the wake’s number in the chain (#114) goes on the
  // turn’s first item: it marks the turn, not necessarily the paragraph with the mention. One message can wake several
  // agents, so each wake’s number is kept (wakes); hop stays the first. A wake with no message of its own (a test’s, a card’s from before) posts one as the waker’s.
  const said = itemId ? rt.store.pending.item(at, itemId) : null;
  if (said) rt.threads.patchItem(at, said.id, { hop: said.hop ?? hop, wakes: [...(said.wakes ?? (said.hop ? [said.hop] : [])), hop] });
  const message = { kind: 'agent', sessionId: from.id, personaId: from.personaId, handle: from.handle, text, status: 'done', hop, wakes: [hop], fromTurnId };
  const it = said ?? rt.threads.addItem(at, message);
  recordAgentMessage(rt, from.id, 'to', p.handle, text);
  recordAgentMessage(rt, target.id, 'from', from.handle, text);
  // The woken agent answers from its session in the conversation (#110): the message is an entry in its inbox there,
  // which starts its turn now, or once its turn ends (designs/rooms-at-scale.md, “Delivery”).
  const waits = rt.running.busy(target.id);
  const entry = { sessionId: target.id, threadId: at, source: 'mention', itemId: it.id, from: from.handle, ...(retryId ? { retryId } : {}), bounce };
  rt.delivery.send(entry, { wake });
  // A card asking to wake it is stale once it’s woken now, or at the end of the waker’s turn under way (#439); one
  // woken once its own turn ends keeps the card the person may answer.
  if (!waits) retireStale(rt, at, target, `@${from.handle} woke it`);
  // itemId: the message the wake went out as, so a turn’s further mentions reuse it rather than post it again.
  return { ok: true, itemId: it.id, message: waits ? `Woke @${p.handle}: it’s busy, so it answers when its current turn ends.` : `Woke @${p.handle}.` };
}

/** An agent whose turn runs in a side thread from before #372 is told, once, that hand-offs happen in the conversation. */
function sideThreadsGone(rt, se) {
  if (se.toldSideThreadsGone) return;
  rt.sessions.update(se.id, { toldSideThreadsGone: true });
  rt.sessions.tell(se.id, 'Side threads are gone: agents hand off in the conversation now, where the person reads (#372). This side thread gets no new wakes.');
}

/** The thread a session’s turn speaks in now, when that isn’t its own (a topic or side thread); else null. */
const replyInOf = (rt, se) => {
  const at = rt.turns.get(se.id)?.threadId;
  return at && at !== se.threadId ? at : null;
};

/**
 * When the last agent working in a conversation ends its turn with nothing left to answer, the chain of wakes has ended,
 * as when an agent acks a hand-off without waking anyone, so its count starts again (#492): separate chains don’t add up
 * to the chain limit. A wake waiting on a card keeps it, until you answer the card.
 * @param {any} rt @param {string} threadId  where the turn that ended spoke
 */
export function endChain(rt, threadId) {
  const conv = rt.threads.lineage(threadId).at(-1);
  if (!rt.store.pending.thread(conv)?.hops) return;
  if (rt.sessions.in(conv).some((se) => rt.turns.has(se.id) || rt.exiting.has(se.id))) return;
  // A mention still waiting in an inbox there is the chain going on (designs/rooms-at-scale.md, “Delivery”).
  if (rt.sessions.in(conv).some((se) => rt.delivery.waiting(se.id).some((e) => e.source === 'mention'))) return;
  if (rt.store.pending.items(conv).some((x) => x.kind === 'hop' && x.status === 'open')) return;
  rt.threads.patch(conv, { hops: 0 });
}

/**
 * The person stopped an agent, or removed it (#228): agents’ messages waiting for it are stopped, since a waiting
 * mention mustn’t undo a Stop, and each sender hears at its next turn that its message went unanswered.
 * @param {any} rt @param {any} se  the agent @param {string} [how]  what happened to it
 */
export function dropWakes(rt, se, how = 'stopped') {
  dropHeld(rt, se, how);
  // Removed, it can't answer for its own card; stopped, it can, and the person still may (#693).
  if (how !== 'stopped') closeOwnCard(rt, se, how);
  // Agents’ waiting entries are stopped, so none starts a turn after the Stop, and each agent that sent one hears so;
  // the person’s messages wait for the next turn, and are stopped too when the agent was removed.
  for (const e of rt.delivery.stopped(se.id, { all: how !== 'stopped' })) {
    // A scheduled wake that waited is settled, as one held on the turn was, so a restart doesn’t fire it again (#466).
    if (e.source === 'scheduled') dropScheduledWake(rt, e.message);
    // A summary request isn’t coming, as one held on a stopped turn wasn’t (#93): its panel’s button stops waiting.
    if (e.message?.summary) rt.clearSummaryPending(e.threadId);
    const sender = e.source === 'mention' && e.from ? rt.sessions.in(rt.threads.lineage(e.threadId).at(-1)).find((x) => x.handle === e.from) : null;
    if (!sender || sender.retiredFork || sender.id === se.id) continue;
    const said = clip(rt.store.pending.item(e.threadId, e.itemId)?.text ?? '', 120);
    rt.sessions.tell(sender.id, `@${se.handle} was ${how} before it answered your message (“${said}”). Mention it again if you still need it.`);
  }
}

/**
 * Who answers for a persona in a side or topic thread (#110, #228): its one session in the conversation. A persona the
 * conversation doesn’t have joins it when you @-mention it there, as adding it would.
 * @param {any} side  the side or topic thread @param {string} personaId @param {string} by  the handle that woke it, or 'you'
 */
export function sideSession(rt, side, personaId, by) {
  const conv = rt.threads.lineage(side.id).at(-1);
  const had = rt.sessions.in(conv).find((x) => x.personaId === personaId);
  if (had?.retiredFork) throw retiredError(had);
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
  const picked =
    (last && rt.persona(last.personaId)) ?? rt.personas.byHandle(t.woke ?? t.pair?.split('|')[1] ?? '') ?? (first && rt.persona(first.personaId)) ?? null;
  if (!picked || !deletedFrom(rt, t, picked.handle)) return picked;
  // An agent deleted from the conversation isn’t brought back to answer: another still in it does, or no one (#283).
  const here = rt.sessions.pendingIn(conversationOf(rt, t)).find((x) => !x.retiredFork);
  return (here && rt.persona(here.personaId)) ?? null;
}

/** A thread’s conversation as written: one made behind a held commit isn’t published yet (#796’s class). */
const conversationOf = (rt, t) => rt.threads.lineage(t.id, (id) => rt.store.pending.thread(id)).at(-1);

/**
 * Whether an agent was deleted from a thread’s conversation and hasn’t come back: it has no session there, and the
 * conversation says it left. An agent that was never in it, as one a topic thread was woken for, can still join (#874).
 * @param {any} rt @param {any} t  the topic or side thread @param {string} handle
 */
export function deletedFrom(rt, t, handle) {
  const conv = conversationOf(rt, t);
  if (rt.sessions.pendingIn(conv).some((x) => !x.retiredFork && rt.persona(x.personaId)?.handle === handle)) return false;
  return rt.store.pending.items(conv).some((i) => i.kind === 'system' && i.variant === 'left' && i.to === handle);
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
  rt.threads.patchItem(side.parentId, link.id, { count: new Set(said.map((x) => x.turnId ?? x.id)).size, lastAt: said.at(-1)?.at ?? link.at });
}

export function recordAgentMessage(rt, sessionId, dir, other, text) {
  const se = rt.s.sessions[sessionId];
  if (!se) return;
  rt.sessions.update(sessionId, { agentMessages: [{ dir, other, text: clip(text, 120), at: Date.now() }, ...se.agentMessages].slice(0, 6) });
}
