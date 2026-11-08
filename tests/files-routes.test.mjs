// #820: the routes that serve stored bytes without a token, a file by its id (/api/files/:id), an app’s data file
// (/api/apps/:id/files/:name) and a command’s output in the work ledger (/api/threads/:id/work/commands/:id/output),
// send Cross-Origin-Resource-Policy: same-origin, so a page on another site can’t embed one. The page loads each by a
// same-origin path, at either host spelling, so it still can.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fakeRequest } from './fake-http.mjs';
import { png } from './review-files-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4473;
const HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
let app;
before(async () => {
  const dir = tempDir('pb-files-routes-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
});
after(async () => {
  await app.close();
});

/** A response’s headers with lowercase names. */
const lower = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * A stored image, a stored file that downloads, an app whose version carries a data file, and a conversation whose
 * work holds a command with its output.
 */
async function stored() {
  const { rt } = app;
  const image = png(4, 3);
  const text = Buffer.from('a,b\n1,2\n');
  const output = Buffer.from(' M calc.py\n<b>"&"</b>\n');
  const img = await rt.blobs.put(image);
  const csv = await rt.blobs.put(text);
  const out = await rt.blobs.put(output);
  rt.store.emit('file', { id: 'fi_image', name: 'a"<&b.png', type: 'image/png', size: img.size, sha256: img.sha256 });
  rt.store.emit('file', { id: 'fi_csv', name: 'pairs.csv', type: 'text/csv', size: csv.size, sha256: csv.sha256 });
  rt.store.emit('app', { id: 'ap_data', title: 'Data', current: 1, versions: [{ code: '<p>x</p>', files: [{ name: 'pairs.json', ...csv }] }] });
  if (!rt.store.state.threads.th_work) rt.store.emit('thread', { id: 'th_work', members: [] });
  if (!rt.store.state.work?.th_work?.length)
    rt.store.emit('work.add', { convId: 'th_work', entry: { id: 'wk_cmd', kind: 'command', command: 'git status', state: 'done', output: out } });
  await rt.store.flush();
  return { image, text, output };
}

test('#820 a stored image is served with the exact headers, Cross-Origin-Resource-Policy: same-origin included, at either host', async () => {
  const { image } = await stored();
  for (const host of HOSTS) {
    const r = await fakeRequest(app.handle, { host, path: '/api/files/fi_image' });
    assert.equal(r.status, 200, host);
    assert.deepEqual(r.bytes, image, host);
    assert.deepEqual(
      lower(r.headers),
      {
        'content-type': 'image/png',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'content-disposition': 'inline; filename="a___b.png"',
        'cache-control': 'private, max-age=31536000, immutable',
        'cross-origin-resource-policy': 'same-origin',
      },
      host,
    );
  }
});

test('#820 a stored file that downloads is served with Cross-Origin-Resource-Policy: same-origin too, at either host', async () => {
  const { text } = await stored();
  for (const host of HOSTS) {
    const r = await fakeRequest(app.handle, { host, path: '/api/files/fi_csv' });
    assert.equal(r.status, 200, host);
    assert.deepEqual(r.bytes, text, host);
    assert.deepEqual(
      lower(r.headers),
      {
        'content-type': 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'content-disposition': 'attachment; filename="pairs.csv"',
        'cache-control': 'private, max-age=31536000, immutable',
        'cross-origin-resource-policy': 'same-origin',
      },
      host,
    );
  }
});

test('#820 an app’s data file is served with the exact headers, Cross-Origin-Resource-Policy: same-origin included, at either host', async () => {
  const { text } = await stored();
  for (const host of HOSTS) {
    const r = await fakeRequest(app.handle, { host, path: '/api/apps/ap_data/files/pairs.json?v=1' });
    assert.equal(r.status, 200, host);
    assert.deepEqual(r.bytes, text, host);
    assert.deepEqual(
      lower(r.headers),
      {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'cache-control': 'no-store',
        'cross-origin-resource-policy': 'same-origin',
      },
      host,
    );
  }
});

test('#820 a command’s output in the work ledger is served with the exact headers, Cross-Origin-Resource-Policy: same-origin included, at either host', async () => {
  const { output } = await stored();
  for (const host of HOSTS) {
    const r = await fakeRequest(app.handle, { host, path: '/api/threads/th_work/work/commands/wk_cmd/output' });
    assert.equal(r.status, 200, host);
    assert.deepEqual(r.bytes, output, host);
    assert.deepEqual(
      lower(r.headers),
      {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      },
      host,
    );
  }
});

test('#820 a miss on any of these routes is a JSON 404 that says what’s missing and carries no file’s bytes', async () => {
  await stored();
  const misses = {
    '/api/files/fi_missing': 'That file doesn’t exist.',
    '/api/apps/ap_data/files/missing.json': 'This version of Data has no file “missing.json”.',
    '/api/apps/ap_missing/files/pairs.json': 'That app doesn’t exist.',
    '/api/threads/th_work/work/commands/wk_missing/output': 'That command isn’t in this conversation’s work.',
  };
  for (const [path, error] of Object.entries(misses)) {
    const r = await fakeRequest(app.handle, { host: HOSTS[0], path });
    assert.equal(r.status, 404, path);
    assert.deepEqual(lower(r.headers), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, path);
    assert.deepEqual(r.json, { error }, path);
  }
});
