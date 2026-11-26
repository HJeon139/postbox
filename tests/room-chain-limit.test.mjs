// #1035: the wake chain limit is 1,000 by default, and each room (conversation) can set its own, saved on the
// conversation beside the count it caps (hops), so a topic thread reads its conversation’s. The check, the card and
// what agents are told all read the room’s number. tests/room-chain-limit-routes.test.mjs holds who may set it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roomText } from '../server/adapters/guide.mjs';
import { DEFAULT_HOP_LIMIT } from '../shared/limits.mjs';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** n wakes between alpha and beta in turn, all while the chain runs, as tests/wakes-no-pair-limit.test.mjs makes them. */
function chain(f, n, { threadId = f.t.id, replyIn = undefined } = {}) {
  const fromOf = (i) => (i % 2 ? [arrange.sessionsIn(f.rt, threadId)[1], 'alpha'] : [arrange.sessionsIn(f.rt, threadId)[0], 'beta']);
  for (let i = 0; i < n; i++) {
    const [from, to] = fromOf(i);
    const r = f.rt.agentWake(from.id, to, `hand-off ${i + 1}`, { replyIn });
    assert.equal(r.ok, true, `hand-off ${i + 1}: ${r.message}`);
  }
}
const cards = (f, id = f.t.id) => f.store.items(id).filter((x) => x.kind === 'hop');
/** The room’s own limit, written as the person’s PATCH writes it, on the conversation. */
const setLimit = (f, id, chainLimit) => arrange.setThread(f.rt, id, { chainLimit });

test('#1035 with nothing set, 51 wakes in a row all go, with no card: the old limit of 50 is gone', async () => {
  const f = setup();
  chain(f, 51);
  assert.equal(f.store.state.threads[f.t.id].hops, 51);
  assert.deepEqual(cards(f), []);
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

test('#1035 the guide tells agents the room’s chain limit, with the server’s default, not one number for every room', () => {
  const room = roomText([{ handle: 'beta', role: 'Reviews' }]);
  assert.match(room, /After the room’s chain limit of agent wakes in one chain \(1,000 unless the person set another\), the person must allow/);
  assert.doesNotMatch(room, /After \d+ agent wakes/);
});
