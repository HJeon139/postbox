// Opening an archived turn through the page’s routes (#305; designs/305-archive-turns.md, “Opening an old turn” and
// “A diff in an archived turn”, T-5): GET /api/threads/:id/work/turns/:turnId returns the turn’s entries, and a diff,
// an output and a restore still work for an entry the pass moved out of the state. What doesn’t resolve is a 404 with
// a sentence; a file that is missing, damaged or another turn’s is a 410, and the page keeps the summary’s counts.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fakeRequest } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';
import { seedArchived } from './work-archive-fixture.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4481;
const UNREADABLE = /This turn’s details couldn’t be read/;
let app;
let seeded;
const get = (path) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, path });
const turnOf = (turnId) => get(`/api/threads/${seeded.conv.id}/work/turns/${turnId}`);

before(async () => {
  const dir = tempDir('pb-archive-routes-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  seeded = await seedArchived(app, dir);
});
after(() => app.close());

test('the turn route returns an archived turn’s entries, from its file', async () => {
  const r = await turnOf('t1');
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.json.work.map((e) => e.id),
    ['t1', 'c1', 'd1', 'e1'],
  );
  assert.equal(r.json.turnId, 't1');
  // Only the turn’s work: a reply’s steps are another route’s (A3).
  assert.deepEqual(Object.keys(r.json).sort(), ['turnId', 'work']);
});

test('the turn route answers 404 with a sentence for a turn that is still hot, or that the conversation never had', async () => {
  for (const turnId of ['t2', 'nope']) {
    const r = await turnOf(turnId);
    assert.equal(r.status, 404, turnId);
    assert.match(r.json.error, /isn’t archived/, turnId);
  }
});

test('the turn route never reads a file the request names: the archive’s own SHA-256 as the turn is a 404', async () => {
  const r = await turnOf(seeded.t1Sha);
  assert.equal(r.status, 404);
  assert.match(r.json.error, /isn’t archived/);
});

test('a missing, damaged or another conversation’s archive file is a 410 that says its details couldn’t be read', async () => {
  for (const turnId of ['t3', 't4', 't5']) {
    const r = await turnOf(turnId);
    assert.equal(r.status, 410, turnId);
    assert.match(r.json.error, UNREADABLE, turnId);
  }
  assert.ok(
    app.store.state.work[seeded.conv.id].some((e) => e.kind === 'turn-archive' && e.turnId === 't3' && e.counts),
    'the summary and its counts stay in the state',
  );
});

test('a topic thread’s turn route refuses as the other work routes do: its work is the conversation’s', async () => {
  const r = await get(`/api/threads/${seeded.topic.id}/work/turns/t1`);
  assert.equal(r.status, 404);
  assert.match(r.json.error, /Open the conversation/);
});

test('an archived command’s output still opens', async () => {
  const r = await get(`/api/threads/${seeded.conv.id}/work/commands/c1/output`);
  assert.equal(r.status, 200);
  assert.equal(r.text, 'the command’s output\n');
});

test('the diff of an archived change still opens, against the hot file it changed', async () => {
  const r = await get(`/api/threads/${seeded.conv.id}/work/files/wf_1/diff?change=d1`);
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.json.rows.filter((row) => row.kind === 'add').map((row) => row.t),
    ['two'],
  );
});

test('an archived edit made on a host is refused as a hot one is: Postbox kept no copy of it', async () => {
  const diff = await get(`/api/threads/${seeded.conv.id}/work/files/e1/diff`);
  assert.equal(diff.status, 409);
  assert.match(diff.json.error, /on devbox/);
  await assert.rejects(app.rt.ledger.restore(seeded.conv.id, 'e1'), (e) => e.status === 409 && /on devbox/.test(e.message));
});

test('an archived entry of another kind is a 404 for output and diff, as a hot one of the wrong kind is', async () => {
  assert.equal((await get(`/api/threads/${seeded.conv.id}/work/commands/d1/output`)).status, 404);
  assert.equal((await get(`/api/threads/${seeded.conv.id}/work/files/wf_1/diff?change=c1`)).status, 404);
  assert.equal((await get(`/api/threads/${seeded.conv.id}/work/commands/zz/output`)).status, 404);
});

test('a restore of a file whose only change was archived lands on the hot file entry', async () => {
  const f = await app.rt.ledger.restore(seeded.conv.id, 'wf_1');
  assert.equal(await readFile(seeded.path, 'utf8'), 'one\n');
  assert.equal(f.id, 'wf_1');
  assert.ok(f.restored, 'the hot file entry records the restore');
});
