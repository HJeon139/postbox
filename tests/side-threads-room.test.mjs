// What reaches the conversation from a side thread: its line’s count (#130), what the person or an agent sends back
// (#128), and a failed turn there (#151).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup, sideOf } from './side-threads-fixture.mjs';

const linkOf = (store, t) => store.items(t.id).find((x) => x.kind === 'sidelink');
/** A turn that posts two items, split by a code block between them, as one reply. */
const twoItems = async (c) => {
  c.text('First part.');
  c.tools.show_block({ block: { id: 'b1', type: 'code', version: 1, fallback: 'x', code: 'x' } });
  c.text('Second part.');
};

test('#130: the side-thread line counts every message there, one per agent turn, and catch-up says the same', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(twoItems);
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  await settle(rt);
  const side = sideOf(store, t);
  // The wake, and beta’s turn of two items: alpha hears the reply in a turn of its own, in the conversation.
  assert.equal(linkOf(store, t).count, 2);
  // The person joins the side thread, and beta answers them: no wake, no reply to one.
  adapter.next.push(async (c) => c.text('Here you go.'));
  rt.sendMessage(side.id, { text: '@beta what about the 1908 one?' });
  await settle(rt);
  assert.equal(store.items(side.id).filter((x) => x.kind === 'user' || x.kind === 'agent').length, 5);
  const link = linkOf(store, t);
  assert.equal(link.count, 4);
  assert.equal(link.lastAt, store.items(side.id).at(-1).at);
  // An agent of the conversation reads the same number.
  const gamma = rt.ensureSession(t.id, Object.values(store.state.personas).find((p) => p.handle === 'gamma').id);
  assert.match(rt.catchUp(store.state.sessions[gamma.id]) ?? '', /talked in a side thread \(4 messages;/);
});
