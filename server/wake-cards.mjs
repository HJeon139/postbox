// The wake cards (#108, #228): a wake past the limit, or of an agent the conversation doesn’t have, waits for the
// person’s Allow on a card in the conversation, and resolveHop settles it. Moved from server/side-threads.mjs, whose
// agentWake raises them. Functions take the Runtime first (architecture.md, “What a move may change”).

import { HOP_LIMIT, PAIR_LIMIT } from '../shared/limits.mjs';
import { clip, httpError } from './helpers.mjs';

/** The card for a wake past the limit (#108), which waits for the person’s Allow. */
export function askToWake(rt, from, parent, p, wake) {
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
export function askToAdd(rt, from, parent, p, wake) {
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
