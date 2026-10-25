// What the conversation shows of agents’ wakes: each turn says what woke it (#135), and agents that wake each other
// add only their messages and the wake limit’s card, with no line per wake (#114), in the conversation itself (#372).

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PAIR_LIMIT } from '../server/side-threads.mjs';
import { collect, tierA } from '../server/telemetry-record.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

test('#135: a woken turn that opens with a block, or proposes a teammate, says what woke it, and keeps to its own turn', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({ block: { id: 'b1', type: 'code', version: 1, fallback: 'x', code: 'x' } });
    c.tools.propose_agent({ handle: 'tester', description: 'Runs the checks.' });
    c.text('Here is the diff.');
  });
  rt.agentWake(alpha.id, 'beta', 'Show me the diff.');
  await settle(rt);
  const [block, proposal] = ['block', 'proposal'].map((k) => store.items(t.id).find((x) => x.kind === k));
  assert.deepEqual(block.woke, { by: 'alpha' });
  assert.equal(proposal.turnId, block.turnId);
  assert.deepEqual(proposal.woke, { by: 'alpha' });
});

test('#135, #372: a turn another agent started says so on its replies, and the waker answers only when mentioned', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  rt.sendMessage(t.id, { text: '@alpha check the totals' });
  await settle(rt);
  // alpha wakes beta, beta answers in the conversation without naming alpha: no turn for alpha.
  adapter.next.push(async (c) => c.text('Revision 3 has one arithmetic gap.'));
  rt.agentWake(alpha.id, 'beta', 'Check revision 3.');
  await settle(rt);
  const said = (handle) => store.items(t.id).filter((x) => x.kind === 'agent' && x.handle === handle && x.text !== 'Check revision 3.');
  assert.equal(said('alpha')[0].woke, undefined, 'the turn you started says nothing more');
  assert.deepEqual(said('beta')[0].woke, { by: 'alpha' });
  assert.equal(said('alpha').length, 1, 'the answer started no turn for alpha');
  // An answer that @-mentions alpha wakes it, and alpha’s reply says beta woke it.
  adapter.next.push(async (c) => c.text('@alpha the gap is in row 4.'));
  adapter.next.push(async (c) => c.text('Sent the fix.'));
  // The person writing starts the pair’s count again, so this is the pair’s first wake, not its third (#372).
  rt.putThread({ ...store.state.threads[t.id], pairRuns: null });
  rt.agentWake(alpha.id, 'beta', 'Where is it?');
  await settle(rt);
  const next = said('alpha').at(-1);
  assert.equal(next.text, 'Sent the fix.');
  assert.deepEqual(next.woke, { by: 'beta' });
  assert.notEqual(next.turnId, said('alpha')[0].turnId);
});

test('#114, #372: two agents mentioning each other in turn stop after a hand-off and its answer, and the card asks you', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  // The issue’s conversation: the person asks @alpha for a fix, and alpha and beta wake each other by @-mentions. A
  // hand-off and its answer go; the pair’s third wake in a row waits for the person, who allows it (#372).
  const say = (text) => adapter.next.push(async (c) => c.text(text));
  say('On it. @beta can you check the fix?');
  say('@alpha one more gap in the totals.');
  say('Fixed. @beta check again, please.');
  say('All good now.');
  rt.sendMessage(t.id, { text: '@alpha fix the arithmetic gap' });
  await settle(rt);
  const card = store.items(t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  assert.ok(card, `the pair’s wake ${PAIR_LIMIT + 1} in a row waits for the person`);
  assert.deepEqual([card.from, card.to, card.pair, card.n], ['alpha', 'beta', PAIR_LIMIT, PAIR_LIMIT + 1]);
  rt.resolveHop(t.id, card.id, true);
  await settle(rt);
  const agents = store.items(t.id).filter((x) => x.kind === 'agent');
  assert.deepEqual(
    agents.map((x) => [x.handle, x.text]),
    [
      ['alpha', 'On it. @beta can you check the fix?'],
      ['beta', '@alpha one more gap in the totals.'],
      ['alpha', 'Fixed. @beta check again, please.'],
      ['beta', 'All good now.'],
    ],
    'each turn’s message once',
  );
  // The wake you allowed is the message of the turn that asked for it (#135), and your Allow started the count again.
  const allowed = agents.findLast((x) => x.handle === 'alpha');
  assert.deepEqual([allowed.sessionId, allowed.turnId, allowed.hop], [alpha.id, card.fromTurnId, 1]);
  // What the conversation shows besides the messages: the card with your answer to it, and no side thread.
  const lines = store.items(t.id).filter((x) => !['user', 'agent', 'block', 'shared'].includes(x.kind));
  assert.deepEqual(
    lines.map((x) => (x.kind === 'system' ? `system ${x.variant}` : x.kind)),
    ['hop', 'voice'],
  );
  assert.match(lines[1].text, /^Allowed: @alpha wakes @beta$/);
  assert.equal(Object.values(store.state.threads).filter((x) => x.kind === 'side').length, 0);
});

test('#114: with no line per wake, a telemetry report still counts the room’s wake chains, from each wake’s message', async () => {
  const { store, rt, t, alpha, beta } = setup();
  rt.agentWake(alpha.id, 'beta', 'Check the totals.');
  await settle(rt);
  rt.agentWake(beta.id, 'alpha', 'One more gap, please look again.');
  await settle(rt);
  const conv = store.state.threads[t.id];
  const { room } = tierA(rt, collect(rt, conv, join(tmpdir(), 'pb-no-recording'), { history: true }));
  assert.deepEqual([room.wakeChains, room.longestWakeChain], [1, 2]);
});

test('#135, #372: an agent that wakes a busy agent from two turns in a row sends two messages, each from its own turn', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  // beta is busy, so alpha’s two wakes, one by wake_agent and one by an @-mention, wait together in the conversation’s
  // queue until beta answers. Each keeps the turn it came from, so the second one gets its own sender line.
  const busy = held();
  adapter.next.push(busy.step);
  adapter.next.push(async (c) => {
    c.tools.wake_agent({ handle: 'beta', message: 'Check revision 3.' });
    c.text('Asked beta.');
  });
  adapter.next.push(async (c) => c.text('@beta and the totals, please.'));
  rt.sendMessage(t.id, { text: '@beta draft the notes' });
  for (const text of ['@alpha get revision 3 checked', '@alpha the totals too']) {
    rt.sendMessage(t.id, { text });
    for (let i = 0; i < 200 && rt.turns.has(alpha.id); i++) await sleep(5);
  }
  assert.ok(rt.turns.has(beta.id), 'beta is still busy');
  const queued = store.state.threads[t.id].queue.filter((q) => q.kind === 'wake');
  assert.deepEqual(
    queued.map((q) => q.text),
    ['Check revision 3.', '@beta and the totals, please.'],
  );
  busy.release();
  await settle(rt);
  // alpha’s two turns you started; the wake_agent message is from the first, and the mention is the second’s reply.
  const turns = [
    ...new Set(
      store
        .items(t.id)
        .filter((x) => x.kind === 'agent' && x.handle === 'alpha' && x.turnId)
        .map((x) => x.turnId),
    ),
  ];
  const [first, second] = queued.map((q) => store.item(t.id, q.itemId));
  assert.deepEqual([first.handle, second.handle], ['alpha', 'alpha']);
  assert.equal(turns.length, 2);
  assert.deepEqual([first.fromTurnId, second.turnId], turns);
  // Your message between them started the wake count again.
  assert.deepEqual([first.hop, second.hop], [1, 1]);
  assert.deepEqual(
    adapter.calls.filter((x) => x.sessionId === beta.id && x.message.kind === 'agent').map((x) => x.message.itemId),
    [first.id, second.id],
  );
});

test('#135: a turn a scheduled wake started says so on its replies', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(async (c) => c.text('Checked the totals again.'));
  const sc = rt.schedule(alpha.id, { inMs: 60000, note: 'Check the totals again.' });
  // Due now, as the timer fires it.
  rt.arm({ ...sc, at: Date.now() });
  await settle(rt);
  const reply = store.items(t.id).findLast((x) => x.kind === 'agent');
  assert.equal(reply.text, 'Checked the totals again.');
  assert.deepEqual(reply.woke, { scheduled: true });
});
