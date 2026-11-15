// The person’s Remove and Send now on an agent’s waiting message, an entry in its inbox (server/entry-queue.mjs): through
// the queue’s own calls, for an entry of a session of that conversation only.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** The room with beta busy and alpha’s message to it waiting in its inbox. */
async function waiting() {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta the long job' });
  await sleep(5);
  f.rt.agentWake(f.alpha.id, 'beta', 'Which editions?');
  const [entry] = arrange.waitingEntries(f.rt, f.beta.id);
  return { ...f, busy, entry };
}

test('Remove on a waiting entry stops it, tells its sender, and its agent never gets it', async () => {
  const { store, rt, adapter, t, alpha, beta, busy, entry } = await waiting();
  rt.cancelQueued(t.id, entry.id);
  assert.deepEqual(arrange.waitingEntries(rt, beta.id), []);
  assert.match(store.state.sessions[alpha.id].context.at(-1), /The person removed your message \(“Which editions\?”\) before it was answered/);
  assert.throws(() => rt.cancelQueued(t.id, entry.id), { status: 404 });
  busy.release();
  await settle(rt);
  assert.ok(!adapter.calls.some((c) => c.sessionId === beta.id && JSON.stringify(c.message).includes('Which editions?')));
});

test('Send now on a waiting entry stops the agent’s turn and gives it that message alone; Edit is refused', async () => {
  const { rt, adapter, t, beta, busy, entry } = await waiting();
  assert.throws(() => rt.editQueued(t.id, entry.id, 'Changed.'), { status: 409, message: /can’t be edited/ });
  assert.deepEqual(rt.sendQueuedNow(t.id, entry.id), { ok: true });
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((c) => c.sessionId === beta.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.text, 'Which editions?');
});

test('an entry of another conversation’s session isn’t found from this one: nothing changes', async () => {
  const { rt, beta, busy, entry, a, b } = await waiting();
  const other = rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [a.id, b.id] });
  assert.throws(() => rt.cancelQueued(other.id, entry.id), { status: 404 });
  assert.throws(() => rt.sendQueuedNow(other.id, entry.id), { status: 404 });
  assert.equal(arrange.waitingEntries(rt, beta.id).length, 1, 'still waiting');
  busy.release();
  await settle(rt);
});
