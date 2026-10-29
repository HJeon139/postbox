// #492: two agents waking each other in turn stopped after a hand-off and its answer (the pair limit, #372), and any
// agent wake past 10 in a row without you waited too (the chain limit, #108, #320). The pair limit stopped ordinary
// work eight times in one working room against two loops it caught (E2’s replay, posted on #492), and the person
// decided both limits were arbitrary restrictions. So no wake waits on a card for a limit: the room shows how many have
// chained since your last message, with a hint to Stop once it reaches CHAIN_HINT (tests/browser/wake-chain.spec.mjs).
// A card still asks to add an agent the conversation doesn’t have (#228).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAIN_HINT } from '../shared/limits.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** n wakes between alpha and beta in turn, each checked to go at once. */
async function trade(f, n) {
  for (let i = 0; i < n; i++) {
    const [from, to] = i % 2 ? [f.beta, 'alpha'] : [f.alpha, 'beta'];
    const r = f.rt.agentWake(from.id, to, `hand-off ${i + 1}`);
    assert.equal(r.ok, true, `wake ${i + 1}: ${r.message}`);
    await settle(f.rt);
  }
}

test('#492 two agents trading hand-offs past the old pair limit get no card: each wake goes', async () => {
  const f = setup();
  await trade(f, 6);
  assert.deepEqual(
    f.store.items(f.t.id).filter((x) => x.kind === 'hop'),
    [],
  );
  assert.equal(f.store.state.threads[f.t.id].hops, 6, 'the chain count runs on');
});

test('#492 a long chain past the old chain limit raises no card either, and the count runs on', async () => {
  const f = setup();
  await trade(f, 25);
  assert.deepEqual(
    f.store.items(f.t.id).filter((x) => x.kind === 'hop'),
    [],
  );
  assert.equal(f.store.state.threads[f.t.id].hops, 25);
  assert.equal(f.store.state.sessions[f.alpha.id].needs ?? null, null, 'nothing waits on you');
});

test('#492 a card still asks to add an agent the conversation doesn’t have', async () => {
  const f = setup();
  const gamma = f.store.state.personas[f.c.id] ?? Object.values(f.store.state.personas).find((p) => p.handle === 'gamma');
  assert.ok(gamma, 'the fixture has a persona outside the conversation');
  const r = f.rt.agentWake(f.alpha.id, 'gamma', 'join us');
  assert.equal(r.waiting, true, r.message);
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop');
  assert.deepEqual([card?.join, card?.to, card?.status], [true, 'gamma', 'open']);
});

test('#492 the Stop hint comes after a few wakes, and wake_agent names no limit', () => {
  assert.ok(CHAIN_HINT > 2, `CHAIN_HINT is ${CHAIN_HINT}`);
  const d = TOOL_DEFS.find((x) => x.name === 'wake_agent').description;
  assert.doesNotMatch(d, /between the same two agents|in a row|must allow the next/);
  assert.match(d, /isn’t in this conversation asks the person to add it/);
});
