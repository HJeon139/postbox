// Permission prompts of a remote turn (#120, server/remote/turns.mjs, the header): the daemon’s `prompt` shows the
// laptop’s card (requestPermission), and the answer goes back as `answer`. Each prompt is an identity, (turn, id),
// which the daemon sends again after every hello until Postbox has answered it: its answer is kept on its card, so a
// repeat gets the same answer. A prompt nobody can answer any more marks its card expired, canceled or ended.

import { NOT_YOUR_PROMPT } from '../../shared/mcp-tools.mjs';
import { message as protocolMessage, REMOTE_LIMITS } from '../../shared/remote-protocol.mjs';
import { describePermission } from '../adapters/claude-stream.mjs';
import { asksByPrompt } from '../permission-prompt.mjs';
import { linkOf } from './turns-need.mjs';
import { ENDED_TEXT, key, ON_HOST, send, sessionOfTurn, updateRemote } from './turns-shared.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */
/** @typedef {import('./turns-shared.mjs').Live} Live */

/**
 * A permission prompt waiting in the shim: the laptop’s card (requestPermission), answered with `answer`. A repeat
 * of one already answered gets the same answer again; one already showing waits on its card.
 * @param {RemoteTurns} rts @param {string} hostId @param {{ id: string, turn: string, request: Record<string, any> }} m
 */
export function onPrompt(rts, hostId, m) {
  const k = key(m.turn, m.id);
  if (rts.endedPrompts.has(k)) return;
  const link = linkOf(rts, hostId);
  const card = cardOf(rts, m.turn, m.id);
  if (card && card.it.status !== 'open') {
    if (card.it.remote?.answer) send(link, 'answer', { turn: m.turn, prompt: m.id, result: card.it.remote.answer });
    return;
  }
  const live = rts.byTurn.get(m.turn);
  if (!live || live.rt.closed) {
    if (!card) send(link, 'answer', { turn: m.turn, prompt: m.id, result: { behavior: 'deny', message: 'The turn has ended.' } });
    return;
  }
  // As on the laptop (server/mcp.mjs), a backend that asks another way gets no card. Its shim, started with
  // --no-prompt, refuses the call itself; this is for one that wasn’t.
  if (!card && !asksByPrompt(rts.rt, live.sessionId))
    return void send(link, 'answer', { turn: m.turn, prompt: m.id, result: { behavior: 'deny', message: NOT_YOUR_PROMPT.content[0].text } });
  // Shown already: after a restart nothing waits on it here yet, so its answer is waited for again.
  if (card) {
    if (!rts.rt.permissionWaits.has(card.it.id)) waitOn(rts, live, card, m);
    return;
  }
  const { tool_name, input = {}, tool_use_id, permission_suggestions, agent_id } = m.request ?? {};
  const { summary, detail } = describePermission(String(tool_name ?? 'a tool'), input);
  const asked = ask(rts, live.rt, {
    tool: String(tool_name ?? ''),
    summary,
    detail,
    toolUseId: tool_use_id ?? null,
    input,
    suggestions: permission_suggestions,
    agentId: typeof agent_id === 'string' ? agent_id : null,
    hostPrompt: { hostId, turn: m.turn, id: m.id },
  });
  asked.then((answer) => answered(rts, hostId, m, answer, input));
}

/** A card shown before a restart, waited on again. @param {RemoteTurns} rts @param {Live} live @param {{ threadId: string, it: any }} card @param {any} m */
function waitOn(rts, live, card, m) {
  const rt = rts.rt;
  const se = rt.s.sessions[live.sessionId];
  const p = new Promise((resolve) => rt.permissionWaits.set(card.it.id, { resolve, threadId: card.threadId, sessionId: live.sessionId }));
  rt.updateSession(live.sessionId, {
    state: 'needs',
    needs: { kind: 'permission', itemId: card.it.id, text: `@${se.handle} asks to ${card.it.summary}`, ...rt.awayFrom(se, card.threadId) },
  });
  setWaiting(rts, live, true);
  p.then((answer) => {
    setWaiting(rts, live, false);
    answered(rts, live.hostId, m, /** @type {any} */ (answer), card.it.input ?? m.request?.input ?? {});
  });
}

/**
 * The person answered (or the turn ended first): the answer goes to the host, and onto the card for repeats,
 * unless the host ended the prompt meanwhile.
 * @param {RemoteTurns} rts @param {string} hostId @param {{ id: string, turn: string }} m @param {any} answer @param {any} input
 */
function answered(rts, hostId, m, answer, input) {
  if (rts.endedPrompts.has(key(m.turn, m.id))) return;
  let result = answer?.allow
    ? {
        behavior: 'allow',
        updatedInput: answer.updatedInput ?? input,
        ...(answer.updatedPermissions ? { updatedPermissions: answer.updatedPermissions } : {}),
      }
    : { behavior: 'deny', message: String(answer?.message || 'The person didn’t allow this.').slice(0, REMOTE_LIMITS.messageChars) };
  try {
    protocolMessage('postbox-to-daemon', 'answer', { turn: m.turn, prompt: m.id, result });
  } catch {
    result = { behavior: 'deny', message: 'Postbox couldn’t send this answer to the host, so it didn’t allow it.' };
  }
  const card = cardOf(rts, m.turn, m.id);
  if (card) rts.rt.patchItem(card.threadId, card.it.id, { remote: { ...card.it.remote, answer: result } });
  send(linkOf(rts, hostId), 'answer', { turn: m.turn, prompt: m.id, result });
}

/**
 * A card for a remote turn: requestPermission, with the card marked as the host prompt it answers, and the turn
 * shown as waiting while it’s open. hostPrompt: { hostId, turn, id }, or a string ID the adapter knows it by (a
 * Codex request’s, codex:<id>), in the turn’s current host turn.
 * @param {RemoteTurns} rts @param {any} turn @param {any} req
 */
export function ask(rts, turn, req) {
  const live = /** @type {Live | undefined} */ (turn.remote);
  if (!live) return rts.rt.requestPermission(turn.sessionId, req);
  const hp = req.hostPrompt;
  const hostPrompt = typeof hp === 'string' ? (live.current ? { hostId: live.hostId, turn: live.current, id: hp } : null) : (hp ?? null);
  setWaiting(rts, live, true);
  const p = rts.rt.requestPermission(turn.sessionId, { ...req, hostPrompt });
  return p.then((/** @type {any} */ a) => {
    setWaiting(rts, live, false);
    return a;
  });
}

/** @param {RemoteTurns} rts @param {Live} live @param {boolean} on */
function setWaiting(rts, live, on) {
  const se = rts.rt.s.sessions[live.sessionId];
  if (!se?.remoteTurn || live.rt.closed || !ON_HOST.has(se.remoteTurn.state)) return;
  const open = [...rts.rt.permissionWaits.values()].some((w) => w.sessionId === live.sessionId);
  const state = on || open ? 'waiting' : 'running';
  if (se.remoteTurn.state !== state) updateRemote(rts, se.id, { state });
}

/**
 * Nobody can answer a prompt any more: its card is marked expired (the host’s permissionWaitMax) or canceled (the
 * harness gave up on the call). A card the person already answered keeps its answer.
 * @param {RemoteTurns} rts @param {{ id: string, turn: string, at: number, reason?: 'expired' | 'canceled' }} m
 */
export function onPromptExpired(rts, m) {
  const card = cardOf(rts, m.turn, m.id);
  if (card && card.it.status !== 'open') return;
  rts.endedPrompts.add(key(m.turn, m.id));
  if (!card) return;
  const canceled = m.reason === 'canceled';
  // noAnswer: the host’s permissionWaitMax ran out, which the card says, unlike an expiry when the turn ended.
  endCard(
    rts,
    card,
    canceled ? 'canceled' : 'expired',
    canceled ? 'The agent stopped waiting for this answer.' : 'Nobody answered in time, so the host didn’t allow it.',
    m.at,
    canceled ? {} : { noAnswer: true },
  );
}

/** @param {RemoteTurns} rts @param {any} m */
export function onError(rts, m) {
  // An allow that reached the host after it stopped waiting: the host denied the call, so the card, which read
  // Allowed, says it expired, and why.
  if (m.re === 'answer' && m.code === 'no-prompt' && typeof m.turn === 'string' && typeof m.id === 'string') {
    const card = cardOf(rts, m.turn, m.id);
    if (card && String(card.it.status).startsWith('allowed'))
      rts.rt.patchItem(card.threadId, card.it.id, { status: 'expired', lateAnswer: true, endedAt: rts.now() });
    return;
  }
  // The daemon couldn’t write down that a prompt of this turn ended: it can’t be answered any more. The error names
  // the prompt (its id), so exactly that card is marked ended; one from a daemon that doesn’t name it marks a lone
  // open card only, since nothing says which when more than one is open. A card already answered keeps its answer.
  if (m.re === 'prompt-expired' && typeof m.turn === 'string') {
    if (typeof m.id === 'string') {
      const card = cardOf(rts, m.turn, m.id);
      if (card && card.it.status !== 'open') return;
      rts.endedPrompts.add(key(m.turn, m.id));
      if (card) endCard(rts, card, 'ended', ENDED_TEXT, rts.now());
      return;
    }
    const open = openCards(rts, m.turn);
    if (open.length === 1) {
      const card = open[0];
      rts.endedPrompts.add(key(m.turn, card.it.remote.prompt));
      endCard(rts, card, 'ended', ENDED_TEXT, rts.now());
    } else if (open.length > 1) console.error(`Postbox’s daemon couldn’t record a prompt’s end in turn ${m.turn}: ${m.message}`);
  }
  // no-prompt (an answer that came too late) and no-tool (a reply to one already settled) change nothing: the
  // prompt-expired or the turn’s end that follows says the rest.
}

/**
 * @param {RemoteTurns} rts @param {{ threadId: string, it: any }} card @param {string} status @param {string} message @param {number} at
 * @param {Record<string, unknown>} [extra]  more for the card, such as noAnswer
 */
export function endCard(rts, card, status, message, at, extra = {}) {
  const rt = rts.rt;
  if (rt.permissionWaits.has(card.it.id)) rt.settlePermission(card.it.id, status, message, {}, { endedAt: at, ...extra });
  else {
    rt.patchItem(card.threadId, card.it.id, { status, answeredAt: rts.now(), endedAt: at, ...extra });
    const se = rt.s.sessions[card.it.sessionId];
    if (se?.needs?.itemId === card.it.id) rt.updateSession(se.id, { needs: null, state: rt.turns.has(se.id) ? 'tool' : 'idle' });
  }
}

/** The card for a host prompt, in its session’s conversation. @param {RemoteTurns} rts @param {string} turn @param {string} id */
function cardOf(rts, turn, id) {
  const se = sessionOfTurn(rts, turn);
  if (!se) return null;
  for (const threadId of rts.rt.conversationThreads(se.threadId)) {
    const it = rts.rt.store.items(threadId).find((/** @type {any} */ i) => i.kind === 'permission' && i.remote?.turn === turn && i.remote?.prompt === id);
    if (it) return { threadId, it };
  }
  return null;
}

/** @param {RemoteTurns} rts @param {string} turn */
export function openCards(rts, turn) {
  const se = sessionOfTurn(rts, turn);
  if (!se) return [];
  return rts.rt.conversationThreads(se.threadId).flatMap((/** @type {string} */ threadId) =>
    rts.rt.store
      .items(threadId)
      .filter((/** @type {any} */ i) => i.kind === 'permission' && i.status === 'open' && i.remote?.turn === turn)
      .map((/** @type {any} */ it) => ({ threadId, it })),
  );
}
