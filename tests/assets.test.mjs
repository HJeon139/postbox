// Assets’ interface (designs/architecture/services.md, “Assets”): the files an agent reads from its folders and the
// ones Postbox stores for it (an app’s files, a review’s images), message attachments, and the room’s assets. Built on
// an in-memory store, real blobs in a temp folder, and small fakes of Sessions, Personas and Placement; it never
// builds Runtime.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Assets } from '../server/asset-service.mjs';
import { Blobs } from '../server/blobs.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A stored upload’s hash. */
const SHA = 'ab'.repeat(32);

/** A one-pixel PNG, as a review’s image. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

/**
 * Assets over a store with a project and one agent’s session in a conversation. The agent’s own folder and the
 * project’s are temp folders; `blobs: false` stands for a Postbox that can’t store files.
 */
function rig({ blobs = true } = {}) {
  const root = tempDir('pb-assets-');
  const own = join(root, 'own');
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  for (const d of [own, project, outside]) mkdirSync(d);
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: project });
  store.emit('thread', { id: 'th_c', projectId: 'p1', title: 'C', kind: 'thread', parentId: null, members: ['se_1'], queue: [], createdAt: 1 });
  store.emit('session', { id: 'se_1', personaId: 'pe_a', threadId: 'th_c', handle: 'alpha', backend: 'mock', addDirs: [] });
  const sessions = {
    get: (/** @type {string} */ id) => {
      const se = store.state.sessions[id];
      if (!se) throw Object.assign(new Error('That session doesn’t exist.'), { status: 404 });
      return se;
    },
  };
  const personas = { forSession: () => ({ handle: 'alpha', backend: 'mock', folder: own }) };
  const placement = { requestAdapter: () => ({ name: 'mock' }) };
  const assets = new Assets({ store, sessions, personas, placement, blobs: blobs ? new Blobs(join(root, 'blobs')) : null });
  return { root, own, project, outside, store, assets };
}

// ── Files an agent names ─────────────────────────────────────────────────────────────

test('agentFolders lists the agent’s own folder first, then the project’s and those added, once each', async () => {
  const { own, project, store, assets } = rig();
  store.emit('session', { ...store.state.sessions.se_1, addDirs: [project, '/srv/extra'] });
  assert.deepEqual(await assets.agentFolders('se_1'), [own, project, '/srv/extra']);
});

test('agentFile reads a file in the agent’s folders, and refuses one outside them, through a link, or over the limit', async () => {
  const { own, outside, assets } = rig();
  writeFileSync(join(own, 'a.txt'), 'hello');
  writeFileSync(join(outside, 'secret.txt'), 'no');
  symlinkSync(join(outside, 'secret.txt'), join(own, 'link.txt'));
  assert.equal((await assets.agentFile('se_1', 'a.txt', 100, 'the file')).toString(), 'hello');
  await assert.rejects(assets.agentFile('se_1', '../outside/secret.txt', 100, 'the file'), /outside your folders/);
  await assert.rejects(assets.agentFile('se_1', 'link.txt', 100, 'the file'), /leads outside your folders/);
  await assert.rejects(assets.agentFile('se_1', 'a.txt', 2, 'the file'), /over the limit/);
  await assert.rejects(assets.agentFile('se_1', 'none.txt', 100, 'the file'), /no file at none\.txt/);
});

test('appFiles reads an app’s code from codePath and stores its data files by their hash', async () => {
  const { own, assets } = rig();
  writeFileSync(join(own, 'app.js'), 'export default 1;');
  writeFileSync(join(own, 'data.csv'), 'a,b\n1,2\n');
  const r = await assets.appFiles('se_1', { title: 'T', codePath: 'app.js', files: [{ path: 'data.csv' }] });
  assert.equal(r.args.code, 'export default 1;');
  assert.equal(r.args.title, 'T');
  assert.equal(r.files?.length, 1);
  assert.equal(r.files?.[0].name, 'data.csv');
  assert.match(r.files?.[0].sha256 ?? '', /^[0-9a-f]{64}$/);
});

test('appFiles refuses data files when this Postbox can’t store files', async () => {
  const { own, assets } = rig({ blobs: false });
  writeFileSync(join(own, 'data.csv'), 'x');
  await assert.rejects(assets.appFiles('se_1', { files: ['data.csv'] }), /can’t store files/);
});

// ── Attachments ──────────────────────────────────────────────────────────────────────

test('attachmentPath finds a stored upload by its hash, and a project file only inside the project’s folder', () => {
  const { project, store, assets } = rig();
  store.emit('file', { id: 'fi1', name: 'a.png', type: 'image/png', size: 3, sha256: SHA });
  // Its stored bytes, by hash, in the blob folder.
  assert.ok(assets.attachmentPath('th_c', { kind: 'file', fileId: 'fi1' })?.endsWith(SHA.slice(2)));
  assert.equal(assets.attachmentPath('th_c', { kind: 'project-file', path: 'notes/x.md' }), join(project, 'notes/x.md'));
  assert.equal(assets.attachmentPath('th_c', { kind: 'project-file', path: '../etc/passwd' }), null);
});

test('sentAttachments takes an upload’s name from its record, and refuses a project file sent without a path', () => {
  const { store, assets } = rig();
  store.emit('file', { id: 'fi1', name: 'kept.png', type: 'image/png', size: 3, sha256: 'ab12' });
  assert.deepEqual(assets.sentAttachments([{ kind: 'file', fileId: 'fi1', name: 'other.exe' }]), [
    { kind: 'file', fileId: 'fi1', name: 'kept.png', type: 'image/png', size: 3 },
  ]);
  assert.throws(
    () => assets.sentAttachments([{ kind: 'project-file' }]),
    (/** @type {any} */ e) => e.status === 422,
  );
});

// ── A review’s images ────────────────────────────────────────────────────────────────

test('storeReviewFiles stores a review’s images by their hash, and servedReviewFile gives one back for its item', async () => {
  const { own, store, assets } = rig();
  writeFileSync(join(own, 'shot.png'), PNG);
  const read = (/** @type {any} */ f, /** @type {number} */ max, /** @type {string} */ what) => assets.agentFile('se_1', f.path, max, what);
  const { files, settle } = await assets.storeReviewFiles([{ path: 'shot.png' }], read);
  await settle(true);
  assert.equal(files[0].name, 'shot.png');
  assert.equal(files[0].type, 'image/png');
  store.emit('item.add', { threadId: 'th_c', item: { id: 'it_r', kind: 'block', valid: true, block: { type: 'review' }, files, at: 1 } });
  const served = await assets.servedReviewFile('th_c', 'it_r', 'shot.png', files[0].sha256);
  assert.deepEqual(served?.bytes, PNG);
  assert.equal(await assets.servedReviewFile('th_c', 'it_r', 'other.png', files[0].sha256), null);
});

// ── The room’s assets ────────────────────────────────────────────────────────────────

test('a store kept in memory has no asset folder: the tools list nothing and refuse a write, with why', async () => {
  const { assets } = rig();
  assert.equal(assets.roomBlobs(), null);
  const tools = assets.tools('se_1', null);
  assert.deepEqual(Object.keys(tools).sort(), ['delete_asset', 'list_assets', 'read_asset', 'rename_asset', 'restore_asset', 'search_assets', 'write_asset']);
  assert.match((await tools.write_asset({ name: 'notes.md', text: 'x' })).message, /no data folder/);
  assert.match((await tools.search_assets({ query: 'x' })).message, /no data folder/);
});
