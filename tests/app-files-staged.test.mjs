// #1702: an app’s data files are stored before show_app or update_app decides whether a version takes them, so a call
// refused at a later file, or by the tool itself, left their blobs on disk that nothing names. They’re now staged, as a
// review’s images are (#780): kept once a version holds them, and removed otherwise, here and from a host.

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { stageFiles } from '../server/agent-files.mjs';
import { onTool } from '../server/remote/turns-tools.mjs';
import { setup } from './review-files-fixture.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');

/** The blob store’s files, by hash. @param {string} root */
function blobsIn(root) {
  const dir = join(root, 'blobs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^[a-f0-9]{2}$/.test(d))
    .flatMap((d) =>
      readdirSync(join(dir, d))
        .filter((n) => !n.endsWith('.draft'))
        .map((n) => d + n),
    );
}

/** One call from a host, as server/remote/turns.mjs applies it, from inside the agent’s turn; gives the reply. */
function fromHost(f, name, args) {
  return f.during(async () => {
    const replies = [];
    const link = { send: (/** @type {any} */ m) => replies.push(m) > 0 };
    const rts = {
      rt: f.rt,
      byTurn: new Map([['t_host', { sessionId: f.se.id, rt: f.rt.turns.get(f.se.id) }]]),
      needed: new Map([['host_1', { link }]]),
      applying: new Set(),
      restoring: new Map(),
      now: () => 1000,
    };
    await onTool(/** @type {any} */ (rts), 'host_1', { turn: 't_host', id: `c_${Math.random()}`, name, args });
    return replies[0];
  });
}

test('#1702 a show_app refused at a later data file leaves no blob of the earlier ones', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'a.csv'), 'a,1\n');
  const r = await f.call('show_app', { id: 'chart', title: 'Chart', code: '<p>x</p>', files: ['a.csv', 'missing.csv'] });
  assert.equal(r.isError, true);
  assert.deepEqual(blobsIn(f.root), []);
});

test('#1702 a show_app or update_app the tool refuses leaves no blob of its files; one it takes keeps them', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'a.csv'), 'a,1\n');
  await writeFile(join(f.folder, 'b.csv'), 'b,2\n');
  const refusedShow = await f.call('show_app', { id: 'chart', title: 'Chart', code: '', files: ['a.csv'] });
  assert.equal(refusedShow.isError, true, refusedShow.text);
  assert.deepEqual(blobsIn(f.root), [], 'a refused show_app');
  assert.equal((await f.call('show_app', { id: 'chart', title: 'Chart', code: '<p>x</p>', files: ['a.csv'] })).isError, false);
  assert.equal(blobsIn(f.root).length, 1, 'a shown app keeps its file');
  const refusedUpdate = await f.call('update_app', { id: 'chart', code: '', files: ['b.csv'] });
  assert.equal(refusedUpdate.isError, true, refusedUpdate.text);
  assert.equal(blobsIn(f.root).length, 1, 'a refused update_app');
  assert.equal((await f.call('update_app', { id: 'chart', code: '<p>y</p>', files: ['b.csv'] })).isError, false);
  assert.equal(blobsIn(f.root).length, 2, 'a new version keeps its file');
  assert.equal(String(await f.rt.apps.appFile('chart', 'b.csv', 2)), 'b,2\n');
  assert.deepEqual([f.rt.blobs.held.size, f.rt.blobs.kept.size], [0, 0], 'every call settled what it put');
});

test('#1702 a host’s show_app the tool refuses leaves no blob of its files; one it takes keeps them', async () => {
  const f = await setup();
  const files = [{ name: 'data.csv', base64: b64('a,b\n1,2\n') }];
  const refused = await fromHost(f, 'show_app', { id: 'chart', title: 'Chart', code: '', files });
  assert.equal(refused.ok, false, refused.text);
  assert.deepEqual(blobsIn(f.root), []);
  const later = [...files, { name: 'bad name!', base64: b64('x') }];
  assert.equal((await fromHost(f, 'show_app', { id: 'chart', title: 'Chart', code: '<p>x</p>', files: later })).ok, false);
  assert.deepEqual(blobsIn(f.root), [], 'refused at a later file');
  assert.equal((await fromHost(f, 'show_app', { id: 'chart', title: 'Chart', code: '<p>x</p>', files })).ok, true);
  assert.equal(blobsIn(f.root).length, 1);
});

test('#1702 two calls staging the same bytes: the refused one never removes the file the other’s version keeps, in either order', async () => {
  for (const keptFirst of [true, false]) {
    const f = await setup();
    const read = [{ name: 'data.csv', buf: Buffer.from('same,1\n') }];
    // The refused call stages first, so it’s the one that wrote the file.
    const refused = await stageFiles(f.rt.blobs, read);
    const taken = await stageFiles(f.rt.blobs, read);
    if (keptFirst) {
      await taken.settle(true);
      await refused.settle(false);
    } else {
      await refused.settle(false);
      await taken.settle(true);
    }
    assert.equal(String(await f.rt.blobs.get(taken.files[0].sha256)), 'same,1\n', `kept first: ${keptFirst}`);
  }
});

test('#1702 show_app on its own app, and on an id another agent holds, keeps the files the version takes', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'a.csv'), 'a,1\n');
  await writeFile(join(f.folder, 'b.csv'), 'b,2\n');
  assert.equal((await f.call('show_app', { id: 'chart', title: 'Chart', code: '<p>x</p>', files: ['a.csv'] })).isError, false);
  // Its own id: a new version, through update_app.
  assert.equal((await f.call('show_app', { id: 'chart', title: 'Chart', code: '<p>y</p>', files: ['b.csv'] })).isError, false);
  assert.equal(String(await f.rt.apps.appFile('chart', 'b.csv', 2)), 'b,2\n');
  // Another agent’s id: shown under a new one, with its file.
  f.rt.store.emit('app', { ...f.rt.store.pending.app('chart'), sessionId: 'someone-else' });
  await writeFile(join(f.folder, 'c.csv'), 'c,3\n');
  const renamed = await f.call('show_app', { id: 'chart', title: 'Mine', code: '<p>z</p>', files: ['c.csv'] });
  assert.match(renamed.text, /shown as (\S+)\./);
  const id = /shown as (\S+)\./.exec(renamed.text)?.[1].replace(/\.$/, '') ?? '';
  assert.equal(String(await f.rt.apps.appFile(id, 'c.csv', 1)), 'c,3\n');
  assert.equal(blobsIn(f.root).length, 3);
});

test('#1702 an update_app with files alone (#1751) keeps their blob, as one with code does', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'a.csv'), 'a,1\n');
  await writeFile(join(f.folder, 'b.csv'), 'b,2\n');
  assert.equal((await f.call('show_app', { id: 'chart', title: 'Chart', code: '<p>x</p>', files: ['a.csv'] })).isError, false);
  assert.equal((await f.call('update_app', { id: 'chart', files: ['b.csv'] })).isError, false);
  assert.equal(blobsIn(f.root).length, 2, 'the version made of files alone holds its file');
  assert.equal(String(await f.rt.apps.appFile('chart', 'b.csv', 2)), 'b,2\n');
  assert.deepEqual([f.rt.blobs.held.size, f.rt.blobs.kept.size], [0, 0], 'the call settled what it put');
});
