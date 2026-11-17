// Live frames on the pages’ streams (designs/architecture/live-progress.md, “Order” and “What reaches the browser”):
// each page gets a frame through its own projection, an item’s only with its conversation open and a session’s on every
// stream, in order with the events, through the same lag.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveStreams } from '../server/live-streams.mjs';
import { Store } from '../server/store.mjs';
import { sendLive } from '../server/store-live.mjs';

/** A page’s stream with `open` conversations open: the frames it’s sent, as event names. @param {any} ls @param {any} store @param {string} [open] */
function tab(ls, store, open) {
  /** @type {string[]} */
  const got = [];
  const res = {
    writeHead() {},
    /** @param {string} s */
    write(s) {
      for (const m of s.matchAll(/event: (\S+)\ndata: (.*)\n\n/g))
        if (m[1] !== 'epoch' && m[1] !== 'status') got.push(m[1] === 'live' ? `live ${JSON.parse(m[2]).kind}` : m[1]);
      return true;
    },
    destroy() {},
    once() {},
  };
  const q = `since=${store.state.seq}&epoch=${encodeURIComponent(store.epoch)}${open === undefined ? '' : `&open=${open}`}`;
  ls.stream(/** @type {any} */ ({ headers: {}, on() {} }), /** @type {any} */ (res), new URL(`http://127.0.0.1/api/stream?${q}`));
  return got;
}

test('a page gets an item’s live frames only with its conversation open, and a session’s on every stream', async () => {
  const store = await new Store(null).load();
  const ls = liveStreams(store, undefined, { running: { all: () => [] } });
  const open = tab(ls, store, 'th_1');
  const closed = tab(ls, store, 'th_2');
  const tool = tab(ls, store);
  sendLive(store, { kind: 'step', threadId: 'th_1', itemId: 'it_1', turnId: 'tu_1', rev: 1, step: { id: 's1', label: 'Read' } });
  sendLive(store, { kind: 'session', sessionId: 'se_1', currentStep: 'Read' });
  assert.deepEqual(open, ['live step', 'live session']);
  assert.deepEqual(closed, ['live session']);
  assert.deepEqual(tool, ['live step', 'live session']);
  ls.stop();
});

test('live frames reach a page in order with the events, through the same lag', async () => {
  const before = process.env.POSTBOX_STREAM_LAG;
  process.env.POSTBOX_STREAM_LAG = '20';
  try {
    const store = await new Store(null).load();
    const ls = liveStreams(store, undefined, { running: { all: () => [] } });
    const got = tab(ls, store, 'th_1');
    store.emit('thread', { id: 'th_1', projectId: 'p1', title: 'T', members: [] });
    sendLive(store, { kind: 'session', sessionId: 'se_1', currentStep: 'Read' });
    store.emit('thread', { id: 'th_1', projectId: 'p1', title: 'T2', members: [] });
    assert.deepEqual(got, [], 'held back by the lag');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(
      got.filter((x) => x !== 'header'),
      ['thread', 'live session', 'thread'],
    );
    ls.stop();
  } finally {
    if (before === undefined) delete process.env.POSTBOX_STREAM_LAG;
    else process.env.POSTBOX_STREAM_LAG = before;
  }
});
