// A stream send held back (POSTBOX_STREAM_LAG) past a Retry says nothing (server/live-streams.mjs; the 1b invariants,
// I6; gpt’s finding on 1b): the event belongs to the history it was made in, and a stream connected after the Retry has
// loaded the recovered state, which that event is not part of.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveStreams } from '../server/live-streams.mjs';
import { Store } from '../server/store.mjs';

test('an event whose send was held back is dropped once the store runs on another epoch', async () => {
  process.env.POSTBOX_STREAM_LAG = '30';
  try {
    const store = new Store(null);
    const live = liveStreams(store);
    const written = [];
    live.streams.add(/** @type {any} */ ({ write: (s) => written.push(String(s)) }));
    store.emit('thread', { id: 'before', members: [] });
    store.epoch = store.newEpoch(); // Retry installed a recovered state meanwhile
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(written, [], 'nothing from the old history reached the stream');
    store.emit('thread', { id: 'after', members: [] });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(written.length, 1, 'an event of the current history does');
    live.stop();
  } finally {
    delete process.env.POSTBOX_STREAM_LAG;
  }
});
