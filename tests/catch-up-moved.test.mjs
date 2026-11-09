// An item brought forward in a topic thread (a block asked again, an app's new version): a session whose catch-up
// marker there, seenIn for that topic, was the item reads on from the stub left in its place, so the next topic
// catch-up skips nothing (#1041), held behind a commit or not (#956).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { threadCatchUp } from '../server/thread-summary.mjs';
import { setup } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** The side-thread room on a store whose log sync can be held; hold() holds a commit and returns its release. */
async function heldRoom() {
  const h = await heldStore();
  const f = setup(h.store);
  await h.store.flush();
  const hold = async () => {
    h.hold();
    const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
    await h.atSync;
    return async () => {
      h.release();
      await commit;
      await h.store.flush();
    };
  };
  return { ...f, h, hold };
}

/** A topic thread in the conversation with three messages, it_a, it_x and it_b, on disk; @beta has read up to it_a. */
async function topicOfThree(f) {
  const root = f.rt.addItem(f.t.id, { kind: 'agent', sessionId: f.beta.id, handle: 'beta', text: 'A topic.', status: 'done' });
  const topic = f.rt.startTopic(f.t.id, root.id).threadId;
  for (const id of ['it_a', 'it_x', 'it_b']) f.store.emit('item.add', { threadId: topic, item: { id, kind: 'user', text: `text of ${id}`, at: Date.now() } });
  f.rt.updateSession(f.beta.id, { seenIn: { [topic]: 'it_a' } });
  await f.store.flush();
  return topic;
}

const stubOf = (f, threadId, id) => f.store.items(threadId).find((x) => x.kind === 'moved' && x.itemId === id);
const seenIn = (f, se, topic) => f.store.state.sessions[se.id].seenIn?.[topic];

test('an item brought forward in a topic thread moves seenIn for that topic to the stub, and the next topic catch-up includes the items after it', async () => {
  const f = await heldRoom();
  const topic = await topicOfThree(f);
  f.rt.updateSession(f.alpha.id, { seenIn: { [topic]: 'it_x' } });
  await f.store.flush();
  assert.equal(f.rt.bringForward(topic, 'it_x', { what: 'block', title: 'X' }), true);
  await f.store.flush();
  const stub = stubOf(f, topic, 'it_x');
  assert.ok(stub, 'a stub took its place');
  assert.equal(seenIn(f, f.alpha, topic), stub.id, 'the topic marker moved to the stub');
  assert.equal(seenIn(f, f.beta, topic), 'it_a', 'a marker on another item is untouched');
  assert.equal(f.store.state.sessions[f.alpha.id].seenItem, null, 'the conversation marker is untouched');
  assert.match(threadCatchUp(f.rt, f.store.state.sessions[f.alpha.id], topic) ?? '', /text of it_b/, 'the next topic catch-up skips nothing');
  await f.store.close();
});

test('an item brought forward in a topic thread behind a held commit moves a seenIn written behind it too', async () => {
  const f = await heldRoom();
  const topic = await topicOfThree(f);
  const release = await f.hold();
  f.rt.updateSession(f.alpha.id, { seenIn: { [topic]: 'it_x' } }); // a topic catch-up that just ran, held
  assert.equal(f.rt.bringForward(topic, 'it_x', { what: 'block', title: 'X' }), true);
  await release();
  assert.equal(seenIn(f, f.alpha, topic), stubOf(f, topic, 'it_x').id, 'the held topic marker moved to the stub');
  assert.equal(seenIn(f, f.beta, topic), 'it_a');
  await f.store.close();
});
