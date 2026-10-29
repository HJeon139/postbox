// The checks of what waits on the person (#508, designs/508/testing-strategy.md, “Triggers, checks and seeds to
// add”): a wake the limit held that went away unanswered and undelivered (#439), and a needs-you ring that disagrees
// with the asks open in the state. Each reads only what `main` records, and names the requirements it serves beside
// its issue. Part of server/room-checks.mjs’s CHECKS, kept apart for size.

import { ASKING } from '../shared/catalog.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import { clip } from '../shared/text.mjs';
import { cardHistory, heldKey, holds, inputsOf, notCheckableAll, recorded, turnsOf, unreadable } from './room-delivery.mjs';

const ANSWERED = new Set(['allowed', 'declined']);
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
