// #990 through the page’s routes: making an agent (POST /api/personas) and saving its sheet (PATCH
// /api/personas/:id) refuse a folder that isn’t a full path with a 422 and the message the sheet shows, and keep
// nothing of it. tests/persona-folder.test.mjs holds the check itself.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4444;
const RELATIVE = 'Write the folder’s full path, starting with /. Postbox doesn’t guess where a relative one is.';
let app;
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });
const pageCookie = async () => (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];

before(async () => {
  const dir = tempDir('pb-persona-folder-routes-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false });
});
after(() => app.close());

test('making an agent with a relative folder answers 422 with the full-path message, and makes no agent', async () => {
  const cookie = await pageCookie();
  const had = Object.keys(app.store.state.personas).length;
  for (const folder of ['server', '../x', '~/x']) {
    const r = await call({ method: 'POST', path: '/api/personas', body: { handle: 'helper', folder }, cookie });
    assert.equal(r.status, 422, r.text);
    assert.equal(r.json.error, RELATIVE);
  }
  assert.equal(Object.keys(app.store.state.personas).length, had);
});

test('saving an agent’s sheet with a relative folder answers 422 with the full-path message, and keeps its folder', async () => {
  const cookie = await pageCookie();
  const made = await call({ method: 'POST', path: '/api/personas', body: { handle: 'keeper', folder: '/srv/keeper/' }, cookie });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.folder, '/srv/keeper');
  const r = await call({ method: 'PATCH', path: `/api/personas/${made.json.id}`, body: { folder: '~/x' }, cookie });
  assert.equal(r.status, 422, r.text);
  assert.equal(r.json.error, RELATIVE);
  assert.equal(app.store.state.personas[made.json.id].folder, '/srv/keeper');
});
