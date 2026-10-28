// The wake cards (#108, #228): a wake past the limit, or of an agent the conversation doesn’t have, waits for the
// person’s Allow on a card in the conversation, and resolveHop settles it. One card waits at a time: a wake that needs
// another while it does is held on it, and settled with it (#439). Moved from server/side-threads.mjs, whose agentWake
// raises them. Functions take the Runtime first (architecture.md, “What a move may change”).

import { HELD_WAKES, HOP_LIMIT, PAIR_LIMIT } from '../shared/limits.mjs';
import { clip, httpError } from './helpers.mjs';

/** The card for a wake past the limit (#108), which waits for the person’s Allow. */
export function askToWake(rt, from, parent, p, wake) {
  const open = openCard(rt, parent);
  if (open) return holdOnCard(rt, open, parent, from, p, wake);
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
  const open = openCard(rt, parent);
  if (open) return holdOnCard(rt, open, parent, from, p, wake);
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

/** One request at a time: the card waiting for the person, if there is one. */
const openCard = (rt, parent) => rt.store.items(parent.id).find((x) => x.kind === 'hop' && x.status === 'open') ?? null;
/** A card as an agent is told of it: who it’s between, and since when. */
const cardName = (c) =>
  `@${c.from}’s request to ${c.join ? 'add' : 'wake'} @${c.to}${Number.isFinite(c.at) ? ` (since ${new Date(c.at).toISOString().slice(11, 16)} UTC)` : ''}`;

/**
 * A wake that needs a card while one waits is held on that card (#439): not sent, not recorded as received and not
 * posted until the person allows the card, which delivers it with the card’s own (resolveHop). Its agent is told which
 * card, as the call’s result, or as a note for a mention, whose own message is already in the conversation.
 */
function holdOnCard(rt, card, parent, from, p, wake) {
  const held = card.held ?? [];
  if (held.length >= HELD_WAKES)
    return {
      ok: false,
      message: `Your message to @${p.handle} wasn’t sent: ${cardName(card)} is waiting for the person, with ${HELD_WAKES} messages already held on it. Send it again once they’ve answered.`,
    };
  const { text, replyIn = null, fromTurnId = null, itemId = null } = wake;
  rt.patchItem(parent.id, card.id, {
    held: [...held, { fromSessionId: from.id, from: from.handle, to: p.handle, text, replyIn, fromTurnId, itemId, at: Date.now() }],
  });
  const message = `Postbox is holding your message to @${p.handle}: ${cardName(card)} is waiting for the person. It goes to @${p.handle} when they allow that, so don’t send it again; if they don’t, you’ll be told.`;
  if (itemId) rt.tellAgent(from.id, `Your mention of @${p.handle} is held. ${message}`);
  return { ok: false, waiting: true, held: true, message };
}

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

/** The wakes held on a card go with it (#439): Allow delivers each as its agent sent it; otherwise each agent is told. */
function settleHeld(rt, card, allow) {
  for (const w of card.held ?? []) {
    if (allow) {
      sendHeld(rt, card, w, true);
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

/**
 * A card whose target got a turn another way is stale (#439): the person wrote to it, or another agent’s wake reached
 * it. It closes as retired, and its own wake isn’t sent, since what it asked for may have happened that way: its agent
 * is told at its next turn, and can send it again. The wakes held on it go on as their agents sent them: through the
 * limits again, so one that still needs a card raises it, unless the person’s message is what retired it, since their
 * acting starts the counts again (intent.md).
 * @param {any} rt @param {string} threadId  where the target’s turn comes from @param {any} target @param {string} why
 * @param {{ byPerson?: boolean }} [opts]
 */
export function retireStale(rt, threadId, target, why, { byPerson = false } = {}) {
  const conv = rt.lineage(threadId).at(-1);
  const card = openCard(rt, { id: conv });
  if (!card || card.join || card.to !== target.handle) return;
  rt.patchItem(conv, card.id, { status: 'retired', retiredWhy: why });
  const from = rt.s.sessions[card.fromSessionId];
  if (from) rt.updateSession(from.id, { needs: null, state: rt.turns.has(from.id) ? from.state : 'idle' });
  if (from && !from.archived)
    rt.tellAgent(
      from.id,
      `@${card.to} got a turn another way (${why}) before the person answered your request to wake it, so your message (“${clip(card.text ?? card.reason ?? '', 120)}”) wasn’t sent. Send it again if it’s still needed.`,
    );
  for (const w of card.held ?? []) sendHeld(rt, card, w, byPerson);
}

/** A held wake goes on as its agent sent it; one that can’t go (its target was archived meanwhile) tells its agent why. */
function sendHeld(rt, card, w, confirmed) {
  const r = rt.agentWake(w.fromSessionId, w.to, w.text, { confirmed, replyIn: w.replyIn, fromTurnId: w.fromTurnId, itemId: w.itemId });
  const se = rt.s.sessions[w.fromSessionId];
  if (!r.ok && !r.waiting && se && !se.archived)
    rt.tellAgent(se.id, `Your message to @${w.to} (“${clip(w.text, 120)}”), held on ${cardName(card)}, didn’t go: ${r.message}`);
}

/**
 * Stopping, archiving or removing an agent reaches the wakes held for it too (#439), as dropWakes does for queued
 * ones: a held wake mustn’t undo a Stop when the card is allowed. Each one’s agent is told at its next turn.
 * @param {any} rt @param {any} se  the agent @param {string} how  what happened to it
 */
export function dropHeld(rt, se, how) {
  const conv = rt.lineage(se.threadId).at(-1);
  const card = openCard(rt, { id: conv });
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
