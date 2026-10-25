// What the review of #377 asked for: each pair of agents keeps its own count of wakes in a row, a message that wakes
// several agents counts each wake in telemetry, and a turn in an old side thread posts its mentions once.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PAIR_LIMIT } from '../server/side-threads.mjs';
import { collect, tierA } from '../server/telemetry-record.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** The fixture’s room with @gamma added: three agents. */
function three() {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  return { ...f, gamma };
}
/** A side thread as the code before #372 made it. */
const oldSide = (rt, t) =>
  rt.putThread({
    id: 'th_old',
    projectId: 'p1',
    title: '@alpha ↔ @beta',
    kind: 'side',
    parentId: t.id,
    pair: 'alpha|beta',
    woke: 'beta',
    members: [],
    lastSpeaker: null,
    hops: 0,
    queue: [],
    createdAt: Date.now(),
    archived: false,
  });

test('#372 a third agent’s wakes in between don’t restart a pair’s count: alpha and beta still reach the card', async () => {
  const { store, rt, t, alpha, beta, gamma } = three();
  const wake = async (from, to) => {
    const r = rt.agentWake(from.id, to, `${from.handle} to ${to}`);
    await settle(rt);
    return r;
  };
  assert.equal((await wake(alpha, 'beta')).ok, true); // alpha|beta 1
  assert.equal((await wake(gamma, 'alpha')).ok, true); // alpha|gamma 1
  assert.equal((await wake(beta, 'alpha')).ok, true); // alpha|beta 2
  assert.equal((await wake(gamma, 'beta')).ok, true); // beta|gamma 1
  const third = await wake(alpha, 'beta'); // alpha|beta 3: the card
  assert.equal(third.waiting, true);
  const card = store.items(t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  assert.deepEqual([card.from, card.to, card.pair], ['alpha', 'beta', PAIR_LIMIT]);
  // You acting clears every pair’s count.
  rt.sendMessage(t.id, { text: 'carry on' });
  await settle(rt);
  assert.equal(store.state.threads[t.id].pairRuns, null);
});

test('#372 a message that wakes two agents counts as one chain with two wakes in telemetry', async () => {
  const { store, rt, adapter, t } = three();
  adapter.next.push(async (c) => c.text('@beta @gamma please review the totals.'));
  rt.sendMessage(t.id, { text: '@alpha get it reviewed' });
  await settle(rt);
  const msg = store.items(t.id).find((x) => x.kind === 'agent' && x.handle === 'alpha');
  assert.deepEqual([msg.hop, msg.wakes], [1, [1, 2]]);
  const { room } = tierA(rt, collect(rt, store.state.threads[t.id], join(tmpdir(), 'pb-no-recording'), { history: true }));
  assert.deepEqual([room.wakeChains, room.longestWakeChain], [1, 2]);
});

test('#372 a turn in an old side thread that mentions two agents posts its message in the conversation once', async () => {
  const { store, rt, adapter, t, alpha } = three();
  const old = oldSide(rt, t);
  adapter.next.push(async (c) => c.text('@beta @gamma the fix is in.'));
  rt.deliver(alpha.id, { kind: 'user', text: 'carry on' }, { threadId: old.id });
  await settle(rt);
  const posted = store.items(t.id).filter((x) => x.kind === 'agent' && x.handle === 'alpha');
  assert.deepEqual(
    posted.map((x) => [x.text, x.wakes]),
    [['@beta @gamma the fix is in.', [1, 2]]],
  );
});

test('#372 a turn in an old side thread whose wake waits on a card is still told side threads are gone', async () => {
  const { store, rt, adapter, t, alpha } = three();
  const old = oldSide(rt, t);
  rt.putThread({ ...store.state.threads[t.id], hops: 10 });
  const h = held();
  adapter.next.push(h.step);
  rt.deliver(alpha.id, { kind: 'user', text: 'carry on' }, { threadId: old.id });
  await sleep(5);
  const r = rt.agentWake(alpha.id, 'beta', 'Status?');
  assert.equal(r.waiting, true, 'past the wake limit, it waits on the card');
  assert.equal(store.state.sessions[alpha.id].toldSideThreadsGone, true);
  h.release();
  await settle(rt);
});

test('#372 a woken agent is told its reply reaches the waker only by an @-mention, and wake_agent names both limits', async () => {
  const { formatMessage } = await import('../server/adapters/guide.mjs');
  const { TOOL_DEFS } = await import('../server/mcp.mjs');
  assert.match(
    formatMessage({ kind: 'agent', from: '@alpha', text: 'Check the totals.' }),
    /^\[Postbox\] @alpha wrote to you\. Your reply posts here; it reaches @alpha only if you @-mention them/,
  );
  assert.match(TOOL_DEFS.find((d) => d.name === 'wake_agent').description, new RegExp(`or ${PAIR_LIMIT} in a row between the same two agents`));
});
