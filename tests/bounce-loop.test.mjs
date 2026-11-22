// #1553: two agents done with their work acknowledged each other without end, each acknowledgment a reply that went
// back on its own (#1518, #1523), until the person pressed Stop: hop 262 in one UAT run, hop 333 in another. The turns
// are recorded in tests/fixtures/uat/bounce-loops-2026-11-21.json, cut from the event logs of
// uat-runs/2026-11-21T06-52-24-harnessmix and uat-runs/2026-11-21T06-52-53-scifact. These aren’t replays: Postbox can’t
// replay a UAT run’s turns (tools/uat-run.mjs --recheck recomputes its checks only). Each agent here plays its own
// recorded replies, in order, as the run woke it, and reacts to the message that woke it when it did in the run. The
// room’s chain limit, set low, is the backstop that bounds each test, as it bounds a room. The fixture keeps each run’s
// first 40 turns, each reply cut to 200 characters; its `mentions` were parsed from the full text, so a few early turns
// (scifact 1, harnessmix 1, 2 and 5) name an agent the cut text no longer shows. The tests play `text` and
// `reactedToWaker` only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { endedByReaction } from '../server/reply-back.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const RUNS = JSON.parse(readFileSync(new URL('fixtures/uat/bounce-loops-2026-11-21.json', import.meta.url), 'utf8')).runs;
const DIR = tempDir('pb-bounce-loop-');
/** The room’s chain limit for these tests: past it a wake waits on a card, which ends the run. */
const LIMIT = 40;

/** One agent’s recorded replies from a turn on: its words, and whether it reacted to the message that woke it. */
const playsFrom = (run, handle, from) =>
  RUNS[run].turns.filter((t) => t.handle === handle && t.turn >= from).map((t) => ({ text: t.text, react: t.reactedToWaker }));

/** An adapter that plays each agent’s replies in order, repeating its last once they run out, as the runs did. */
class Recorded {
  name = 'mock';
  calls = [];
  constructor(plays) {
    this.plays = plays;
  }
  async folderFor() {
    return null;
  }
  fork() {}
  async deliver(session, message, ctx) {
    const se = this.rt.s.sessions[session.id];
    const mine = this.plays[se.handle];
    const play = mine.length > 1 ? mine.shift() : mine[0];
    this.calls.push({ handle: se.handle, text: message.text ?? '' });
    const waker = this.rt.store
      .items(se.threadId)
      .filter((i) => i.kind === 'agent' && i.handle !== se.handle && i.text?.trim())
      .at(-1);
    if (waker && play.react) ctx.tools.react({ id: waker.id, emoji: '✅' });
    // The person’s reaction is theirs: it ends no agent’s exchange.
    if (waker && play.personReacts) this.rt.threads.toggleReaction(se.threadId, waker.id, '👍', null);
    if (play.text) ctx.text(play.text);
    if (play.fail) throw new Error('Claude Code exited with code 1.');
    // Still at work, so what comes back meanwhile waits, and the next turn takes it together.
    if (play.busyMs) await new Promise((r) => setTimeout(r, play.busyMs));
  }
}

function room(plays) {
  const store = new Store(null);
  const adapter = new Recorded(plays);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  adapter.rt = rt;
  store.emit('project', { id: 'p1', name: 'P', folder: DIR });
  const ids = Object.keys(plays).map((handle) => rt.createPersona({ handle }).id);
  const t = rt.createThread({ projectId: 'p1', title: 'UAT', personaIds: ids });
  rt.threads.patch(t.id, { chainLimit: LIMIT });
  return { store, rt, adapter, t };
}

const settle = async (rt) => {
  for (let i = 0; i < 2000 && rt.turns.size; i++) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 10));
};
const heldOnCard = (store, t) => store.items(t.id).some((i) => i.kind === 'hop' && i.status === 'open');

test('#1553: Codex with Kiro, acknowledging with a reaction and words, stops once a reaction ends the exchange', async () => {
  // harnessmix from turn 11: alpha (Kiro) reports to critic (Codex), and from there both react ✅ and write words too.
  const { store, rt, adapter, t } = room({ alpha: playsFrom('harnessmix', 'alpha', 11), critic: playsFrom('harnessmix', 'critic', 12) });
  rt.sendMessage(t.id, { text: '@alpha report to critic when the tests pass' });
  await settle(rt);
  assert.ok(!heldOnCard(store, t), 'the chain ended before the room’s limit');
  assert.ok(adapter.calls.length < 12, `${adapter.calls.length} turns: ${adapter.calls.map((c) => c.handle).join(' ')}`);
  // It ended on a reaction: the last reply posted, and went back to no one.
  const last = store
    .items(t.id)
    .filter((i) => i.kind === 'agent' && i.text?.trim())
    .at(-1);
  assert.equal(last.wentBack, undefined, JSON.stringify(last));
});

test('#1553: two Claude agents that write “I’m not replying” instead of reacting still run to the chain limit', async () => {
  // scifact from turn 7, where critic @-mentions researcher, then from turn 8 on neither agent reacts, and each says it isn’t replying, in a reply. A reaction can’t end what
  // no one reacts in; the room’s chain limit stops it, and the first line now tells such a turn it may end with nothing.
  const { store, rt, adapter, t } = room({ researcher: playsFrom('scifact', 'researcher', 8), critic: playsFrom('scifact', 'critic', 7) });
  rt.sendMessage(t.id, { text: '@critic close the table exchange with researcher' });
  await settle(rt);
  assert.ok(heldOnCard(store, t), 'the chain limit is the backstop');
  const answering = adapter.calls.filter((c) => c.handle === 'critic').at(-1);
  assert.match(
    answering.text,
    /If the exchange is done, react to the reply: then what you write doesn’t go back, so @-mention an agent that must act next\. If you do nothing else, you can also end without writing anything\./,
  );
});

test('#1553: control: a review that goes back by itself still reaches the agent that asked for it', async () => {
  // harnessmix turns 8–9: alpha asks critic for a review by @-mention; critic’s review names no one and goes back.
  const { store, rt, adapter, t } = room({ alpha: playsFrom('harnessmix', 'alpha', 8), critic: playsFrom('harnessmix', 'critic', 9) });
  rt.sendMessage(t.id, { text: '@alpha run the tests and ask critic to review' });
  await settle(rt);
  const review = store.items(t.id).find((i) => i.kind === 'agent' && i.text?.startsWith('I reviewed `wordcount.py`'));
  assert.deepEqual(review.wentBack, ['alpha'], 'the review went back');
  assert.ok(
    adapter.calls.some((c) => c.handle === 'alpha' && c.text.includes('I reviewed `wordcount.py`')),
    'alpha was given it',
  );
});

test('#1553: a 👍 on a direct request doesn’t stop the report that follows from going back', async () => {
  // Only a reply that came back counts: a reaction to a request may come before the work it asks for.
  const plays = {
    alpha: [
      { text: '@critic please review wordcount.py.', react: false },
      { text: '', react: false },
    ],
    critic: [{ text: 'Reviewed: whitespace-only input prints 0, and a missing file exits 1.', react: true }],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask critic for a review' });
  await settle(rt);
  const report = store.items(t.id).find((i) => i.kind === 'agent' && i.text?.startsWith('Reviewed:'));
  assert.deepEqual(report.wentBack, ['alpha']);
  // And a turn a request woke isn’t told a reaction ends it.
  assert.doesNotMatch(adapter.calls.find((c) => c.handle === 'critic').text, /If the exchange is done/);
});

test('#1553: the person’s reaction to a reply that came back doesn’t end the agents’ exchange', async () => {
  const plays = {
    alpha: [
      { text: '@critic please review wordcount.py.', react: false },
      { text: 'One more: does it handle tabs?', personReacts: true },
    ],
    critic: [
      { text: 'Reviewed: whitespace-only input prints 0.', react: false },
      { text: '', react: false },
    ],
  };
  const { store, rt, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask critic for a review' });
  await settle(rt);
  const question = store.items(t.id).find((i) => i.kind === 'agent' && i.text?.startsWith('One more'));
  assert.deepEqual(question.wentBack, ['critic']);
});

test('#1553: a reaction ends the exchange only with the agent whose reply it was', async () => {
  // critic asks two agents, then works on the person’s next message while both answer, so one turn takes both replies.
  // It reacts to beta’s, the last, and writes a line: that goes back to alpha, whose reply it didn’t react to.
  const plays = {
    critic: [{ text: '@alpha @beta check the counts.' }, { text: 'Working on the table.', busyMs: 300 }, { text: 'Thanks, noted.', react: true }],
    alpha: [{ text: 'alpha: the counts hold.' }],
    beta: [{ text: 'beta: the counts hold.' }],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@critic ask alpha and beta to check the counts' });
  rt.sendMessage(t.id, { text: '@critic then fix the table' });
  await settle(rt);
  const third = adapter.calls.filter((c) => c.handle === 'critic')[2];
  assert.ok(third?.text.includes('alpha: the counts hold.') && third.text.includes('beta: the counts hold.'), JSON.stringify(adapter.calls));
  const noted = store.items(t.id).find((i) => i.kind === 'agent' && i.text === 'Thanks, noted.');
  assert.deepEqual(noted.wentBack, ['alpha']);
});

test('#1553: a request from the same agent in the same batch still gets its answer back', () => {
  // Pre-review of the first version: one reacted reply from alpha hid the answer to alpha’s direct request beside it.
  const items = { r1: { reactions: [{ emoji: '✅', by: 'se_critic', at: 10 }] }, q1: { reactions: [] } };
  const rt = { store: { pending: { item: (_t, id) => items[id] } } };
  const se = { id: 'se_critic' };
  const back = { source: 'mention', from: 'alpha', bounce: true, threadId: 't', itemId: 'r1' };
  const asked = { source: 'mention', from: 'alpha', threadId: 't', itemId: 'q1' };
  const note = { source: 'notice', text: 'Postbox’s note' };
  assert.equal(endedByReaction(rt, se, [back, note], 'alpha', 0), true, 'a reacted reply alone ends it');
  assert.equal(endedByReaction(rt, se, [back, asked], 'alpha', 0), false, 'with a request beside it, it goes back');
  assert.equal(endedByReaction(rt, se, [{ ...back, itemId: 'q1' }], 'alpha', 0), false, 'a reply not reacted to goes back');
  assert.equal(endedByReaction(rt, se, [back], 'beta', 0), false, 'nothing from beta, so nothing ends with beta');
  assert.equal(endedByReaction(rt, se, [back], 'alpha', 20), false, 'a reaction from before this turn began doesn’t count');
});

test('#1553: a reaction from a failed attempt doesn’t stop the Retry’s answer going back', async () => {
  // Critic’s review of PR #1557: alpha reacted to critic’s reply, then its turn failed; the person’s Retry answered with
  // a question, which must reach critic. Only a reaction made in this attempt ends the exchange.
  const plays = {
    alpha: [{ text: '@critic please review wordcount.py.' }, { text: '', react: true, fail: true }, { text: 'One more: does it handle tabs?' }],
    critic: [{ text: 'Reviewed: whitespace-only input prints 0.' }, { text: '' }],
  };
  const { store, rt, adapter, t } = room(plays);
  rt.sendMessage(t.id, { text: '@alpha ask critic for a review' });
  await settle(rt);
  const failed = store.items(t.id).find((i) => i.kind === 'agent' && i.handle === 'alpha' && i.status === 'failed');
  assert.ok(failed, 'alpha’s turn failed after it reacted');
  await rt.retry(t.id, failed.id);
  await settle(rt);
  const question = store.items(t.id).find((i) => i.kind === 'agent' && i.text?.startsWith('One more'));
  assert.deepEqual(question?.wentBack, ['critic']);
  // The Retry still owes a reply (#1543), so its first line offers the reaction only (integrator’s review of PR #1557).
  const retried = adapter.calls.filter((c) => c.handle === 'alpha').at(-1).text;
  assert.match(retried, /If the exchange is done, react to the reply/);
  assert.doesNotMatch(retried, /end without writing anything/);
});
