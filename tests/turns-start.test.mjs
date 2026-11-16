// How a turn started from inbox entries ends for them (server/turns.mjs, and endTurn’s turn.ended and turn.failed):
// a stopped turn delivered what it took, so nothing reopens to wake the agent after the person’s Stop; and a Retry hands
// the failed turn’s entries to the turn it starts, which delivers them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** Every entry beta’s inbox holds, with its state and the turn that took it. */
const beta = (rt, f) => Object.values(rt.store.state.inbox[f.beta.id] ?? []).map((e) => ({ state: e.state, takenBy: e.takenBy, resend: e.resend }));

test('a turn the person stops ends as delivered for what it took: nothing reopens, and no turn starts after the Stop', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.agentWake(f.alpha.id, 'beta', 'Which editions?');
  await sleep(5);
  assert.ok(arrange.running(f.rt, f.beta.id), 'the mention started beta’s turn');
  f.rt.stop(f.beta.id);
  busy.release();
  await settle(f.rt);
  assert.deepEqual(
    beta(f.rt, f).map((e) => e.state),
    ['delivered'],
  );
  assert.equal(f.adapter.calls.filter((c) => c.sessionId === f.beta.id).length, 1, 'no turn after the Stop');
});

test('a Retry’s turn takes what the failed turn took, as a resend, and delivers it', async () => {
  const f = setup();
  f.adapter.next.push(async () => {
    throw new Error('API 500');
  });
  f.rt.agentWake(f.alpha.id, 'beta', 'Which editions?');
  await settle(f.rt);
  const failed = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.status === 'failed' && i.sessionId === f.beta.id);
  await f.rt.retry(f.t.id, failed.id);
  await settle(f.rt);
  const calls = f.adapter.calls.filter((c) => c.sessionId === f.beta.id);
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[1].message), /Which editions\?/);
  const [e] = beta(f.rt, f);
  assert.deepEqual([e.state, e.resend, e.takenBy === f.rt.store.state.sessions[f.beta.id].lastTurnId], ['delivered', true, true]);
});

test('a reply the person stops hands its mention over to no one, as a stopped turn woke no one before', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(async (c) => {
    c.text('@beta here is half of it');
    await busy.step(c);
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha hand it to beta' });
  await sleep(5);
  f.rt.stop(f.alpha.id);
  busy.release();
  await settle(f.rt);
  assert.deepEqual(arrange.waitingEntries(f.rt, f.beta.id), []);
  assert.equal(f.adapter.calls.filter((c) => c.sessionId === f.beta.id).length, 0);
});
