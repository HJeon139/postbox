// Thread headers (#1155): what the page shows about a thread without its items. The server keeps each thread’s, forgets
// it on an event that changes it, and the stream sends it after that event.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveStreams } from '../server/live-streams.mjs';
import { threadHeaders } from '../server/thread-headers.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { headerOf } from '../shared/thread-header.mjs';

/** A room with a topic thread off its first message and a side thread linked from it. */
function room() {
  const s = emptyState();
  apply(s, 'thread', { id: 'c', kind: 'room', createdAt: 1 });
  apply(s, 'thread', { id: 'tp', kind: 'topic', parentId: 'c', rootItemId: 'u1', createdAt: 2 });
  apply(s, 'thread', { id: 'sd', kind: 'side', parentId: 'c', createdAt: 3 });
  apply(s, 'item.add', { threadId: 'c', item: { id: 'u1', kind: 'user', at: 10, replies: 2, lastReplyAt: 40 } });
  apply(s, 'item.add', { threadId: 'c', item: { id: 'a1', kind: 'agent', handle: 'ada', sessionId: 's1', at: 20 } });
  apply(s, 'item.add', { threadId: 'c', item: { id: 'b1', kind: 'block', sessionId: 's1', valid: true, block: { type: 'review' }, at: 30 } });
  apply(s, 'item.add', { threadId: 'c', item: { id: 'b2', kind: 'block', sessionId: 's1', valid: true, block: { type: 'table' }, at: 31 } });
  apply(s, 'item.add', { threadId: 'c', item: { id: 'l1', kind: 'sidelink', sideThreadId: 'sd', count: 4, at: 32, lastAt: 50 } });
  return s;
}

test('a header has the thread’s count, last time, speakers, open asks and blocks, and its conversation’s facts about it', () => {
  const s = room();
  assert.deepEqual(headerOf(s, 'c'), {
    count: 5,
    lastAt: 32,
    speakers: ['ada'],
    asks: [{ id: 'b1', sessionId: 's1', type: 'review' }],
    blocks: { s1: 2 },
  });
  assert.deepEqual(headerOf(s, 'tp').root, { replies: 2, lastReplyAt: 40 });
  assert.deepEqual(headerOf(s, 'sd').link, { count: 4, at: 32, lastAt: 50 });
  apply(s, 'item.patch', { threadId: 'c', id: 'b1', patch: { answered: true } });
  assert.deepEqual(headerOf(s, 'c').asks, [], 'an answered ask isn’t open');
});

test('a kept header is forgotten by an item change in its thread or its conversation, not by streamed text', () => {
  const store = { state: room() };
  const headers = threadHeaders(store);
  const before = headers.of('c');
  assert.equal(headers.of('c'), before, 'kept');
  assert.deepEqual(headers.note({ seq: 1, type: 'item.text', data: { threadId: 'c', id: 'a1', text: 'x' } }), []);
  apply(store.state, 'item.patch', { threadId: 'c', id: 'u1', patch: { replies: 3 } });
  assert.deepEqual(headers.note({ seq: 2, type: 'item.patch', data: { threadId: 'c', id: 'u1' } }).sort(), ['c', 'sd', 'tp']);
  assert.equal(headers.of('tp')?.root?.replies, 3);
  assert.deepEqual(headers.changedSince(1).sort(), ['c', 'sd', 'tp']);
  assert.deepEqual(headers.changedSince(2), []);
});

test('the stream sends a thread’s header after the event that changed it, and the ones a reconnecting page missed', () => {
  let listener = (/** @type {any} */ _ev) => {};
  const state = room();
  const events = [{ seq: 1, type: 'item.add', data: { threadId: 'c', item: { id: 'u2', kind: 'user', at: 60 } } }];
  const store = { epoch: 'ep', status: {}, state, subscribe: (f) => (listener = f), since: () => events, onStatus() {}, onReload() {} };
  const live = liveStreams(/** @type {any} */ (store));
  try {
    const out = [];
    live.streams.add(/** @type {any} */ ({ write: (/** @type {string} */ s) => out.push(s) }));
    apply(state, events[0].type, events[0].data);
    listener(events[0]);
    const frames = out.join('').split('\n\n').filter(Boolean);
    assert.match(frames[0], /^id: 1\nevent: item.add/);
    const header = frames.find((f) => f.includes('"threadId":"c"') && f.startsWith('event: header'));
    assert.ok(header, 'the conversation’s header follows its event');
    assert.equal(JSON.parse(header.split('data: ')[1]).header.lastAt, 60);

    const backlog = [];
    live.stream(
      /** @type {any} */ ({ headers: {}, on() {} }),
      /** @type {any} */ ({ writeHead() {}, write: (/** @type {string} */ s) => backlog.push(s) }),
      new URL('http://x/api/stream?since=0'),
    );
    assert.match(backlog.join(''), /event: header\ndata: \{"threadId":"c"/, 'a page back from seq 0 gets the header it missed');
  } finally {
    live.stop();
  }
});
