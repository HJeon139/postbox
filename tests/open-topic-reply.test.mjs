// open_topic’s reply says what happened to its message (#651): opened and posted, posted into the topic the message
// already had, or already there as the opener’s newest (I6), so not posted again and no one woken again. A second open
// with a new message did post it, and the reply said only that the topic existed, so the agent said it hadn’t. The
// agents are tests/side-threads-fixture.mjs’s.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

/** The conversation with alpha’s settled reply, and a way to run one turn of an agent’s that calls open_topic on it. */
async function conversation() {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('The totals are off by one.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha check the totals' });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((i) => i.kind === 'agent');
  /** One turn of `handle`’s that opens the topic on alpha’s reply; resolves with the result. */
  const open = async (args, handle = 'alpha') => {
    let out;
    f.adapter.next.push(async (c) => {
      out = c.tools.open_topic({ itemId: reply.id, ...args });
      c.text('Done.');
    });
    f.rt.sendMessage(f.t.id, { text: `@${handle} go` });
    await settle(f.rt);
    return out;
  };
  /** alpha’s messages in the topic with this text. */
  const copies = (threadId, text) => f.store.items(threadId).filter((i) => i.kind === 'agent' && i.sessionId === f.alpha.id && i.text === text);
  return { ...f, reply, open, copies };
}
/** The sentence a repeat’s reply ends with, for the message already there. */
const alreadyThere = (id) =>
  `Your message is already there, as your newest in this topic thread (\`${id}\`), so it wasn’t posted again and no one was woken again. To post it a second time, change its text.`;

test('#651 the first open with a message says it opened the topic and posted it, with its id', async () => {
  const f = await conversation();
  const r = await f.open({ message: 'A' });
  const [it] = f.copies(r.threadId, 'A');
  assert.equal(r.posted, true, JSON.stringify(r));
  assert.equal(r.itemId, it.id);
  assert.match(r.message, /^Opened a topic thread/);
  assert.ok(r.message.includes(`Posted your message there as \`${it.id}\`.`), r.message);
  assert.doesNotMatch(r.message, /already there/);
});

test('#651 a second open with a new message says it posted it, and still says who it couldn’t wake', async () => {
  const f = await conversation();
  const one = await f.open({ message: 'A' });
  const two = await f.open({ message: 'B', mentions: ['betta'] });
  const [it] = f.copies(one.threadId, 'B');
  assert.ok(it, 'B posted');
  assert.equal(two.created, false);
  assert.equal(two.posted, true, JSON.stringify(two));
  assert.equal(two.itemId, it.id);
  assert.match(two.message, /Posted/);
  assert.ok(two.message.includes(it.id), 'the reply names the new message');
  assert.match(two.message, /There’s no agent called @betta/);
});

test('#651 a repeat says its message is already there and wasn’t posted again (I6)', async () => {
  const f = await conversation();
  const one = await f.open({ message: 'A' });
  const again = await f.open({ message: 'A' });
  const copies = f.copies(one.threadId, 'A');
  assert.equal(copies.length, 1, 'one copy');
  assert.equal(again.posted, false, JSON.stringify(again));
  assert.equal(again.itemId, copies[0].id);
  assert.ok(again.message.endsWith(alreadyThere(copies[0].id)), again.message);
  assert.doesNotMatch(again.message, /Posted/);
});

test('#651 a repeat that names beta wakes beta once, and says no one was woken again', async () => {
  const f = await conversation();
  const one = await f.open({ message: 'A', mentions: ['beta'] });
  const betaCalls = () => f.adapter.calls.filter((c) => c.sessionId === f.beta.id).length;
  const before = betaCalls();
  assert.equal(before, 1, 'the first open woke beta');
  const again = await f.open({ message: 'A', mentions: ['beta'] });
  assert.equal(betaCalls(), before, 'beta wasn’t woken again');
  assert.equal(f.copies(one.threadId, 'A').length, 1);
  assert.equal(again.posted, false);
  assert.match(again.message, /no one was woken again/);
});

test('#651 an open with a different text posts it: only the same text is a repeat', async () => {
  const f = await conversation();
  const one = await f.open({ message: 'A' });
  const two = await f.open({ message: 'A, and the March totals' });
  assert.equal(f.copies(one.threadId, 'A, and the March totals').length, 1);
  assert.equal(two.posted, true);
});

test('#651 once the opener has spoken there since, the same text posts again: only its newest message counts', async () => {
  const f = await conversation();
  const one = await f.open({ message: 'A' });
  f.rt.addItem(one.threadId, { kind: 'agent', sessionId: f.alpha.id, personaId: f.alpha.personaId, handle: 'alpha', text: 'Something else.', status: 'done' });
  const two = await f.open({ message: 'A' });
  assert.equal(f.copies(one.threadId, 'A').length, 2);
  assert.equal(two.posted, true);
});

test('#651 another agent’s identical open isn’t the opener’s repeat: it posts', async () => {
  const f = await conversation();
  const one = await f.open({ message: 'A' }, 'beta');
  const two = await f.open({ message: 'A' });
  assert.equal(two.threadId, one.threadId);
  assert.equal(f.copies(one.threadId, 'A').length, 1, 'alpha’s own copy');
  assert.equal(two.posted, true);
});

test('#651 an open with no message posts nothing and says so in its fields', async () => {
  const f = await conversation();
  const r = await f.open({});
  assert.equal(r.ok, true);
  assert.equal(r.posted, false);
  assert.equal(r.itemId, null);
  assert.doesNotMatch(r.message, /Posted|already there/);
});

test('#651 the reply never echoes the message', async () => {
  const f = await conversation();
  const text = 'a"<&\u0000b';
  const one = await f.open({ message: text });
  const again = await f.open({ message: text });
  for (const r of [one, again]) {
    assert.ok(!r.message.includes(text), r.message);
    assert.ok(!r.message.includes('\u0000'), 'no NUL in the reply');
  }
});
