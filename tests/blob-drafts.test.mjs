// #870: the drafts a killed or crashed Postbox leaves in a blob store are removed at start, and a draft of a process
// still running is kept. A streamed upload’s draft can be as large as the file, and it counts against the free space
// uploads keep, so one left behind is a leak (critic’s review of #2015).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepDrafts } from '../server/blob-drafts.mjs';
import { openDataFolder } from '../server/data-folder.mjs';
import { tempDir } from './temp-dirs.mjs';

const HASH = 'ab'.padEnd(64, 'c');

// Pids with no process started (unit tests start none, tests/guard.mjs): one above every system’s pid limit names no
// process, and this test’s parent (the test runner) is running.
const DEAD = 2 ** 31 - 2;

/**
 * A blob store with drafts for each pid, at the root and beside a blob, and with `blob`, the blob itself. The assets’
 * store gets none, since a file no asset names is logged at start (server/asset-orphans.mjs).
 */
function storeWith(dir, pids, { blob = true } = {}) {
  mkdirSync(join(dir, 'ab'), { recursive: true });
  if (blob) writeFileSync(join(dir, 'ab', HASH.slice(2)), 'kept');
  const drafts = {};
  for (const [who, pid] of Object.entries(pids)) {
    drafts[`${who} at the root`] = join(dir, `stream.${pid}.0a1b2c3d.draft`);
    drafts[`${who} beside a blob`] = join(dir, 'ab', `${HASH.slice(2)}.${pid}.4e5f6a7b.draft`);
  }
  for (const path of Object.values(drafts)) writeFileSync(path, 'part of a file');
  return drafts;
}

const present = (drafts) => Object.fromEntries(Object.entries(drafts).map(([k, p]) => [k, existsSync(p)]));

// pid 1 runs as root, so signal 0 from this user is refused with EPERM: running, but not this user’s to signal.
test('#870 a dead process’s drafts are removed; a running process’s, another user’s included; this process’s own pid’s are a dead Postbox’s, and the blobs are kept', async () => {
  const dir = tempDir('pb-blob-drafts-');
  const drafts = storeWith(dir, { dead: DEAD, running: process.ppid, self: process.pid, root: 1 });
  assert.equal(await sweepDrafts(dir), 4);
  assert.deepEqual(present(drafts), {
    'dead at the root': false,
    'dead beside a blob': false,
    'running at the root': true,
    'running beside a blob': true,
    'self at the root': false,
    'self beside a blob': false,
    'root at the root': true,
    'root beside a blob': true,
  });
  assert.ok(existsSync(join(dir, 'ab', HASH.slice(2))), 'the blob stays');
});

test('#870 Postbox’s start removes a dead Postbox’s drafts from the attachments’ and the assets’ stores', async () => {
  const data = tempDir('pb-blob-drafts-start-');
  const blobs = storeWith(join(data, 'blobs'), { dead: DEAD });
  const assets = storeWith(join(data, 'assets'), { dead: DEAD }, { blob: false });
  const { store } = await openDataFolder(data);
  try {
    assert.deepEqual([...Object.values(present(blobs)), ...Object.values(present(assets))], [false, false, false, false]);
  } finally {
    await store.close();
  }
});

test('#870 a store with no folder yet has no drafts to remove', async () => {
  assert.equal(await sweepDrafts(join(tempDir('pb-blob-drafts-none-'), 'blobs')), 0);
});
