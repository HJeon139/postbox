// The wake cards (#228): a wake of an agent the conversation doesn’t have waits for the person’s Allow on a card in the
// conversation, and resolveHop settles it. Until #492, a wake past a limit raised one too (#108, #372), and while one
// waited, a wake that needed another was held on it (#439): no limit holds a wake back now, but a card stored from then
// is still answered, with the wakes held on it. Moved from server/side-threads.mjs, whose agentWake raises them.
// Functions take the Runtime first (architecture.md, “What a move may change”).

import { clip, httpError } from './helpers.mjs';

/**
 * An agent wakes a persona the conversation doesn’t have (#228): only the person adds one, so a card asks them. Allow
 * adds it, with a note, and delivers the wake; Decline tells the agent (resolveHop). One whose session here is
 * archived needs the person to restore it.
 */
export function askToAdd(rt, from, parent, p, wake) {
  if (rt.sessionsIn(parent.id).some((x) => x.personaId === p.id))
    return { ok: false, message: `@${p.handle}’s session in this conversation is archived, so it can’t be woken. Ask the person to restore it.` };
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

/** A card stored from before #492 that still waits with wakes held on it. */
const heldCard = (rt, parent) => rt.store.items(parent.id).find((x) => x.kind === 'hop' && x.status === 'open' && x.held?.length) ?? null;
/** A card as an agent is told of it: who it’s between, and since when. */
const cardName = (c) =>
  `@${c.from}’s request to ${c.join ? 'add' : 'wake'} @${c.to}${Number.isFinite(c.at) ? ` (since ${new Date(c.at).toISOString().slice(11, 16)} UTC)` : ''}`;

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
  rt.putThread({ ...rt.s.threads[threadId], hops: 0 });
  // Added: it joins with a note on why, as an agent the person adds does, and the wake goes on (#228).
  const p = it.join && allow ? rt.personaByHandle(it.to) : null;
  if (p) {
    rt.ensureSession(threadId, p.id, { brief: `@${it.from} woke you, and the person added you to this conversation.`, joined: { by: it.from, in: threadId } });
    rt.addItem(threadId, { kind: 'system', variant: 'joined', to: p.handle });
  }
  // A request stored before #108 kept only the preview.
  if (allow)
    rt.agentWake(it.fromSessionId, it.to, it.text ?? it.reason, {
      replyIn: it.replyIn ?? null,
      fromTurnId: it.fromTurnId ?? null,
      itemId: it.itemId ?? null,
    });
  settleHeld(rt, it, allow);
  if (allow) return;
  if (from && !from.archived)
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

/** The wakes held on a card from before #492 go with it (#439): Allow delivers each as its agent sent it; otherwise each agent is told. */
function settleHeld(rt, card, allow) {
  for (const w of card.held ?? []) {
    if (allow) {
      sendHeld(rt, card, w);
      continue;
    }
    const se = rt.s.sessions[w.fromSessionId];
    if (se && !se.archived)
      rt.deliver(
        se.id,
        {
          kind: 'notice',
          text: `The person chose not to allow ${cardName(card)}, so your message held on it (“${clip(w.text, 120)}”) didn’t go to @${w.to}. Send it again if you still need it.`,
        },
        { threadId: w.replyIn ?? null },
      );
  }
}

/** A held wake goes on as its agent sent it; one that can’t go (its target was archived meanwhile) tells its agent why. */
function sendHeld(rt, card, w) {
  const r = rt.agentWake(w.fromSessionId, w.to, w.text, { replyIn: w.replyIn, fromTurnId: w.fromTurnId, itemId: w.itemId });
  const se = rt.s.sessions[w.fromSessionId];
  if (!r.ok && !r.waiting && se && !se.archived)
    rt.tellAgent(se.id, `Your message to @${w.to} (“${clip(w.text, 120)}”), held on ${cardName(card)}, didn’t go: ${r.message}`);
}

/**
 * Stopping, archiving or removing an agent reaches the wakes held for it on a card from before #492 too (#439), as
 * dropWakes does for queued ones: a held wake mustn’t undo a Stop when the card is allowed. Each one’s agent is told at
 * its next turn.
 * @param {any} rt @param {any} se  the agent @param {string} how  what happened to it
 */
export function dropHeld(rt, se, how) {
  const conv = rt.lineage(se.threadId).at(-1);
  const card = heldCard(rt, { id: conv });
  const mine = (card?.held ?? []).filter((w) => w.to === se.handle);
  if (!mine.length) return;
  rt.patchItem(conv, card.id, { held: card.held.filter((w) => !mine.includes(w)) });
  for (const w of mine)
    if (rt.s.sessions[w.fromSessionId] && !rt.s.sessions[w.fromSessionId].archived && w.fromSessionId !== se.id)
      rt.tellAgent(
        w.fromSessionId,
        `@${se.handle} was ${how} before your message held for it (“${clip(w.text, 120)}”) went, so it won’t go. Wake it again if you still need it.`,
      );
}
