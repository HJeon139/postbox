// What the review of #377 asked for: a turn in an old side thread posts its mentions once. Each pair of agents kept its own count of wakes in a row too, until #492
// removed the pair limit (tests/wakes-no-pair-limit.test.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOP_LIMIT } from '../server/side-threads.mjs';
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
  rt.putThread({ ...store.state.threads[t.id], hops: HOP_LIMIT });
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

test('#372 a woken agent is told its reply reaches the waker only by an @-mention, and wake_agent names the chain limit', async () => {
  const { formatMessage } = await import('../server/adapters/guide.mjs');
  const { TOOL_DEFS } = await import('../server/mcp.mjs');
  assert.match(
    formatMessage({ kind: 'agent', from: '@alpha', text: 'Check the totals.' }),
    /^\[Postbox\] @alpha wrote to you\. Your reply posts here; it reaches @alpha only if you @-mention them/,
  );
  assert.match(
    TOOL_DEFS.find((d) => d.name === 'wake_agent').description,
    /After the room’s chain limit of agent wakes in one chain \(1,000 unless the person set another\), the person must allow/,
  );
});
