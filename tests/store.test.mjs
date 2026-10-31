import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Blobs } from '../server/blobs.mjs';
import { Store } from '../server/store.mjs';
import { apply, emptyState } from '../shared/state.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-store-'));

// The old log’s own tests (a torn last line, snapshots and their segments, Stage 2’s store.json) moved to
// tests/store-import.test.mjs with the one-time import, the only code that still reads that format; snapshots are gone
// (#508’s design, “Storage”, decision 4). On Redis, a restart reads the documents back.
test('events are appended to the log and replayed after a restart', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  a.emit('thread', { id: 't1', members: [] });
  a.emit('item.add', { threadId: 't1', item: { id: 'i1', text: 'Hel' } });
  a.emit('item.text', { threadId: 't1', id: 'i1', text: 'lo' });
  await a.flush();
  const b = await new Store(dir).load();
  assert.equal(b.state.seq, 3);
  assert.equal(b.state.items.t1[0].text, 'Hello');
  await rm(dir, { recursive: true });
});

test('since() gives the backlog for a reconnecting browser, or null when it’s gone', async () => {
  const s = new Store(null);
  for (let i = 0; i < 3; i++) s.emit('thread', { id: `t${i}`, members: [] });
  assert.deepEqual(
    s.since(1).map((e) => e.seq),
    [2, 3],
  );
  assert.deepEqual(s.since(3), []);
  s.events.splice(0, 2);
  assert.equal(s.since(0), null);
});

test('a reconnecting browser gets each event as it was emitted, so a streamed reply isn’t doubled', () => {
  const s = new Store(null);
  s.emit('item.add', { threadId: 't', item: { id: 'i1', kind: 'agent', text: '' } });
  s.emit('item.text', { threadId: 't', id: 'i1', text: 'Hello ' });
  s.emit('item.text', { threadId: 't', id: 'i1', text: 'world' });
  s.emit('item.patch', { threadId: 't', id: 'i1', patch: { status: 'done' } });
  const browser = emptyState();
  for (const ev of s.since(0)) apply(browser, ev.type, JSON.parse(JSON.stringify(ev.data)));
  assert.equal(s.state.items.t[0].text, 'Hello world');
  assert.deepEqual(browser.items.t, s.state.items.t);
  assert.deepEqual(s.since(0)[0].data.item, { id: 'i1', kind: 'agent', text: '' });
});

test('blobs are stored by content, kept once, and checked on read', async () => {
  const dir = await tmp();
  const blobs = new Blobs(dir);
  const a = await blobs.put(Buffer.from('hello'));
  const b = await blobs.put(Buffer.from('hello'));
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal((await blobs.get(a.sha256)).toString(), 'hello');
  await writeFile(a.path, 'tampered');
  await assert.rejects(blobs.get(a.sha256), /damaged/);
  assert.throws(() => blobs.pathOf('../etc/passwd'), /Not a SHA-256/);
  await rm(dir, { recursive: true });
});
