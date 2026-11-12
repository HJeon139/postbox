// server/data-folder.mjs: a fresh start (start({ fresh: true }), the demo’s and the tests’) empties the data folder
// under its lock. It removed the store’s files and left the asset folder, so the asset pass at load found the last
// run’s files that no asset names, warned about them on every fresh start, and kept them for good.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDataFolder } from '../server/data-folder.mjs';
import { tempDir } from './temp-dirs.mjs';

test('a fresh start empties the asset folder, so it finds nothing of the last run’s there and warns of nothing', async () => {
  const dir = tempDir('pb-data-folder-');
  mkdirSync(join(dir, 'assets', 'ab'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'ab', 'cdef0123'), 'an asset of the last run');
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  let store;
  try {
    ({ store } = await openDataFolder(dir, { fresh: true }));
  } finally {
    console.warn = warn;
  }
  try {
    assert.deepEqual(warned, [], 'nothing was warned of');
    const assets = join(dir, 'assets');
    assert.deepEqual(existsSync(assets) ? readdirSync(assets, { recursive: true }) : [], [], 'the asset folder holds nothing');
  } finally {
    await store?.close();
  }
});
