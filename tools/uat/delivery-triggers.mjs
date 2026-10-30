// The delivery scenario’s triggers (#508, tests/uat/e2e/scenarios/delivery.md, designs/508/testing-strategy.md):
// wakes held behind a card and released by its answer, a mention past the catch-up cap, an edit while a delivery
// waited, a turn that failed before any output, and a labeled resend. tools/uat/triggers.mjs adds them to TRIGGERS.
// Each reads only what `main` records (server/room-delivery.mjs), and names the requirements it serves.

import { CATCH_UP_ITEMS } from '../../server/catch-up.mjs';
import { addressed, cardHistory, headOf, holds, inputsOf, labeled, plain, RESEND_LABEL, settledAt, timeAfter, turnsOf } from '../../server/room-delivery.mjs';
import { clip, itemsOf } from './trigger-facts.mjs';

const POINTER = /which your last summary gave you in full/;
const pair = (a, b) => [a, b].sort().join('+');
const reached = (f, to, text, itemId, since) => (inputsOf(f, to) ?? []).some((x) => x.at >= since && holds(x, { itemId, text }));
const prompts = (f, to) => (inputsOf(f, to) ?? []).filter((x) => x.kind === 'prompt');

/**
 * Two pairs’ wakes waiting behind one open card at once: its own, and one held on it from another pair (#439). The card
 * records which wake of the chain raised it (n, server/wake-cards.mjs), one past the chain limit the run’s Postbox enforces
 * (`- chain-limit:`, tools/uat/scenario.mjs), so the evidence says at which wake it came.
 */
function heldBehindCard(f) {
  const out = [];
  for (const [id, c] of cardHistory(f.events)) {
    const own = pair(c.card.from, c.card.to);
    const other = [...c.held.values()].find((h) => pair(h.w.from, h.w.to) !== own);
    const raised = Number.isFinite(c.card.n) ? `, raised by wake ${c.card.n} of the chain,` : '';
    if (other)
      out.push({
        at: other.w.at ?? null,
        evidence: `Card ${id} (@${c.card.from} → @${c.card.to})${raised} held @${other.w.from}’s wake of @${other.w.to} too, while it waited.`,
      });
  }
  return out;
}

/** The person allowed a card, and its own wake and every one held on it reached their agents. */
function heldReleased(f) {
  const out = [];
  for (const [id, c] of cardHistory(f.events)) {
    if (!c.statuses.includes('allowed') || !c.held.size) continue;
    const since = settledAt(f, id) ?? c.card.at;
    const all = [{ to: c.card.to, text: c.card.text ?? c.card.reason, itemId: c.card.itemId ?? null }, ...[...c.held.values()].map((h) => h.w)];
    if (all.every((w) => reached(f, w.to, w.text, w.itemId ?? null, c.card.at)))
      out.push({ at: since, evidence: `Allowing card ${id} delivered its wake and the ${c.held.size} held on it, each to its agent.` });
  }
  return out;
}

/** A mention with CATCH_UP_ITEMS or more items after it before its agent’s next turn, which still reached it. */
function mentionPastCap(f) {
  const items = itemsOf(f);
  return addressed(f)
    .filter((a) => a.how === 'mention')
    .flatMap((a) => {
      const turn = turnsOf(f, a.to).find((t) => t.started > a.due);
      if (!turn) return [];
      const after = items.filter((it) => it.at > a.from && it.at < turn.started && it.handle !== a.to).length;
      if (after < CATCH_UP_ITEMS || !reached(f, a.to, a.text, a.itemId, a.from)) return [];
      return [{ at: turn.started, evidence: `@${a.to} got ${a.itemId}, with ${after} items after it, past the catch-up’s ${CATCH_UP_ITEMS}.` }];
    });
}

/** When the item added last before seq was: a patch carries no time, so it happened at or after this. */
const timeBefore = (events, seq) => {
  let at = null;
  for (const e of events ?? []) if (e.seq < seq && e.type === 'item.add' && Number.isFinite(e.data?.item?.at)) at = e.data.item.at;
  return at;
};

/**
 * An addressed message edited before its agent’s next turn, whose new text then reached it in one prompt only. The
 * new revision counts whole, every letter and digit of it, so a prompt with only the old one doesn’t hold it however
 * long a start the two share; and only from the edit on, since a prompt before the edit can’t have carried it.
 */
function editWhileWaiting(f) {
  const due = new Map(addressed(f).map((a) => [`${a.to}:${a.itemId}`, a]));
  const out = [];
  for (const e of f.events ?? []) {
    if (e.type !== 'item.patch' || typeof e.data?.patch?.text !== 'string') continue;
    const at = timeAfter(f.events, e.seq);
    const since = timeBefore(f.events, e.seq);
    for (const a of [...due.values()].filter((x) => x.itemId === e.data.id)) {
      const turn = turnsOf(f, a.to).find((t) => t.started > a.due);
      if (at === null || !turn || at > turn.started) continue;
      const all = headOf(e.data.patch.text) ? plain(e.data.patch.text) : null;
      const from = Math.max(a.from, since ?? a.from);
      const got = all ? prompts(f, a.to).filter((x) => x.at >= from && x.key.includes(all)) : [];
      if (got.length === 1) out.push({ at, evidence: `${a.itemId} was edited while it waited for @${a.to}, and its new text reached @${a.to} once.` });
    }
  }
  return out;
}

/** A turn with no output, and a message it should have carried that the agent’s next turn carried instead. */
function failBeforeOutput(f) {
  const out = [];
  for (const a of addressed(f)) {
    const turns = turnsOf(f, a.to);
    const failed = turns.find((t) => t.started > a.due && !t.running && !t.output);
    const i = failed ? turns.indexOf(failed) : -1;
    const next = turns[i + 1];
    if (!failed || !next) continue;
    const before = (inputsOf(f, a.to) ?? []).some((x) => x.at >= a.from - 1000 && x.at < failed.started && holds(x, a));
    const carried = prompts(f, a.to).some((x) => x.at >= failed.ended && x.at <= next.ended && holds(x, a));
    if (!before && carried)
      out.push({
        at: failed.started,
        evidence: `@${a.to}’s turn at ${new Date(failed.started).toISOString()} wrote nothing, and its next turn carried “${clip(a.text, 80)}”.`,
      });
  }
  return out;
}

/** A message given to an agent whole a second time, in a prompt that says it’s a repeat: a pointer to it isn’t one. */
function resendLabeled(f) {
  return addressed(f).flatMap((a) => {
    const all = headOf(a.text) ? plain(a.text) : null;
    const got = all ? prompts(f, a.to).filter((x) => x.key.includes(all)) : [];
    // A pointer to a message the last summary gave (#484) says so, and isn’t a resend.
    const again = got.slice(1).find((x) => labeled(x.text, a.text) && !POINTER.test(x.text));
    return again ? [{ at: again.at, evidence: `@${a.to} got “${clip(a.text, 80)}” again, labeled: “${clip(RESEND_LABEL.exec(again.text)?.[0], 40)}”.` }] : [];
  });
}

const reads = (f) => !!f.state && Array.isArray(f.events) && Array.isArray(f.transcripts);

export const DELIVERY_TRIGGERS = {
  'held-behind-card': {
    issue: 439,
    requirements: ['AT-1'],
    says: 'two deliveries were held, open at once, behind cards',
    recorded: (f) => Array.isArray(f.events),
    run: heldBehindCard,
  },
  'held-released': {
    issue: 439,
    requirements: ['AT-1', 'AT-2'],
    says: 'answering a card delivered every delivery it held',
    recorded: reads,
    run: heldReleased,
  },
  'mention-past-cap': {
    issue: 484,
    requirements: ['DL-1', 'DL-5'],
    says: 'an addressed item older than the catch-up cap reached its agent',
    recorded: (f) => reads(f) && Array.isArray(f.streams),
    run: mentionPastCap,
  },
  'edit-while-waiting': {
    issue: 484,
    requirements: ['DL-7', 'AT-6'],
    says: 'an item changed while its delivery waited, and arrived once',
    recorded: reads,
    run: editWhileWaiting,
  },
  'fail-before-output': {
    issue: 484,
    requirements: ['DL-3'],
    says: 'a turn failed with no output and its deliveries went back to waiting',
    recorded: (f) => reads(f) && Array.isArray(f.streams),
    run: failBeforeOutput,
  },
  'resend-labeled': { issue: 484, requirements: ['DL-2', 'DL-3'], says: 'a resend reached the agent with its label', recorded: reads, run: resendLabeled },
};
