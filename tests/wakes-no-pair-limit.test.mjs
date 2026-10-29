// #492: two agents waking each other in turn stopped after a hand-off and its answer (PAIR_LIMIT, #372), and the card
// it raised stopped ordinary work, eight times in one working room against two loops it caught (E2’s replay, posted on
// #492). The person decided there’s no pair limit: the room shows how many wakes have chained since your last message,
// with a hint to Stop once it passes CHAIN_HINT. The chain limit (HOP_LIMIT) stays as it was for now.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAIN_HINT, HOP_LIMIT } from '../shared/limits.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

test('#492 two agents trading hand-offs past the old pair limit get no card: each wake goes', async () => {
  const f = setup();
  for (let i = 0; i < 6; i++) {
    const [from, to] = i % 2 ? [f.beta, 'alpha'] : [f.alpha, 'beta'];
    const r = f.rt.agentWake(from.id, to, `hand-off ${i + 1}`);
    assert.equal(r.ok, true, `wake ${i + 1}: ${r.message}`);
    await settle(f.rt);
  }
  assert.deepEqual(
    f.store.items(f.t.id).filter((x) => x.kind === 'hop'),
    [],
  );
  assert.equal(f.store.state.threads[f.t.id].hops, 6, 'the chain count runs on');
});

test('#492 the chain limit still holds: past HOP_LIMIT wakes in a row, the next waits for you', async () => {
  const f = setup();
  for (let i = 0; i < HOP_LIMIT; i++) {
    const [from, to] = i % 2 ? [f.beta, 'alpha'] : [f.alpha, 'beta'];
    assert.equal(f.rt.agentWake(from.id, to, `hand-off ${i + 1}`).ok, true);
    await settle(f.rt);
  }
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'one more').waiting, true);
});

test('#492 the Stop hint comes after fewer wakes than the chain limit, and wake_agent names no pair limit', () => {
  assert.ok(CHAIN_HINT > 2 && CHAIN_HINT < HOP_LIMIT, `CHAIN_HINT is ${CHAIN_HINT}`);
  assert.doesNotMatch(TOOL_DEFS.find((d) => d.name === 'wake_agent').description, /between the same two agents/);
});
