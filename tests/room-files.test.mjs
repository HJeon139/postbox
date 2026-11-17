// #1446: Work’s viewer reads a room asset’s bytes (/api/threads/:id/assets/:assetId) and a changed file as the agents
// left it (/api/threads/:id/work/files/:fileId/content). Each answers only for its own conversation, with /api/files’s
// headers: text as text/plain, the four safe image types inline, anything else as a download, never as a page.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { writeAsset } from '../server/assets.mjs';
import { VIEWER } from '../shared/limits.mjs';
import { fakeRequest } from './fake-http.mjs';
import { png } from './review-files-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4474;
const host = `127.0.0.1:${PORT}`;
let app;
/** @type {Record<string, string>} */
const ids = {};
const image = png(4, 3);

/** The conversation’s changed files: one kept as text, one too large to keep, and one that isn’t UTF-8. @param {any} rt */
async function changedFiles(rt) {
  const kept = await rt.blobs.put(Buffer.from('export const year = 2026;\n'));
  rt.store.emit('work.add', {
    convId: 'th_a',
    entry: {
      id: 'wf_cite',
      kind: 'file',
      path: '/p/cite.mjs',
      rel: 'cite.mjs',
      handles: ['alpha'],
      before: { exists: false },
      after: { exists: true, size: kept.size, sha256: kept.sha256, binary: false },
    },
  });
  rt.store.emit('work.add', {
    convId: 'th_a',
    entry: {
      id: 'wf_big',
      kind: 'file',
      path: '/p/big.bin',
      rel: 'big.bin',
      handles: ['alpha'],
      before: { exists: false },
      after: { exists: true, size: 9e6, big: true },
    },
  });
  // A changed file that isn’t UTF-8: continuation bytes all the way, with no NUL, so the ledger keeps it as text.
  const odd = await rt.blobs.put(Buffer.alloc(VIEWER.textBytes + 10, 0x80));
  rt.store.emit('work.add', {
    convId: 'th_a',
    entry: {
      id: 'wf_odd',
      kind: 'file',
      path: '/p/odd.txt',
      rel: 'odd.txt',
      handles: ['alpha'],
      before: { exists: false },
      after: { exists: true, size: odd.size, sha256: odd.sha256, binary: false },
    },
  });
}

before(async () => {
  const dir = tempDir('pb-room-files-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  const { rt } = app;
  const write = async (room, name, bytes, type) => {
    const r = await writeAsset(rt.store, rt.assets.roomBlobs(), { kind: 'write', room, name, bytes: Buffer.from(bytes), type, author: 'alpha' });
    assert.ok(r.ok, JSON.stringify(r));
    return r.id;
  };
  rt.store.emit('thread', { id: 'th_a', members: [] });
  rt.store.emit('thread', { id: 'th_a_side', kind: 'side', parentId: 'th_a', members: [] });
  rt.store.emit('thread', { id: 'th_b', members: [] });
  ids.notes = await write('th_a', 'notes/plan.md', '# Plan\n<script>x</script>\n', 'text/markdown');
  ids.image = await write('th_a', 'pics/dot.png', image, 'image/png');
  ids.page = await write('th_a', 'site/index.html', '<!doctype html><script>alert(1)</script>', 'text/html');
  ids.other = await write('th_b', 'theirs.md', 'not yours', 'text/markdown');
  ids.gone = await write('th_a', 'gone.md', 'was here', 'text/markdown');
  const del = await writeAsset(rt.store, rt.assets.roomBlobs(), { kind: 'delete', room: 'th_a', id: ids.gone, base: 1, author: 'alpha' });
  assert.ok(del.ok, JSON.stringify(del));
  // Past the viewer’s limit, with a three-byte character across it.
  ids.long = await write('th_a', 'long.txt', `${'a'.repeat(VIEWER.textBytes - 1)}€tail`, 'text/plain');
  await changedFiles(rt);
  await rt.store.flush();
});
after(async () => {
  await app.close();
});

const get = (path) => fakeRequest(app.handle, { host, path });
const lower = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
const SAFE = { 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'cross-origin-resource-policy': 'same-origin' };

test('a markdown asset is served as plain text, inline and sandboxed, so the page renders it and nothing runs', async () => {
  const r = await get(`/api/threads/th_a/assets/${ids.notes}`);
  assert.equal(r.status, 200);
  assert.equal(r.bytes.toString(), '# Plan\n<script>x</script>\n');
  const h = lower(r.headers);
  assert.equal(h['content-type'], 'text/plain; charset=utf-8');
  assert.equal(h['content-disposition'], 'inline; filename="plan.md"');
  for (const [k, v] of Object.entries(SAFE)) assert.equal(h[k], v, k);
});

test('an image asset of a safe type is served as that image, inline', async () => {
  const r = await get(`/api/threads/th_a/assets/${ids.image}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.bytes, image);
  assert.equal(lower(r.headers)['content-type'], 'image/png');
});

test('an HTML asset is never served as a page: it comes as text', async () => {
  const r = await get(`/api/threads/th_a/assets/${ids.page}`);
  assert.equal(r.status, 200);
  assert.equal(lower(r.headers)['content-type'], 'text/plain; charset=utf-8');
});

test('?download=1 sends any asset as a download', async () => {
  const r = await get(`/api/threads/th_a/assets/${ids.image}?download=1`);
  const h = lower(r.headers);
  assert.equal(h['content-type'], 'application/octet-stream');
  assert.equal(h['content-disposition'], 'attachment; filename="dot.png"');
});

test('a side thread reads its conversation’s assets', async () => {
  const r = await get(`/api/threads/th_a_side/assets/${ids.notes}`);
  assert.equal(r.status, 200);
});

test('an asset of another conversation is the same 404 as one that doesn’t exist', async () => {
  const theirs = await get(`/api/threads/th_a/assets/${ids.other}`);
  const none = await get('/api/threads/th_a/assets/as_nothere1');
  assert.equal(theirs.status, 404);
  assert.equal(none.status, 404);
  assert.doesNotMatch(theirs.bytes.toString(), /not yours/);
});

test('a version that isn’t there is a 404', async () => {
  const r = await get(`/api/threads/th_a/assets/${ids.notes}?v=7`);
  assert.equal(r.status, 404);
});

test('a changed file is served from the copy the ledger kept, as text', async () => {
  const r = await get('/api/threads/th_a/work/files/wf_cite/content');
  assert.equal(r.status, 200);
  assert.equal(r.bytes.toString(), 'export const year = 2026;\n');
  const h = lower(r.headers);
  assert.equal(h['content-type'], 'text/plain; charset=utf-8');
  assert.equal(h['content-disposition'], 'inline; filename="cite.mjs"');
  for (const [k, v] of Object.entries(SAFE)) assert.equal(h[k], v, k);
});

test('a changed file of which Postbox kept no copy is a 404 that says so', async () => {
  const r = await get('/api/threads/th_a/work/files/wf_big/content');
  assert.equal(r.status, 404);
  assert.match(JSON.parse(r.bytes.toString()).error, /kept no copy of big\.bin/);
});

test('a file from another conversation’s work is a 404', async () => {
  const r = await get('/api/threads/th_b/work/files/wf_cite/content');
  assert.equal(r.status, 404);
});

test('a deleted asset is a 404 at every version, its older ones included', async () => {
  for (const q of ['', '?v=1', '?v=1&download=1']) {
    const r = await get(`/api/threads/th_a/assets/${ids.gone}${q}`);
    assert.equal(r.status, 404, q);
    assert.doesNotMatch(r.bytes.toString(), /was here/, q);
  }
});

test('text shown inline is cut at the viewer’s limit in bytes, at a character’s edge, and a download sends it whole', async () => {
  const shown = await get(`/api/threads/th_a/assets/${ids.long}`);
  assert.equal(shown.bytes.length, VIEWER.textBytes - 1, 'the € that crosses the limit is left out whole');
  assert.equal(shown.bytes.toString(), 'a'.repeat(VIEWER.textBytes - 1));
  const whole = await get(`/api/threads/th_a/assets/${ids.long}?download=1`);
  assert.equal(whole.bytes.length, VIEWER.textBytes - 1 + 3 + 4);
});

test('the step back to a character’s edge stops after 3 bytes, so bytes that aren’t UTF-8 still show', async () => {
  const r = await get('/api/threads/th_a/work/files/wf_odd/content');
  assert.equal(r.status, 200);
  assert.equal(r.bytes.length, VIEWER.textBytes - 3);
});
