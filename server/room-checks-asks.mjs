// The checks of what waits on the person (#508, designs/508/testing-strategy.md, “Triggers, checks and seeds to
// add”): a wake the limit held that went away unanswered and undelivered (#439), and a needs-you ring that disagrees
// with the asks open in the state. Each reads only what `main` records, and names the requirements it serves beside
// its issue. Part of server/room-checks.mjs’s CHECKS, kept apart for size.

import { ASKING } from '../shared/catalog.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import { clip } from '../shared/text.mjs';
import { headOf, holds, inputsOf, notCheckableAll, recorded, timeAfter, turnsOf, unreadable } from './room-delivery.mjs';

const ANSWERED = new Set(['allowed', 'declined']);
const heldKey = (w) => `${w.fromSessionId ?? w.from}:${w.to}:${headOf(w.text) ?? w.text}`;

/** How close to a card’s retiring the wakes it sent on are raised again, or held on another card. */
const MOVE_MS = 1000;
/** A card’s own wake, in the shape of a held one, for heldKey. */
const ownOf = (card) => ({ fromSessionId: card.fromSessionId, from: card.from, to: card.to, text: card.text ?? card.reason, itemId: card.itemId, at: card.at });

/**
 * Each card’s history from the events: the card as added, the statuses it went through, when it was settled (null
 * while open), and every wake held on it, with whether a later patch took it off while the card was still open.
 * Retiring a card sends its own wake and those held on it on (server/wake-cards.mjs’s retireStale), and one that
 * still needs a card raises the next card, or is held on it: movedTo names the card that took a wake over, and
 * movedFrom the card it came from, its own wake’s (own) as a held one’s.
 * @param {any[]} events
 */
export function cardHistory(events) {
  /** @typedef {{ w: any, removedOpen: boolean, movedTo: string|null, movedFrom: string|null }} Wake */
  /** @type {Map<string, { card: any, statuses: string[], settled: number|null, own: Wake, held: Map<string, Wake> }>} */
  const cards = new Map();
  /** The wakes of retired cards not yet taken over, by heldKey: each with its card and when it was retired. */
  /** @type {Map<string, { h: Wake, cardId: string, at: number }>} */
  const pending = new Map();
  /** A wake raised again, or held, at `at`: the retired card’s that it is, if one was sent on just then. */
  const takeOver = (k, at, cardId, h) => {
    const p = pending.get(k);
    if (!p || p.cardId === cardId || !Number.isFinite(at) || Math.abs(at - p.at) > MOVE_MS) return;
    pending.delete(k);
    p.h.movedTo = cardId;
    h.movedFrom = p.cardId;
  };
  for (const e of events ?? []) {
    if (e.type === 'item.add' && e.data?.item?.kind === 'hop') {
      const card = e.data.item;
      const own = { w: ownOf(card), removedOpen: false, movedTo: null, movedFrom: null };
      cards.set(card.id, { card, statuses: [card.status], settled: null, own, held: new Map() });
      takeOver(heldKey(own.w), card.at, card.id, own);
    }
    const c = e.type === 'item.patch' ? cards.get(e.data?.id) : null;
    if (!c) continue;
    const p = e.data.patch ?? {};
    if (typeof p.status === 'string') c.statuses.push(p.status);
    // A patch carries no time: a retired card’s says when; otherwise the next item added is the closest record.
    if (typeof p.status === 'string' && p.status !== 'open' && c.settled === null)
      c.settled = Number.isFinite(p.retiredAt) ? p.retiredAt : timeAfter(events, e.seq);
    if (p.status === 'retired' && Number.isFinite(p.retiredAt))
      for (const h of [c.own, ...c.held.values()]) pending.set(heldKey(h.w), { h, cardId: c.card.id, at: p.retiredAt });
    if (!Array.isArray(p.held)) continue;
    const now = new Set(p.held.map(heldKey));
    for (const w of p.held)
      if (!c.held.has(heldKey(w))) {
        const h = { w, removedOpen: false, movedTo: null, movedFrom: null };
        c.held.set(heldKey(w), h);
        takeOver(heldKey(w), w.at, c.card.id, h);
      }
    const open = c.statuses.at(-1) === 'open';
    for (const [k, h] of c.held) if (!now.has(k) && open) h.removedOpen = true;
  }
  return cards;
}

/**
 * ask-dropped: a held wake, or a card, that left the state with no answer from the person and never reached its
 * target. The turn it went on in, the target’s first after its card settled, may have no line in the transcript
 * (stopped before Claude Code wrote its prompt): then the check says it couldn’t check it there. A wake a retired
 * card sent on to the next card is that card’s to settle (cardHistory’s movedTo): it counts as dropped only when the
 * last card it was on ends without delivering it.
 */
function droppedAsks(f) {
  const live = new Set((f.threads ?? []).flatMap((t) => (f.state?.items?.[t] ?? []).map((it) => it.id)));
  const unread = new Map();
  const reached = (w, since, settled) => {
    const got = inputsOf(f, w.to);
    // No transcript of the target: whether it got the wake can’t be read, so the wake isn’t called dropped, and the
    // check says it didn’t check it.
    if (!got) {
      unreadable(unread, w.to);
      return true;
    }
    if (got.some((x) => x.at >= since && holds(x, { itemId: w.itemId ?? null, text: w.text ?? '' }))) return true;
    const due = turnsOf(f, w.to).find((t) => t.started >= (settled ?? since) - 1000);
    if (!due || recorded(got, due)) return false;
    unreadable(unread, w.to, due);
    return true;
  };
  const out = [];
  const cards = cardHistory(f.events);
  /** Since when a moved wake could reach its target: when it was first held, on the first card it was on. */
  const first = (h) => {
    let w = h;
    for (let i = 0; i < cards.size && w.movedFrom; i++) {
      const c = cards.get(w.movedFrom);
      const k = heldKey(w.w);
      const before = c && (heldKey(c.own.w) === k && c.own.movedTo ? c.own : c.held.get(k));
      if (!before) break;
      w = before;
    }
    return w.w.at ?? 0;
  };
  for (const [id, c] of cards) {
    const answered = c.statuses.some((s) => ANSWERED.has(s));
    const own = { to: c.card.to, itemId: c.card.itemId, text: c.card.text ?? c.card.reason, at: c.card.at };
    if (!answered && !live.has(id) && !c.own.movedTo && !reached(own, own.at ?? 0, c.settled))
      out.push({
        key: `ask-dropped:${id}`,
        title: `@${c.card.from}’s request to wake @${c.card.to} left the room unanswered`,
        evidence: `Card ${id} (“${clip(own.text, 100)}”) went from the state without the person answering it, and @${c.card.to} never got its message.`,
      });
    for (const [k, h] of c.held) {
      // Taken over by the next card: that one settles it.
      if (h.movedTo) continue;
      const retired = !answered && c.statuses.includes('retired');
      // Settled with its card: Allow or Don’t allow is the person’s answer; retiring sends it on, so it must arrive.
      const cardGone = !answered && !live.has(id);
      if (!(h.removedOpen || cardGone || retired) || reached(h.w, first(h), retired ? c.settled : null)) continue;
      const via = h.movedFrom ? `, moved from ${h.movedFrom}` : '';
      out.push({
        key: `ask-dropped:${id}:${k}`,
        title: `@${h.w.from}’s wake of @${h.w.to}, held on a card, went without an answer and never arrived`,
        evidence: `Held on ${id}${via} (“${clip(h.w.text, 100)}”), it ${h.removedOpen ? 'was taken off the card while it still waited' : retired ? 'went on when the card was retired' : 'went with its card'}, and @${h.w.to} never got it.`,
      });
    }
  }
  return [...notCheckableAll(f, 'ask-dropped', unread), ...out];
}

/**
 * needs-mismatch: a ring that disagrees with the open asks. An agent with an open card or an unanswered block that
 * doesn’t need you, or one that needs you for an ask already settled.
 */
function needsMismatches(f) {
  const out = [];
  const sessions = f.state?.sessions ?? {};
  const byId = new Map();
  for (const t of f.threads ?? [])
    for (const it of f.state?.items?.[t] ?? []) {
      byId.set(it.id, it);
      const sid = it.kind === 'hop' ? it.fromSessionId : it.kind === 'block' ? it.sessionId : null;
      const se = sid ? sessions[sid] : null;
      if (!se || se.archived) continue;
      const open = it.kind === 'hop' ? it.status === 'open' : ASKING.has(it.block?.type) && it.valid !== false && !it.answered && !it.closed;
      if (open && !needsYouNow(se))
        out.push({
          key: `needs-mismatch:${it.id}`,
          title: `@${se.handle} has an open ask, and its ring doesn’t say it needs you`,
          evidence: `${it.kind === 'hop' ? `Its request to wake @${it.to}` : `Its ${it.block.type} “${clip(it.block.title ?? it.block.prompt ?? '', 80)}”`} (${it.id}) is open, and @${se.handle} needs ${se.needs ? `you for ${se.needs.kind}, not this` : 'nothing'}.`,
        });
    }
  for (const se of Object.values(sessions)) {
    if (se.archived || !needsYouNow(se) || !se.needs.itemId) continue;
    const it = byId.get(se.needs.itemId);
    const settled = it?.kind === 'hop' ? it.status !== 'open' : it?.kind === 'block' && ASKING.has(it.block?.type) ? !!(it.answered || it.closed) : false;
    if (settled)
      out.push({
        key: `needs-mismatch:${se.id}:${it.id}`,
        title: `@${se.handle}’s ring says it needs you for an ask that’s settled`,
        evidence: `@${se.handle} needs you for ${se.needs.kind} ${it.id}, which is ${it.kind === 'hop' ? it.status : 'answered or withdrawn'}.`,
      });
  }
  return out;
}

export const ASK_CHECKS = [
  { id: 'ask-dropped', inputs: ['state', 'threads', 'events', 'transcripts'], issue: 439, requirements: ['AT-1'], run: droppedAsks },
  { id: 'needs-mismatch', inputs: ['state', 'threads'], issue: 508, requirements: ['AT-4'], run: needsMismatches },
];
