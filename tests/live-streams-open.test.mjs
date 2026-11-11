// The page’s stream sends item events only for the conversations it has open (#1155): an item’s change anywhere else
// goes out as a cursor, and the thread’s header frame says what the page shows of it. Every other event still flows,
// and a tool’s stream, which names no open conversations, gets every item event as before. /api/state carries no items.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveStreams } from '../server/live-streams.mjs';
import { pageState } from '../server/page-state.mjs';
import { apply, emptyState } from '../shared/state.mjs';

/** A store with two conversations, whose events the test sends by hand. */
function fakeStore() {
  const state = emptyState();
  apply(state, 'thread', { id: 'here', kind: 'room' });
  apply(state, 'thread', { id: 'away', kind: 'room' });
  /** @type {(ev: any) => void} */
  let listener = () => {};
  const store = { epoch: 'ep', status: {}, state, subscribe: (/** @type {any} */ f) => (listener = f), since: () => [], onStatus() {}, onReload() {} };
  const emit = (/** @type {number} */ seq, /** @type {string} */ type, /** @type {any} */ data) => {
    apply(state, type, data);
    listener({ seq, type, data });
  };
  return { store, emit };
}

/** A stream opened through the router’s handler, with the frames written to it, by event name. */
function open(live, query) {
  const frames = [];
  const res = { writeHead() {}, write: (/** @type {string} */ s) => frames.push(s) };
  live.stream(/** @type {any} */ ({ headers: {}, on() {} }), /** @type {any} */ (res), new URL(`http://x/api/stream?since=0${query}`));
  live.streams.add(res);
  const names = () =>
    frames
      .join('')
      .split('\n\n')
      .map((f) => /^(?:id: (\d+)\n)?event: (\S+)/m.exec(f))
      .filter(Boolean)
      .map((m) => (m?.[1] ? `${m[1]}:${m?.[2]}` : m?.[2]));
  return { names };
}

test('a page’s stream sends item events only for its open conversations; a tool’s, every one', () => {
  const { store, emit } = fakeStore();
  const live = liveStreams(/** @type {any} */ (store));
  try {
    const page = open(live, '&open=here');
    const tool = open(live, '');
    emit(1, 'item.add', { threadId: 'here', item: { id: 'a', kind: 'user', at: 1 } });
    emit(2, 'item.add', { threadId: 'away', item: { id: 'b', kind: 'user', at: 2 } });
    emit(3, 'session', { id: 's', threadId: 'away' });
    const seen = page.names().filter((n) => n !== 'epoch' && n !== 'status');
    assert.deepEqual(seen, ['1:item.add', 'header', '2:cursor', 'header', '3:session'], 'away’s item is a cursor, then its header');
    assert.deepEqual(
      tool.names().filter((n) => n.includes(':')),
      ['1:item.add', '2:item.add', '3:session'],
    );
  } finally {
    live.stop();
  }
});

test('/api/state carries each thread’s header and no conversation’s items', () => {
  const { store, emit } = fakeStore();
  const live = liveStreams(/** @type {any} */ (store));
  try {
    emit(1, 'item.add', { threadId: 'away', item: { id: 'b', kind: 'user', at: 2, text: 'history' } });
    const rt = { localBackends: () => [], config: { telemetryRoot: 'x' }, store };
    const adapters = { names: () => [], get: () => ({}), runsHere: () => true };
    const answer = pageState(
      /** @type {any} */ ({ store, rt, adapters, origin: '', demo: false, real: null, config: {}, corpus: { stats: () => ({}) }, headers: live.headers }),
    );
    assert.deepEqual(answer.state.items, {});
    assert.equal(answer.headers.away.count, 1);
    assert.doesNotMatch(JSON.stringify(answer), /history/);
  } finally {
    live.stop();
  }
});

test('a held-back event goes out as it was, not as the store has it by the time it’s sent', async () => {
  // POSTBOX_STREAM_LAG holds each send back, as CI's browser run does; the item's text streams in meanwhile.
  process.env.POSTBOX_STREAM_LAG = '20';
  const { store, emit } = fakeStore();
  const live = liveStreams(/** @type {any} */ (store));
  delete process.env.POSTBOX_STREAM_LAG;
  try {
    const frames = [];
    const res = { writeHead() {}, write: (/** @type {string} */ s) => frames.push(s) };
    live.stream(/** @type {any} */ ({ headers: {}, on() {} }), /** @type {any} */ (res), new URL('http://x/api/stream?since=0&open=here'));
    live.streams.add(res);
    emit(1, 'item.add', { threadId: 'here', item: { id: 'r', kind: 'agent', at: 1, text: '' } });
    emit(2, 'item.text', { threadId: 'here', id: 'r', text: 'Done.' });
    await new Promise((r) => setTimeout(r, 60));
    const add = frames
      .join('')
      .split('\n\n')
      .find((f) => f.startsWith('id: 1\nevent: item.add'));
    assert.equal(JSON.parse(add?.split('data: ')[1] ?? '{}').item.text, '', 'the text comes once, with item.text');
  } finally {
    live.stop();
  }
});
