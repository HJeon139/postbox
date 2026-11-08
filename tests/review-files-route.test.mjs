// #780: the route a review’s image loads from (note as_BkHPLMds v3, §4). It serves only a file on that item, by its
// name and SHA-256, with the headers /api/files sends plus Cross-Origin-Resource-Policy: same-origin, so a page on
// another site can’t embed it. Anything else is a 404 that doesn’t say whether the item exists.

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fakeRequest } from './fake-http.mjs';
import { png } from './review-files-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4471;
let app;
let dir;
const get = (path) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, path });
before(async () => {
  dir = tempDir('pb-review-route-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
});
after(async () => {
  await app.close();
});

/** A review item with one stored image, and another review with none. */
async function reviewWithImage() {
  const { rt } = app;
  rt.store.emit('project', { id: 'p1', name: 'P', folder: null });
  const p = rt.createPersona({ handle: `a${Math.random().toString(36).slice(2, 8)}` });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const bytes = png(4, 3);
  const { sha256, size } = await rt.blobs.put(bytes);
  const file = { name: 'today.png', ref: 'figs/today.png', sha256, size, type: 'image/png', width: 4, height: 3 };
  const block = (id) => ({ id, type: 'review', version: 1, format: 'markdown', content: 'x', fallback: 'x' });
  const it = rt.addItem(t.id, { kind: 'block', valid: true, block: block('fig'), files: [file] });
  const other = rt.addItem(t.id, { kind: 'block', valid: true, block: block('other') });
  // Not a review, though it carries a file record: only a review’s files are served.
  const message = rt.addItem(t.id, { kind: 'message', text: 'x', files: [file] });
  // A block that isn’t a review, though it carries a file record: only a review’s files are served.
  const code = rt.addItem(t.id, { kind: 'block', valid: true, block: { id: 'code', type: 'code', version: 1, code: 'x', fallback: 'x' }, files: [file] });
  // A record whose name would break the header, as no call can make (FILE_NAME refuses it).
  const quoted = rt.addItem(t.id, { kind: 'block', valid: true, block: block('quoted'), files: [{ ...file, name: 'a"b.png' }] });
  await rt.store.flush();
  return { t, it, other, message, code, quoted, bytes, sha256 };
}

const url = (t, it, name, sha) => `/api/threads/${t.id}/items/${it.id}/files/${name}?sha=${sha}`;

test('#780 a review’s image is served by its name and SHA-256, with the exact headers, CORP included', async () => {
  const { t, it, bytes, sha256 } = await reviewWithImage();
  const r = await get(url(t, it, 'today.png', sha256));
  assert.equal(r.status, 200);
  assert.deepEqual(r.bytes, bytes);
  assert.deepEqual(Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v])), {
    'content-type': 'image/png',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'content-disposition': 'inline; filename="today.png"',
    'cache-control': 'private, max-age=31536000, immutable',
    'cross-origin-resource-policy': 'same-origin',
  });
});

test('#780 anything but the item’s own file is the same 404: another name, item, thread or SHA-256', async () => {
  const { t, it, other, message, code, sha256 } = await reviewWithImage();
  const misses = [
    url(t, code, 'today.png', sha256),
    url(t, message, 'today.png', sha256),
    url(t, it, 'nope.png', sha256),
    url(t, other, 'today.png', sha256),
    url(t, it, 'today.png', 'f'.repeat(64)),
    url(t, { id: 'it_missing' }, 'today.png', sha256),
    url({ id: 'th_missing' }, it, 'today.png', sha256),
    `/api/threads/${t.id}/items/${it.id}/files/today.png`,
  ];
  const bodies = new Set();
  for (const path of misses) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    bodies.add(r.text);
  }
  assert.equal(bodies.size, 1, 'every miss says the same thing');
});

test('#780 the header’s filename is kept whole even if a record’s name held a quote', async () => {
  const { t, quoted, sha256 } = await reviewWithImage();
  const r = await get(url(t, quoted, encodeURIComponent('a"b.png'), sha256));
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-disposition'], 'inline; filename="a_b.png"');
});

test('#825 an item whose blob is gone from the store is the same 404, not a 500 naming its path', async () => {
  const { rt } = app;
  const { t, it, sha256 } = await reviewWithImage();
  const gone = await rt.blobs.put(png(9, 7));
  const file = { name: 'gone.png', ref: null, sha256: gone.sha256, size: gone.size, type: 'image/png', width: 9, height: 7 };
  const block = { id: 'gone', type: 'review', version: 1, format: 'markdown', content: 'x', fallback: 'x' };
  const item = rt.addItem(t.id, { kind: 'block', valid: true, block, files: [file] });
  await rt.store.flush();
  await rm(rt.blobs.pathOf(gone.sha256));
  const r = await get(url(t, item, 'gone.png', gone.sha256));
  const miss = await get(url(t, it, 'nope.png', sha256));
  assert.equal(r.status, 404);
  assert.equal(r.text, miss.text, 'the same words as any other miss');
  assert.doesNotMatch(r.text, /blobs|ENOENT/);
});
