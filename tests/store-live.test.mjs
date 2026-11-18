// A live frame takes the store’s one held FIFO (designs/architecture/live-progress.md, “Order”): with nothing held it’s
// heard at once; while a commit is in flight it waits as an unnumbered job, and comes out in the order it was made
// among the held emits, never numbered, applied or written; an emit made while it waits waits behind it; and a write
// that fails releases it with the held emits.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { onLive, sendLive } from '../server/store-live.mjs';
import { tempDir } from './temp-dirs.mjs';

/** What the store’s listeners hear, stored events and live frames together, in order. @param {any} store */
function hear(store) {
  /** @type {string[]} */
  const heard = [];
  store.subscribe((/** @type {any} */ ev) => heard.push(`${ev.type} ${ev.data?.id ?? ''}`.trim()));
  onLive(store, (/** @type {any} */ f) => heard.push(`live ${f.n}`));
  return heard;
}

const thread = (/** @type {string} */ id) => ({ id, projectId: 'p1', title: id, members: [] });

test('with nothing held, a live frame is heard at once, and is never numbered, applied or written', async () => {
  const dir = tempDir('pb-live-');
  const store = await new Store(dir).load();
  const heard = hear(store);
  const seq = store.state.seq;
  sendLive(store, { kind: 'session', n: 1 });
  assert.deepEqual(heard, ['live 1']);
  assert.equal(store.state.seq, seq, 'not numbered');
  await store.close();
  const log = readdirSync(dir)
    .filter((n) => n.startsWith('events-'))
    .map((n) => readFileSync(join(dir, n), 'utf8'))
    .join('');
  assert.ok(!log.includes('"kind":"session"'), 'not written');
});

test('while a commit is in flight, live frames wait in the held FIFO and come out in the order they were made', async () => {
  const store = await new Store(tempDir('pb-live-')).load();
  const heard = hear(store);
  const committing = store.commit([{ type: 'thread', data: thread('th_c') }]);
  store.emit('thread', thread('th_a'));
  sendLive(store, { kind: 'session', n: 1 });
  store.emit('thread', thread('th_b'));
  sendLive(store, { kind: 'session', n: 2 });
  assert.deepEqual(heard, [], 'all held behind the commit');
  await committing;
  await store.flush();
  assert.deepEqual(heard, ['thread th_c', 'thread th_a', 'live 1', 'thread th_b', 'live 2']);
  await store.close();
});

test('an emit made while a live frame waits waits behind it, so it can’t overtake the frame', async () => {
  const store = await new Store(tempDir('pb-live-')).load();
  const heard = hear(store);
  const committing = store.commit([{ type: 'thread', data: thread('th_c') }]);
  sendLive(store, { kind: 'session', n: 1 });
  await committing;
  // The commit has settled; the frame may still wait in the queue. An emit now goes behind it either way.
  store.emit('thread', thread('th_after'));
  await store.flush();
  assert.ok(heard.indexOf('live 1') < heard.indexOf('thread th_after'), heard.join(', '));
  await store.close();
});

test('a write that fails releases the waiting live frames with the held emits, in order', async () => {
  const store = await new Store(tempDir('pb-live-')).load();
  const heard = hear(store);
  const error = console.error;
  console.error = () => {};
  try {
    store.held++; // as an emit held behind a commit leaves it
    store.queue.push({ held: { type: 'thread', data: thread('th_h') }, json: JSON.stringify({ type: 'thread', data: thread('th_h') }) });
    store.heldLog.push(store.queue.at(-1));
    sendLive(store, { kind: 'session', n: 1 });
    store.fail(new Error('The disk is full.'));
    assert.deepEqual(heard, ['thread th_h', 'live 1']);
    assert.equal(store.heldLive, 0);
  } finally {
    console.error = error;
  }
});
