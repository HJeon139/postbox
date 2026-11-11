// A stream whose page has stopped reading is closed, rather than kept for good (#1210). Each frame written to it waits in
// its response’s buffer, as a string on the heap, until the page reads: a tab the browser froze in the background never
// does, so at the person’s rate (about 14 events a second, 1.85 KB a line) one such tab held about 1 GB more per 11 hours.
// Closed, the page’s EventSource reconnects when it runs again, with its Last-Event-ID, and gets what it missed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { liveStreams, UNREAD_MS } from '../server/live-streams.mjs';

/** A store with one listener, which the test calls as the store would on each event. */
function fakeStore() {
  const store = {
    epoch: 'ep',
    status: {},
    state: { seq: 0 },
    listener: (/** @type {any} */ _ev) => {},
    subscribe: (/** @type {any} */ f) => (store.listener = f),
    since: () => [],
    onStatus() {},
    onReload() {},
  };
  return store;
}

/** A response whose page reads only when the test says: write returns false once its buffer is past Node’s mark. */
function fakeResponse() {
  const res = Object.assign(new EventEmitter(), {
    frames: /** @type {string[]} */ ([]),
    unread: 0,
    destroyed: false,
    writeHead() {},
    write(/** @type {string} */ s) {
      res.frames.push(s);
      res.unread += s.length;
      return res.unread < 16384;
    },
    destroy() {
      res.destroyed = true;
    },
    /** The page reads everything waiting. */
    read() {
      res.unread = 0;
      res.emit('drain');
    },
  });
  return res;
}

const event = (seq) => ({ seq, type: 'item.text', data: { threadId: 't', id: 'i', text: 'x'.repeat(20000) } });

test('#1210 a stream whose page hasn’t read for UNREAD_MS is closed at the next frame, and gets no more', () => {
  let now = 0;
  const store = fakeStore();
  const live = liveStreams(/** @type {any} */ (store), undefined, { now: () => now });
  try {
    const res = fakeResponse();
    live.stream(/** @type {any} */ ({ headers: {}, on() {} }), /** @type {any} */ (res), new URL('http://localhost/api/stream'));
    store.listener(event(1)); // past the mark: the page is behind from here
    now = UNREAD_MS - 1;
    store.listener(event(2));
    assert.equal(res.destroyed, false, 'behind for less than UNREAD_MS, it stays open');
    const written = res.frames.length;
    now = UNREAD_MS;
    store.listener(event(3));
    assert.equal(res.destroyed, true, 'behind for UNREAD_MS, it’s closed');
    assert.equal(res.frames.length, written, 'and the frame isn’t added to what it holds');
    assert.equal(live.streams.has(/** @type {any} */ (res)), false);
  } finally {
    live.stop();
  }
});

test('#1210 a page that reads again in time keeps its stream, and its clock starts over', () => {
  let now = 0;
  const store = fakeStore();
  const live = liveStreams(/** @type {any} */ (store), undefined, { now: () => now });
  try {
    const res = fakeResponse();
    live.stream(/** @type {any} */ ({ headers: {}, on() {} }), /** @type {any} */ (res), new URL('http://localhost/api/stream'));
    store.listener(event(1));
    now = UNREAD_MS - 1;
    res.read();
    store.listener(event(2)); // behind again, from now
    now = 2 * UNREAD_MS - 2;
    store.listener(event(3));
    assert.equal(res.destroyed, false);
    assert.ok(res.frames.at(-1)?.startsWith('id: 3\n'), 'the frame reached it');
  } finally {
    live.stop();
  }
});
