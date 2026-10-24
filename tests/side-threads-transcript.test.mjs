// What the conversation shows of agents’ wakes: each turn says what woke it (#135), and a side thread’s wakes are one
// line, its link (#114).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup, sideOf } from './side-threads-fixture.mjs';

test('#135: a woken turn that opens with a block, or proposes a teammate, says what woke it, and keeps to its own turn', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({ block: { id: 'b1', type: 'code', version: 1, fallback: 'x', code: 'x' } });
    c.tools.propose_agent({ handle: 'tester', description: 'Runs the checks.' });
    c.text('Here is the diff.');
  });
  rt.agentWake(alpha.id, 'beta', 'Show me the diff.');
  await settle(rt);
  const side = sideOf(store, t);
  const [block, proposal] = ['block', 'proposal'].map((k) => store.items(side.id).find((x) => x.kind === k));
  assert.deepEqual(block.woke, { by: 'alpha' });
  assert.equal(proposal.turnId, block.turnId);
  assert.deepEqual(proposal.woke, { by: 'alpha' });
});

test('#135: a turn another agent started says so on its replies: a wake, or an answer and where it was given', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  rt.sendMessage(t.id, { text: '@alpha check the totals' });
  await settle(rt);
  // alpha wakes beta, beta answers in their side thread, and the answer starts alpha’s next turn in the conversation.
  adapter.next.push(async (c) => c.text('Revision 3 has one arithmetic gap.'));
  adapter.next.push(async (c) => c.text('Sent the fix.'));
  rt.agentWake(alpha.id, 'beta', 'Check revision 3.');
  await settle(rt);
  const side = sideOf(store, t);
  const said = (id, handle) => store.items(id).filter((x) => x.kind === 'agent' && x.handle === handle);
  assert.equal(said(t.id, 'alpha')[0].woke, undefined, 'the turn you started says nothing more');
  assert.deepEqual(said(side.id, 'beta')[0].woke, { by: 'alpha' });
  const next = said(t.id, 'alpha')[1];
  assert.equal(next.text, 'Sent the fix.');
  assert.deepEqual(next.woke, { by: 'beta', reply: true, in: side.id });
  assert.notEqual(next.turnId, said(t.id, 'alpha')[0].turnId);
});

test('#114: a fix request that sends agents back and forth shows one line for their side thread, plus the allow card', async () => {
  const { store, rt, adapter, t } = setup();
  // The issue’s conversation: the person asks @alpha for a fix, alpha and beta wake each other until the wake limit
  // asks the person, who allows one more. The steps run in the order the turns do.
  const say = (text) => adapter.next.push(async (c) => c.text(text));
  say('On it. @beta can you check the fix?');
  for (let i = 0; i < 3; i++) {
    say('One more gap in the totals.');
    say('Fixed. @beta check again, please.');
  }
  say('All good now.');
  say('Done.');
  rt.sendMessage(t.id, { text: '@alpha fix the arithmetic gap' });
  await settle(rt);
  const card = store.items(t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  assert.ok(card, 'the fourth wake waits for the person');
  rt.resolveHop(t.id, card.id, true);
  await settle(rt);
  assert.equal(store.items(sideOf(store, t).id).filter((x) => x.kind === 'agent').length, 8, 'four wakes, each answered');
  // What the conversation shows besides the messages: the side thread’s line, updated in place, and the card with
  // your answer to it.
  const lines = store.items(t.id).filter((x) => !['user', 'agent', 'block', 'shared'].includes(x.kind));
  assert.deepEqual(
    lines.map((x) => (x.kind === 'system' ? `system ${x.variant}` : x.kind)),
    ['sidelink', 'hop', 'voice'],
  );
  assert.equal(lines[0].count, 8);
  assert.match(lines[2].text, /^Allowed: @alpha wakes @beta$/);
});
