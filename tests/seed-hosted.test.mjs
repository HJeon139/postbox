// What a hosted Postbox’s demo seeds for its projects (designs/architecture/hosted.md, “What assumed one computer”,
// “Project and agent folders”): a hosted project is its name, since the server has no folder for one, so the demo’s
// two are seeded without. With a folder, the file picker listed the data folder’s notes to everyone signed in.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { seed } from '../server/seed.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

/** The demo’s projects and how many conversations it seeded, on a server for a team or on your own computer. */
async function demo(/** @type {boolean} */ hosted) {
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'claude-code' }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], hosted },
  });
  const dataDir = tempDir('pb-seed-hosted-');
  await seed(rt, { dataDir, backend: 'claude-code', demo: true });
  const folders = ['notes', 'research'].filter((f) => existsSync(join(dataDir, f)));
  return { projects: Object.values(store.state.projects), threads: Object.keys(store.state.threads).length, folders };
}

test('hosted, the demo’s projects are seeded without a folder on the server, with their conversations as before', async () => {
  const { projects, threads, folders } = await demo(true);
  assert.deepEqual(folders, [], 'and no folder is made for them');
  assert.deepEqual(
    projects.map((p) => [p.name, 'folder' in p]),
    [
      ['Reading notes', false],
      ['Agent research', false],
    ],
  );
  assert.ok(threads > 0);
});

test('on your own computer each of the demo’s projects has its folder in the data folder, as before', async () => {
  const { projects, threads, folders } = await demo(false);
  assert.deepEqual(folders, ['notes', 'research']);
  assert.deepEqual(
    projects.map((p) => String(p.folder).split('/').at(-1)),
    ['notes', 'research'],
  );
  assert.equal(threads, (await demo(true)).threads, 'and the same conversations either way');
});
