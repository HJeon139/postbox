#!/usr/bin/env node
// The real-shape seed’s snapshot (#305, designs/305-archive-turns.md, “Context: what the state holds today”): seeds
// the bench’s big room, with each reply’s turn, its work entries and its steps (seedRoomFolder’s `work`,
// tools/uat/big-room-work.mjs), into a new data folder, and has the store write its own snapshot.json there, so
// tools/measure-archive-policies.mjs measures the archive policies on it:
//
//   node tools/seed-archive-snapshot.mjs --items 1000 --out /tmp/pb-archive-1000
//   node tools/measure-archive-policies.mjs /tmp/pb-archive-1000/snapshot.json
//
// --out is a folder of its own: one that already holds a store is refused, so it never writes over a Postbox’s data.
// The room’s proportions are the 1 November run’s, not a measurement of this room (tools/uat/big-room-work.mjs).

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../server/store.mjs';
import { count, seedRoomFolder } from './bench-room.mjs';

/** Seeds `items` items with their work into `out` and writes its snapshot. @param {string} out @param {number} items */
async function seedArchiveSnapshot(out, items) {
  if (existsSync(out) && readdirSync(out).some((n) => n === 'snapshot.json' || /^events-/.test(n)))
    throw new Error(`${out} already holds a store. Give --out a new or empty folder.`);
  mkdirSync(out, { recursive: true });
  await seedRoomFolder(out, items, { work: true });
  const store = await new Store(out).load();
  try {
    await store.snapshot();
  } finally {
    await store.close();
  }
  return join(out, 'snapshot.json');
}

async function main() {
  const { values } = parseArgs({ options: { items: { type: 'string', default: '1000' }, out: { type: 'string' } } });
  if (!values.out) throw new Error('--out names the new data folder to seed, such as --out /tmp/pb-archive-1000.');
  const path = await seedArchiveSnapshot(resolve(values.out), count('items', values.items ?? ''));
  console.log(`${path}: ${(statSync(path).size / 1048576).toFixed(2)} MB`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
