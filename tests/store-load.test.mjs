// What load() does with a damaged log (server/store.mjs; #508’s PR 1a). A torn last line is a crash mid-write and is
// dropped (tests/store.test.mjs). A bad line with complete lines after it is not that: the store refuses to load
// rather than silently dropping everything after it. A complete last line without its newline is the crash between
// the line and its newline: it counts, and the next write starts on a line of its own.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-load-'));
/** @param {number} seq @param {string} id */
const line = (seq, id) => JSON.stringify({ seq, type: 'thread', data: { id, members: [] } });

test('a bad line in the middle of a segment makes load() refuse, naming the file and the line, instead of dropping what follows', async () => {
  const dir = await tmp();
  const path = join(dir, 'events-1.jsonl');
  const text = `${line(1, 't1')}\n{"seq":2,"type":"thread","data":{"id":"t2"\n${line(3, 't3')}\n`;
  await writeFile(path, text);
  await assert.rejects(
    new Store(dir).load(),
    (e) => {
      assert.match(e.message, /events-1\.jsonl/, 'names the file');
      assert.match(e.message, /line 2\b/, 'names the line');
      return true;
    },
    'a bad line with complete lines after it is refused',
  );
  assert.equal((await stat(path)).size, Buffer.byteLength(text), 'the file is left as it was, not truncated');
  await rm(dir, { recursive: true });
});

test('a complete last line without its newline counts, and the next write starts on a fresh line', async () => {
  const dir = await tmp();
  const path = join(dir, 'events-1.jsonl');
  await writeFile(path, `${line(1, 't1')}\n${line(2, 't2')}`);
  const a = await new Store(dir).load();
  assert.equal(a.state.seq, 2, 'the line without a newline is a whole event');
  a.emit('thread', { id: 't3', members: [] });
  await a.flush();
  const written = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim());
  assert.equal(written.length, 3, 'three lines, not two with the last joined onto the second');
  for (const l of written) JSON.parse(l);
  await a.close();
  const b = await new Store(dir).load();
  assert.equal(b.state.seq, 3);
  assert.deepEqual(Object.keys(b.state.threads).sort(), ['t1', 't2', 't3']);
  await b.close();
  await rm(dir, { recursive: true });
});
