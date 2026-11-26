// #492: two agents waking each other in turn stopped after a hand-off and its answer (PAIR_LIMIT, #372), which stopped
// ordinary hand-offs 8 times in one working room, against 2 for a limit of 6 (E2’s replay, posted on #492). The person
// decided there’s no pair limit: the room shows how many wakes have chained since your last message, with a hint to
// Stop once it reaches CHAIN_HINT. The chain limit stays only as a backstop, at 50 rather than 10, until a supervisor
// agent watches the room (#538); since #1035 it’s 1,000 by default, and each room can set its own.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guideText, roomText } from '../server/adapters/guide.mjs';
import { CHAIN_HINT, DEFAULT_HOP_LIMIT } from '../shared/limits.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/**
 * n wakes between alpha and beta in turn, all while the chain runs: the first starts a turn, and the rest go to an agent
 * already busy with one, so nothing ends the chain until they’ve all been answered (settle).
 */
function chain(f, n, label = 'hand-off') {
  for (let i = 0; i < n; i++) {
    const [from, to] = i % 2 ? [f.beta, 'alpha'] : [f.alpha, 'beta'];
    const r = f.rt.agentWake(from.id, to, `${label} ${i + 1}`);
    assert.equal(r.ok, true, `${label} ${i + 1}: ${r.message}`);
  }
}

test('#492 two agents trading hand-offs past the old pair limit get no card: each wake goes', async () => {
  const f = setup();
  chain(f, 6);
  assert.equal(f.store.state.threads[f.t.id].hops, 6, 'the chain count runs on');
  await settle(f.rt);
  assert.deepEqual(
    f.store.items(f.t.id).filter((x) => x.kind === 'hop'),
    [],
  );
});

test('#492 a chain past the old limit of 10 raises no card: the backstop is 1,000 since #1035', async () => {
  const f = setup();
  chain(f, 25);
  await settle(f.rt);
  assert.deepEqual(
    f.store.items(f.t.id).filter((x) => x.kind === 'hop'),
    [],
  );
  assert.equal(DEFAULT_HOP_LIMIT, 1000);
});

test('#492 the Stop hint comes after fewer wakes than the chain limit, and the guide names no pair limit', () => {
  // Against the default only: a room may set its own limit below the hint’s count (#1035).
  assert.ok(CHAIN_HINT > 2 && CHAIN_HINT < DEFAULT_HOP_LIMIT, `CHAIN_HINT is ${CHAIN_HINT}`);
  for (const text of [guideText(), roomText([{ handle: 'beta', role: 'Reviews' }])]) assert.doesNotMatch(text, /between the same two agents/);
});

test('#492 a chain that ends starts the count again: an ack that wakes no one ends it, so separate chains never add up to the backstop', async () => {
  const f = setup();
  // Three chains of 20 wakes, each ending with an answer that wakes no one, as an agent acking does: 60 in all.
  for (let n = 1; n <= 3; n++) {
    chain(f, 20, `chain ${n}, hand-off`);
    assert.equal(f.store.state.threads[f.t.id].hops, 20, `chain ${n} counts while it runs`);
    for (let i = 0; i < 40 && f.store.state.threads[f.t.id].hops; i++) await settle(f.rt);
    assert.equal(f.store.state.threads[f.t.id].hops, 0, `chain ${n} ended, so its count is gone`);
  }
  assert.deepEqual(
    f.store.items(f.t.id).filter((x) => x.kind === 'hop'),
    [],
  );
});

test('#492 a chain still going keeps its count: an answer that wakes the next agent isn’t the end', async () => {
  const f = setup();
  // beta answers alpha's wake by @-mentioning alpha; alpha's answer, naming no one, goes back to beta (#1518), and beta
  // ends the chain with a reaction (#1523).
  f.adapter.next.push(async (c) => c.text('@alpha the totals are off by one.'));
  f.adapter.next.push(async (c) => c.text('Thanks, fixed.'));
  let most = 0;
  f.store.subscribe(() => {
    most = Math.max(most, f.store.state.threads[f.t.id]?.hops ?? 0);
  });
  f.rt.agentWake(f.alpha.id, 'beta', 'Check the totals.');
  for (let i = 0; i < 20 && f.adapter.calls.length < 3; i++) await settle(f.rt);
  await settle(f.rt);
  assert.equal(most, 3, 'three wakes chained while it ran');
  assert.equal(f.store.state.threads[f.t.id].hops, 0, 'and none once it ended');
});
