// A reply a restart or a store outage cut off before it had words of its own keeps what its turn held (#1451): the
// steps it kept and whom its turn was answering, from what was stored, since the turn’s memory is gone.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { settleInterrupted, stopStreaming } from '../server/restart-sweep.mjs';
import { Runtime } from '../server/runtime.mjs';
import { stopTimers } from '../server/runtime-close.mjs';
import { settleOrphanTurns } from '../server/store-outage.mjs';
import { ScriptedAdapter, setup, sleep } from './side-threads-fixture.mjs';

/** A turn that took two steps and wrote nothing, still running: its reply streams with no words. */
async function cutOff() {
  const f = setup();
  f.adapter.next.push(async (c) => {
    c.activity({ id: 's1', label: 'Read the shelf', state: 'done' });
    c.activity({ id: 's2', label: 'Ran tests', state: 'running' });
    await new Promise(() => {});
  });
  f.rt.sendMessage(f.t.id, { text: '@beta secret words' });
  await sleep(20);
  stopTimers(f.rt);
  // Postbox again on the same store, with no turn running in it.
  const again = new Runtime({ store: f.store, adapters: new AdapterRegistry().register(new ScriptedAdapter()), config: f.rt.config });
  return { ...f, again };
}

const replyOf = (/** @type {any} */ f) => f.store.items(f.t.id).find((/** @type {any} */ i) => i.kind === 'agent' && i.sessionId === f.beta.id);
const HELD = { took: [{ from: 'you' }], steps: 2, last: 'Ran tests', running: [], stopped: [] };

test('a reply a restart cut off with no words keeps what its turn held', async () => {
  const f = await cutOff();
  assert.equal(replyOf(f).status, 'streaming');
  settleInterrupted(f.again);
  stopStreaming(f.again);
  assert.equal(replyOf(f).status, 'stopped');
  assert.deepEqual(replyOf(f).held, HELD);
  assert.ok(!JSON.stringify(replyOf(f).held).includes('secret'), 'no message text');
  stopTimers(f.again);
});

test('a reply a store outage stopped with no words keeps what its turn held', async () => {
  const f = await cutOff();
  settleOrphanTurns(f.again);
  assert.equal(replyOf(f).status, 'stopped');
  assert.equal(replyOf(f).stopReason, 'store');
  assert.deepEqual(replyOf(f).held, HELD);
  stopTimers(f.again);
});
