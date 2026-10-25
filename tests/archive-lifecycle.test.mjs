// A conversation owns its agents’ sessions (#320): nothing archives a conversation by itself any more, an agent’s
// session is archived only with its conversation and deleted with it, and what idle archiving (#101) hid comes back,
// once. The server is started as it is at boot (start({ listen: false })), twice where a restart matters.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

let port = 4461;
const dirs = [];
const open = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
/** Starts Postbox on dir: a fresh demo install the first time, else what the last start left. */
async function boot(dir, fresh = false) {
  const app = await start({ port: port++, dataDir: dir, fresh, demo: true, quiet: true, claudeHome: dir, listen: false });
  open.push(app);
  return app;
}
async function restart(app, dir) {
  open.splice(open.indexOf(app), 1);
  await app.close();
  return boot(dir);
}
async function install() {
  const dir = await mkdtemp(join(tmpdir(), 'pb-archive-'));
  dirs.push(dir);
  return { dir, app: await boot(dir, true) };
}
const conversations = (st) => Object.values(st.threads).filter((t) => t.kind !== 'topic' && t.kind !== 'side');
/** The archived conversations, by title, and the agents archived on their own, by handle. */
const archived = (st) => [
  ...conversations(st)
    .filter((t) => t.archived)
    .map((t) => t.title),
  ...Object.values(st.sessions)
    .filter((se) => se.archived && !se.retiredFork && !st.threads[se.threadId]?.archived)
    .map((se) => `@${se.handle}`),
];
const roomOf = (st) => conversations(st).find((t) => t.members.length > 1);

test('a conversation left alone for a month is still there after a restart: nothing archives one by itself (#320)', async (ctx) => {
  let { dir, app } = await install();
  // An install that had chosen a day under #101’s setting.
  app.store.emit('settings', { archiveAfterDays: 1 });
  ctx.mock.timers.enable({ apis: ['Date'], now: Date.now() + 30 * 864e5 });
  app = await restart(app, dir);
  assert.ok(conversations(app.store.state).length > 3, 'the demo’s conversations');
  assert.deepEqual(archived(app.store.state), []);
});

test('what idle archiving hid comes back, once: an archived conversation, and an agent archived on its own (#320)', async () => {
  let { dir, app } = await install();
  const st = () => app.store.state;
  const dm = conversations(st()).find((t) => t.members.length === 1);
  const room = roomOf(st());
  app.rt.archiveThread(dm.id);
  app.rt.archive(room.members[1]);
  // As an install from before #320 is: it never ran the restore.
  app.store.emit('settings', { archivesRestored: false });
  assert.equal(archived(st()).length, 2);
  app = await restart(app, dir);
  assert.deepEqual(archived(st()), []);
  assert.equal(st().settings.archivesRestored, true);
  // Once: a conversation archived since stays archived across the next restart.
  app.rt.archiveThread(dm.id);
  app = await restart(app, dir);
  assert.deepEqual(archived(st()), [dm.title]);
  assert.ok(
    app.rt.sessionsIn(dm.id).every((se) => se.archived),
    'its agents are archived with it',
  );
});

test('deleting a room deletes every session in it, and in its threads’ threads too (#320)', async () => {
  const { app } = await install();
  const { rt, store } = app;
  const [a, b] = Object.values(store.state.personas);
  const room = rt.createThread({ projectId: Object.keys(store.state.projects)[0], title: 'Room', personaIds: [a.id, b.id] });
  const topic = rt.createThread({ projectId: room.projectId, title: 'Topic', kind: 'topic', parentId: room.id, personaIds: [a.id] });
  const side = rt.createThread({ projectId: room.projectId, title: 'Side', kind: 'side', parentId: topic.id, personaIds: [b.id] });
  const ids = [room, topic, side].flatMap((t) => store.state.threads[t.id].members);
  assert.equal(ids.length, 4);
  rt.archive(ids[0]);
  rt.deleteThread(room.id);
  rt.purgeThread(room.id);
  assert.deepEqual(
    [room, topic, side].filter((t) => store.state.threads[t.id]).map((t) => t.title),
    [],
  );
  assert.deepEqual(
    ids.filter((id) => store.state.sessions[id]).map((id) => `@${store.state.sessions[id].handle}`),
    [],
  );
});

test('an agent’s session can’t be archived on its own: only its conversation can (#320)', async () => {
  const { app } = await install();
  const call = (r) => fakeRequest(app.handle, { host: new URL(app.origin).host, ...r });
  const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  const room = roomOf(app.store.state);
  const post = (path) => call({ method: 'POST', path, headers: { cookie, origin: app.origin, 'content-type': 'application/json' }, body: '{}' });
  for (const what of ['archive', 'restore']) assert.equal((await post(`/api/sessions/${room.members[0]}/${what}`)).status, 404, what);
  assert.equal((await post(`/api/threads/${room.id}/archive`)).status, 200);
  assert.ok(
    app.rt.sessionsIn(room.id).every((se) => se.archived),
    'its agents are archived with it',
  );
  assert.equal((await post(`/api/threads/${room.id}/restore`)).status, 200);
  assert.ok(
    app.rt.sessionsIn(room.id).every((se) => !se.archived),
    'and restored with it',
  );
});
