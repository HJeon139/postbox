// An asset’s content is kept only in its blob file (#516 S3, designs/architecture.md, “Assets”): the asset events are
// public and carry metadata alone, so the content must never reach the event log, a snapshot, or /api/state’s JSON.
// Nor in another encoding (#722): JSON writes a Buffer as its bytes, `{"type":"Buffer","data":[…]}`, and a copy could
// be hex or base64. So each event, asset and version carries exactly its known keys, and the content is looked for in
// each of those forms too.
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

/** The keys each asset record may carry: metadata only (shared/state-assets.mjs). */
const KEYS = {
  asset: ['created', 'id', 'name', 'room'],
  'asset.version': ['id', 'prunes', 'released', 'version'],
  stored: ['created', 'head', 'id', 'name', 'room', 'versions'],
  version: ['at', 'author', 'base', 'isText', 'op', 'pruned', 'sha256', 'size', 'type', 'v'],
};
/** Fails unless the record’s keys are among the allowed ones. @param {object} record @param {string[]} allowed @param {string} what */
function onlyKeys(record, allowed, what) {
  const extra = Object.keys(record).filter((k) => !allowed.includes(k));
  assert.deepEqual(extra, [], `${what} carries only metadata`);
}
/** The forms content could be copied into a record in: as text, hex, base64, and the bytes JSON writes for a Buffer. */
const forms = (/** @type {Buffer} */ bytes, /** @type {string} */ marker) => ({
  text: marker,
  hex: Buffer.from(marker).toString('hex'),
  base64: bytes.toString('base64'),
  bytes: [...Buffer.from(marker)].join(','),
});

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
  const first = Buffer.from(`# Plan\n${marker}\n`);
  const a = await writeAsset(store, assetBlobs(dir), { ...req, name: 'notes/plan.md', bytes: first });
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

  for (const [form, text] of Object.entries(forms(first, marker))) {
    assert.ok(!log.includes(text), `no content in the event log, as ${form}`);
    assert.ok(!snapshot.includes(text), `no content in the snapshot, as ${form}`);
    assert.ok(!api.includes(text), `no content in /api/state, as ${form}`);
  }
  // Whatever the encoding, nothing beyond the known keys: the log’s asset events, and the assets the state keeps.
  const events = log
    .split('\n')
    .filter(Boolean)
    // A commit of several events is one line holding their array (server/store-commit.mjs).
    .flatMap((l) => [JSON.parse(l)].flat())
    .filter((e) => e.type === 'asset' || e.type === 'asset.version');
  assert.equal(events.length, 3, 'one asset event and two versions');
  for (const e of events) {
    onlyKeys(e.data, KEYS[e.type], `the log’s ${e.type}`);
    if (e.type === 'asset.version') onlyKeys(e.data.version, KEYS.version, 'the log’s version');
  }
  for (const [where, state] of [
    ['the snapshot', JSON.parse(snapshot).state ?? JSON.parse(snapshot)],
    ['/api/state', JSON.parse(api)],
  ])
    for (const asset of Object.values(state.assets ?? {})) {
      onlyKeys(asset, KEYS.stored, `${where}’s asset`);
      for (const v of asset.versions) onlyKeys(v, KEYS.version, `${where}’s version`);
    }
});
