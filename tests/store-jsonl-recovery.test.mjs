import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { event, folder, line, opened } from './store-jsonl-fixture.mjs';

test('old single-event lines and complete transaction arrays replay in one sequence', async (t) => {
  const dir = await folder(t);
  await writeFile(join(dir, 'events-1.jsonl'), line(event(1, 'old')) + line([event(2, 'a'), event(3, 'b')]));
  const store = await opened(t, dir);
  assert.equal(store.state.seq, 3);
  assert.deepEqual(Object.keys(store.state.threads), ['old', 'a', 'b']);
});

test('every byte cut of the final transaction recovers all its events or none', async (t) => {
  const dir = await folder(t);
  const prefix = line(event(1, 'old'));
  const transaction = Buffer.from(line([event(2, 'é'), event(3, '🌙')]));
  t.mock.method(console, 'warn', () => {});
  for (let cut = 0; cut <= transaction.length; cut++) {
    await writeFile(join(dir, 'events-1.jsonl'), Buffer.concat([Buffer.from(prefix), transaction.subarray(0, cut)]));
    const store = await new Store(dir, { snapshotEvery: Infinity }).load();
    try {
      const complete = cut === transaction.length;
      assert.equal(store.state.seq, complete ? 3 : 1, `cut at byte ${cut}`);
      assert.deepEqual(Object.keys(store.state.threads), complete ? ['old', 'é', '🌙'] : ['old'], `cut at byte ${cut}`);
      assert.equal(await readFile(join(dir, 'events-1.jsonl'), 'utf8'), prefix + (complete ? transaction.toString() : ''));
    } finally {
      if (store.close) await store.close();
      else await store.flush();
    }
  }
});

test('a new durable commit never joins the recovered torn tail', async (t) => {
  const dir = await folder(t);
  await writeFile(join(dir, 'events-1.jsonl'), `${line(event(1, 'old'))}[{"seq":2`);
  t.mock.method(console, 'warn', () => {});
  const store = await opened(t, dir);
  await store.commit([{ type: 'thread', data: { id: 'new', members: [] } }], { opId: 'after-torn-tail' });
  const lines = (await readFile(join(dir, 'events-1.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].data.id, 'old');
  assert.equal(Array.isArray(lines[1]), false);
  assert.equal(lines[1].op, 'after-torn-tail');
  assert.equal(lines[1].data.id, 'new');
  assert.equal(store.state.seq, 2);
});

test('a bad middle line refuses startup without truncating later acknowledged history', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 'events-1.jsonl');
  const bytes = `${line(event(1, 'old'))}{not-json}\n${line(event(3, 'later'))}`;
  await writeFile(path, bytes);
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(new Store(dir).load(), /events-1\.jsonl/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('a torn line in a sealed segment refuses startup instead of hiding a later segment', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 'events-1.jsonl');
  const bytes = `${line(event(1, 'old'))}{"seq":2`;
  await writeFile(path, bytes);
  await writeFile(join(dir, 'events-3.jsonl'), line(event(3, 'later')));
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(new Store(dir).load(), /events-1\.jsonl/);
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('events-')).sort(), ['events-1.jsonl', 'events-3.jsonl']);
});
