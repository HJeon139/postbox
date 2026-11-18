// A running reply’s stored chunk carries `at`, where its words start (server/live-text.mjs). The log is ordered and
// complete, so a chunk that starts at its item’s end is written without `at` (server/store-text-at.mjs), by an emit and
// a commit alike, the chunks before it in the same commit counted. The event since() and the streams give keeps it, so
// a page that reconnects adds only what it lacks; a load appends the chunks back to the same text.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

/** The item.text events written to the log, each as its data. @param {string} dir */
async function writtenText(dir) {
  const segment = (await readdir(dir)).find((n) => n.startsWith('events-'));
  return (await readFile(join(dir, /** @type {string} */ (segment)), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => [JSON.parse(l)].flat())
    .filter((e) => e.type === 'item.text')
    .map((e) => e.data);
}

test('a chunk that starts at its item’s end is written without at, one that doesn’t keeps it, and since() keeps it', async () => {
  const dir = await tempDir('pb-text-at-');
  const s = await new Store(dir).load();
  s.emit('thread', { id: 't', members: [] });
  s.emit('item.add', { threadId: 't', item: { id: 'i', kind: 'agent', text: '' } });
  const from = s.state.seq;
  s.emit('item.text', { threadId: 't', id: 'i', text: 'Reading ', at: 0 });
  // A commit of two chunks: the second starts where the first ends, counted before either applies.
  await s.commit([
    { type: 'item.text', data: { threadId: 't', id: 'i', text: 'the ', at: 8 } },
    { type: 'item.text', data: { threadId: 't', id: 'i', text: 'shelf.', at: 12 } },
  ]);
  // A chunk that overlaps what the item has: its `at` says what, so it’s kept.
  s.emit('item.text', { threadId: 't', id: 'i', text: 'shelf. Done.', at: 12 });
  await s.flush();
  assert.deepEqual(
    (await writtenText(dir)).map((d) => d.at),
    [undefined, undefined, undefined, 12],
  );
  assert.deepEqual(
    /** @type {any[]} */ (s.since(from)).map((e) => e.data.at),
    [0, 8, 12, 12],
    'since() gives each event as it was emitted',
  );
  assert.equal(s.state.items.t[0].text, 'Reading the shelf. Done.');
  await s.close();
  const again = await new Store(dir).load();
  assert.equal(again.state.items.t[0].text, 'Reading the shelf. Done.', 'a load makes the same text');
  await again.close();
});
