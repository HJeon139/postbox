// #992: the sandbox pages (an app’s version and the Mermaid page) name the one page that may frame them, in
// frame-ancestors: Postbox’s page at the spelling the request came to, 127.0.0.1 or localhost, on Postbox’s port. The
// spellings are different origins, so naming both would let a page at one frame the other’s sandbox. The listener’s
// origin is named rather than 'self', because the sandbox page’s own origin is opaque (its policy starts `sandbox`).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fakeRequest } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4992;
let app;
before(async () => {
  const dir = tempDir('pb-frame-ancestors-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  app.rt.store.emit('project', { id: 'p1', name: 'P', folder: null });
  const p = app.rt.createPersona({ handle: 'drawer' });
  const t = app.rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  app.rt.toolsFor(app.rt.sessionsIn(t.id)[0].id).show_app({ id: 'framed', title: 'Framed', code: '<p>Hi</p>' });
});
after(async () => {
  await app.close();
});

/** The whole policy a sandbox page carries when the request came to `host`. */
const policy = (host) =>
  [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: http://127.0.0.1:${PORT}/media/`,
    'media-src blob:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors http://${host}`,
  ].join('; ');

const ROUTES = ['/sandbox/app/framed/1?theme=dark', '/sandbox/app/framed/1?theme=light&check', '/sandbox/mermaid?theme=dark'];

test('#992: each sandbox page may be framed only by Postbox’s page at the spelling it was asked for', async () => {
  for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`])
    for (const path of ROUTES) {
      const res = await fakeRequest(app.handle, { path, host });
      assert.equal(res.status, 200, `${host}${path}`);
      assert.equal(res.headers['content-security-policy'], policy(host), `${host}${path}`);
    }
});

test('#992: a Host in capitals names the lowercase origin the browser compares against', async () => {
  for (const path of ROUTES) {
    const res = await fakeRequest(app.handle, { path, host: `LocalHost:${PORT}` });
    assert.equal(res.headers['content-security-policy'], policy(`localhost:${PORT}`), path);
  }
});

test('#992: a sandbox page asked for at another port, or another host, isn’t served at all, so it names no ancestor', async () => {
  for (const host of [`127.0.0.1:${PORT + 1}`, `localhost:${PORT + 1}`, `127.0.0.1`, `example.com:${PORT}`])
    for (const path of ROUTES) {
      const res = await fakeRequest(app.handle, { path, host });
      assert.equal(res.status, 421, `${host}${path}`);
      assert.equal(res.headers['content-security-policy'], undefined, `${host}${path}`);
    }
});
