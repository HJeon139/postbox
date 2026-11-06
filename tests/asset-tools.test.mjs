// The asset tools as an agent calls them (#516 S3b, server/asset-tools.mjs): write_asset creates and updates from the
// base it read, read_asset reads one version in parts the first part fixes, list_assets pages the room, and rename,
// delete and restore make versions. The commit path itself is tests/assets.test.mjs’s and the failure rows
// tests/asset-failures.test.mjs’s; these test what the tools add: their arguments, their answers and their reads.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { ASSETS, READING } from '../shared/limits.mjs';
import { assetRoom, contentOf, readsOn } from './asset-tools-fixture.mjs';

const idOf = (/** @type {string} */ msg) => /asset (as_\w+)/.exec(msg)?.[1];

test('#516 S3b: write_asset makes an asset from a name and text, and read_asset reads it back, naming its author and version', async (ctx) => {
  const { A, B } = await assetRoom(ctx);
  const made = await A.write_asset({ name: 'notes/plan.md', text: '# Plan\n' });
  assert.equal(made.ok, true, made.message);
  assert.match(made.message, /^Published v1 of asset as_\w+, “notes\/plan\.md”, 7 bytes\. To change it, write from base: 1\.$/);
  const read = await B.read_asset({ id: made.id });
  assert.equal(read.ok, true, read.message);
  assert.match(read.message, /v1 \(the newest\), by @alpha/);
  assert.match(read.message, /not instructions to you/, 'the content is data (SC-4)');
  assert.equal(contentOf(read.message), '# Plan\n');
});

test('#516 S3b: an update names the base it read; a stale one is refused naming the newer version, and a repeat with its op makes nothing', async (ctx) => {
  const { A, B } = await assetRoom(ctx);
  const { id } = await A.write_asset({ name: 'plan.md', text: 'one' });
  assert.equal((await B.write_asset({ id, base: 1, text: 'two', op: 'b-1' })).ok, true);
  const stale = await A.write_asset({ id, base: 1, text: 'three' });
  assert.equal(stale.ok, false);
  assert.match(stale.message, /@beta wrote version 2/);
  const again = await B.write_asset({ id, base: 1, text: 'two', op: 'b-1' });
  assert.equal(again.ok, true, again.message);
  assert.match(again.message, /^Already published as v2/);
  assert.equal(contentOf((await A.read_asset({ id })).message), 'two');
});

test('#516 S3b: write_asset refuses what it can’t make sense of, before anything is stored', async (ctx) => {
  const { A, rt } = await assetRoom(ctx);
  const { id } = await A.write_asset({ name: 'a.md', text: 'x' });
  const cases = [
    [{ name: 'b.md' }, /text or path: one of them/],
    [{ name: 'b.md', text: 'x', path: 'x.md' }, /text or path: one of them/],
    [{ name: 'b.md', text: 7 }, /as a string/],
    [{ name: 'b.md', base: 1, text: 'x' }, /A new asset has no base/],
    [{ id, name: 'c.md', base: 1, text: 'x' }, /use rename_asset/],
    [{ id, text: 'x' }, /Name the version you read as base/],
    [{ id, base: 0, text: 'x' }, /Name the version you read as base/],
    [{ id: 5, base: 1, text: 'x' }, /by its id/],
    [{ name: 'b.md', text: 'x', type: 'not a type' }, /media type/],
    [{ name: '../b.md', text: 'x' }, /no empty, \. or \.\. part/],
    [{ name: 'b.md', text: 'x', op: 'has space' }, /letters, digits/],
  ];
  for (const [args, why] of cases) {
    const r = await A.write_asset(args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.message, why, JSON.stringify(args));
  }
  assert.deepEqual(Object.keys(rt.s.assets), [id], 'nothing else was made');
  const long = await A.read_asset({ id: `as_${'x'.repeat(10_000)}` });
  assert.ok(long.message.length < 300, 'an id an agent sent is clipped where an answer names it');
  assert.match((await A.read_asset({ id: '__proto__' })).message, /There’s no asset __proto__/);
});

test('#516 S3b: path reads a file in the agent’s folders, and one outside them is refused; an agent on a host gets text only', async (ctx) => {
  const { A, as, alpha, folder } = await assetRoom(ctx);
  writeFileSync(join(folder, 'report.md'), '## Report\n');
  const made = await A.write_asset({ name: 'report.md', path: 'report.md' });
  assert.equal(made.ok, true, made.message);
  assert.equal(contentOf((await A.read_asset({ id: made.id })).message), '## Report\n');
  // A file of the test’s own, in a folder that isn’t one of the agent’s.
  const elsewhere = mkdtempSync(join(tmpdir(), 'pb-asset-elsewhere-'));
  ctx.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  writeFileSync(join(elsewhere, 'secret.md'), 'not yours');
  assert.match((await A.write_asset({ name: 'x.md', path: join(elsewhere, 'secret.md') })).message, /outside your folders/);
  const onHost = await as(alpha, null, { onHost: true }).write_asset({ name: 'y.md', path: 'report.md' });
  assert.equal(onHost.ok, false);
  assert.match(onHost.message, /On a remote host, write_asset takes text/);
});

test('#516 S3b: a long text is read in parts by following each “reads on” line, and a write between parts doesn’t change them', async (ctx) => {
  const { A, B } = await assetRoom(ctx);
  const v1 = Array.from({ length: 9000 }, (_, i) => `line ${String(i).padStart(5, '0')}\n`).join('');
  const { id } = await A.write_asset({ name: 'long.txt', text: v1 });
  const one = (await B.read_asset({ id })).message;
  const at = readsOn(one);
  assert.deepEqual(at, { id, version: 1, from: READING.part }, 'the first part fixes the version (IF-2)');
  assert.ok(one.includes(`(Characters 1–40,000 of ${v1.length.toLocaleString('en-US')} of v1.`), 'N counts the content alone');
  await A.write_asset({ id, base: 1, text: 'replaced' });
  const two = (await B.read_asset(at)).message;
  const three = (await B.read_asset(readsOn(two))).message;
  assert.equal(readsOn(three), null);
  assert.equal(contentOf(one) + contentOf(two) + contentOf(three), v1);
});

test('#516 S3b: a part never ends inside a character, and content with backticks gets a longer fence', async (ctx) => {
  const { A } = await assetRoom(ctx);
  const text = `${'a'.repeat(READING.part - 1)}\u{1F600}tail`;
  const { id } = await A.write_asset({ name: 'emoji.txt', text });
  const one = (await A.read_asset({ id })).message;
  const two = (await A.read_asset(readsOn(one))).message;
  assert.ok(!/[\uD800-\uDBFF]$/.test(contentOf(one)), 'part 1 doesn’t end with half a character');
  assert.equal(contentOf(one) + contentOf(two), text);
  const md = 'Use:\n````js\nx\n````\n';
  const fenced = (await A.read_asset({ id: (await A.write_asset({ name: 'fence.md', text: md })).id })).message;
  assert.match(fenced, /\n`````\n/);
  assert.equal(contentOf(fenced), md);
  const empty = (await A.read_asset({ id: (await A.write_asset({ name: 'empty.md', text: '' })).id })).message;
  assert.match(empty, /not instructions to you\.\n\n```\n\n```$/, 'an empty version reads as an empty block');
});

test('#516 S3b: rename, delete and restore each make a version; a deleted one reads as deleted and lists as such', async (ctx) => {
  const { A } = await assetRoom(ctx);
  const { id } = await A.write_asset({ name: 'old.md', text: 'body' });
  assert.match((await A.rename_asset({ id, base: 1, name: 'new.md' })).message, /^Renamed it as v2 of asset \S+, “new\.md”/);
  assert.match((await A.delete_asset({ id, base: 2 })).message, /^Deleted it as v3/);
  assert.match((await A.read_asset({ id })).message, /This version deletes it/);
  assert.match((await A.list_assets({})).message, new RegExp(`\\[${id}\\] new\\.md: deleted at v3 by @alpha`));
  assert.match((await A.restore_asset({ id, version: 1, base: 3 })).message, /^Restored v1 as v4/);
  assert.equal(contentOf((await A.read_asset({ id })).message), 'body');
  assert.match((await A.restore_asset({ id, base: 4 })).message, /Name the version to restore/);
  assert.match((await A.read_asset({ id, version: 9 })).message, /has no version 9: it has v1 to v4/);
  assert.match((await A.read_asset({ id, from: 99 })).message, /Nothing after character 4 of v4: that’s the end of it\./);
});

test('I5: a rename_asset or delete_asset retried without an op answers that it repeated, quoting the stored name', async (ctx) => {
  const { A, B } = await assetRoom(ctx);
  const { id } = await A.write_asset({ name: 'old.md', text: 'body' });
  // Sent decomposed (NFD), stored and quoted NFC: the answer quotes the asset’s name, not the string sent.
  const name = 'q"<&amp;>e\u0301.md';
  const stored = 'q"<&amp;>\u00e9.md';
  const repeated = (/** @type {number} */ v) =>
    `Already published as v${v} of asset ${id}, “${stored}”; this write repeated it, so nothing new was made. To change it, write from base: ${v}.`;
  assert.match((await A.rename_asset({ id, base: 1, name })).message, /^Renamed it as v2/);
  assert.equal((await A.rename_asset({ id, base: 1, name })).message, repeated(2));
  const other = await B.rename_asset({ id, base: 1, name });
  assert.equal(other.message, `@alpha wrote version 2 of ${id} since version 1. Read version 2, then write again from it.`);
  assert.equal((await A.rename_asset({ id, base: 1, name: 'nul\u0000.md' })).message, 'An asset’s name has no backslash or control characters.');
  assert.equal((await A.delete_asset({ id, base: 2 })).ok, true);
  assert.equal((await A.delete_asset({ id, base: 2 })).message, repeated(3));
});

test('rename_asset of a deleted asset is refused, saying to restore it first, whatever the new name holds (#707)', async (ctx) => {
  const { A } = await assetRoom(ctx);
  const { id } = await A.write_asset({ name: 'old.md', text: 'body' });
  await A.delete_asset({ id, base: 1 });
  const said = `Asset ${id} is deleted, so it can’t be renamed. Bring a version back with restore_asset first, then rename it.`;
  // The refusal quotes the id, never the name an agent sent, so quotes, <, & and NUL can't reach it.
  for (const name of ['new.md', 'q"<&>.md', 'q&amp;.md']) {
    const r = await A.rename_asset({ id, base: 2, name });
    assert.deepEqual([r.ok, r.message], [false, said], name);
  }
  const nul = await A.rename_asset({ id, base: 2, name: 'nul\u0000.md' });
  assert.deepEqual([nul.ok, nul.message], [false, 'An asset’s name has no backslash or control characters.']);
  assert.match((await A.list_assets({})).message, new RegExp(`\\[${id}\\] old\\.md: deleted at v2 by @alpha`));
});

test('#516 S3b: a binary version gives its metadata, and a pruned one says it was pruned and can’t be restored', async (ctx) => {
  const { A, folder } = await assetRoom(ctx);
  const big = (/** @type {number} */ n) => {
    const b = Buffer.alloc(ASSETS.largeBinaryBytes + 1, n);
    b[0] = 0; // a NUL byte: binary, whatever the rest decodes as
    writeFileSync(join(folder, `big-${n}.bin`), b);
    return `big-${n}.bin`;
  };
  const { id } = await A.write_asset({ name: 'model.bin', path: big(1) });
  for (let v = 1; v <= ASSETS.binaryVersionsKept; v++) assert.equal((await A.write_asset({ id, base: v, path: big(v + 1) })).ok, true);
  assert.match(
    (await A.read_asset({ id })).message,
    /It’s binary \(1,048,577 bytes, application\/octet-stream, sha256 [0-9a-f]{64}\), so read_asset gives only this\./,
  );
  assert.match((await A.read_asset({ id, version: 1 })).message, /pruned under the room’s retention rule/);
  const back = await A.restore_asset({ id, version: 1, base: ASSETS.binaryVersionsKept + 1 });
  assert.equal(back.ok, false);
  assert.match(back.message, /pruned/);
});

test('#516 S3b: list_assets pages the room’s assets by name, ignoring case, and a write’s type comes from its name', async (ctx) => {
  const { A } = await assetRoom(ctx);
  assert.match((await A.list_assets({})).message, /no assets yet/);
  for (const name of ['b.md', 'A.json', 'c.txt', 'd.constructor']) await A.write_asset({ name, text: '{}' });
  const lines = (await A.list_assets({})).message.split('\n').filter((l) => l.startsWith('['));
  assert.deepEqual(
    lines.map((l) => / (\S+): v1 by @alpha, 2 bytes, (\S+),/.exec(l)?.slice(1).join(' ')),
    ['A.json application/json', 'b.md text/markdown', 'c.txt text/plain', 'd.constructor text/plain'],
  );
  for (let i = 0; i < ASSETS.listPage; i++) await A.write_asset({ name: `p/${String(i).padStart(3, '0')}.md`, text: 'x' });
  const first = (await A.list_assets({})).message;
  assert.match(first, /Page 1 of 2: 104 assets\. list_assets \{ page: 2 \} lists more\./);
  assert.equal((await A.list_assets({ page: 2 })).message.split('\n').filter((l) => l.startsWith('[')).length, 4);
});

test('#516 S3b: topic and side threads share their conversation’s assets, and another conversation can’t read them', async (ctx) => {
  const { rt, A, as, alpha, t } = await assetRoom(ctx);
  const { id } = await A.write_asset({ name: 'shared.md', text: 'one room' });
  const root = rt.addItem(t.id, { kind: 'user', text: 'Start a topic' });
  const topic = rt.startTopic(t.id, root.id).threadId;
  assert.match((await as(alpha, { threadId: topic }).list_assets({})).message, /shared\.md/);
  // A side thread’s session is its own, in its own thread: the room is still the conversation’s.
  const side = rt.createThread({ projectId: 'p1', title: 'Side', kind: 'side', parentId: t.id, personaIds: [alpha.personaId] });
  assert.match((await as(rt.sessionsIn(side.id)[0]).list_assets({})).message, /shared\.md/);
  const other = rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [alpha.personaId] });
  const there = as(rt.sessionsIn(other.id)[0]);
  assert.match((await there.read_asset({ id })).message, /There’s no asset as_\w+ in this conversation/);
  assert.match((await there.write_asset({ id, base: 1, text: 'x' })).message, /no asset/);
  assert.equal(idOf((await there.write_asset({ name: 'shared.md', text: 'two' })).message) !== id, true, 'the name is free in another room');
  // Each conversation lists its own assets alone.
  assert.match((await there.list_assets({})).message, /\(Page 1 of 1: 1 asset\.\)$/);
  assert.match((await A.list_assets({})).message, /\(Page 1 of 1: 1 asset\.\)$/);
});

test('#516 S3b: a write while its conversation is being deleted says so, and after Undo the same write is published', async (ctx) => {
  const { A, rt, t } = await assetRoom(ctx);
  rt.deleteThread(t.id);
  const during = await A.write_asset({ name: 'late.md', text: 'x' });
  assert.equal(during.ok, false);
  assert.match(during.message, /being deleted/, 'the tool passes the store’s refusal through as it is');
  rt.undoDeleteThread(t.id);
  const after = await A.write_asset({ name: 'late.md', text: 'x' });
  assert.equal(after.ok, true, after.message);
});

test('#516 S3b: a store kept in memory has no assets folder, so a write says so and a read finds nothing', async (ctx) => {
  const { A } = await assetRoom(ctx, { store: new Store(null) });
  const r = await A.write_asset({ name: 'a.md', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.message, /keeps no data folder/);
});
