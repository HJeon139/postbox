import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveStreams } from '../server/live-streams.mjs';
import { EVENTS } from '../shared/state.mjs';

// A private type for the test: none exists on main yet, so the table is passed in with one added.
const TABLE = { ...EVENTS, secret: { apply: () => {}, public: false } };

test('live and backlog frames are the same public projection: a private event becomes a cursor with its seq', () => {
  const events = [
    { seq: 1, type: 'secret', data: { words: 'private recipient words' } },
    { seq: 2, type: 'item.patch', data: { threadId: 't', id: 'i', patch: { text: 'Public update' } } },
    { seq: 3, type: 'secret', data: { words: 'private again' } },
  ];
  let listener = (_ev) => {};
  const store = {
    epoch: 'ep_test',
    status: { writes: 'open' },
    state: { seq: 3 },
    subscribe: (f) => (listener = f),
    since: () => events,
    onStatus() {},
    onReload() {},
  };
  const streams = liveStreams(/** @type {any} */ (store), TABLE);
  try {
    const backlog = [];
    const res = { writeHead() {}, write: (s) => backlog.push(s) };
    streams.stream(/** @type {any} */ ({ headers: {}, on() {} }), /** @type {any} */ (res), new URL('http://localhost/api/stream?since=0'));
    const frames = backlog.slice(1);
    assert.deepEqual(frames, [
      'id: 1\nevent: cursor\ndata: {}\n\n',
      `id: 2\nevent: item.patch\ndata: ${JSON.stringify(events[1].data)}\n\n`,
      'id: 3\nevent: cursor\ndata: {}\n\n',
    ]);
    const live = [];
    streams.streams.clear();
    streams.streams.add(/** @type {any} */ ({ write: (s) => live.push(s) }));
    for (const ev of events) listener(ev);
    assert.deepEqual(live, frames, 'live frames are the backlog’s');
    assert.doesNotMatch(backlog.join('') + live.join(''), /private/);
  } finally {
    streams.stop();
  }
});

test('the stream’s first frames name the epoch and the store’s status by the reserved names', () => {
  const store = { epoch: 'ep_x', status: { writes: 'open' }, state: { seq: 0 }, subscribe() {}, since: () => [], onStatus() {}, onReload() {} };
  const streams = liveStreams(/** @type {any} */ (store));
  try {
    const out = [];
    streams.stream(
      /** @type {any} */ ({ headers: {}, on() {} }),
      /** @type {any} */ ({ writeHead() {}, write: (s) => out.push(s) }),
      new URL('http://localhost/api/stream'),
    );
    assert.equal(out[0], `retry: 1500\n\nevent: epoch\ndata: "ep_x"\n\nevent: status\ndata: {"writes":"open"}\n\n`);
  } finally {
    streams.stop();
  }
});
