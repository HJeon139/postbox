// An asset’s content is kept only in its blob file (#516 S3, designs/architecture.md, “Assets”): the asset events are
// public and carry metadata alone, so the content must never reach the event log, a snapshot, or /api/state’s JSON.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetBlobs, writeAsset } from '../server/assets.mjs';
import { openDataFolder } from '../server/data-folder.mjs';
import { publicState } from '../server/public-state.mjs';

/** The text of each file directly in the data folder whose name matches, joined. */
const filesText = (dir, pattern) =>
  readdirSync(dir)
    .filter((n) => pattern.test(n))
    .map((n) => readFileSync(join(dir, n), 'utf8'))
    .join('\n');

/** The text of every file under the asset folder. */
const blobsText = (dir) =>
  readdirSync(dir)
    .flatMap((f) => readdirSync(join(dir, f)).map((n) => readFileSync(join(dir, f, n), 'utf8')))
    .join('\n');

test('an asset’s content reaches its blob file, and never the event log, a snapshot or /api/state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-assetprivate-'));
  const { store } = await openDataFolder(dir);
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  store.emit('thread', { id: 'c1', members: [] });
  const marker = `marker-${randomUUID()}`;
  const req = { kind: 'write', room: 'c1', type: 'text/markdown', author: 'dev' };
  const a = await writeAsset(store, assetBlobs(dir), { ...req, name: 'notes/plan.md', bytes: Buffer.from(`# Plan\n${marker}\n`) });
  assert.equal(a.ok, true);
  const v2 = await writeAsset(store, assetBlobs(dir), { ...req, id: a.id, base: 1, bytes: Buffer.from(`# Plan\n${marker} v2\n`) });
  assert.equal(v2.ok, true);
  await store.flush();
  const log = filesText(dir, /^events-\d+\.jsonl$/); // read first: a snapshot drops the segments it covers
  await store.snapshot();
  const snapshot = filesText(dir, /^snapshot\.json$/);
  const api = JSON.stringify(publicState(store.state));
  // Each place holds the asset’s metadata, so a missing marker means it was kept out, not that nothing was looked at.
  assert.ok(log.includes(a.version.sha256), 'the log holds the version’s hash');
  assert.ok(snapshot.includes(v2.version.sha256), 'the snapshot holds the head’s hash');
  assert.ok(api.includes(v2.version.sha256), '/api/state holds the head’s hash');
  assert.ok(blobsText(join(dir, 'assets')).includes(marker), 'the content is in its blob file');

  assert.ok(!log.includes(marker), 'no content in the event log');
  assert.ok(!snapshot.includes(marker), 'no content in the snapshot');
  assert.ok(!api.includes(marker), 'no content in /api/state');
});
