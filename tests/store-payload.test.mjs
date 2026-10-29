// What the store’s subscribers hear (server/store.mjs, broadcast()): each event as it was emitted, the bytes a
// reconnecting browser replays and the stream holds, whichever path published it (re-review finding 1 on #525).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../shared/state.mjs';
import { holdEval, open, streamed, tmp } from './store-fixture.mjs';

/** Each event as JSON. @param {any[]} evs */
const bytes = (evs) => evs.map((e) => JSON.stringify(e));

// gpt’s regression: a held emit was published from the object the reducer keeps in the state, so an item.text emitted
// after it, before the commit replied, changed the item.add a browser then heard, and the browser applied it twice.
test('live subscribers receive a held event as it was emitted, not as later events changed it', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  const from = s.state.seq;
  const browser = structuredClone(s.state);
  const heard = [];
  s.subscribe((e) => {
    heard.push(JSON.stringify(e));
    apply(browser, e.type, structuredClone(e.data));
    browser.seq = e.seq;
  });
  const b = holdEval(s);
  const p = s.commit([{ type: 'item.add', data: { threadId: 't', item: { id: 'c', text: 'commit' } } }], 'commit');
  await b.hit;
  s.emit('item.add', { threadId: 't', item: { id: 'e', text: 'hello' } });
  s.emit('item.text', { threadId: 't', id: 'e', text: 'world' });
  b.go();
  await p;
  await s.flush();
  assert.deepEqual(browser.items.t, s.state.items.t);
  assert.equal(s.state.items.t[1].text, 'helloworld');
  assert.deepEqual(heard, bytes(/** @type {any[]} */ (s.since(from))), 'live and replay give the same bytes');
  assert.deepEqual(heard, bytes(await streamed(s, from)), 'and the stream holds them too');
  assert.deepEqual((await open(s.dir ?? '')).state, s.state);
});

// The paths that publish at once. A subscriber that keeps an event (or sends it later, as POSTBOX_STREAM_LAG does)
// has it as it was emitted.
test('an event a subscriber keeps stays as it was emitted, from an emit, a commit or catch-up', async () => {
  const a = await open(await tmp());
  a.emit('thread', { id: 't', members: [] });
  await a.flush();
  const from = a.state.seq;
  const kept = [];
  a.subscribe((e) => kept.push(e));
  a.emit('item.add', { threadId: 't', item: { id: 'e', text: 'hello' } });
  await a.commit([{ type: 'item.add', data: { threadId: 't', item: { id: 'c', text: 'hi' } } }], 'kept-commit');
  const b = await open(a.dir ?? '');
  await b.commit([{ type: 'item.add', data: { threadId: 't', item: { id: 'o', text: 'other' } } }], 'kept-other');
  // Another process wrote first: this commit catches up, applying b’s item.add, and runs again.
  await a.commit([{ type: 'item.text', data: { threadId: 't', id: 'o', text: '!' } }], 'kept-catch-up');
  a.emit('item.text', { threadId: 't', id: 'e', text: 'world' });
  a.emit('item.text', { threadId: 't', id: 'c', text: 'there' });
  await a.flush();
  assert.deepEqual(
    a.state.items.t.map((it) => it.text),
    ['helloworld', 'hithere', 'other!'],
  );
  assert.deepEqual(bytes(kept), bytes(/** @type {any[]} */ (a.since(from))), 'what subscribers kept is what replay gives');
  assert.deepEqual(
    kept.slice(0, 3).map((e) => e.data.item.text),
    ['hello', 'hi', 'other'],
  );
  assert.deepEqual(bytes(kept), bytes(await streamed(a, from)));
});
