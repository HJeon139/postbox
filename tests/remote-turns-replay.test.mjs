// A host's call that Postbox waits on, sent again by the daemon after a hello, is applied once (#439, #458): the reply
// is kept, as a queued call's is. The rig is tests/remote-turns-helpers.mjs, as tests/remote-turns.test.mjs uses it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

test('#439 an asked tool from the host that changes something is applied once: a repeat after a hello gets the kept reply', async () => {
  // wake_agent, schedule_wake and react wait for Postbox’s answer, and the daemon sends a call again after each hello
  // until it hears one, so a reply lost to a dropped link must not apply the call a second time. react shows it: a
  // second application takes the reaction back.
  const r = rig();
  const turn = await running(r);
  const mine = r.store.items(r.t.id).find((i) => i.kind === 'user');
  const id = r.d.tool(turn, 'react', { id: mine.id, emoji: '✅' });
  await until(() => r.d.replies.length === 1, 'the reply');
  assert.equal(r.d.replies[0].ok, true, r.d.replies[0].text);
  r.link.hear({ type: 'tool', turn, id, name: 'react', args: { id: mine.id, emoji: '✅' } });
  await until(() => r.link.sent.filter((m) => m.type === 'reply' && m.id === id).length === 2, 'the repeat’s reply');
  const replies = r.link.sent.filter((m) => m.type === 'reply' && m.id === id);
  assert.equal(replies[1].text, replies[0].text, 'the same answer');
  assert.equal(
    (r.store.item(r.t.id, mine.id).reactions ?? []).filter((x) => x.emoji === '✅').length,
    1,
    'still reacted: not taken back by a second application',
  );
  r.d.end(turn);
  await settled(r);
});
