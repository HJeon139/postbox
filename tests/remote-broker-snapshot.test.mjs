// The daemon’s broker (server/remote/host/broker.mjs, #120), driven in-process: the snapshot and its reading tools. A
// shim is a pair of functions, Postbox is a list of what the broker sent it, and the turn folders are in a temp home
// (tests/remote-broker-fixtures.mjs). Nothing is spawned; the real daemon, runner and shim are in
// tests/integration/remote-broker.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { readConversation, readMessage } from '../server/remote/host/broker.mjs';
import { Runtime } from '../server/runtime.mjs';
import { READING } from '../shared/limits.mjs';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { connectShim, makeBroker, makeHome } from './remote-broker-fixtures.mjs';

// ── The snapshot and its reading tools ──

/** A snapshot thread of n items, with every 4th one empty (an item read_conversation leaves out). */
const itemsOf = (th, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${th}_${i}`,
    line: i % 4 === 3 ? '' : `line ${i} of ${th}`,
    text: i === 5 ? 'L'.repeat(READING.part * 2 + 17) : i % 4 === 3 ? '' : `full ${i} of ${th}`,
    ...(i === 2 ? { blockId: `blk_${th}` } : {}),
  }));

test('read_conversation and read_message from a snapshot match server/runtime.mjs’s, case for case', () => {
  const snap = {
    home: 'th_home',
    threads: [
      { id: 'th_home', items: itemsOf('th_home', 260) },
      { id: 'th_side', items: itemsOf('th_side', 3) },
      { id: 'th_empty', items: [] },
    ],
  };
  // runtime.mjs’s own methods, over a store that holds the same items, so the paging and the words are its.
  const store = {
    items: (th) =>
      snap.threads.find((t) => t.id === th)?.items.map((i) => ({ ...i, ...(i.blockId ? { kind: 'block', valid: true, block: { id: i.blockId } } : {}) })) ?? [],
    item: (th, id) => store.items(th).find((i) => i.id === id),
  };
  const rt = {
    store,
    conversationThreads: () => snap.threads.map((t) => t.id),
    readLine: (i, _se, n = READING.item) => (n === Number.POSITIVE_INFINITY ? i.text : i.line) || null,
  };
  const se = { threadId: 'th_home', id: 's1', handle: 'dev' };
  const laptopConversation = (args) => {
    try {
      return { ok: true, text: Runtime.prototype.readConversation.call(rt, se, args) };
    } catch (e) {
      return { ok: false, text: e.message };
    }
  };
  const laptopMessage = (args) => {
    const r = Runtime.prototype.readMessage.call(rt, se, args);
    return { ok: r.ok, text: r.message };
  };
  const conversations = [
    {},
    { limit: 10 },
    { limit: 0 },
    { limit: 500 },
    { limit: -3 },
    { limit: 'x' },
    { skip: 30 },
    { skip: 255, limit: 10 },
    { skip: 1000 },
    { skip: -5 },
    { thread: 'th_side' },
    { thread: '  th_side  ' },
    { thread: 'th_empty' },
    { thread: 'th_nope' },
    { thread: '' },
    { thread: 7 },
    { limit: null, skip: null },
  ];
  for (const args of conversations) assert.deepEqual(readConversation(snap, args), laptopConversation(args), JSON.stringify(args));
  const messages = [
    { id: 'th_home_0' },
    { id: ' th_side_1 ' },
    { id: 'th_home_3' },
    { id: 'th_home_5' },
    { id: 'th_home_5', from: READING.part },
    { id: 'th_home_5', from: READING.part * 2 },
    { id: 'th_home_5', from: READING.part * 3 },
    { id: 'th_home_5', from: -10 },
    { id: 'th_home_5', from: 'x' },
    { id: 'blk_th_side' },
    { id: 'nope' },
    { id: '' },
    {},
  ];
  for (const args of messages) assert.deepEqual(readMessage(snap, args), laptopMessage(args), JSON.stringify(args));
  // Two blocks with one ID: the laptop names their agents, which the snapshot doesn’t carry, so it names the items.
  const twice = {
    home: 'a',
    threads: [
      {
        id: 'a',
        items: [
          { id: 'i1', line: 'x', text: 'x', blockId: 'b' },
          { id: 'i2', line: 'y', text: 'y', blockId: 'b' },
        ],
      },
    ],
  };
  assert.deepEqual(readMessage(twice, { id: 'b' }), { ok: false, text: 'More than one block is called “b”: they’re the items i1, i2. Read one by that id.' });
});

test('the snapshot: kept until start, written 0600 into the folder, updated by snapshot-items, and read by the shim’s calls', async () => {
  const h = makeHome();
  try {
    const k = makeBroker(h);
    const snap = { turn: 't1', home: 'th', threads: [{ id: 'th', items: [{ id: 'i1', line: 'You: hi', text: 'You: hi' }] }] };
    assert.equal((await k.post('snapshot', snap)).took, true);
    assert.equal((await k.post('snapshot-items', { turn: 't1', thread: 'th', items: [{ id: 'i2', line: '@dev: yo', text: '@dev: yo' }] })).errors.length, 0);
    h.turn('t1');
    await k.b.starting('t1');
    const path = h.p.turn('t1', TURN_FILES.snapshot);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(path, 'utf8')).threads[0].items.map((i) => i.id),
      ['i1', 'i2'],
    );
    // An existing ID is replaced in place; a new thread is added.
    await k.post('snapshot-items', { turn: 't1', thread: 'th', items: [{ id: 'i1', line: 'You: hello', text: 'You: hello' }] });
    await k.post('snapshot-items', { turn: 't1', thread: 'th_side', items: [{ id: 's1', line: 'aside', text: 'aside' }] });
    // A new broker reads the file: the daemon restarted.
    const again = makeBroker(h);
    const s = connectShim(again.b, 't1');
    await s.next('welcome');
    assert.deepEqual(await s.call('c1', 'read_conversation', {}), { type: 'result', id: 'c1', ok: true, text: 'You: hello\n\n@dev: yo' });
    assert.equal((await s.call('c2', 'read_conversation', { thread: 'th_side' })).text, 'aside');
    assert.deepEqual(await s.call('c3', 'read_message', { id: 'nope' }), {
      type: 'result',
      id: 'c3',
      ok: false,
      text: 'There’s no item “nope” in this conversation. Your history and read_conversation give the id of each item they cut.',
    });
    assert.deepEqual(again.sent, [], 'reading tools never cross to Postbox');
    // No snapshot yet: the call says so, and snapshot-items is refused.
    h.turn('t2');
    const s2 = connectShim(again.b, 't2');
    await s2.next('welcome');
    const none = await s2.call('c1', 'read_message', { id: 'i1' });
    assert.equal(none.ok, false);
    assert.match(none.text, /^Postbox hasn’t sent this host the conversation yet/);
    assert.equal((await again.post('snapshot-items', { turn: 't2', thread: 'th', items: [] })).errors[0].code, 'no-turn');
  } finally {
    h.done();
  }
});
