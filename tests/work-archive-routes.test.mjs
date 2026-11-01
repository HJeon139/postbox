// The routes that open archived detail (#305, design A2 and A3), through the router: GET
// /api/threads/:id/work/turns/:turnId and /api/threads/:id/items/:itemId/activity. Also the ledger's output and diff
// for an entry the pass moved out of the state (A4).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fakeRequest } from './fake-http.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4441;
let app;
let dir;
let conv;
let topic;
const call = (path) => fakeRequest(app.handle, { path, host: `127.0.0.1:${PORT}` });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-archive-routes-'));
  app = await start({ port: PORT, dataDir: dir, fresh: true, quiet: true, claudeHome: dir, listen: false });
  const { rt, store } = app;
  store.emit('project', { id: 'p1', name: 'P', folder: dir });
  const project = 'p1';
  conv = rt.createThread({ projectId: project, title: 'Archive routes', personaIds: [] });
  topic = rt.createThread({ projectId: project, title: 'A topic', kind: 'topic', parentId: conv.id });
  const out = await rt.ledger.blobs.put(Buffer.from('the command’s output'));
  const before = await rt.ledger.blobs.put(Buffer.from('one\n'));
  const after = await rt.ledger.blobs.put(Buffer.from('one\ntwo\n'));
  const snap = (b, size) => ({ exists: true, size, sha256: b.sha256 });
  for (const [k, t] of ['t1', 't2', 't3'].entries()) {
    store.emit('work.add', { convId: conv.id, entry: { id: t, kind: 'turn', turnId: t, handle: 'alpha', status: 'done', at: k * 10 } });
    store.emit('work.add', {
      convId: conv.id,
      entry: { id: `c_${t}`, kind: 'command', turnId: t, handle: 'alpha', state: 'done', command: 'ls', output: { sha256: out.sha256 }, at: k * 10 + 1 },
    });
    store.emit('work.add', {
      convId: conv.id,
      entry: { id: `d_${t}`, kind: 'change', turnId: t, handle: 'alpha', fileId: 'wf_1', before: snap(before, 4), after: snap(after, 8), at: k * 10 + 2 },
    });
    store.emit('item.add', {
      threadId: topic.id,
      item: { id: `r_${t}`, kind: 'agent', turnId: t, text: 'done', at: k * 10 + 3, activity: { steps: [{ id: 's1', label: 'Read', detail: `${t} detail` }] } },
    });
  }
  store.emit('work.add', {
    convId: conv.id,
    entry: {
      id: 'wf_1',
      kind: 'file',
      path: join(dir, 'a.txt'),
      rel: 'a.txt',
      before: snap(before, 4),
      after: snap(after, 8),
      added: 1,
      deleted: 0,
      handles: ['alpha'],
    },
  });
  app.rt.turnArchive.enabled = true;
  assert.equal(await app.rt.turnArchive.conversation(conv.id), 1, 't1 is archived');
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET work/turns/:turnId returns an archived turn’s entries and its replies’ steps', async () => {
  const r = await call(`/api/threads/${conv.id}/work/turns/t1`);
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.json.work.map((e) => e.id),
    ['t1', 'c_t1', 'd_t1'],
  );
  assert.equal(r.json.activity[topic.id].r_t1.steps[0].detail, 't1 detail');
});

test('a turn that is still live, or unknown, is a 404 with a sentence; the route takes no path', async () => {
  assert.equal((await call(`/api/threads/${conv.id}/work/turns/t3`)).status, 404);
  const r = await call(`/api/threads/${conv.id}/work/turns/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(r.status, 404);
  assert.match(r.json.error ?? r.text, /archived/i);
});

test('GET items/:itemId/activity returns an archived reply’s steps, in a topic thread too', async () => {
  const r = await call(`/api/threads/${topic.id}/items/r_t1/activity`);
  assert.equal(r.status, 200);
  assert.equal(r.json.steps[0].detail, 't1 detail');
  assert.equal((await call(`/api/threads/${topic.id}/items/r_t3/activity`)).status, 404, 'a live reply keeps its steps in the state');
});

test('a command’s output and a change’s diff still open after the pass (A4)', async () => {
  const out = await call(`/api/threads/${conv.id}/work/commands/c_t1/output`);
  assert.equal(out.status, 200);
  assert.equal(out.text, 'the command’s output');
  const diff = await call(`/api/threads/${conv.id}/work/files/wf_1/diff?change=d_t1`);
  assert.equal(diff.status, 200);
  assert.ok(
    diff.json.rows.some((row) => /two/.test(JSON.stringify(row))),
    'the diff shows the line the change added',
  );
});
