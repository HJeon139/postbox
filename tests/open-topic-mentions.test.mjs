// open_topic checks its mentions before it opens anything (#650): a list of at most SENDING.mentions handles, each a
// handle’s shape, or the whole call is refused and nothing is written. Agent text reaches the reply and the stored
// `opened`, so a refusal never echoes what was sent. The agents are tests/side-threads-fixture.mjs’s.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SENDING } from '../shared/limits.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** The conversation with alpha’s settled reply, and a way to run one of alpha’s turns with its tools. */
async function conversation() {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('The totals are off by one.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha check the totals' });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((i) => i.kind === 'agent');
  /** One turn of alpha’s that calls open_topic on its reply; resolves with the result. */
  const open = async (args) => {
    let out;
    f.adapter.next.push(async (c) => {
      out = c.tools.open_topic({ itemId: reply.id, message: 'Please check the totals.', ...args });
      c.text('Done.');
    });
    f.rt.sendMessage(f.t.id, { text: '@alpha go' });
    await settle(f.rt);
    return out;
  };
  return { ...f, reply, open };
}
const topics = (store) => Object.values(store.state.threads).filter((t) => t.kind === 'topic');
/** Every item in every thread, to show a refusal wrote none. */
const allItems = (store) => Object.values(store.state.threads).flatMap((t) => store.items(t.id));
/** `n` distinct handles of a handle’s shape, none an agent’s. */
const handles = (n) => Array.from({ length: n }, (_, i) => `h${String(i + 1).padStart(2, '0')}`);

test('#650 SENDING caps open_topic’s mentions at 16', () => {
  assert.equal(SENDING.mentions, 16);
});

test('#650 one mention past the cap refuses the call, naming the cap, before anything opens or posts', async () => {
  const f = await conversation();
  const before = allItems(f.store).length;
  const r = await f.open({ mentions: handles(SENDING.mentions + 1) });
  assert.equal(r?.ok, false, JSON.stringify(r));
  assert.match(r.message, new RegExp(`\\b${SENDING.mentions}\\b`));
  assert.equal(topics(f.store).length, 0, 'no topic');
  assert.equal(allItems(f.store).length, before + 2, 'only the turn’s own message and reply');
});

test('#650 exactly the cap of mentions opens the topic', async () => {
  const f = await conversation();
  const r = await f.open({ mentions: handles(SENDING.mentions) });
  assert.equal(r?.ok, true, JSON.stringify(r));
  assert.equal(topics(f.store).length, 1);
});

test('#650 a mention that isn’t a string is refused as a list of handles, not thrown', async () => {
  const f = await conversation();
  const r = await f.open({ mentions: [1] });
  assert.equal(r?.ok, false, JSON.stringify(r));
  assert.match(r.message, /list of handles/);
  assert.equal(topics(f.store).length, 0);
});

test('#650 null mentions are still refused', async () => {
  const f = await conversation();
  const r = await f.open({ mentions: null });
  assert.equal(r?.ok, false, JSON.stringify(r));
  assert.equal(topics(f.store).length, 0);
});

test('#650 a 20,000-character mention is refused in a short reply, and nothing keeps it', async () => {
  const f = await conversation();
  const r = await f.open({ mentions: ['g'.repeat(20_000)] });
  assert.equal(r?.ok, false, JSON.stringify(r)?.slice(0, 300));
  assert.ok(r.message.length < 400, `the reply is ${r.message.length} characters`);
  assert.equal(topics(f.store).length, 0);
  assert.deepEqual(
    allItems(f.store).filter((i) => i.opened !== undefined),
    [],
    'no item keeps the handles',
  );
});

test('#650 one bad handle among good ones refuses the whole call: no topic, and no one is woken', async () => {
  const f = await conversation();
  const calls = f.adapter.calls.length;
  const r = await f.open({ mentions: ['beta', 'not a handle!'] });
  assert.equal(r?.ok, false, JSON.stringify(r));
  assert.equal(topics(f.store).length, 0);
  assert.equal(f.adapter.calls.length, calls + 1, 'only alpha’s own turn ran');
});

test('#650 a hostile mention is refused before any write, and the reply has none of it', async () => {
  const f = await conversation();
  const before = allItems(f.store).length;
  const r = await f.open({ mentions: ['a"<&\u0000b'] });
  assert.equal(r?.ok, false, JSON.stringify(r));
  assert.ok(!r.message.includes('\u0000'), 'no NUL in the reply');
  assert.ok(!r.message.includes('a"<&'), 'nor the rest of it');
  assert.equal(topics(f.store).length, 0);
  assert.equal(allItems(f.store).length, before + 2, 'only the turn’s own message and reply');
});
