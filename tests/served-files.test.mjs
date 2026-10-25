// Files Postbox serves by a request’s path (server/served-files.mjs): only from inside their folder, through links too.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { mediaFile, servedFile } from '../server/served-files.mjs';
import { fakeRequest } from './fake-http.mjs';

let dir = '';
let app = null;
const PORT = 4987;
before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'pb-served-')));
  await mkdir(join(dir, 'folder', 'sub'), { recursive: true });
  await writeFile(join(dir, 'folder', 'sub', 'in.svg'), '<svg/>');
  await writeFile(join(dir, 'secret.svg'), '<svg>secret</svg>');
  await symlink(join(dir, 'secret.svg'), join(dir, 'folder', 'out.svg'));
  await symlink(join(dir, 'folder', 'sub', 'in.svg'), join(dir, 'folder', 'alias.svg'));
  const { start } = await import('../server/index.mjs');
  app = await start({ port: PORT, dataDir: join(dir, 'data'), fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false });
});
after(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

test('#351: a served path resolves through links, and is refused when it lands outside its folder', async () => {
  const folder = join(dir, 'folder');
  assert.equal(await servedFile(folder, 'sub/in.svg'), join(folder, 'sub', 'in.svg'));
  assert.equal(await servedFile(folder, 'alias.svg'), join(folder, 'sub', 'in.svg'), 'a link that stays inside is followed');
  await assert.rejects(servedFile(folder, 'out.svg'), { status: 403 });
  await assert.rejects(servedFile(folder, '../secret.svg'), { status: 403 });
  await assert.rejects(servedFile(folder, '%2e%2e/secret.svg'), { status: 403 });
  await assert.rejects(servedFile(folder, 'missing.svg'), { status: 404 });
  await assert.rejects(servedFile(folder, 'sub/in.svg%00.png'), { status: 404 });
  // The folder itself is no file, and a folder that isn’t there (an installed package ships no mockups/) has none.
  await assert.rejects(servedFile(folder, ''), { status: 404 });
  await assert.rejects(servedFile(join(dir, 'missing'), 'x.html'), { status: 404 });
  // The data folder’s media keeps its own rule on top: images only.
  await assert.rejects(mediaFile(folder, 'out.svg'), { status: 403 });
  assert.equal(await mediaFile(folder, 'alias.svg'), join(folder, 'sub', 'in.svg'));
});

test('#351: a path with a malformed % escape is the request’s fault: 400 with a reason, never 500', async () => {
  await assert.rejects(servedFile(join(dir, 'folder'), '%E0%A4%A.svg'), { status: 400 });
  for (const path of ['/app/%E0%A4%A', '/media/%E0', '/sandbox/app/%E0/1', '/api/apps/%E0/files/x']) {
    const res = await fakeRequest(app.handle, { method: 'GET', path, host: `127.0.0.1:${PORT}` });
    assert.equal(res.status, 400, path);
    assert.match(res.json.error, /% escape/, path);
  }
});

test('#351: the page, its icon and the shared stylesheet are served through the same check, and still load', async () => {
  for (const path of ['/', '/index.html', '/favicon.svg', '/kit/workbench.css', '/app/workbench.css'])
    assert.equal((await fakeRequest(app.handle, { method: 'GET', path, host: `127.0.0.1:${PORT}` })).status, 200, path);
  for (const path of ['/app/', '/kit/', '/mockups/no-such.html'])
    assert.equal((await fakeRequest(app.handle, { method: 'GET', path, host: `127.0.0.1:${PORT}` })).status, 404, path);
});
