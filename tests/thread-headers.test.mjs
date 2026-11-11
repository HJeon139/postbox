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

/** Applies an event to the store’s state and tells the headers, as the store’s subscribers hear it. */
function emitter(/** @type {any} */ store, /** @type {any} */ headers) {
  let seq = 0;
  return (/** @type {string} */ type, /** @type {any} */ data) => {
    apply(store.state, type, data);
    return headers.note({ seq: ++seq, type, data }).map((/** @type {any} */ c) => c.threadId);
  };
}

test('kept current from each event, every header matches a walk of the thread whole', () => {
  const store = { state: room() };
  const headers = threadHeaders(store);
  headers.all();
  const emit = emitter(store, headers);
  const same = (/** @type {string} */ when) => {
    for (const id of Object.keys(store.state.threads)) assert.deepEqual(headers.of(id), headerOf(store.state, id), `${id} ${when}`);
  };
  same('at first');
  emit('item.add', { threadId: 'c', item: { id: 'a2', kind: 'agent', handle: 'bo', sessionId: 's2', at: 60 } });
  emit('item.add', { threadId: 'c', item: { id: 'b3', kind: 'block', sessionId: 's2', valid: true, block: { type: 'choice' }, at: 61 } });
  same('after adds');
  emit('item.patch', { threadId: 'c', id: 'b1', patch: { answered: true } });
  emit('item.patch', { threadId: 'c', id: 'u1', patch: { replies: 5, lastReplyAt: 70 } });
  emit('item.patch', { threadId: 'c', id: 'l1', patch: { count: 9, lastAt: 71 } });
  same('after patches');
  emit('item.move', { threadId: 'c', id: 'b3', stub: { id: 'st1', kind: 'moved', at: 61 }, patch: { at: 80 } });
  same('after a move');
  emit('thread', { id: 'tp2', kind: 'topic', parentId: 'c', rootItemId: 'a2', createdAt: 90 });
  emit('item.add', { threadId: 'tp2', item: { id: 'r1', kind: 'agent', handle: 'ada', at: 91 } });
  emit('item.patch', { threadId: 'c', id: 'a2', patch: { replies: 1, lastReplyAt: 91 } });
  emit('thread', { id: 'sd2', kind: 'side', parentId: 'c', createdAt: 92 });
  emit('item.add', { threadId: 'c', item: { id: 'l2', kind: 'sidelink', sideThreadId: 'sd2', count: 1, at: 93 } });
  same('after new threads');
  assert.deepEqual(emit('remove', { kind: 'thread', id: 'sd2' }), ['sd2']);
  assert.equal(headers.of('sd2'), null);
});

test('only a header the event changed is sent, and a topic or side thread only when the event names its item', () => {
  const store = { state: room() };
  const headers = threadHeaders(store);
  headers.all();
  const emit = emitter(store, headers);
  assert.deepEqual(emit('item.text', { threadId: 'c', id: 'a1', text: 'x' }), [], 'streamed text changes none');
  assert.deepEqual(emit('item.patch', { threadId: 'c', id: 'a1', patch: { text: 'more words' } }), [], 'a patch that changes no fact');
  assert.deepEqual(emit('item.add', { threadId: 'c', item: { id: 'u9', kind: 'user', at: 99 } }), ['c'], 'not the topic or side thread');
  assert.deepEqual(emit('item.patch', { threadId: 'c', id: 'u1', patch: { replies: 3 } }), ['tp'], 'the topic’s root');
  assert.deepEqual(emit('item.patch', { threadId: 'c', id: 'l1', patch: { count: 5 } }), ['sd'], 'the side thread’s link');
  assert.deepEqual(
    headers
      .changedSince(3)
      .map((c) => c.threadId)
      .sort(),
    ['sd', 'tp'],
  );
});

test('clear() counts every header again, and trimming lets go of seqs no stream can still ask for', () => {
  const store = { state: room(), events: /** @type {{ seq: number }[]} */ ([]) };
  const headers = threadHeaders(store);
  headers.all();
  const emit = emitter(store, headers);
  emit('item.add', { threadId: 'c', item: { id: 'u9', kind: 'user', at: 99 } });
  store.state.items.c.push({ id: 'unseen', kind: 'user', at: 100 }); // as a rejected event’s handler might
  headers.clear();
  assert.equal(headers.of('c')?.count, 7, 'counted again from the items');
  assert.deepEqual(headers.changedSince(0), [], 'nothing kept for streams; a rejected event resyncs them');
  for (let i = 0; i < 1000; i++) emit('item.patch', { threadId: 'c', id: 'b1', patch: { answered: i % 2 === 0 } });
  store.events = [{ seq: 1000 }];
  for (let i = 0; i < 1000; i++) emit('item.text', { threadId: 'c', id: 'a1', text: 'x' });
  assert.deepEqual(
    headers.changedSince(0).map((c) => c.threadId),
    ['c'],
    'a seq still in the store’s backlog stays',
  );
  store.events = [{ seq: 5000 }];
  for (let i = 0; i < 1000; i++) emit('item.text', { threadId: 'c', id: 'a1', text: 'x' });
  assert.deepEqual(headers.changedSince(0), [], 'one older than the backlog goes');
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
