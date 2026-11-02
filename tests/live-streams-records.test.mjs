import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveStreams } from '../server/live-streams.mjs';

const secret = {
  operation: 'open',
  record: { id: 'rec_private', parts: [{ text: 'private recipient words' }], pins: ['private pin'], receipts: ['private receipt'] },
};

test('private events become cursors on both live and backlog streams, without changing stored history', () => {
  const events = [
    { seq: 1, type: 'record', data: secret },
    { seq: 2, type: 'item.patch', data: { threadId: 't', id: 'i', patch: { text: 'Public update' } } },
    { seq: 3, type: 'record.close', data: { id: 'rec_private', final: 'withdrawn' } },
  ];
  let listener;
  const store = { epoch: 'ep_test', state: { seq: 3 }, subscribe: (f) => (listener = f), since: () => events, onStatus() {}, onReload() {} };
  const streams = liveStreams(store);
  try {
    const backlog = [];
    const res = { writeHead() {}, write: (s) => backlog.push(s) };
    streams.stream({ headers: {}, on() {} }, res, new URL('http://localhost/api/stream?since=0'));
    assert.match(backlog.join(''), /id: 1\nevent: cursor\ndata: \{\}/);
    assert.match(backlog.join(''), /id: 2\nevent: item.patch/);
    assert.match(backlog.join(''), /id: 3\nevent: cursor/);
    assert.doesNotMatch(backlog.join(''), /private|parts|pins|receipts/);
    const live = [];
    streams.streams.clear();
    streams.streams.add({ write: (s) => live.push(s) });
    for (const ev of events) listener(ev);
    assert.equal(live.join(''), backlog.slice(1).join(''));
    assert.equal(store.since(0)[0].data, secret, 'internal history stays private and unprojected');
  } finally {
    streams.stop();
  }
});
