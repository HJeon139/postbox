// #637 on a host: a host's tool call goes through the same write gate as a local one, and open_topic from a host's turn
// opens the topic once, its repeat after a hello getting the kept reply (designs/508/637-open-topic.md, spec 4). The rig
// is tests/remote-turns-helpers.mjs, as tests/remote-turns-replay.test.mjs uses it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

const topics = (store) => Object.values(store.state.threads).filter((t) => t.kind === 'topic');

/** Closes the rig's store as an EIO does (ST-3), until the returned function reopens it. */
function closeStore(r) {
  r.store.writable = false;
  r.store.cause = Object.assign(new Error('Postbox can’t write its event log (EIO): disk sync refused.'), { code: 'EIO' });
  return () => {
    r.store.writable = true;
    r.store.cause = null;
  };
}
const keptReplies = (r) => Object.values(r.store.state.sessions).flatMap((s) => s.remoteTurn?.replies ?? []);

test('a host’s asked write tool while the store is closed is refused with the cause, and writes and keeps nothing (I5)', async () => {
  const r = rig();
  const turn = await running(r);
  const mine = r.store.items(r.t.id).find((i) => i.kind === 'user');
  const reopen = closeStore(r);
  r.d.tool(turn, 'open_topic', { itemId: mine.id });
  await until(() => r.d.replies.length === 1, 'the reply');
  assert.equal(r.d.replies[0].ok, false);
  assert.match(r.d.replies[0].text, /can’t write its event log/);
  assert.deepEqual(topics(r.store), [], 'the refused call opened nothing');
  assert.deepEqual(keptReplies(r), [], 'nor kept its refusal, a write the closed store would hold only in memory');
  reopen();
  r.d.end(turn);
  await settled(r);
});

test('a host’s queued write tool while the store is closed gets no reply, so the daemon’s repeat after it reopens runs it (I5)', async () => {
  const r = rig();
  const turn = await running(r);
  const mine = r.store.items(r.t.id).find((i) => i.kind === 'user');
  const reopen = closeStore(r);
  const id = r.d.tool(turn, 'define_term', { term: 'W', definition: 'D' });
  // An asked call after it, refused with a reply: by then the queued one has been through the gate.
  const asked = r.d.tool(turn, 'open_topic', { itemId: mine.id });
  await until(() => r.link.sent.some((m) => m.type === 'reply' && m.id === asked), 'the asked call’s reply');
  assert.equal(r.link.sent.filter((m) => m.type === 'reply' && m.id === id).length, 0, 'no reply, which the daemon would only log');
  assert.deepEqual(r.store.state.glossary[r.t.id] ?? {}, {}, 'the refused call defined nothing');
  assert.deepEqual(keptReplies(r), [], 'and kept nothing');
  reopen();
  r.link.hear({ type: 'tool', turn, id, name: 'define_term', args: { term: 'W', definition: 'D' } }); // the hello’s resend
  await until(() => r.link.sent.some((m) => m.type === 'reply' && m.id === id), 'the repeat’s reply');
  assert.equal(r.link.sent.find((m) => m.type === 'reply' && m.id === id).ok, true);
  assert.equal(Object.keys(r.store.state.glossary[r.t.id] ?? {}).length, 1, 'the repeat defined it');
  r.d.end(turn);
  await settled(r);
});

test('open_topic from a host’s turn opens the topic, and its repeat after a hello gets the kept reply and posts nothing', async () => {
  const r = rig();
  const turn = await running(r);
  const mine = r.store.items(r.t.id).find((i) => i.kind === 'user');
  const args = { itemId: mine.id, message: 'Notes on this, from the host' };
  const id = r.d.tool(turn, 'open_topic', args);
  await until(() => r.d.replies.length === 1, 'the reply');
  assert.equal(r.d.replies[0].ok, true, r.d.replies[0].text);
  const [topic] = topics(r.store);
  assert.ok(topic, 'a topic opened');
  assert.match(r.d.replies[0].text, new RegExp(topic.id), 'the reply names it');
  r.link.hear({ type: 'tool', turn, id, name: 'open_topic', args });
  await until(() => r.link.sent.filter((m) => m.type === 'reply' && m.id === id).length === 2, 'the repeat’s reply');
  const [first, again] = r.link.sent.filter((m) => m.type === 'reply' && m.id === id);
  // The same text, “Opened a topic thread…”: the kept reply answered (#439), not a second run that I6 caught, which
  // would say the message already has one.
  assert.equal(again.text, first.text, 'the kept reply, not a second run');
  assert.equal(topics(r.store).length, 1);
  assert.equal(r.store.items(topic.id).filter((i) => i.text === args.message).length, 1, 'the message posted once');
  r.d.end(turn);
  await settled(r);
});
