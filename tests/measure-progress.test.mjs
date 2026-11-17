// The live-progress measurement counts the event log as the store writes it (tools/measure-progress/log-bytes.mjs): the
// bytes it counts by kind, with the framing, are every byte written to a log segment, and what’s on disk, in UTF-8.

import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { countingIo, kindOf, tally } from '../tools/measure-progress/log-bytes.mjs';
import { tempDir } from './temp-dirs.mjs';

test('the counted bytes are the bytes the store writes, emits and commits alike, in UTF-8', async () => {
  const dir = tempDir('pb-measure-');
  const { io, written } = countingIo();
  const store = await new Store(dir, { io }).load();
  store.emit('thread', { id: 'th_1', projectId: 'p1', title: 'Ünïcode “quotes” 👩‍👩‍👧', members: [] });
  store.emit('item.add', { threadId: 'th_1', item: { id: 'it_1', kind: 'agent', text: '' } });
  for (const w of ['Héllo ', 'wörld ', '👍']) store.emit('item.text', { threadId: 'th_1', id: 'it_1', text: w });
  await store.commit([
    { type: 'item.patch', data: { threadId: 'th_1', id: 'it_1', patch: { status: 'done' } } },
    { type: 'session', data: { id: 'se_1', threadId: 'th_1', state: 'idle' } },
  ]);
  await store.close();
  const bytes = written();
  const t = tally(bytes);
  const onDisk = readdirSync(dir)
    .filter((n) => n.startsWith('events-'))
    .reduce((a, n) => a + statSync(join(dir, n)).size, 0);
  assert.equal(t.total, bytes.length, 'every written byte is counted once');
  assert.equal(bytes.length, onDisk, 'what was written is what’s on disk');
  assert.equal(t.kinds['progress: item.text'].events, 3);
  assert.ok(t.framing > 0, 'newlines, and the commit’s brackets and comma');
});

test('a session patch is progress with only live fields, mixed with a stored one beside them, other with none', () => {
  const patch = (/** @type {any} */ p) => ({ type: 'session.patch', data: { id: 'se_1', patch: p } });
  assert.equal(kindOf(patch({ currentStep: 'Read', updatedAt: 1 })), 'progress: session.patch');
  assert.equal(kindOf(patch({ currentStep: 'Read', state: 'tool' })), 'mixed: session.patch');
  assert.equal(kindOf(patch({ state: 'idle', updatedAt: 1 })), 'other: session.patch');
  assert.equal(kindOf(patch({ compacting: true })), 'other: session.patch', 'compacting stays stored');
});

test('a time 12% worse in every pair is worse, though the bands overlap; the same times are not', async () => {
  const { compare } = await import('../tools/measure-progress/compare.mjs');
  // A busy machine: each pair runs slower than the last, so the branch’s median sits inside main’s band.
  const mainMs = [100, 140, 180, 220, 260, 300, 340, 380];
  const main = mainMs.map((ms) => [{ row: 'r', cpuMs: ms, logBytes: 1000 }]);
  const worse = mainMs.map((ms) => [{ row: 'r', cpuMs: ms * 1.12, logBytes: 1000 }]);
  const same = mainMs.map((ms) => [{ row: 'r', cpuMs: ms, logBytes: 1000 }]);
  assert.equal(compare(main, worse).find((c) => c.key === 'cpuMs')?.worse, true);
  assert.equal(
    compare(main, same).some((c) => c.worse),
    false,
  );
  const bytes = mainMs.map((ms) => [{ row: 'r', cpuMs: ms, logBytes: 1100 }]);
  assert.equal(compare(main, bytes).find((c) => c.key === 'logBytes')?.worse, true);
});

test('a number is worse only when a second round of pairs agrees, and small times and the time a delta aren’t judged', async () => {
  const { compare, worseTwice } = await import('../tools/measure-progress/compare.mjs');
  const runs = (/** @type {number} */ k) =>
    [100, 140, 180, 220, 260, 300, 340, 380].map((ms) => [{ row: 'r', cpuMs: ms * k, pushMs: (ms / 100) * k, usPerDelta: ms * k }]);
  const worse = compare(runs(1), runs(1.2));
  assert.deepEqual(
    worse.filter((c) => c.worse).map((c) => c.key),
    ['cpuMs'],
    'pushMs under 20 ms and usPerDelta, pushMs again, are reported only',
  );
  assert.equal(worseTwice(worse, compare(runs(1), runs(1))).length, 0, 'a second round that disagrees clears it');
  assert.equal(worseTwice(worse, compare(runs(1), runs(1.2))).length, 1, 'one that agrees keeps it');
});
