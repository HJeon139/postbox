#!/usr/bin/env node
// Rewrites a data folder’s snapshot.json as one JSON value, for a Postbox from before #1180 (C5, the person’s choice on
// #1155). Since #1180 Postbox writes the snapshot as lines, which an older build can’t read: it refuses to start on the
// folder, losing nothing. Run this, with Postbox stopped, before starting an older build on the same folder.
//
// It opens the folder through the store, so it holds the folder’s lock, and refuses while a Postbox holds it. It writes
// the state the store loaded, the snapshot and the log after it, so nothing in the log is lost. It refuses a state
// past V8’s string limit, about 68,000 items of the big-room seed, which no one-value snapshot can hold. The next
// snapshot a current Postbox takes is lines again.
//
// Usage: node tools/snapshot-for-older.mjs [data folder]   (without one, the folder Postbox itself would use)

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataFolder } from '../server/home.mjs';
import { Store } from '../server/store.mjs';
import { syncDir, writeSnapshot } from '../server/store-snapshot.mjs';

/**
 * Rewrites the folder’s snapshot as one JSON value, and returns how many items it holds.
 * @param {string} dir @returns {Promise<{ items: number, seq: number }>}
 */
export async function rebuildForOlder(dir) {
  const store = await new Store(dir, { snapshotEvery: Infinity }).load();
  try {
    await store.flush();
    await writeSnapshot(store, { forOlder: true });
    await syncDir(store);
    const items = Object.values(store.state.items ?? {}).reduce((n, list) => n + list.length, 0);
    return { items, seq: store.state.seq };
  } finally {
    await store.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { dataDir: dir } = dataFolder({ data: process.argv[2], root: fileURLToPath(new URL('..', import.meta.url)) });
  try {
    const { items, seq } = await rebuildForOlder(dir);
    console.log(`Rewrote ${join(dir, 'snapshot.json')} as one JSON value: ${items} items, at seq ${seq}. A Postbox from before #1180 can start on it.`);
  } catch (e) {
    console.error(`Couldn’t rewrite the snapshot: ${e.message}`);
    process.exitCode = 1;
  }
}
