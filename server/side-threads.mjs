// Agents waking agents, in the conversation where the person reads (#372): the wake limit, who answers for a persona
// in a topic thread or an old side thread (its one session in the conversation: no forks, #228), the card that asks to
// add an agent the conversation doesn’t have, and the lines of side threads from before #372. Functions take the
// Runtime first (architecture.md, “What a move may change”).

import { HOP_LIMIT, PAIR_LIMIT } from '../shared/limits.mjs';
import { clip, httpError, tooLongToSend } from './helpers.mjs';
import { newId } from './store.mjs';

// Agent wakes in a row, without you, and between the same two agents, before the next waits for your Allow
// (shared/limits.mjs: wake_agent’s description on a host names them too).
export { HOP_LIMIT, PAIR_LIMIT };

// ── Agents waking agents ───────────────────────────────────────────────────────────

/**
 * An agent wakes another (#110, #228, #372): by an @-mention in what it said (itemId, that message) or by wake_agent. It
 * reaches the persona’s one session in the conversation, which answers there; a busy one takes the wake when its turn
 * ends, as any message to a busy agent waits. A persona the conversation doesn’t have needs the
 * person: a card asks to add it. After HOP_LIMIT wakes in a row without you, the next one waits for your confirm.
 */
export function agentWake(
  rt,
  fromSessionId,
  handle,
  text,
  { confirmed = false, replyIn = undefined, fromTurnId = rt.turns.get(fromSessionId)?.id, itemId = null } = {},
) {
  const from = rt.s.sessions[fromSessionId];
  const p = rt.personaByHandle(handle);
  if (!from || !p) return { ok: false, message: `There’s no agent called @${handle}.` };
  // Archived, it can’t be answered: a reply would have nowhere to go.
  if (from.archived) return { ok: false, message: 'Your session is archived, so it can’t wake anyone.' };
  // The conversation: every session lives in one. A fork from before #228 wakes from the conversation it came from.
  const parent = rt.s.threads[rt.lineage(from.threadId).at(-1)];
  const target = rt.sessionsIn(parent.id).find((x) => x.personaId === p.id && !x.archived);
  if (target?.id === from.id) return { ok: false, message: `@${p.handle} is you: just carry on.` };
  // Where the waker speaks now: a topic thread it’s in, else the conversation. Agents talk where the person reads,
  // never in a side thread of their own (#372); a turn still in an old side thread hands off in the conversation.
  const back = replyIn === undefined ? replyInOf(rt, from) : replyIn;
  const at = back && rt.s.threads[back]?.kind === 'topic' ? back : parent.id;
  // Told before any card, so a wake that waits for Allow still tells it (Allow carries no side thread).
  if (back && rt.s.threads[back]?.kind === 'side') sideThreadsGone(rt, from);
  // A card keeps the mention’s message, so Allow wakes from it rather than posting it again.
  const card = { text, replyIn: at === parent.id ? null : at, fromTurnId, itemId };
  if (!target) return askToAdd(rt, from, parent, p, card);
  // Two agents mentioning each other in turn (“pushed @a”, “thanks @b”, “noted @a”) stop after a hand-off and its
  // answer, as a reply that went back by itself once stopped them. Each pair keeps its own count, so a third agent’s
  // wakes in between don’t restart it; the person acting does.
  const pair = [from.handle, p.handle].sort().join('|');
  const runs = parent.pairRuns ?? {};
  const run = Object.hasOwn(runs, pair) ? runs[pair] : 0;
  if (!confirmed && ((parent.hops ?? 0) >= HOP_LIMIT || run >= PAIR_LIMIT)) return askToWake(rt, from, parent, p, card);
  const hop = (parent.hops ?? 0) + 1;
  rt.putThread({ ...rt.s.threads[parent.id], hops: hop, pairRuns: { ...runs, [pair]: run + 1 } });
  // A mention is already the waker’s message there, so the wake’s number in the chain (#114, telemetry) goes on the
  // turn’s first item: it marks the turn, not necessarily the paragraph with the mention. One message can wake several
  // agents, so each wake’s number is kept (wakes); hop stays the first. wake_agent’s message is posted as the waker’s.
  const said = itemId ? rt.store.item(at, itemId) : null;
  if (said) rt.patchItem(at, said.id, { hop: said.hop ?? hop, wakes: [...(said.wakes ?? (said.hop ? [said.hop] : [])), hop] });
  const it =
    said ??
    rt.addItem(at, { kind: 'agent', sessionId: from.id, personaId: from.personaId, handle: from.handle, text, status: 'done', hop, wakes: [hop], fromTurnId });
  rt.recordAgentMessage(from.id, 'to', p.handle, text);
  rt.recordAgentMessage(target.id, 'from', from.handle, text);
  // The woken agent answers from its session in the conversation (#110). Busy, it takes the wake when its turn ends,
  // from the queue where it was sent, where the person sees it and can cancel it (#228).
  const waits = rt.turns.has(target.id) || rt.exiting.has(target.id);
  const wake = { id: newId('q'), kind: 'wake', from: from.handle, fromSessionId: from.id, text, itemId: it.id, sessionIds: [target.id], at: Date.now() };
  if (waits) rt.putThread({ ...rt.s.threads[at], queue: [...(rt.s.threads[at].queue ?? []), wake] });
  else deliverWake(rt, at, wake);
  // itemId: the message the wake went out as, so a turn’s further mentions reuse it rather than post it again.
  return { ok: true, itemId: it.id, message: waits ? `Woke @${p.handle}: it’s busy, so it answers when its current turn ends.` : `Woke @${p.handle}.` };
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
}

/**
 * The person stopped an agent, or archived it (#228): wakes queued for it are dropped, since a queued wake mustn’t undo
 * a Stop, and each waker hears at its next turn that its message went unanswered.
 * @param {any} rt @param {any} se  the agent @param {string} [how]  what happened to it
 */
export function dropWakes(rt, se, how = 'stopped') {
  for (const t of Object.values(rt.s.threads)) {
    const mine = (t.queue ?? []).filter((q) => q.kind === 'wake' && q.sessionIds.includes(se.id));
    if (!mine.length) continue;
    rt.putThread({ ...t, queue: t.queue.filter((q) => !mine.includes(q)) });
    for (const q of mine)
      if (rt.s.sessions[q.fromSessionId] && !rt.s.sessions[q.fromSessionId].archived && q.fromSessionId !== se.id)
        rt.tellAgent(q.fromSessionId, `@${se.handle} was ${how} before it answered your message (“${clip(q.text, 120)}”). Wake it again if you still need it.`);
  }
}

/** The card for a wake past the limit (#108), which waits for the person’s Allow. */
function askToWake(rt, from, parent, p, wake) {
  if (openCard(rt, parent)) return busyCard(p);
  const n = (parent.hops ?? 0) + 1;
  // Under the limit, it’s the pair’s: these two agents have woken each other PAIR_LIMIT times in a row (#372).
  const pair = n <= HOP_LIMIT ? PAIR_LIMIT : null;
  // The card shows reason as a preview; text is the whole message, delivered when you allow it (#108).
  const it = rt.addItem(parent.id, {
    kind: 'hop',
    fromSessionId: from.id,
    from: from.handle,
    to: p.handle,
    reason: clip(wake.text, 200),
    ...wake,
    status: 'open',
    n,
    pair,
  });
  needsCard(rt, from, parent, it, `@${from.handle} wants to wake @${p.handle}`);
  const why = pair ? `They’ve woken each other ${pair} times in a row.` : `That would be agent wake ${n} since your last message.`;
  rt.notify('blocking', from, `Let @${from.handle} wake @${p.handle}?`, why);
  return { ok: false, waiting: true, message: `Waiting for the person to allow waking @${p.handle}.` };
}

/**
 * An agent wakes a persona the conversation doesn’t have (#228): only the person adds one, so a card asks them. Allow
 * adds it, with a note, and delivers the wake; Decline tells the agent (resolveHop). One whose session here is
 * archived needs the person to restore it.
 */
function askToAdd(rt, from, parent, p, wake) {
  if (rt.sessionsIn(parent.id).some((x) => x.personaId === p.id))
    return { ok: false, message: `@${p.handle}’s session in this conversation is archived, so it can’t be woken. Ask the person to restore it.` };
  if (openCard(rt, parent)) return busyCard(p);
  const it = rt.addItem(parent.id, {
    kind: 'hop',
    join: true,
    fromSessionId: from.id,
    from: from.handle,
    to: p.handle,
    reason: clip(wake.text, 200),
    ...wake,
    status: 'open',
  });
  needsCard(rt, from, parent, it, `@${from.handle} wants to add @${p.handle}`);
  rt.notify('blocking', from, `Add @${p.handle} to this conversation?`, `@${from.handle} wants to wake it.`);
  return {
    ok: false,
    waiting: true,
    message: `@${p.handle} isn’t in this conversation, so the person was asked to add it. If they do, it gets your message; if not, you’ll be told.`,
  };
}

/** One request at a time: while a card waits for the person, a further wake isn’t sent, and the agent is told so. */
const openCard = (rt, parent) => rt.store.items(parent.id).some((x) => x.kind === 'hop' && x.status === 'open');
const busyCard = (p) => ({
  ok: false,
  message: `Your message to @${p.handle} wasn’t sent: another request is waiting for the person to answer it. Send it again once they have.`,
});

/** The agent asking needs the person, at the card in the conversation (#121). */
function needsCard(rt, from, parent, it, text) {
  rt.updateSession(from.id, {
    needs: { kind: 'hop', itemId: it.id, text, ...rt.awayFrom(from, parent.id) },
    state: rt.turns.has(from.id) ? from.state : 'needs',
  });
}

/** wake_agent { handle, message }, the tool, for the session rt.toolsFor made it for. A summary’s turn wakes no one (#225). */
export function wakeAgent(rt, sessionId, { handle, message }) {
  if (rt.turns.get(sessionId)?.summarizeTo)
    return { ok: false, message: 'A summary for the conversation wakes no one: finish it, and the person decides the rest.' };
  const text = String(message ?? '');
  return tooLongToSend('A message to another agent', text) ?? rt.agentWake(sessionId, String(handle).replace(/^@/, ''), text);
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
  for (const t of Object.values(rt.s.threads)) {
    if (t.queue?.some((q) => q.sessionIds.some((id) => gone.has(id))))
      rt.putThread({ ...t, queue: t.queue.map((q) => ({ ...q, sessionIds: q.sessionIds.filter((id) => !gone.has(id)) })).filter((q) => q.sessionIds.length) });
    for (const it of rt.store.items(t.id))
      if (it.kind === 'hop' && it.status === 'open' && gone.has(it.fromSessionId)) rt.patchItem(t.id, it.id, { status: 'declined' });
  }
  rt.store.emit('settings', { forksArchived: true });
  return forks.length;
}

export function resolveHop(rt, threadId, itemId, allow) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'hop' || it.status !== 'open') throw httpError(409, 'That request was already answered.');
  // Added while its session here is being removed, Undo would leave two of it: wait for the removal to finish (#228).
  const removing = (rt.s.threads[threadId]?.members ?? []).map((id) => rt.s.sessions[id]).find((x) => x?.deleting && x.handle === it.to);
  if (it.join && allow && removing) throw httpError(409, `@${it.to} is being removed from this conversation. Undo that, or add it once it’s gone.`);
  rt.patchItem(threadId, itemId, { status: allow ? 'allowed' : 'declined' });
  const voice = it.join
    ? allow
      ? `Added @${it.to} to this conversation for @${it.from}`
      : `Didn’t add @${it.to} to this conversation`
    : allow
      ? `Allowed: @${it.from} wakes @${it.to}`
      : `Didn’t allow @${it.from} to wake @${it.to}`;
  rt.addItem(threadId, { kind: 'voice', text: voice });
  const from = rt.s.sessions[it.fromSessionId];
  if (from) rt.updateSession(from.id, { needs: null, state: rt.turns.has(from.id) ? from.state : 'idle' });
  rt.putThread({ ...rt.s.threads[threadId], hops: 0, pairRuns: null });
  // Added: it joins with a note on why, as an agent the person adds does, and the wake goes on (#228).
  const p = it.join && allow ? rt.personaByHandle(it.to) : null;
  if (p) {
    rt.ensureSession(threadId, p.id, { brief: `@${it.from} woke you, and the person added you to this conversation.`, joined: { by: it.from, in: threadId } });
    rt.addItem(threadId, { kind: 'system', variant: 'joined', to: p.handle });
  }
  // A request stored before #108 kept only the preview.
  if (allow)
    rt.agentWake(it.fromSessionId, it.to, it.text ?? it.reason, {
      confirmed: true,
      replyIn: it.replyIn ?? null,
      fromTurnId: it.fromTurnId ?? null,
      itemId: it.itemId ?? null,
    });
  else if (from && !from.archived)
    rt.deliver(
      from.id,
      {
        kind: 'notice',
        text: it.join
          ? `The person chose not to add @${it.to} to this conversation, so it didn’t get your message. Carry on without it.`
          : `The person chose not to let you wake @${it.to}. Carry on without it.`,
      },
      { threadId: it.replyIn ?? null },
    );
}

/**
 * The side thread's line in the conversation: how many messages it holds, as the side thread shows them, and when the
 * last one came (#130). Yours and each wake count one each, and an agent's turn counts one however many items it
 * posted (blocks split a reply). addItem calls it for every message there.
 */
export function bumpSideLink(rt, sideThreadId) {
  const side = rt.s.threads[sideThreadId];
  if (side?.kind !== 'side') return;
  const link = rt.store.items(side.parentId).find((x) => x.kind === 'sidelink' && x.sideThreadId === side.id);
  if (!link) return;
  // A turn that failed or was stopped before it said anything left an empty placeholder: not a message.
  const said = rt.store.items(side.id).filter((x) => x.kind === 'user' || (x.kind === 'agent' && (x.text || x.status === 'streaming')));
  rt.patchItem(side.parentId, link.id, { count: new Set(said.map((x) => x.turnId ?? x.id)).size, lastAt: said.at(-1)?.at ?? link.at });
}

export function recordAgentMessage(rt, sessionId, dir, other, text) {
  const se = rt.s.sessions[sessionId];
  if (!se) return;
  rt.updateSession(sessionId, { agentMessages: [{ dir, other, text: clip(text, 120), at: Date.now() }, ...se.agentMessages].slice(0, 6) });
}
