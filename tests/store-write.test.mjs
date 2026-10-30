// The store’s optimistic write loop (server/store-write.mjs) on its Redis child when Redis refuses a batch for a reason no
// retry changes (server/store-reject.mjs; gpt’s r2 review of #553, blocker 1): the store fails closed, with the batch
// queued and nothing tried again on its own; Retry saves the batch’s events Redis takes, one at a time, then reads
// Redis back, so memory equals what’s saved and the pages resync. A refusal a retry can change (out of memory) keeps the
// fail-closed retry: tests/store-consistency.test.mjs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { liveStreams } from '../server/live-streams.mjs';
import { retry } from '../server/store-recover.mjs';
import { consistent, open, raw, tmp } from './store-fixture.mjs';

/** A value nested n levels deep. @param {number} n */
const nested = (n) => {
  let v = /** @type {any} */ (1);
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
};

/**
 * Makes an EVAL carry a document RedisJSON refuses (nested past its limit): a poison the store’s own check
 * (server/store-check.mjs) can’t see, standing in for a key of the wrong type or a script error. With `key`, every EVAL
 * that sets that document is poisoned, as a document Redis won’t ever hold; without, only the next EVAL’s first document,
 * as gpt’s regression does.
 * @param {import('../server/store.mjs').Store} s @param {string} [key]
 */
function poison(s, key) {
  const client = /** @type {any} */ (s).client;
  const call = client.call.bind(client);
  let once = true;
  client.call = async (...a) => {
    if (a[0] === 'EVAL') {
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== 'S') continue;
        if (key ? a[i + 1] === key : once) {
          once = false;
          a[i + 2] = JSON.stringify(nested(200));
          break;
        }
      }
    }
    return call(...a);
  };
  return client;
}

/** A page’s stream on the store: the event names it got, the status line aside. @param {import('../server/store.mjs').Store} s */
async function page(s) {
  const live = liveStreams(s);
  const req = /** @type {any} */ (Object.assign(new EventEmitter(), { headers: {} }));
  const written = [];
  const res = /** @type {any} */ ({ writeHead() {}, write: (x) => written.push(String(x)) });
  await live.stream(req, res, new URL(`http://x/api/stream?since=${s.state.seq}`));
  return {
    stop: live.stop,
    frames: () =>
      written
        .join('')
        .split('\n\n')
        .map((f) => /^event: (\S+)/m.exec(f)?.[1])
        .filter((f) => f && f !== 'store'),
  };
}

// gpt’s regression: the store dropped the batch and reopened writes, with a message visible in memory but gone after a
// restart.
test('a batch Redis refuses for good closes writes, keeps the batch, and tries nothing again on its own', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  const errors = [];
  const { error } = console;
  console.error = (m) => errors.push(String(m));
  let evals = 0;
  try {
    const client = poison(s);
    const call = client.call;
    client.call = (...a) => {
      if (a[0] === 'EVAL') evals++;
      return call(...a);
    };
    s.emit('item.add', { threadId: 't', item: { id: 'message', kind: 'user', text: 'keep my message', at: 1 } });
    s.emit('project', { id: 'innocent', name: 'same batch' });
    await s.flush();
    // A retry on a timer would be the loop the integrator saw: nothing happens on its own.
    await new Promise((ok) => setTimeout(ok, 600));
  } finally {
    console.error = error;
  }
  assert.equal(s.writable, false, 'a rejected batch must stay fail-closed until its state is repaired, not discard the message and reopen');
  assert.equal(evals, 1, 'the batch isn’t tried again on its own');
  assert.equal(s.retry, null, 'no retry waits');
  assert.equal(s.lines.length, 2, 'the batch stays queued');
  const status = /** @type {any} */ (s.status);
  assert.equal(status.state, 'down');
  assert.equal(status.cause, 'rejected');
  assert.match(status.message, /recursion limit/);
  assert.match(status.message, /item\.add .*message.* in t/, 'the status names the changes that may be the one refused');
  assert.match(status.message, /project innocent/);
  assert.match(status.message, /Retry/);
  assert.match(errors.join('\n'), /refused a write.*recursion limit/);
  assert.throws(
    () => s.emit('settings', { theme: 'light' }),
    (e) => e.code === 'ESTOREDOWN' && /refused/.test(e.message),
  );
  // Nothing of the batch reached Redis: the refusal was the whole script’s.
  const c = await raw(s);
  assert.equal(await c.call('GET', 'seq'), '1');
  c.close();
});

// gpt’s regression: a later commit, acknowledged by Redis, certified a state whose message Redis never held.
test('a later unrelated commit can’t certify state holding a refused change: it’s refused until Retry reloads Redis', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  const { error } = console;
  console.error = () => {};
  try {
    poison(s);
    s.emit('item.add', { threadId: 't', item: { id: 'message', kind: 'user', text: 'keep my message', at: 1 } });
    await s.flush();
    assert.equal(s.writable, false);
    await assert.rejects(s.commit([{ type: 'settings', data: { theme: 'dark' } }], 'after-poison'), (e) => e.code === 'ESTOREDOWN');
    assert.equal(s.state.items.t.length, 1, 'the refused change is still in memory while the store is closed');
    // Retry: the batch is written again (the poison was one EVAL’s, so Redis takes it now), then Redis is read back.
    const status = await retry(s);
    assert.equal(status.state, 'running');
    assert.equal(s.writable, true);
    const fresh = await open(/** @type {string} */ (s.dir));
    assert.deepEqual(fresh.state, s.state, 'after Retry, memory is what Redis holds');
    assert.equal(s.state.items.t[0].id, 'message', 'a change Redis takes on the retry is saved, not dropped');
    assert.equal(s.dropped, null);
  } finally {
    console.error = error;
  }
  await s.commit([{ type: 'settings', data: { theme: 'dark' } }], 'after-retry');
  await consistent(s);
});

/**
 * A store whose batch Redis refused for good, after Retry: event 2 and 4 touch the document Redis won’t hold, 3 and 5
 * don’t. With a page’s stream on it, and what its watchers and the log heard.
 */
async function repaired() {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  const p = await page(s);
  const statuses = [];
  s.watchers.add((_w, status) => statuses.push(status));
  const errors = [];
  const { error } = console;
  console.error = (m) => errors.push(String(m));
  try {
    poison(s, 'item:message'); // a document Redis won’t ever hold
    s.emit('item.add', { threadId: 't', item: { id: 'message', kind: 'user', text: 'keep my message', at: 1 } }); // 2
    s.emit('project', { id: 'innocent', name: 'same batch' }); // 3
    s.emit('item.patch', { threadId: 't', id: 'message', patch: { text: 'edited' } }); // 4: the same document, so refused with it
    s.emit('item.add', { threadId: 't', item: { id: 'fine', kind: 'user', text: 'another', at: 2 } }); // 5
    await s.flush();
    assert.equal(s.writable, false);
    assert.equal(s.lines.length, 4);
    await retry(s);
  } finally {
    console.error = error;
  }
  p.stop();
  return { s, p, statuses, errors };
}

test('Retry saves the batch’s other events, drops the refused ones, and reloads Redis, so memory is what Redis holds', async () => {
  const { s } = await repaired();
  assert.equal(s.writable, true);
  assert.equal(s.failed, null);
  assert.equal(s.lines.length, 0);
  // Redis has the unrelated events and their documents, in order, without the refused ones.
  const c = await raw(s);
  assert.deepEqual(
    (await c.call('XRANGE', 'events', '-', '+')).map(([id]) => id),
    ['1-0', '3-0', '5-0'],
    'the stream has the events Redis took',
  );
  assert.equal(await c.call('GET', 'seq'), '5');
  assert.equal(JSON.parse(await c.call('JSON.GET', 'project:innocent', '$'))[0].d.name, 'same batch');
  assert.equal(await c.call('JSON.GET', 'item:message', '$'), null, 'the refused document isn’t there');
  assert.equal(JSON.parse(await c.call('JSON.GET', 'item:fine', '$'))[0].d.text, 'another');
  c.close();
  // Memory is what Redis holds: the refused message is gone from it too.
  assert.deepEqual(
    s.state.items.t.map((it) => it.id),
    ['fine'],
  );
  assert.equal(s.state.projects.innocent.name, 'same batch');
  assert.equal(s.state.seq, 5);
  const { fresh } = await consistent(s);
  assert.deepEqual(s.state, fresh.state, 'the store’s state after Retry equals Redis');
  // The store goes on writing after it.
  s.emit('settings', { theme: 'light' });
  await s.flush();
  assert.equal(s.state.seq, 6);
  await consistent(s);
});

test('Retry says what wasn’t saved, once, in the status and the log, and tells the pages to resync', async () => {
  const { s, p, statuses, errors } = await repaired();
  const status = /** @type {any} */ (s.status);
  assert.equal(status.state, 'running');
  assert.equal(status.dropped.events, 2);
  assert.equal(status.dropped.from, 2);
  assert.equal(status.dropped.to, 4);
  assert.equal(status.dropped.documents, 1);
  assert.match(status.dropped.message, /recursion limit/);
  assert.deepEqual(status.dropped.changes, ['2: item.add user message in t', '4: item.patch message in t'], 'named by type and ids, never text');
  assert.deepEqual(
    statuses.map((x) => [x.state, x.cause ?? (x.dropped ? 'dropped' : '')]),
    [
      ['down', 'rejected'],
      ['down', 'reconciling'],
      ['running', 'dropped'],
    ],
  );
  // The page heard the batch’s events as they were emitted, then one resync: it loads the state again.
  assert.deepEqual(p.frames(), ['item.add', 'project', 'item.patch', 'item.add', 'resync']);
  assert.match(errors.join('\n'), /weren’t saved.*recursion limit/);
});

test('a store closed while a batch is refused saves the batch’s other events before it stops', async () => {
  const dir = await tmp();
  const s = await open(dir);
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  const errors = [];
  const { error } = console;
  console.error = (m) => errors.push(String(m));
  try {
    poison(s, 'item:message');
    s.emit('item.add', { threadId: 't', item: { id: 'message', kind: 'user', text: 'keep my message', at: 1 } });
    s.emit('project', { id: 'innocent', name: 'same batch' });
    await s.flush();
    assert.equal(s.writable, false);
    await s.close();
  } finally {
    console.error = error;
  }
  assert.match(errors.join('\n'), /weren’t saved.*recursion limit/);
  const b = await open(dir);
  assert.equal(b.state.projects.innocent?.name, 'same batch', 'the innocent event is saved');
  assert.equal(b.state.items.t?.length ?? 0, 0, 'the refused one isn’t');
  assert.equal(b.state.seq, 3);
});
