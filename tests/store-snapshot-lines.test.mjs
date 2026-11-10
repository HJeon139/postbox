// The snapshot’s line format reads back as the one-value format did (#1180), and reads a long line in linear time.

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileLines, readSnapshotFile, snapshotLines } from '../server/store-snapshot-lines.mjs';
import { emptyState } from '../shared/state.mjs';
import { tempDir } from './temp-dirs.mjs';

/** Writes a state as format-2 lines and reads it back, as the store does. */
async function roundTrip(state) {
  const path = join(await tempDir('pb-snapshot-lines-'), 'snapshot.json');
  await fs.writeFile(path, [...snapshotLines(state)].map((l) => `${l}\n`).join(''));
  return readSnapshotFile(fs, path);
}

test('#1180 a value of the state that isn’t a list, such as settings, reads back as JSON.parse gives it', async () => {
  const state = { ...emptyState(), settings: { theme: 'dark', shown: { tips: true } } };
  const back = await roundTrip(state);
  assert.equal(Object.getPrototypeOf(back.settings), Object.prototype, 'settings is a plain object, as on main');
  assert.equal(String(back.settings), '[object Object]', 'so Object’s methods work on it');
  assert.deepEqual(back.settings, JSON.parse(JSON.stringify(state.settings)));
});

test('#1180 a key named __proto__ in the snapshot is read as data, and changes no prototype', async () => {
  const state = { settings: JSON.parse('{"__proto__":{"polluted":true},"theme":"dark"}') };
  const back = await roundTrip(state);
  assert.ok(Object.hasOwn(back.settings, '__proto__'), 'it’s an own key, as JSON.parse makes it');
  assert.equal(Object.getPrototypeOf(back.settings), Object.prototype);
  assert.equal(/** @type {any} */ ({}).polluted, undefined, 'Object’s prototype is untouched');
});

test('#1180 a line many chunks long is read with each byte copied a bounded number of times', async (t) => {
  const path = join(await tempDir('pb-snapshot-lines-'), 'long.jsonl');
  const long = 'x'.repeat(8 << 20); // eight of fileLines’ 1 MB chunks
  await fs.writeFile(path, `a\n${long}\nb`);
  const concat = Buffer.concat;
  let copied = 0;
  Buffer.concat = /** @type {any} */ (
    (list, ...rest) => {
      const out = concat(list, ...rest);
      copied += out.length;
      return out;
    }
  );
  t.after(() => {
    Buffer.concat = concat;
  });
  const lines = [];
  for await (const l of fileLines(fs, path)) lines.push({ length: l.line.length, terminated: l.terminated });
  Buffer.concat = concat;
  assert.deepEqual(lines, [
    { length: 1, terminated: true },
    { length: long.length, terminated: true },
    { length: 1, terminated: false },
  ]);
  // Joining the line once copies it once; growing a carry by each chunk copies it 1 + 2 + … + 8 = 36 MB.
  assert.ok(copied <= 2 * long.length, `the long line was copied ${copied} bytes in joins, for ${long.length} bytes`);
});
