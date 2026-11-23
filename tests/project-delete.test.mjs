// #119: a project can be deleted from Settings. Its conversations go with it, as deleting each would (the person’s
// choice, 23 November 2026), and its folder on this computer stays. The last project stays, since Postbox opens on one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectsRoute } from '../server/project-routes.mjs';
import * as arrange from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const remove = (f, id) => projectsRoute(f.rt, `/api/projects/${id}`, 'DELETE', {}, new URLSearchParams());

/** The fixture’s project p1, with its conversation, beside a second project p2 with one of its own. */
function twoProjects() {
  const f = setup();
  f.store.emit('project', { id: 'p2', name: 'Q', folder: tempDir('pb-project-') });
  const other = f.rt.createThread({ projectId: 'p2', title: 'U', personaIds: [f.a.id] });
  return { ...f, other };
}

test('#119 deleting a project deletes its conversations, their sessions and threads, and keeps the others', async () => {
  const f = twoProjects();
  const topic = f.rt.createThread({ projectId: 'p1', title: 'A topic', kind: 'topic', parentId: f.t.id });
  const answer = await remove(f, 'p1');
  assert.deepEqual(answer, { status: 200, body: { name: 'P', conversations: 1 } });
  assert.equal(f.store.state.projects.p1, undefined, 'the project goes');
  for (const id of [f.t.id, topic.id]) assert.equal(f.store.state.threads[id], undefined, 'its conversation and its topic go');
  for (const se of [f.alpha, f.beta]) assert.equal(f.store.state.sessions[se.id], undefined, 'their sessions go');
  assert.ok(f.store.state.threads[f.other.id], 'another project’s conversation stays');
  assert.equal(arrange.sessionsIn(f.rt, f.other.id).length, 1);
  assert.ok(f.store.state.personas[f.a.id], 'the personas stay');
});

test('#119 the last project is refused, saying what to do, and nothing goes', async () => {
  const f = setup();
  await assert.rejects(remove(f, 'p1'), {
    status: 409,
    message: 'This is the only project, and Postbox opens on one. Add another project, then delete this one.',
  });
  assert.ok(f.store.state.projects.p1);
  assert.ok(f.store.state.threads[f.t.id]);
});

test('#119 a project that doesn’t exist is refused with a 404', async () => {
  const f = twoProjects();
  await assert.rejects(remove(f, 'p9'), { status: 404 });
  assert.ok(f.store.state.projects.p1 && f.store.state.projects.p2);
});
