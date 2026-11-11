// No size of the state stops the snapshot or the next start (#1180). V8 caps a string at 536,870,888 characters, and
// the store built the snapshot, and read it and each log segment back, as one string. These cases set that limit at
// LIMIT characters instead: JSON.stringify, and the store’s readFile, throw “Invalid string length” past it, as V8 does
// past its own. So a room of a few hundred kilobytes takes the path a room of half a gigabyte would.

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { disk, folder, image, opened } from './store-jsonl-fixture.mjs';

const LIMIT = 50_000;
const tooLong = () => new RangeError('Invalid string length');

/** JSON.stringify as V8 would behave with a LIMIT-character string cap, for the rest of the test. */
function capStringify(t) {
  const real = JSON.stringify;
  JSON.stringify = /** @type {any} */ (
    (...args) => {
      const text = real(...args);
      if (typeof text === 'string' && text.length > LIMIT) throw tooLong();
      return text;
    }
  );
  t.after(() => {
    JSON.stringify = real;
  });
}

/** The store’s io, with readFile capped the same way when it reads text. */
const cappedIo = () =>
  disk({
    readFile: async (path, options) => {
      const value = await fs.readFile(path, options);
      if (typeof value === 'string' && value.length > LIMIT) throw tooLong();
      return value;
    },
  });

/** A room whose state is several times LIMIT: 400 items of about 500 characters, in two conversations. */
function fill(store) {
  for (const id of ['one', 'two']) store.emit('thread', { id, members: [] });
  for (let n = 0; n < 400; n++)
    store.emit('item.add', { threadId: n % 2 ? 'one' : 'two', item: { id: `it_${n}`, kind: 'user', at: n, text: `${n} `.padEnd(500, 'x') } });
}

test('#1180 a state whose JSON passes the string limit is snapshotted, and a restart loads it back whole', async (t) => {
  const dir = await folder(t);
  const store = await opened(t, dir, { io: cappedIo() });
  fill(store);
  await store.flush();
  const before = structuredClone(store.state);
  capStringify(t);
  await store.snapshot();
  const files = await fs.readdir(dir);
  assert.ok(files.includes('snapshot.json'), 'the snapshot is written');
  const text = await fs.readFile(join(dir, 'snapshot.json'), 'utf8');
  assert.match(text.slice(0, 80), /^\{"postbox":"snapshot","format":2\}\n/, 'past the limit, it’s written as lines');
  // An older Postbox reads snapshot.json with one JSON.parse, and refuses to start on any error but ENOENT
  // (store-recover.mjs before #1180): so on this file it stops, rather than starting empty.
  assert.throws(() => JSON.parse(text), SyntaxError);
  const again = await opened(t, await image(t, dir), { io: cappedIo() });
  assert.deepEqual(structuredClone(again.state.items), before.items, 'every item comes back');
  assert.equal(again.state.seq, before.seq);
});

test('#1180 a log segment past the string limit is replayed line by line', async (t) => {
  const dir = await folder(t);
  const store = await opened(t, dir);
  fill(store);
  await store.flush();
  const before = structuredClone(store.state);
  const segment = (await fs.readdir(dir)).find((n) => n.startsWith('events-'));
  assert.ok((await fs.stat(join(dir, segment))).size > LIMIT, 'the segment is past the limit');
  const again = await opened(t, await image(t, dir), { io: cappedIo() });
  assert.deepEqual(structuredClone(again.state.items), before.items);
  assert.equal(again.state.seq, before.seq);
});

test('#1180 a snapshot.json in the old format, one JSON value, still loads', async (t) => {
  const dir = await folder(t);
  const old = { seq: 3, threads: { one: { id: 'one', members: [] } }, items: { one: [{ id: 'it_a', kind: 'user', at: 1, text: 'kept' }] } };
  await fs.writeFile(join(dir, 'snapshot.json'), JSON.stringify(old));
  const store = await opened(t, dir);
  assert.equal(store.state.seq, 3);
  assert.deepEqual(structuredClone(store.state.items.one), old.items.one);
  assert.deepEqual(structuredClone(store.state.threads.one), old.threads.one);
});

test('#1180 a small room’s state loads back from its snapshot as it was', async (t) => {
  const dir = await folder(t);
  const store = await opened(t, dir);
  store.emit('thread', { id: 'one', members: ['se_a'] });
  store.emit('item.add', { threadId: 'one', item: { id: 'it_a', kind: 'user', at: 1, text: 'a “quoted” line\nand a 😀' } });
  store.emit('settings', { theme: 'dark' });
  await store.flush();
  const before = structuredClone(store.state);
  await store.snapshot();
  const again = await opened(t, await image(t, dir));
  assert.deepEqual(structuredClone(again.state), before);
});

test('#1180 an old snapshot written across lines, as a hand-made one can be, still loads', async (t) => {
  const dir = await folder(t);
  const old = { seq: 2, threads: { one: { id: 'one', members: [] } } };
  await fs.writeFile(join(dir, 'snapshot.json'), JSON.stringify(old, null, 2));
  const store = await opened(t, dir);
  assert.equal(store.state.seq, 2);
  assert.deepEqual(structuredClone(store.state.threads.one), old.threads.one);
});

test('#1180 a state that fits is snapshotted as lines too, which an older Postbox refuses rather than starting empty', async (t) => {
  // C5, the person’s choice on #1155: always the line format, so a snapshot never stops the server for its whole
  // JSON.stringify. An older Postbox reads snapshot.json with one JSON.parse and refuses to start on any error but
  // ENOENT (store-recover.mjs before #1180): so on this file it stops, rather than starting empty.
  const dir = await folder(t);
  const store = await opened(t, dir);
  fill(store);
  await store.flush();
  const before = structuredClone(store.state);
  await store.snapshot();
  const text = await fs.readFile(join(dir, 'snapshot.json'), 'utf8');
  assert.match(text.slice(0, 80), /^\{"postbox":"snapshot","format":2\}\n/, 'a state that fits is written as lines');
  assert.throws(() => JSON.parse(text), SyntaxError);
  const again = await opened(t, await image(t, dir));
  assert.deepEqual(structuredClone(again.state), before);
});

test('#1180 an item holding U+2028 and U+2029 survives a line-format snapshot', async (t) => {
  // readline also ends a line at U+2028 and U+2029, which JSON.stringify leaves as they are (critic, on #1194): the
  // snapshot splits on the newline byte alone, as the replay does.
  const dir = await folder(t);
  const store = await opened(t, dir, { io: cappedIo() });
  fill(store);
  store.emit('item.add', { threadId: 'one', item: { id: 'it_sep', kind: 'user', at: 1, text: 'a\u2028b\u2029c' } });
  await store.flush();
  const before = structuredClone(store.state);
  capStringify(t);
  await store.snapshot();
  const again = await opened(t, await image(t, dir), { io: cappedIo() });
  assert.deepEqual(structuredClone(again.state.items), before.items);
});

/** A line-format snapshot of a room past the limit, in its own folder, and its text. */
async function lineSnapshot(t) {
  const dir = await folder(t);
  const store = await opened(t, dir, { io: cappedIo() });
  fill(store);
  await store.flush();
  capStringify(t);
  await store.snapshot();
  const copy = await image(t, dir);
  return { copy, text: await fs.readFile(join(copy, 'snapshot.json'), 'utf8') };
}

test('#1180 a line-format snapshot cut at a line boundary is refused, not loaded as a smaller state', async (t) => {
  const { copy, text } = await lineSnapshot(t);
  const cut = text.indexOf('\n', Math.floor(text.length / 2)) + 1;
  await fs.writeFile(join(copy, 'snapshot.json'), text.slice(0, cut));
  await assert.rejects(opened(t, copy, { io: cappedIo() }), /Couldn’t read the snapshot/);
});

test('#1180 a snapshot that’s only the header line is refused, not loaded as an empty state', async (t) => {
  const { copy, text } = await lineSnapshot(t);
  await fs.writeFile(join(copy, 'snapshot.json'), text.slice(0, text.indexOf('\n') + 1));
  await assert.rejects(opened(t, copy, { io: cappedIo() }), /Couldn’t read the snapshot/);
});

test('#1180 an empty snapshot.json, or one shorter than the header, is refused', async (t) => {
  for (const text of ['', '{"postbox":"snap']) {
    const dir = await folder(t);
    await fs.writeFile(join(dir, 'snapshot.json'), text);
    await assert.rejects(opened(t, dir), /Couldn’t read the snapshot/, JSON.stringify(text));
  }
});

test('#1180 a line-format snapshot with an item’s line missing, a line past its end, or no last newline is refused', async (t) => {
  const { copy, text } = await lineSnapshot(t);
  const lines = text.split('\n'); // the header, the body, the end line, then '' after the last newline
  const damaged = {
    'an item’s line missing': lines.filter((_, i) => i !== lines.findIndex((l) => l.startsWith('["i",'))).join('\n'),
    'a line past its end': `${text}${lines[2]}\n`,
    'no last newline': text.slice(0, -1),
  };
  for (const [what, damage] of Object.entries(damaged)) {
    await fs.writeFile(join(copy, 'snapshot.json'), damage);
    await assert.rejects(opened(t, copy, { io: cappedIo() }), /Couldn’t read the snapshot/, what);
  }
});
