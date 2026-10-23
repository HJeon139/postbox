// Side threads, where agents talk to each other: an agent waking another, the wake limit, who answers for a persona
// there (its session in the conversation, or a fork of it while that session is busy), and the side-thread line in
// the conversation. Functions take the Runtime first (architecture.md, “What a move may change”).

import { clip, clipText, httpError } from './helpers.mjs';
import { newId } from './store.mjs';

export const HOP_LIMIT = 3;

// ── Agents waking agents ───────────────────────────────────────────────────────────

/** After HOP_LIMIT agent-to-agent wakes in a row without you, the next one waits for your confirm. */
export function agentWake(rt, fromSessionId, handle, text, { confirmed = false } = {}) {
  const from = rt.s.sessions[fromSessionId];
  const p = rt.personaByHandle(handle);
  if (!from || !p) return { ok: false, message: `There’s no agent called @${handle}.` };
  const t = rt.s.threads[from.threadId];
  const parent = t.kind === 'side' ? (rt.s.threads[t.parentId] ?? t) : t;
  if (!confirmed && (parent.hops ?? 0) >= HOP_LIMIT) {
    // One request at a time: further wakes wait behind the one you haven’t answered.
    if (rt.store.items(parent.id).some((x) => x.kind === 'hop' && x.status === 'open'))
      return { ok: false, waiting: true, message: 'Another wake is already waiting for the person to allow it.' };
    const it = rt.addItem(parent.id, {
      kind: 'hop',
      fromSessionId,
      from: from.handle,
      to: p.handle,
      // The card shows reason as a preview; text is the whole message, delivered when you allow it (#108).
      reason: clip(text, 200),
      text,
      status: 'open',
      n: (parent.hops ?? 0) + 1,
    });
    rt.updateSession(fromSessionId, {
      // The card is in the conversation, even when the agent asking is a fork in a side thread (#121).
      needs: { kind: 'hop', itemId: it.id, text: `@${from.handle} wants to wake @${p.handle}`, ...rt.awayFrom(from, parent.id) },
      state: rt.turns.has(fromSessionId) ? from.state : 'needs',
    });
    rt.notify('blocking', from, `Let @${from.handle} wake @${p.handle}?`, `That would be agent wake ${(parent.hops ?? 0) + 1} since your last message.`);
    return { ok: false, waiting: true, message: `Waiting for the person to allow waking @${p.handle}.` };
  }
  const hops = (parent.hops ?? 0) + 1;
  rt.putThread({ ...rt.s.threads[parent.id], hops });
  // A persona with no session here joins the conversation (sideSession), and the line says so.
  const joins = !rt.sessionsIn(parent.id).some((x) => x.personaId === p.id);
  rt.addItem(parent.id, {
    kind: 'system',
    variant: 'wake',
    from: from.handle,
    to: p.handle,
    n: hops,
    limit: HOP_LIMIT,
    ...(joins ? { joined: true } : {}),
  });
  // The exchange happens in a side thread; your thread shows one line that links to it.
  const pair = [from.handle, p.handle].sort().join('|');
  let side = Object.values(rt.s.threads).find((x) => x.kind === 'side' && x.parentId === parent.id && x.pair === pair);
  if (!side) {
    side = rt.putThread({
      id: newId('th'),
      projectId: parent.projectId,
      title: `@${from.handle} ↔ @${p.handle}`,
      kind: 'side',
      parentId: parent.id,
      pair,
      // Who answers in it before anyone has spoken there (sendMessage).
      woke: p.handle,
      members: [],
      lastSpeaker: null,
      hops: 0,
      queue: [],
      createdAt: Date.now(),
      archived: false,
    });
    rt.addItem(parent.id, { kind: 'sidelink', sideThreadId: side.id, from: from.handle, to: p.handle, count: 0 });
  }
  const said = rt.addItem(side.id, { kind: 'agent', sessionId: from.id, personaId: from.personaId, handle: from.handle, text, status: 'done' });
  rt.recordAgentMessage(from.id, 'to', p.handle, text);
  // The woken agent answers from its session in the conversation, so it remembers the exchange (#110); a fork of it
  // answers only while that session is busy.
  const target = rt.sideSession(side, p.id, from.handle);
  rt.recordAgentMessage(target.id, 'from', from.handle, text);
  rt.deliver(target.id, { kind: 'agent', from: `@${from.handle}`, text, itemId: said.id }, { replyTo: from.id, threadId: side.id });
  return { ok: true, message: target.forkOf?.busy ? `Woke @${p.handle}: its session was busy, so a fork of it answers.` : `Woke @${p.handle}.` };
}

/**
 * Who answers for a persona in a side thread (#110): one session per persona per conversation. That’s its session in
 * the conversation, which joins it if it isn’t there yet. Only while that session is mid-turn (or archived) does a fork
 * of it, taken at its latest point, answer instead: one per side thread, reused, and shown nested under the persona.
 * @param {any} side @param {string} personaId @param {string} by  the handle that woke it, or 'you'
 */
export function sideSession(rt, side, personaId, by) {
  const parent = rt.thread(side.parentId);
  const home =
    rt.sessionsIn(parent.id).find((x) => x.personaId === personaId) ??
    rt.ensureSession(parent.id, personaId, {
      brief: by === 'you' ? 'You were @-mentioned in a side thread of this conversation.' : `@${by} woke you in a side thread of this conversation.`,
      joined: { by, in: side.id },
    });
  if (!home.archived && !rt.turns.has(home.id) && !rt.exiting.has(home.id)) return home;
  // Busy in this side thread already: the message waits for that turn, as any message to a busy agent does. A fork
  // here would be a second session doing the same work, which is #121 again.
  const busyIn = rt.turns.get(home.id)?.threadId ?? rt.exiting.get(home.id)?.turn.threadId;
  if (!home.archived && busyIn === side.id) return home;
  const fork = rt.sessionsIn(side.id).find((x) => x.personaId === personaId && !x.archived);
  return fork ?? rt.forkBusy(home, side, by);
}

/**
 * A fork of a busy session into a side thread, at the session’s latest point: it starts with its memory, answers the
 * wake, and when it’s done the session hears where to read what it did (forkDone).
 * @param {any} src @param {any} side @param {string} by
 */
export function forkBusy(rt, src, side, by) {
  const se = rt.ensureSession(side.id, src.personaId);
  const adapter = rt.adapters.get(rt.persona(src.personaId)?.backend ?? 'mock');
  // first: its first turn hasn’t ended yet. If that turn fails before it does anything, the fork starts again fresh.
  rt.updateSession(se.id, { personaSnapshot: src.personaSnapshot, forkOf: { sessionId: src.id, itemId: null, busy: true, by, first: true }, wokenBy: by });
  if (adapter.capabilities?.fork === false) return rt.forkFresh(se, src, side);
  rt.updateSession(se.id, {
    backendState: { fork: null, forkFrom: src.backendState ?? null, contextWindow: src.backendState?.contextWindow },
    ctx: src.ctx,
    compactions: src.compactions,
    // Its catch-up is this side thread’s, from the start.
    seenItem: null,
    context: [rt.forkNote(src, side, null)],
  });
  try {
    adapter.fork?.(src, rt.s.sessions[se.id]);
  } catch (e) {
    return rt.forkFresh(se, src, side, e);
  }
  return rt.s.sessions[se.id];
}

/**
 * A fork that can’t start from its session’s memory: the backend can’t fork (Kiro), or forking failed. It’s a new
 * session of the agent, and its note says so, and why.
 * @param {any} se @param {any} src @param {any} side @param {any} [err]
 */
export function forkFresh(rt, se, src, side, err = null) {
  if (err) console.error(`A fork of @${src.handle}’s session couldn’t start from its memory, so it starts fresh: ${err.message ?? err}`);
  rt.updateSession(se.id, {
    backendState: {},
    ctx: 2,
    compactions: 0,
    seenItem: null,
    forkOf: { ...rt.s.sessions[se.id].forkOf, fresh: true },
    context: [rt.forkNote(src, side, err)],
  });
  return rt.s.sessions[se.id];
}

/**
 * What a fork reads first. fresh: null when it starts from its session’s memory; otherwise why it doesn’t (true for
 * a backend that can’t fork, or the error).
 * @param {any} src @param {any} side @param {any} fresh
 */
export function forkNote(rt, src, side, fresh) {
  const conv = rt.s.threads[src.threadId]?.title ?? '';
  const why = fresh && fresh !== true ? ` (starting from its memory failed: ${clipText(String(fresh.message ?? fresh), 200)})` : '';
  return `[Postbox] You’re answering in the side thread “${side.title}” as a fork of your session in the conversation “${conv}”: that session was busy${src.archived ? ' (archived)' : ''}, so ${fresh ? `this is a new session of you, and it doesn’t remember the conversation${why}` : 'this one starts from what it remembered then'}. Your session there doesn’t see what you do here; when you’re done, it’s told where to read it.`;
}

/**
 * A fork’s first turn failed before it said or did anything, which is how a backend’s fork of a session mid-turn
 * fails: it starts again, once, as a fresh session, with the same message. Returns whether it did.
 * @param {any} se @param {any} turn @param {any} err
 */
export function forkRetry(rt, se, turn, err) {
  if (!se.forkOf?.busy || !se.forkOf.first || se.forkOf.fresh || turn.first || turn.steps.length || turn.said) return false;
  const src = rt.s.sessions[se.forkOf.sessionId];
  const side = rt.s.threads[se.threadId];
  if (!src || !side) return false;
  rt.forkFresh(se, src, side, err);
  rt.updateSession(se.id, { state: 'idle', needs: null, currentStep: '' });
  const { message, replyTo, summarizeTo, threadId } = turn.asked;
  rt.deliver(se.id, message, { replyTo, summarizeTo, threadId });
  rt.turns.get(se.id)?.pending.push(...turn.pending);
  return true;
}

/**
 * A fork made because its session was busy finished a turn: its session’s next turn gets a pointer to it, with the
 * thread id. The agent decides whether to bring it in: the fork’s summary (its last reply) or its full messages, both
 * with read_conversation. Postbox sends neither. The pointer replaces an older one for the same thread.
 * @param {any} se @param {any} turn
 */
export function forkDone(rt, se, turn) {
  if (!se.forkOf?.busy) return;
  const main = rt.s.sessions[se.forkOf.sessionId];
  const side = rt.s.threads[turn.threadId];
  if (!main || !side) return;
  const tag = `(thread ${side.id})`;
  const text = `[Postbox] A fork of you answered in the side thread “${side.title}” ${tag} while you were busy, starting from what you remembered then. You don’t remember what it did. Its summary is its last reply: read_conversation with thread: "${side.id}" and limit: 1. Its full messages: read_conversation with thread: "${side.id}". Read either only if it matters to your work.`;
  rt.updateSession(main.id, { context: [...(main.context ?? []).filter((x) => !x.includes(tag)), text].slice(-20) });
}

export function resolveHop(rt, threadId, itemId, allow) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'hop' || it.status !== 'open') throw httpError(409, 'That request was already answered.');
  rt.patchItem(threadId, itemId, { status: allow ? 'allowed' : 'declined' });
  rt.addItem(threadId, { kind: 'voice', text: allow ? `Allowed: @${it.from} wakes @${it.to}` : `Didn’t allow @${it.from} to wake @${it.to}` });
  const from = rt.s.sessions[it.fromSessionId];
  if (from) rt.updateSession(from.id, { needs: null, state: rt.turns.has(from.id) ? from.state : 'idle' });
  rt.putThread({ ...rt.s.threads[threadId], hops: 0 });
  // A request stored before #108 kept only the preview.
  if (allow) rt.agentWake(it.fromSessionId, it.to, it.text ?? it.reason, { confirmed: true });
  else if (from) rt.deliver(from.id, { kind: 'notice', text: `The person chose not to let you wake @${it.to}. Carry on without it.` });
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
