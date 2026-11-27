// The add card (#228): a wake of an agent the conversation doesn’t have waits for the person’s Allow on a card in the
// conversation, and resolveHop settles it. One card waits at a time: a wake that needs another while it does is held on
// it, and settled with it (#439). The wake-limit card that shared it is gone (#1623): the chain’s cap refuses a wake
// with no card (chain-stop.mjs). Moved from server/side-threads.mjs, whose agentWake raises them. Functions take the
// Runtime first (designs/architecture/code-size.md, “What a move may change”).

import { HELD_WAKES } from '../shared/limits.mjs';
import { offerNeed, releaseNeed } from './card-needs.mjs';
import { clip, httpError } from './helpers.mjs';

/**
 * An agent wakes a persona the conversation doesn’t have (#228): only the person adds one, so a card asks them. Allow
 * adds it, with a note, and delivers the wake; Decline tells the agent (resolveHop). One whose session here was
 * retired can’t be woken. After the person declines adding it here, a prose mention asks no more (#693).
 * @param {any} rt @param {any} from @param {any} parent @param {any} p @param {any} wake
 * @param {{ prose?: boolean }} [opts]  prose: the wake is an @-mention in a turn’s reply
 */
export function askToAdd(rt, from, parent, p, wake, { prose = false } = {}) {
  if (rt.sessions.pendingIn(parent.id).some((x) => x.personaId === p.id))
    return { ok: false, message: `@${p.handle}’s session in this conversation was retired, so it can’t be woken.` };
  if (prose && declinedAdd(rt, parent.id, p.handle))
    return { ok: false, message: `the person chose not to add @${p.handle} to this conversation. Carry on without it, or ask the person.` };
  const open = openCard(rt, parent);
  if (open) return holdOnCard(rt, open, parent, from, p, wake);
  const it = rt.threads.addItem(parent.id, {
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
  rt.threads.notify('blocking', from, `Add @${p.handle} to this conversation?`, `@${from.handle} wants to wake it.`);
  return {
    ok: false,
    waiting: true,
    message: `@${p.handle} isn’t in this conversation, so the person was asked to add it. If they do, it gets your message; if not, you’ll be told.`,
  };
}

/**
 * Whether the person’s last answer to adding `handle` to the conversation was no (#693), read from its cards, so a
 * restart keeps it: a later Add lifts it, an Allow on a card or the person’s own add (liftDecline, #789). A card
 * retiring forks declined (#228’s startup migration, before #693) isn’t the person’s answer. O(items in the
 * conversation), once per mention of an agent it doesn’t have.
 */
function declinedAdd(rt, conv, handle) {
  const last = lastAddAnswer(rt, conv, handle);
  return last?.status === 'declined' && !last.lifted && !rt.s.sessions[last.fromSessionId]?.retiredFork;
}

/**
 * The person added `handle` to the conversation themselves (#789): an @-mention, a new agent, a proposal accepted. Its
 * last decline is marked lifted, so a prose mention once it’s removed asks again, as after an Allow on a card. Every new
 * session passes here (ensureSession); after an Allow the last answer is already yes.
 * @param {any} rt @param {string} conv @param {string} handle
 */
export function liftDecline(rt, conv, handle) {
  const last = lastAddAnswer(rt, conv, handle);
  if (last?.status === 'declined' && !last.lifted) rt.threads.patchItem(conv, last.id, { lifted: Date.now() });
}

/** The newest add card for `handle` the person answered, read pending, so an answer held behind a commit counts (#796). */
const lastAddAnswer = (rt, conv, handle) =>
  rt.store.pending.items(conv).findLast((x) => x.kind === 'hop' && x.join && x.to === handle && (x.status === 'allowed' || x.status === 'declined'));

/** One request at a time: the card waiting for the person, if there is one. */
const openCard = (rt, parent) => rt.store.pending.items(parent.id).find((x) => x.kind === 'hop' && x.status === 'open') ?? null;
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
  const { text, replyIn = null, fromTurnId = null, itemId = null, bounce = false } = wake;
  rt.threads.patchItem(parent.id, card.id, {
    held: [
      ...held,
      { fromSessionId: from.id, from: from.handle, to: p.handle, text, replyIn, fromTurnId, itemId, ...(bounce ? { bounce } : {}), at: Date.now() },
    ],
  });
  const message = `Postbox is holding your message to @${p.handle}: ${cardName(card)} is waiting for the person. It goes to @${p.handle} when they allow that, so don’t send it again; if they don’t, you’ll be told.`;
  // A bounce may be a reply that went back on its own, not a mention its agent wrote (reply-back.mjs, #1518).
  const what = bounce ? `Your message to @${p.handle} is held` : `Your mention of @${p.handle} is held`;
  if (itemId) rt.sessions.tell(from.id, `${what}. ${message}`);
  return { ok: false, waiting: true, held: true, message };
}

/** The agent asking needs the person, at the card in the conversation (#121). */
function needsCard(rt, from, parent, it, text) {
  offerNeed(rt, from, { kind: 'hop', itemId: it.id, text, ...rt.sessions.awayFrom(from, parent.id) }, rt.turns.has(from.id) ? from.state : 'needs');
}

/**
 * The person’s answer on an add card. A wake-limit card from before #1623 closed at startup (closeOrphanCards), so the
 * one still open is an add card.
 */
export function resolveHop(rt, threadId, itemId, allow) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind === 'hop' && it.status === 'closed') throw httpError(409, `That request was closed: ${it.closedWhy}.`);
  if (it?.kind !== 'hop' || !it.join || it.status !== 'open') throw httpError(409, 'That request was already answered.');
  rt.threads.patchItem(threadId, itemId, { status: allow ? 'allowed' : 'declined' });
  const voice = allow ? `Added @${it.to} to this conversation for @${it.from}` : `Didn’t add @${it.to} to this conversation`;
  rt.threads.addItem(threadId, { kind: 'voice', text: voice });
  const from = rt.s.sessions[it.fromSessionId];
  releaseNeed(rt, from, itemId);
  rt.threads.patch(threadId, { hops: 0 });
  // Added: it joins with a note on why, as an agent the person adds does, and the wake goes on (#228).
  const p = allow ? rt.personas.byHandle(it.to) : null;
  if (p) {
    rt.ensureSession(threadId, p.id, { brief: `@${it.from} woke you, and the person added you to this conversation.`, joined: { by: it.from, in: threadId } });
    rt.threads.addItem(threadId, { kind: 'system', variant: 'joined', to: p.handle });
  }
  // A request stored before #108 kept only the preview.
  if (allow)
    rt.agentWake(it.fromSessionId, it.to, it.text ?? it.reason, {
      confirmed: true,
      replyIn: it.replyIn ?? null,
      fromTurnId: it.fromTurnId ?? null,
      itemId: it.itemId ?? null,
      bounce: it.bounce === true,
    });
  settleHeld(rt, it, allow);
  if (allow) return { ok: true };
  if (from && !from.retiredFork)
    answerWaker(rt, from, it, it.replyIn, `The person chose not to add @${it.to} to this conversation, so it didn’t get your message. Carry on without it.`);
  return { ok: true };
}

/** The wakes held on a card go with it (#439): Allow delivers each as its agent sent it; otherwise each agent is told. */
function settleHeld(rt, card, allow) {
  for (const w of card.held ?? []) {
    if (allow) {
      sendHeld(rt, card, w);
      continue;
    }
    const se = rt.s.sessions[w.fromSessionId];
    if (se && !se.retiredFork)
      answerWaker(
        rt,
        se,
        card,
        w.replyIn,
        `The person chose not to allow ${cardName(card)}, so your message held on it (“${clip(w.text, 120)}”) didn’t go to @${w.to}. Send it again if you still need it.`,
      );
  }
}

/**
 * The person’s decline on a card reaches an agent whose wake it held as an answer entry pointing at the card
 * (designs/rooms-at-scale.md, “What an entry is”), in the thread it spoke from, with the words its turn is given until
 * Turns builds input from entries.
 * @param {any} rt @param {any} se @param {any} card @param {string|null|undefined} replyIn @param {string} text
 */
function answerWaker(rt, se, card, replyIn, text) {
  const threadId = replyIn ?? se.threadId;
  rt.delivery.send({ sessionId: se.id, threadId, source: 'answer', itemId: card.id, from: 'you', message: { kind: 'notice', text } });
}

/**
 * A held wake goes on as its agent sent it, and its agent is told either way: that it went, since the hold’s answer said
 * it waits and the agent would go on reporting it as waiting (#517), or why it didn’t (its target was removed meanwhile).
 */
function sendHeld(rt, card, w) {
  const r = rt.agentWake(w.fromSessionId, w.to, w.text, {
    confirmed: true,
    replyIn: w.replyIn,
    fromTurnId: w.fromTurnId,
    itemId: w.itemId,
    bounce: w.bounce === true,
  });
  const se = rt.s.sessions[w.fromSessionId];
  if (r.waiting || !se || se.retiredFork) return;
  const outcome = r.ok ? 'went: the person allowed it.' : `didn’t go: ${r.message}`;
  rt.sessions.tell(se.id, `Your message to @${w.to} (“${clip(w.text, 120)}”), held on ${cardName(card)}, ${outcome}`);
}

/**
 * Stopping or removing an agent reaches the wakes held for it too (#439), as dropWakes does for queued
 * ones: a held wake mustn’t undo a Stop when the card is allowed. Each one’s agent is told at its next turn.
 * @param {any} rt @param {any} se  the agent @param {string} how  what happened to it
 */
export function dropHeld(rt, se, how) {
  const conv = rt.threads.conversationToWrite(se.threadId);
  const card = openCard(rt, { id: conv });
  const mine = (card?.held ?? []).filter((w) => w.to === se.handle);
  if (!mine.length) return;
  rt.threads.patchItem(conv, card.id, { held: card.held.filter((w) => !mine.includes(w)) });
  for (const w of mine)
    if (rt.s.sessions[w.fromSessionId] && !rt.s.sessions[w.fromSessionId].retiredFork && w.fromSessionId !== se.id)
      rt.sessions.tell(
        w.fromSessionId,
        `@${se.handle} was ${how} before your message held for it (“${clip(w.text, 120)}”) went, so it won’t go. Wake it again if you still need it.`,
      );
}

/**
 * A card that closes with no answer from the person (#693): the agent that asked was removed or retired, so
 * nothing can answer for it. @param {any} rt @param {string} conv @param {any} card @param {string} how  what happened
 * to the agent that asked
 */
export const closeHop = (rt, conv, card, how) => closeCard(rt, conv, card, `@${card.from} was ${how}`, `you were ${how}`);

/**
 * A card that closes with no answer from the person: it closes, its agent stops needing the person, and nothing it held
 * goes. Its agent and each agent whose wake was held on it are told at their next turn, as dropHeld tells, and the card
 * stays closed. The one way every such close goes (#693, #1623).
 * @param {any} rt @param {string} conv @param {any} card @param {string} why  why it closed, as the page and the held
 * wakes’ agents read it @param {string} askerWhy  the same, as the agent that asked is told it
 */
function closeCard(rt, conv, card, why, askerWhy) {
  rt.threads.patchItem(conv, card.id, { status: 'closed', closedWhy: why, closedAt: Date.now() });
  const asker = rt.s.sessions[card.fromSessionId];
  releaseNeed(rt, asker, card.id);
  if (asker)
    rt.sessions.tell(
      asker.id,
      `${cardName(card).replace(`@${card.from}’s request`, 'Your request')} was closed: ${askerWhy}. Send your message again if you still need it.`,
    );
  for (const w of card.held ?? []) {
    // The agent that asked has its note above, which covers its own wakes held here.
    if (!rt.s.sessions[w.fromSessionId] || w.fromSessionId === card.fromSessionId) continue;
    rt.sessions.tell(
      w.fromSessionId,
      `Your message to @${w.to} (“${clip(w.text, 120)}”), held on ${cardName(card)}, didn’t go: ${why}. Send it again if you still need it.`,
    );
  }
}

/** The agent that asked is removed (#693): its open card closes. O(items in its conversation). */
export function closeOwnCard(rt, se, how) {
  const conv = rt.threads.conversationToWrite(se.threadId);
  const card = openCard(rt, { id: conv });
  if (card?.fromSessionId === se.id) closeHop(rt, conv, card, how);
}

/** Why a wake-limit card from before #1623 closed, as its agents are told. */
const CARD_GONE = 'Postbox no longer asks the person to continue a chain of wakes';

/**
 * At startup, an open card whose agent is retired or gone closes (#693): a room from before the fix would hold every
 * wake on it. So does a wake-limit card from before #1623: nothing asks past the chain’s cap now (chain-stop.mjs), and
 * the page shows one as a line with no buttons. O(items), once per start.
 */
export function closeOrphanCards(rt) {
  for (const t of Object.values(rt.s.threads)) {
    const card = openCard(rt, t);
    const from = card && rt.s.sessions[card.fromSessionId];
    if (card && !card.join) closeCard(rt, t.id, card, CARD_GONE, CARD_GONE);
    else if (card && (!from || from.retiredFork)) closeHop(rt, t.id, card, 'retired or removed');
  }
}

/** How many held messages a catch-up names, one line each; the rest are counted (#693). */
const HELD_NAMED = 3;

/**
 * The messages waiting for an agent on its conversation’s open card, for its catch-up (#693): each wake held on the
 * card, so it learns a message is coming, and from whom, while the person hasn’t
 * answered. Up to HELD_NAMED lines, then a count. O(items in the conversation), once per turn.
 * @param {any} rt @param {any} se  the agent the messages are for @returns {string[]}
 */
export function heldFor(rt, se) {
  // Published, not pending: the catch-up says what the person can see (designs/508/601-held-view.md), and it decides no
  // write, so a card still held behind a commit isn’t named yet.
  const card = rt.store.items(rt.threads.lineage(se.threadId).at(-1)).find((x) => x.kind === 'hop' && x.status === 'open');
  if (!card) return [];
  const mine = (card.held ?? []).filter((w) => w.to === se.handle);
  const lines = mine
    .slice(0, HELD_NAMED)
    .map((w) => `@${w.from}’s message to you (“${clip(w.text, 120)}”) is held on ${cardName(card)}, waiting for the person.`);
  const more = mine.length - lines.length;
  return more > 0 ? [...lines, `And ${more} more messages for you are held on it.`] : lines;
}
