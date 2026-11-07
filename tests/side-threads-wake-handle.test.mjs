// wake_agent checks its handle’s shape before it looks the agent up (#650): agentWake’s “There’s no agent called @…”
// echoed whatever an agent sent, of any length. The agents are tests/side-threads-fixture.mjs’s.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

/** One turn of alpha’s that calls wake_agent; resolves with its result and the fixture. */
async function wake(handle) {
  const f = setup();
  let out;
  f.adapter.next.push(async (c) => {
    out = c.tools.wake_agent({ handle, message: 'Please check the totals.' });
    c.text('Done.');
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha go' });
  await settle(f.rt);
  return { ...f, r: out };
}
const agentItems = (f) => f.store.items(f.t.id).filter((i) => i.kind === 'agent' && i.text === 'Please check the totals.');

test('#650 wake_agent refuses a 20,000-character handle in a short reply, and posts nothing', async () => {
  const f = await wake('g'.repeat(20_000));
  assert.equal(f.r?.ok, false);
  assert.ok(f.r.message.length < 400, `the reply is ${f.r.message.length} characters`);
  assert.deepEqual(agentItems(f), []);
});

test('#650 wake_agent refuses a hostile handle, and the reply has none of it', async () => {
  const f = await wake('a"<&\u0000b');
  assert.equal(f.r?.ok, false);
  assert.ok(!f.r.message.includes('\u0000'), 'no NUL in the reply');
  assert.ok(!f.r.message.includes('a"<&'), 'nor the rest of it');
  assert.deepEqual(agentItems(f), []);
});

test('#650 wake_agent still names a well-formed handle no agent has', async () => {
  const f = await wake('@zed');
  assert.equal(f.r?.ok, false);
  assert.match(f.r.message, /There’s no agent called @zed\./);
});
