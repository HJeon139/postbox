// #1035: the wake chain limit is 1,000 by default, and each room (conversation) can set its own, saved on the
// conversation beside the count it caps (hops), so a topic thread reads its conversation’s. The check, the card and
// what agents are told all read the room’s number. tests/room-chain-limit-routes.test.mjs holds who may set it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateThread } from '../server/thread-write.mjs';
import { DEFAULT_HOP_LIMIT, HOP_LIMIT } from '../shared/limits.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** n wakes between alpha and beta in turn, all while the chain runs, as tests/wakes-no-pair-limit.test.mjs makes them. */
function chain(f, n, { threadId = f.t.id, replyIn = undefined } = {}) {
  const fromOf = (i) => (i % 2 ? [f.rt.sessionsIn(threadId)[1], 'alpha'] : [f.rt.sessionsIn(threadId)[0], 'beta']);
  for (let i = 0; i < n; i++) {
    const [from, to] = fromOf(i);
    const r = f.rt.agentWake(from.id, to, `hand-off ${i + 1}`, { replyIn });
    assert.equal(r.ok, true, `hand-off ${i + 1}: ${r.message}`);
  }
}
const cards = (f, id = f.t.id) => f.store.items(id).filter((x) => x.kind === 'hop');
/** The room’s own limit, written as the person’s PATCH writes it, on the conversation. */
const setLimit = (f, id, chainLimit) => updateThread(f.rt, id, { chainLimit });

test('#1035 with nothing set, 51 wakes in a row all go, with no card: the old limit of 50 is gone', async () => {
  const f = setup();
  chain(f, 51);
  assert.equal(f.store.state.threads[f.t.id].hops, 51);
  assert.deepEqual(cards(f), []);
  await settle(f.rt);
});

test('#1035 with nothing set, the wake after 1,000 in a row asks, on a card numbered 1,001 that keeps the limit of 1,000', async () => {
  const f = setup();
  assert.equal(HOP_LIMIT, 1000, 'the tests run without POSTBOX_CHAIN_LIMIT');
  updateThread(f.rt, f.t.id, { hops: 1000 });
  const r = f.rt.agentWake(f.alpha.id, 'beta', 'one more');
  assert.equal(r.waiting, true);
  assert.equal(r.message, 'Waiting for the person to allow waking @beta: this room’s chain limit is 1,000.');
  const [card] = cards(f);
  assert.deepEqual([card.n, card.limit], [1001, 1000]);
  await settle(f.rt);
});

test('#1035 roomChainLimit gives the server’s default for a room with nothing set, and the room’s own once set', async () => {
  const { roomChainLimit } = await import('../server/room-chain-limit.mjs');
  const f = setup();
  assert.equal(roomChainLimit(f.rt, f.t.id), DEFAULT_HOP_LIMIT);
  setLimit(f, f.t.id, 5);
  assert.equal(roomChainLimit(f.rt, f.t.id), 5);
  setLimit(f, f.t.id, null);
  assert.equal(roomChainLimit(f.rt, f.t.id), 1000);
});

test('#1035 a room set to 5 asks at the 6th wake, and another room on the same server with nothing set lets its 6th go', async () => {
  const f = setup();
  const other = f.rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [f.a.id, f.b.id] });
  setLimit(f, f.t.id, 5);
  chain(f, 5);
  const r = f.rt.agentWake(f.alpha.id, 'beta', 'the sixth');
  assert.equal(r.waiting, true, 'the room’s sixth waits');
  assert.equal(r.message, 'Waiting for the person to allow waking @beta: this room’s chain limit is 5.');
  assert.deepEqual(
    cards(f).map((x) => [x.n, x.limit]),
    [[6, 5]],
  );
  chain(f, 6, { threadId: other.id });
  assert.deepEqual(cards(f, other.id), [], 'the other room’s sixth went');
  await settle(f.rt);
});

test('#1035 a topic thread reads its conversation’s limit: a wake from a topic of a room set to 5 asks at the 6th', async () => {
  const f = setup();
  f.rt.sendMessage(f.t.id, { text: '@alpha start' });
  await settle(f.rt);
  const root = f.store.items(f.t.id).find((x) => x.kind === 'agent');
  const { threadId: topic } = f.rt.startTopic(f.t.id, root.id);
  setLimit(f, f.t.id, 5);
  chain(f, 5, { replyIn: topic });
  assert.equal(f.store.state.threads[f.t.id].hops, 5, 'the topic’s wakes count on the conversation');
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'the sixth', { replyIn: topic }).waiting, true);
  assert.deepEqual(
    cards(f).map((x) => x.limit),
    [5],
  );
  await settle(f.rt);
});

test('#1035 the card keeps the limit it was raised under: at 20 wakes, setting the room to 5 makes the next ask, past 5', async () => {
  const f = setup();
  chain(f, 20);
  setLimit(f, f.t.id, 5);
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'the 21st').waiting, true);
  assert.deepEqual(
    cards(f).map((x) => [x.n, x.limit]),
    [[21, 5]],
  );
  await settle(f.rt);
});

test('#1035 wake_agent tells agents the room’s chain limit, with the server’s default, not one number for every room', () => {
  const description = TOOL_DEFS.find((d) => d.name === 'wake_agent').description;
  assert.match(description, /After the room’s chain limit of agent wakes in one chain \(1,000 unless the person set another\), the person must allow/);
  assert.doesNotMatch(description, /After \d+ agent wakes/);
});
