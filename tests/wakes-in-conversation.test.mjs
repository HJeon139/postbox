// Agents talk in the conversation (#372): a wake runs where the waking agent spoke, never in a side thread of its own,
// and a reply wakes its waker only by @-mentioning it. Side threads from before #372 are history.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

const sides = (store) => Object.values(store.state.threads).filter((x) => x.kind === 'side');
const turnsOf = (adapter, sessionId) => adapter.calls.filter((c) => c.sessionId === sessionId);

test('#372 an @-mention wakes the agent in the conversation, its reply posts there, and the waker gets no new turn', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  adapter.next.push(async (c) => c.text('@beta which editions did you index?'));
  adapter.next.push(async (c) => c.text('The 1st and 3rd.'));
  rt.sendMessage(t.id, { text: '@alpha ask beta about the editions' });
  await settle(rt);
  const woke = turnsOf(adapter, beta.id);
  assert.deepEqual(
    woke.map((c) => [c.thread, c.message.kind, c.message.from]),
    [[t.id, 'agent', '@alpha']],
  );
  const said = store.items(t.id).filter((x) => x.kind === 'agent');
  assert.deepEqual(
    said.map((x) => [x.handle, x.text]),
    [
      ['alpha', '@beta which editions did you index?'],
      ['beta', 'The 1st and 3rd.'],
    ],
  );
  // The mention is the wake’s message: it carries its number in the chain, and no copy is posted.
  assert.equal(said[0].hop, 1);
  assert.equal(sides(store).length, 0, 'no side thread');
  assert.equal(
    store.items(t.id).some((x) => x.kind === 'sidelink'),
    false,
  );
  // beta didn’t mention alpha, so alpha reads the reply at its next turn instead of being woken by it.
  assert.equal(turnsOf(adapter, alpha.id).length, 1);
});

test('#372 a hand-off that needs the waker to act wakes it exactly once', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  adapter.next.push(async (c) => c.text('@beta please push the fix'));
  adapter.next.push(async (c) => c.text('@alpha pushed at abc123, ready for your re-review'));
  adapter.next.push(async (c) => c.text('Re-reviewed abc123: approved.'));
  rt.sendMessage(t.id, { text: '@alpha get the fix pushed' });
  await settle(rt);
  assert.equal(turnsOf(adapter, beta.id).length, 1);
  const alphaTurns = turnsOf(adapter, alpha.id);
  assert.equal(alphaTurns.length, 2, 'the person’s message, then beta’s hand-off');
  assert.deepEqual([alphaTurns[1].thread, alphaTurns[1].message.from], [t.id, '@beta']);
  assert.equal(store.items(t.id).findLast((x) => x.kind === 'agent').text, 'Re-reviewed abc123: approved.');
  assert.equal(store.state.threads[t.id].hops, 2);
});

test('#372 wake_agent posts its message in the conversation as the waker’s, with its number in the chain', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  const r = rt.agentWake(alpha.id, 'beta', 'Which editions?');
  assert.equal(r.ok, true);
  await settle(rt);
  const msg = store.items(t.id).find((x) => x.kind === 'agent' && x.handle === 'alpha');
  assert.deepEqual([msg.text, msg.hop, msg.sessionId], ['Which editions?', 1, alpha.id]);
  assert.deepEqual(
    turnsOf(adapter, beta.id).map((c) => [c.thread, c.message.itemId]),
    [[t.id, msg.id]],
  );
  assert.equal(sides(store).length, 0);
});

test('#372 a wake for a busy agent waits in the conversation’s queue, and goes when its turn ends', async () => {
  const { store, rt, adapter, t, beta, alpha } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start the long job' });
  await sleep(5);
  const r = rt.agentWake(alpha.id, 'beta', 'Which editions?');
  assert.match(r.message, /busy/);
  const [q] = store.state.threads[t.id].queue;
  assert.deepEqual([q.kind, q.from, q.text, q.sessionIds], ['wake', 'alpha', 'Which editions?', [beta.id]]);
  busy.release();
  await settle(rt);
  assert.deepEqual(
    turnsOf(adapter, beta.id).map((c) => c.message.text ?? c.message.kind),
    ['@beta start the long job', 'Which editions?'],
  );
  assert.equal(sides(store).length, 0);
});

test('#372 a side thread from before reads only, and a turn there hands off in the conversation, told once', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  // A side thread as the code before #372 made it.
  const old = rt.putThread({
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
  assert.throws(() => rt.sendMessage(old.id, { text: 'hello' }), /read-only/);
  // A turn of alpha’s still running in it, from before the change, mentions beta twice in a row.
  for (const _ of [1, 2]) {
    const h = held();
    adapter.next.push(h.step);
    rt.deliver(alpha.id, { kind: 'user', text: 'carry on' }, { threadId: old.id });
    await sleep(5);
    rt.agentWake(alpha.id, 'beta', 'Status?');
    h.release();
    await settle(rt);
  }
  assert.deepEqual(
    turnsOf(adapter, beta.id).map((c) => c.thread),
    [t.id, t.id],
  );
  assert.equal(store.items(old.id).filter((x) => x.kind === 'agent' && x.handle === 'alpha' && x.hop).length, 0);
  // Told once: in the turn after the first wake, and not waiting again for the next.
  const notes = [...turnsOf(adapter, alpha.id).flatMap((c) => c.message.context ?? []), ...(store.state.sessions[alpha.id].context ?? [])];
  assert.equal(notes.filter((x) => /Side threads are gone/.test(JSON.stringify(x))).length, 1);
  assert.equal(store.state.sessions[alpha.id].toldSideThreadsGone, true);
});
