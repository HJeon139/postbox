// What the conversation shows of agents’ wakes: each turn says what woke it (#135), and agents that wake each other
// add only their messages and the wake limit’s card, with no line per wake (#114), in the conversation itself (#372).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
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

test('#135, #1518: a turn another agent started says so on its replies, and an answer that names no one goes back to the waker', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  rt.sendMessage(t.id, { text: '@alpha check the totals' });
  await settle(rt);
  // alpha wakes beta, beta answers in the conversation naming no one: the answer goes back to alpha (#1518, which
  // reverses #372 here), and alpha ends the exchange with a reaction (#1523).
  adapter.next.push(async (c) => c.text('Revision 3 has one arithmetic gap.'));
  rt.agentWake(alpha.id, 'beta', 'Check revision 3.');
  await settle(rt);
  const said = (handle) => store.items(t.id).filter((x) => x.kind === 'agent' && x.handle === handle && x.text !== 'Check revision 3.');
  assert.equal(said('alpha')[0].woke, undefined, 'the turn you started says nothing more');
  assert.deepEqual(said('beta')[0].woke, { by: 'alpha' });
  assert.equal(adapter.calls.filter((c) => c.handle === 'alpha').length, 2, 'the answer started one turn for alpha');
  assert.deepEqual(
    said('beta')[0].reactions.map((r) => `${r.handle} ${r.emoji}`),
    ['alpha 👍'],
    'which reacted',
  );
  assert.equal(said('alpha').length, 1, 'and posted nothing');
  assert.equal(said('beta').length, 1, 'so nothing came after it');
  // An answer that @-mentions alpha wakes it, and alpha’s reply says beta woke it.
  adapter.next.push(async (c) => c.text('@alpha the gap is in row 4.'));
  adapter.next.push(async (c) => c.text('Sent the fix.'));
  rt.agentWake(alpha.id, 'beta', 'Where is it?');
  await settle(rt);
  const next = said('alpha').at(-1);
  assert.equal(next.text, 'Sent the fix.');
  assert.deepEqual(next.woke, { by: 'beta' });
  assert.notEqual(next.turnId, said('alpha')[0].turnId);
});

test('#114, #492: two agents mentioning each other in turn go on without a card, and the room counts the chain', async () => {
  const { store, rt, adapter, t } = setup();
  // The issue’s conversation: the person asks @alpha for a fix, and alpha and beta wake each other by @-mentions. Until
  // #492 the pair’s third wake in a row waited for the person; now each goes, and the chain count says how many.
  const say = (text) => adapter.next.push(async (c) => c.text(text));
  say('On it. @beta can you check the fix?');
  say('@alpha one more gap in the totals.');
  say('Fixed. @beta check again, please.');
  say('All good now.');
  say('Thanks.');
  rt.sendMessage(t.id, { text: '@alpha fix the arithmetic gap' });
  for (let i = 0; i < 20 && store.items(t.id).filter((x) => x.kind === 'agent').length < 5; i++) await settle(rt);
  await settle(rt);
  const agents = store.items(t.id).filter((x) => x.kind === 'agent');
  assert.deepEqual(
    agents.map((x) => [x.handle, x.text]),
    [
      ['alpha', 'On it. @beta can you check the fix?'],
      ['beta', '@alpha one more gap in the totals.'],
      ['alpha', 'Fixed. @beta check again, please.'],
      ['beta', 'All good now.'],
      ['alpha', 'Thanks.'],
    ],
    'each turn’s message once',
  );
  // Nothing besides the messages: no card, no side thread.
  assert.deepEqual(
    store.items(t.id).filter((x) => !['user', 'agent', 'block', 'shared'].includes(x.kind)),
    [],
  );
  // beta’s “All good now.” named no one, so it went back to alpha, whose mention asked for it (#1518).
  assert.deepEqual(
    agents.filter((x) => x.hop).map((x) => x.hop),
    [1, 2, 3, 4],
    'four agent wakes in the chain',
  );
  // alpha’s thanks, from a turn that reply woke and that only wrote, ended the exchange: it woke no one (#1591).
  assert.deepEqual(
    agents.slice(3).map((x) => x.wentBack),
    [['alpha'], undefined],
  );
  assert.equal(store.state.threads[t.id].hops, 0, 'so its count starts again');
  assert.equal(Object.values(store.state.threads).filter((x) => x.kind === 'side').length, 0);
});

test('#135: both wakes keep their transcript provenance, and both are delivered: the newer doesn’t replace the older', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  // beta is busy, so alpha’s two wakes, an @-mention in each of two turns, wait together in beta’s inbox until
  // beta answers. Each keeps the turn it came from, so the second one gets its own sender line. Nothing is replaced
  // (designs/rooms-at-scale.md, “Delivery”), where #374 delivered only the newer.
  const busy = held();
  adapter.next.push(busy.step);
  adapter.next.push(async (c) => c.text('@beta check revision 3.'));
  adapter.next.push(async (c) => c.text('@beta and the totals, please.'));
  rt.sendMessage(t.id, { text: '@beta draft the notes' });
  for (const text of ['@alpha get revision 3 checked', '@alpha the totals too']) {
    rt.sendMessage(t.id, { text });
    for (let i = 0; i < 200 && rt.turns.has(alpha.id); i++) await sleep(5);
  }
  assert.ok(rt.turns.has(beta.id), 'beta is still busy');
  const queued = arrange.waitingEntries(rt, beta.id);
  assert.deepEqual(
    queued.map((e) => store.items(t.id).find((x) => x.id === e.itemId)?.text),
    ['@beta check revision 3.', '@beta and the totals, please.'],
  );
  busy.release();
  await settle(rt);
  // alpha’s two turns you started; each mention is that turn’s reply. Beta’s answer going back to alpha starts a
  // third, which says beta woke it (#1518).
  const turns = [
    ...new Set(
      store
        .items(t.id)
        .filter((x) => x.kind === 'agent' && x.handle === 'alpha' && x.turnId && !x.woke)
        .map((x) => x.turnId),
    ),
  ];
  const [first, second] = queued.map((q) => store.item(t.id, q.itemId));
  assert.deepEqual([first.handle, second.handle], ['alpha', 'alpha']);
  assert.equal(turns.length, 2);
  assert.deepEqual([first.turnId, second.turnId], turns);
  // Your message between them started the wake count again.
  assert.deepEqual([first.hop, second.hop], [1, 1]);
  assert.deepEqual(
    adapter.calls.filter((x) => x.sessionId === beta.id && x.parts[0].kind === 'agent').flatMap((x) => x.parts.map((m) => m.itemId)),
    [first.id, second.id],
  );
});

test('#135: a turn a scheduled wake started says so on its replies', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(async (c) => c.text('Checked the totals again.'));
  const sc = rt.schedule(alpha.id, { inMs: 60000, note: 'Check the totals again.' });
  // Due now, as the timer fires it.
  // The stored schedule is what arming reads (#466), so it’s made due there.
  store.emit('schedule', { ...sc, at: Date.now() });
  rt.arm(sc);
  await settle(rt);
  const reply = store.items(t.id).findLast((x) => x.kind === 'agent');
  assert.equal(reply.text, 'Checked the totals again.');
  assert.deepEqual(reply.woke, { scheduled: true });
});
