import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { disk, folder, handleWith, image, opened } from './store-jsonl-fixture.mjs';

for (const when of ['before', 'after']) {
  test(`a crash ${when} snapshot rename leaves all acknowledged events recoverable`, async (t) => {
    const dir = await folder(t);
    let cuts = 0;
    const io = disk({
      rename: async (source, target) => {
        if (String(target) !== join(dir, 'snapshot.json')) return fs.rename(source, target);
        cuts++;
        if (when === 'after') await fs.rename(source, target);
        throw new Error('simulated publication cut');
      },
    });
    const store = await opened(t, dir, { io });
    store.emit('thread', { id: 'first', members: [] });
    store.emit('thread', { id: 'second', members: [] });
    await store.flush();
    await assert.rejects(store.snapshot(), /simulated publication cut/);
    assert.equal(cuts, 1, 'the filesystem fault actually fired');
    const recovered = await opened(t, await image(t, dir));
    assert.equal(recovered.state.seq, 2);
    assert.deepEqual(Object.keys(recovered.state.threads), ['first', 'second']);
  });
}

test('log segments are retained if snapshot directory sync fails after rename', async (t) => {
  const dir = await folder(t);
  let cuts = 0;
  let armed = false; // load() syncs the folder once at start (the integrator’s review of 1a); only the snapshot’s sync fails here
  const io = disk({
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      if (String(path) !== dir) return handle;
      return handleWith(handle, {
        sync: async () => {
          if (!armed) return handle.sync();
          cuts++;
          throw new Error('snapshot directory sync failed');
        },
      });
    },
  });
  const store = await opened(t, dir, { io });
  armed = true;
  store.emit('thread', { id: 'saved', members: [] });
  await store.flush();
  const before = await fs.readFile(join(dir, 'events-1.jsonl'), 'utf8');
  await assert.rejects(store.snapshot(), /snapshot directory sync failed/);
  assert.equal(cuts, 1);
  assert.equal(await fs.readFile(join(dir, 'events-1.jsonl'), 'utf8'), before);
  const recovered = await opened(t, await image(t, dir));
  assert.equal(recovered.state.seq, 1);
  assert.ok(recovered.state.threads.saved);
});
