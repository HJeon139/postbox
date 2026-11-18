import assert from 'node:assert/strict';
import { appendFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Blobs } from '../server/blobs.mjs';
import { Store } from '../server/store.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { tempDir } from './temp-dirs.mjs';

const tmp = () => tempDir('pb-store-');

test('events are appended to the log and replayed after a restart', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  a.emit('thread', { id: 't1', members: [] });
  a.emit('item.add', { threadId: 't1', item: { id: 'i1', text: 'Hel' } });
  a.emit('item.text', { threadId: 't1', id: 'i1', text: 'lo' });
  await a.close();
  const b = await new Store(dir).load();
  assert.equal(b.state.seq, 3);
  assert.equal(b.state.items.t1[0].text, 'Hello');
});

test('a torn last line from a crash is dropped, and earlier events survive', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.close();
  const seg = (await readdir(dir)).find((n) => n.startsWith('events-'));
  await appendFile(join(dir, seg), '{"seq":2,"type":"thread","data":{"id":"t2"');
  const b = await new Store(dir).load();
  assert.equal(b.state.seq, 1);
  assert.ok(b.state.threads.t1);
  assert.equal(b.state.threads.t2, undefined);
  b.emit('thread', { id: 't3', members: [] });
  await b.close();
  const c = await new Store(dir).load();
  assert.ok(c.state.threads.t3, 'new events append cleanly after the dropped line');
});

test('a snapshot starts a new segment and deletes the ones it covers', async () => {
  const dir = await tmp();
  const a = await new Store(dir, { snapshotChars: 250 }).load();
  for (let i = 0; i < 12; i++) {
    a.emit('thread', { id: `t${i}`, members: [] });
    await a.flush();
  }
  const files = await readdir(dir);
  assert.ok(files.includes('snapshot.json'));
  assert.equal(files.filter((n) => n.startsWith('events-')).length, 1, 'only the segment after the last snapshot remains');
  await a.close();
  const b = await new Store(dir).load();
  assert.equal(b.state.seq, 12);
  assert.equal(Object.keys(b.state.threads).length, 12);
});

test('Stage 2’s store.json is read once as the first snapshot', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'store.json'), JSON.stringify({ version: 1, seq: 7, threads: { old: { id: 'old', members: [] } } }));
  const s = await new Store(dir).load();
  assert.equal(s.state.seq, 7);
  assert.ok(s.state.threads.old);
  const files = await readdir(dir);
  assert.ok(files.includes('store.json.migrated'));
  assert.ok(files.includes('snapshot.json'));
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
});

// A snapshot comes at SNAPSHOT_CHARS of log written since the last, not at a count of events, so a load replays a
// bounded log whatever its events weigh, and a change that writes fewer, bigger events doesn't move the snapshot
// earlier (#1502's crash restart, where a smaller log of fewer events replayed more after its snapshot).
test('a snapshot comes after so much log written, emits, commits and a load’s replay counted alike, not after so many events', async () => {
  const dir = await tmp();
  const line = (/** @type {string} */ id) => JSON.stringify({ type: 'thread', data: { id, members: [] }, seq: 1 }).length;
  const a = await new Store(dir, { snapshotChars: 600 }).load();
  for (let i = 0; i < 20; i++) {
    a.emit('thread', { id: `t${i}`, members: [] }); // twenty small events: about 60 characters each, 1,200 in all
    await a.flush();
  }
  assert.ok((await readdir(dir)).includes('snapshot.json'), 'the small events wrote enough log for a snapshot');
  const after = a.sinceSnapshot;
  assert.ok(after < 600, `counted from the snapshot: ${after}`);
  await a.commit([{ type: 'thread', data: { id: 'c'.repeat(400), members: [] } }]);
  assert.ok(a.sinceSnapshot >= after + 400, 'a commit counts its line');
  await a.close();
  // A load counts the log it replays toward the next snapshot.
  const b = await new Store(dir, { snapshotChars: 600 }).load();
  assert.ok(b.sinceSnapshot >= 400 + line('x'), `the replayed log is counted: ${b.sinceSnapshot}`);
  await b.close();

  // Few, big events: three lines past the limit, where an event count of 5 would have taken none.
  const big = await tempDir('pb-store-big-');
  const c = await new Store(big, { snapshotChars: 600 }).load();
  for (let i = 0; i < 3; i++) {
    c.emit('thread', { id: `b${i}`.padEnd(250, 'x'), members: [] });
    await c.flush();
  }
  assert.ok((await readdir(big)).includes('snapshot.json'), 'three big events wrote enough');
  await c.close();
});
