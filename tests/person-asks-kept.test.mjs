// How many of its unread asks a session keeps (#1742, ASKS.kept in shared/limits.mjs), and that the cap bounds what
// the session carries, never which asks can be read: one too old to be kept is read when it comes up as the need.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { People } from '../server/people.mjs';
import { ASKS } from '../shared/limits.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const SAM = { provider: 'oidc', issuer: 'https://idp.example', subject: 'u-2', username: 'sam', name: 'Sam Okafor' };

test('more unread asks than a session keeps are all read: the oldest isn’t left ringing with nothing to clear it', async () => {
  const f = setup();
  const people = new People({ store: f.rt.store });
  const robin = people.seen(people.of({ ...SAM, subject: 'u-1', username: 'robin', name: 'Robin Example' }));
  const sam = people.seen(people.of(SAM));
  const se = () => f.store.state.sessions[f.alpha.id];
  for (let i = 1; i <= ASKS.kept + 1; i++) {
    f.adapter.next.push(async (/** @type {any} */ c) => c.text(`Question ${i} for @sam.`));
    f.rt.sendMessage(f.t.id, { text: `@alpha ask ${i}` }, { id: robin.id });
    await settle(f.rt);
  }
  const unread = () => f.store.items(f.t.id).filter((/** @type {any} */ i) => i.asks && !i.asksSeen).length;
  assert.deepEqual([se().asked.length, unread()], [ASKS.kept, ASKS.kept + 1], 'the session keeps the newest, and every reply keeps its mark');
  assert.match(f.store.item(f.t.id, se().asked.at(-1).itemId).text, new RegExp(`^Question ${ASKS.kept + 1} `));
  // Another person’s view reads none of them.
  f.rt.view(f.t.id, robin.id);
  assert.equal(unread(), ASKS.kept + 1);
  f.rt.view(f.t.id, sam.id);
  assert.deepEqual([se().needs, se().asked ?? [], unread()], [null, [], 0]);
});
