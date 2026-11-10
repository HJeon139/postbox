// #362: a served file is checked (servedFile) and then read (file). A link swapped in between, for the file itself or
// for a folder on its path, must not hand out what it points to: the file is opened without following a final link,
// checked again by its handle, and read from that handle. Each swap is made after servedFile's check and before
// file(), where a request's two awaits leave room for one.

import assert from 'node:assert/strict';
import { mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { file, servedFile } from '../server/served-files.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A response that keeps what file() wrote. */
function response() {
  const r = { status: 0, headers: {}, body: null };
  return {
    r,
    writeHead(status, headers) {
      r.status = status;
      r.headers = headers;
    },
    end(body) {
      r.body = body ?? null;
    },
  };
}

/** A served folder with sub/page.txt, and secrets outside it, at secret.txt and outside/page.txt. */
async function folders() {
  const dir = await realpath(tempDir('pb-served-swap-'));
  const served = join(dir, 'served');
  await mkdir(join(served, 'sub'), { recursive: true });
  await mkdir(join(dir, 'outside'), { recursive: true });
  await writeFile(join(served, 'sub', 'page.txt'), 'the page "<&>"');
  await writeFile(join(dir, 'secret.txt'), 'SECRET');
  await writeFile(join(dir, 'outside', 'page.txt'), 'OUTSIDE SECRET');
  return { dir, served };
}

test('#362: a file served whole, with nothing swapped, reads as before', async () => {
  const { served } = await folders();
  const real = await servedFile(served, 'sub/page.txt');
  const res = response();
  await file(res, real);
  assert.equal(res.r.status, 200);
  assert.equal(String(res.r.body), 'the page "<&>"');
});

test('#362: the file swapped for a link after its check is refused, and its target never sent', async () => {
  const { dir, served } = await folders();
  const real = await servedFile(served, 'sub/page.txt');
  const res = response();
  // Between the check and the read: the file becomes a link to a secret outside the folder.
  await rm(real);
  await symlink(join(dir, 'secret.txt'), real);
  await assert.rejects(file(res, real), { status: 404 });
  assert.equal(res.r.status, 0, 'nothing was written');
});

test('#362: a folder on its path swapped for a link after the check is refused, and the file there never sent', async () => {
  const { dir, served } = await folders();
  const real = await servedFile(served, 'sub/page.txt');
  const res = response();
  // Between the check and the read: sub/ becomes a link to a folder outside, with a file of the same name.
  await rename(join(served, 'sub'), join(dir, 'moved'));
  await symlink(join(dir, 'outside'), join(served, 'sub'));
  await assert.rejects(file(res, real), { status: 404 });
  assert.equal(res.r.status, 0, 'nothing was written');
});

test('#362: a folder is no file to serve: 404, not an error from reading it', async () => {
  const { served } = await folders();
  const res = response();
  await assert.rejects(file(res, await servedFile(served, 'sub')), { status: 404 });
  assert.equal(res.r.status, 0, 'nothing was written');
});
