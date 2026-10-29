// The checks of what waits on the person (#508, designs/508/testing-strategy.md, “Triggers, checks and seeds to
// add”): a wake the limit held that went away unanswered and undelivered (#439), and a needs-you ring that disagrees
// with the asks open in the state. Each reads only what `main` records, and names the requirements it serves beside
// its issue. Part of server/room-checks.mjs’s CHECKS, kept apart for size.

import { ASKING } from '../shared/catalog.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import { clip } from '../shared/text.mjs';
import { headOf, holds, inputsOf, notCheckableAll } from './room-delivery.mjs';

const ANSWERED = new Set(['allowed', 'declined']);
const heldKey = (w) => `${w.fromSessionId ?? w.from}:${w.to}:${headOf(w.text) ?? w.text}`;

/**
 * Each card’s history from the events: the card as added, the statuses it went through, and every wake held on it,
 * with whether a later patch took it off while the card was still open.
 * @param {any[]} events
 */
export function cardHistory(events) {
  /** @type {Map<string, { card: any, statuses: string[], held: Map<string, { w: any, removedOpen: boolean }> }>} */
  const cards = new Map();
  for (const e of events ?? []) {
    if (e.type === 'item.add' && e.data?.item?.kind === 'hop')
      cards.set(e.data.item.id, { card: e.data.item, statuses: [e.data.item.status], held: new Map() });
    const c = e.type === 'item.patch' ? cards.get(e.data?.id) : null;
    if (!c) continue;
    const p = e.data.patch ?? {};
    if (typeof p.status === 'string') c.statuses.push(p.status);
    if (!Array.isArray(p.held)) continue;
    const now = new Set(p.held.map(heldKey));
    for (const w of p.held) if (!c.held.has(heldKey(w))) c.held.set(heldKey(w), { w, removedOpen: false });
    const open = c.statuses.at(-1) === 'open';
    for (const [k, h] of c.held) if (!now.has(k) && open) h.removedOpen = true;
  }
  return cards;
}

/** ask-dropped: a held wake, or a card, that left the state with no answer from the person and never reached its target. */
function droppedAsks(f) {
  const live = new Set((f.threads ?? []).flatMap((t) => (f.state?.items?.[t] ?? []).map((it) => it.id)));
  const unread = new Map();
  const reached = (w, since) => {
    const got = inputsOf(f, w.to);
    // No transcript of the target: whether it got the wake can’t be read, so the wake isn’t called dropped, and the
    // check says it didn’t check it.
    if (!got) unread.set(w.to, (unread.get(w.to) ?? 0) + 1);
    return !got || got.some((x) => x.at >= since && holds(x, { itemId: w.itemId ?? null, text: w.text ?? '' }));
  };
  const out = [];
  for (const [id, c] of cardHistory(f.events)) {
    const answered = c.statuses.some((s) => ANSWERED.has(s));
    const own = { to: c.card.to, itemId: c.card.itemId, text: c.card.text ?? c.card.reason, at: c.card.at };
    if (!answered && !live.has(id) && !reached(own, own.at ?? 0))
      out.push({
        key: `ask-dropped:${id}`,
        title: `@${c.card.from}’s request to wake @${c.card.to} left the room unanswered`,
        evidence: `Card ${id} (“${clip(own.text, 100)}”) went from the state without the person answering it, and @${c.card.to} never got its message.`,
      });
    for (const [k, h] of c.held) {
      // Settled with its card: Allow or Don’t allow is the person’s answer; retiring sends it on, so it must arrive.
      const cardGone = !answered && !live.has(id);
      const retired = !answered && c.statuses.includes('retired');
      if (!(h.removedOpen || cardGone || retired) || reached(h.w, h.w.at ?? 0)) continue;
      out.push({
        key: `ask-dropped:${id}:${k}`,
        title: `@${h.w.from}’s wake of @${h.w.to}, held on a card, went without an answer and never arrived`,
        evidence: `Held on ${id} (“${clip(h.w.text, 100)}”), it ${h.removedOpen ? 'was taken off the card while it still waited' : retired ? 'went on when the card was retired' : 'went with its card'}, and @${h.w.to} never got it.`,
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
