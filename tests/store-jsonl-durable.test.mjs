import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { deferred, disk, folder, handleWith, image, opened } from './store-jsonl-fixture.mjs';

const changes = (id) => [{ type: 'thread', data: { id, members: [] } }];
const logFile = (path) => /events-\d+\.jsonl$/.test(String(path));

test('short writes loop until a large multibyte transaction is completely written', async (t) => {
  const dir = await folder(t);
  let writes = 0;
  const io = disk({
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      if (!logFile(path)) return handle;
      return handleWith(handle, {
        write: async (buffer, offset = 0, length = buffer.length - offset, position = null) => {
          writes++;
          assert.ok(Buffer.isBuffer(buffer), 'write uses byte offsets, not UTF-16 character offsets');
          return handle.write(buffer, offset, Math.min(length, 997), position);
        },
      });
    },
  });
  const store = await opened(t, dir, { io });
  const events = changes('large');
  events[0].data.title = '🌙'.repeat(20000);
  await store.commit(events, { opId: 'large' });
  assert.ok(writes > 1, 'fault injection actually forced a short write');
  const text = await fs.readFile(join(dir, 'events-1.jsonl'), 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.equal(Array.isArray(JSON.parse(text)), false, 'one-event commits keep the plain event format');
  assert.equal(JSON.parse(text).op, 'large');
  assert.equal(JSON.parse(text).data.title, events[0].data.title);
});

test('a commit stays invisible until sync and held emits follow it in replay order', async (t) => {
  const dir = await folder(t);
  const entered = deferred();
  const release = deferred();
  const io = disk({
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      if (!logFile(path)) return handle;
      return handleWith(handle, {
        sync: async () => {
          entered.resolve();
          await release.promise;
          await handle.sync();
        },
      });
    },
  });
  const store = await opened(t, dir, { io });
  assert.equal(typeof store.commit, 'function');
  const seen = [];
  store.subscribe((event) => seen.push({ seq: event.seq, ids: Object.keys(store.state.threads) }));
  const pending = store.commit([...changes('a'), ...changes('b')], { opId: 'visibility' });
  try {
    await entered.promise;
    store.emit('thread', { id: 'after', members: [] });
    assert.deepEqual(Object.keys(store.state.threads), []);
    assert.deepEqual(seen, []);
    assert.deepEqual(store.since(0), []);
  } finally {
    release.resolve();
  }
  await pending;
  await store.flush();
  assert.deepEqual(Object.keys(store.state.threads), ['a', 'b', 'after']);
  assert.deepEqual(
    seen.map((entry) => entry.seq),
    [1, 2, 3],
  );
  assert.deepEqual(seen[0].ids, ['a', 'b'], 'the first subscriber sees the entire transaction');
});

test('repeating an acknowledged opId leaves the sequence and log unchanged', async (t) => {
  const dir = await folder(t);
  const store = await opened(t, dir);
  assert.deepEqual(await store.commit(changes('once'), { opId: 'repeat' }), { seq: 1, duplicate: false });
  const before = await fs.readFile(join(dir, 'events-1.jsonl'), 'utf8');
  assert.deepEqual(await store.commit(changes('once'), { opId: 'repeat' }), { seq: 1, duplicate: true });
  assert.equal(store.state.seq, 1);
  assert.equal(await fs.readFile(join(dir, 'events-1.jsonl'), 'utf8'), before);
});

test('restart recovers an opId from a complete line whose caller never got acknowledgment', async (t) => {
  const dir = await folder(t);
  let fail = true;
  const io = disk({
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      if (!logFile(path)) return handle;
      return handleWith(handle, {
        sync: async () => {
          await handle.sync();
          if (fail) {
            fail = false;
            throw new Error('acknowledgment lost');
          }
        },
      });
    },
  });
  const first = await opened(t, dir, { io });
  assert.equal(typeof first.commit, 'function');
  await assert.rejects(first.commit(changes('once'), { opId: 'restart' }), /acknowledgment lost/);
  const before = await fs.readFile(join(dir, 'events-1.jsonl'), 'utf8');
  const recoveredDir = await image(t, dir);
  const next = await opened(t, recoveredDir);
  assert.deepEqual(await next.commit(changes('once'), { opId: 'restart' }), { seq: 1, duplicate: true });
  assert.equal(next.state.seq, 1);
  assert.equal(await fs.readFile(join(recoveredDir, 'events-1.jsonl'), 'utf8'), before);
});

test('a failed sync cannot acknowledge or publish the commit', async (t) => {
  const dir = await folder(t);
  let calls = 0;
  const io = disk({
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      if (!logFile(path)) return handle;
      return handleWith(handle, {
        sync: async () => {
          calls++;
          if (calls === 1) throw Object.assign(new Error('disk sync refused'), { code: 'EIO' });
          await handle.sync();
        },
      });
    },
  });
  const store = await opened(t, dir, { io });
  const seen = [];
  store.subscribe((event) => seen.push(event));
  assert.equal(typeof store.commit, 'function');
  await assert.rejects(store.commit(changes('unsynced'), { opId: 'failed' }), /disk sync refused|EIO/);
  assert.ok(calls > 0);
  assert.equal(store.state.threads.unsynced, undefined);
  assert.equal(store.state.seq, 0);
  assert.deepEqual(seen, []);
});
