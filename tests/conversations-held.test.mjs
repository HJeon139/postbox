// Starting a conversation while a commit is held (#796’s class): the new thread is held behind the commit, so it isn’t
// in the published state yet. POST /api/threads sends what createThread returns, and createThread returned the
// published thread, undefined there, so the route answered with nothing; with agents, ensureSession looked for the
// thread in the published state too and refused it as deleted. Both read the thread as written, from store.pending.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deletePersona } from '../server/persona-delete.mjs';
import { patchThread } from '../server/room-chain-limit.mjs';
import { heldStore, setup } from './stop-reply-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A runtime on a store whose next commit is held, with fn run, and awaited, while it is. */
async function whileHeld(fn) {
  const h = await heldStore();
  const env = await setup(async () => {}, h.store);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync; // the commit is in flight: emits from now on are held behind it
  let result;
  try {
    result = await fn(env);
  } finally {
    h.release();
    await commit;
    await h.store.flush();
  }
  return { env, result, store: h.store };
}

test('starting a conversation with no agents while a commit is held returns the new thread for the route to send', async () => {
  const { result, store } = await whileHeld(({ rt }) => rt.createThread({ projectId: 'p1', title: 'Held' }));
  assert.ok(result, 'createThread returned the thread');
  assert.equal(result.title, 'Held');
  assert.equal(store.state.threads[result.id]?.title, 'Held', 'and it was written');
  await store.close();
});

test('starting a conversation with an agent while a commit is held joins the agent and returns the thread with it', async () => {
  const { env, result, store } = await whileHeld(({ rt }) => {
    const p = rt.personaByHandle('researcher');
    return rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id] });
  });
  assert.ok(result, 'createThread returned the thread');
  assert.equal(result.members.length, 1, 'with its agent as a member');
  assert.deepEqual(
    env.rt.sessionsIn(result.id).map((se) => se.handle),
    ['researcher'],
    'the agent’s session was written',
  );
  await store.close();
});

// PATCH /api/threads/:id sends what patchThread returns. A conversation deleted while a commit is held is still in the
// published state, so it passed rt.thread, but updateThread found no thread to write and returned undefined.
for (const [what, body] of [
  ['renaming', { title: 'Renamed' }],
  ['setting the chain limit of', { chainLimit: 5 }],
]) {
  test(`${what} a conversation deleted behind a held commit is refused as deleted, not answered with nothing`, async () => {
    const { result, store } = await whileHeld(({ rt, t }) => {
      rt.deleteThread(t.id);
      try {
        return patchThread(rt, t.id, body);
      } catch (e) {
        return e;
      }
    });
    assert.equal(result?.status, 404, `refused: ${result?.message ?? JSON.stringify(result)}`);
    await store.close();
  });
}

// POST /api/personas with join: the persona createPersona just wrote is held too, so ensureSession, which looked it up
// in the published state, refused it as “That agent doesn’t exist” after it was made. The route does what these do.
test('a new agent joining a conversation behind a held commit joins it, not a 404 after it was made', async () => {
  const { env, result, store } = await whileHeld(({ rt, t }) => {
    const p = rt.createPersona({ handle: 'helper', backend: 'claude-code' });
    try {
      return rt.ensureSession(rt.lineage(t.id).at(-1), p.id, { brief: 'You were just created and added to this thread.' });
    } catch (e) {
      return e;
    }
  });
  assert.equal(result?.handle, 'helper', `joined: ${result?.message ?? ''}`);
  assert.ok(
    env.rt.sessionsIn(env.t.id).some((se) => se.handle === 'helper'),
    'its session is in the conversation',
  );
  await store.close();
});

test('a new agent starting a conversation in a project behind a held commit starts it with the agent', async () => {
  const { env, result, store } = await whileHeld(({ rt }) => {
    const p = rt.createPersona({ handle: 'starter', backend: 'claude-code' });
    try {
      return rt.createThread({ projectId: 'p1', title: 'With @starter', personaIds: [p.id] });
    } catch (e) {
      return e;
    }
  });
  assert.equal(result?.members?.length, 1, `started: ${result?.message ?? ''}`);
  assert.deepEqual(
    env.rt.sessionsIn(result.id).map((se) => se.handle),
    ['starter'],
  );
  await store.close();
});

// POST /api/claude-sessions/attach: createThread joins the persona it just made, and attachClaudeSession reads the
// session that made from the published state, undefined behind a held commit, so it threw a TypeError on its id.
test('attaching a Claude Code session behind a held commit attaches it and follows its transcript', async () => {
  const root = tempDir('pb-attach-held-');
  const id = '11111111-2222-3333-4444-555555555555';
  mkdirSync(join(root, '-work-site'));
  const typed = { type: 'user', turnOrigin: 'human', cwd: '/work/site', message: { role: 'user', content: 'Fix the header' } };
  writeFileSync(join(root, '-work-site', `${id}.jsonl`), `${JSON.stringify(typed)}\n`);
  const { env, result, store } = await whileHeld(async ({ rt }) => {
    rt.config.claudeProjectsRoot = root;
    try {
      return await rt.attachClaudeSession({ claudeSessionId: id, projectId: 'p1' });
    } catch (e) {
      return e;
    }
  });
  assert.ok(result?.sessionId, `attached: ${result?.message ?? ''}`);
  assert.equal(store.state.sessions[result.sessionId].backendState.claudeSessionId, id, 'its session records what it follows');
  assert.ok(env.rt.mirrors.has(result.sessionId), 'and its transcript is followed');
  env.rt.stopMirrors();
  await store.close();
});

// PATCH and DELETE /api/personas/:id read the persona, and DELETE its sessions, from the published state, so either
// on an agent made behind a held commit answered “That agent doesn’t exist”.
test('changing an agent made behind a held commit changes it, not a 404', async () => {
  const { result, store } = await whileHeld(({ rt }) => {
    const p = rt.createPersona({ handle: 'fresh', backend: 'claude-code' });
    try {
      return rt.updatePersona(p.id, { description: 'Reads the numbers' });
    } catch (e) {
      return e;
    }
  });
  assert.equal(result?.description, 'Reads the numbers', `changed: ${result?.message ?? ''}`);
  assert.equal(store.state.personas[result.id].description, 'Reads the numbers', 'and it was written');
  await store.close();
});

test('deleting an agent made and joined behind a held commit deletes it and its session, not a 404', async () => {
  const { env, result, store } = await whileHeld(({ rt, t }) => {
    const p = rt.createPersona({ handle: 'brief', backend: 'claude-code' });
    rt.ensureSession(t.id, p.id);
    try {
      return { handle: deletePersona(rt, p.id).handle, id: p.id };
    } catch (e) {
      return e;
    }
  });
  assert.equal(result?.handle, 'brief', `deleted: ${result?.message ?? ''}`);
  assert.equal(store.state.personas[result.id], undefined, 'the agent is gone');
  assert.deepEqual(
    env.rt.sessionsIn(env.t.id).filter((se) => se.handle === 'brief'),
    [],
    'and so is its session',
  );
  assert.deepEqual(
    Object.values(store.state.sessions).filter((se) => se.handle === 'brief'),
    [],
    'nowhere',
  );
  await store.close();
});

// Deleting an agent whose conversation was started behind a held commit: deleteSession read that conversation’s
// threads from the published state (conversationScope) and refused it as deleted, after it had already stopped the
// session’s turn, dropped its wakes and released its queue, so the agent and its session stayed, half deleted.
test('deleting an agent whose conversation started behind a held commit deletes the agent, its session and the conversation', async () => {
  const { env, result, store } = await whileHeld(({ rt }) => {
    const p = rt.createPersona({ handle: 'solo', backend: 'claude-code' });
    const room = rt.createThread({ projectId: 'p1', title: 'Solo', personaIds: [p.id] });
    try {
      return { handle: deletePersona(rt, p.id).handle, id: p.id, room: room.id };
    } catch (e) {
      return e;
    }
  });
  assert.equal(result?.handle, 'solo', `deleted: ${result?.message ?? ''}`);
  assert.equal(store.state.personas[result.id], undefined, 'the agent is gone');
  assert.deepEqual(
    Object.values(store.state.sessions).filter((se) => se.handle === 'solo'),
    [],
    'so is its session',
  );
  assert.equal(store.state.threads[result.room], undefined, 'and its conversation, which it was alone in');
  assert.ok(env.rt.s.threads[env.t.id], 'the other conversation stays');
  await store.close();
});

// A delete looks everything up before it changes anything, so one it refuses leaves nothing half done.
test('a delete it refuses stops no turn and leaves every session', async () => {
  const { result, store } = await whileHeld(({ rt, t }) => {
    const before = Object.keys(rt.store.pending.sessions()).length;
    const stopped = [];
    const stop = rt.stop.bind(rt);
    rt.stop = (...args) => {
      stopped.push(args[0]);
      return stop(...args);
    };
    const topic = rt.putThread({ id: 'th_topic', projectId: 'p1', title: 'A topic', kind: 'topic', parentId: t.id, members: [], queue: [] });
    const refused = [];
    for (const del of [() => rt.deleteThread('th_gone'), () => rt.deleteThread(topic.id)])
      try {
        del();
      } catch (e) {
        refused.push(e.status);
      }
    return { refused, stopped, sessions: Object.keys(rt.store.pending.sessions()).length, before };
  });
  assert.deepEqual(result.refused, [404, 409], 'both were refused');
  assert.deepEqual(result.stopped, [], 'no turn was stopped');
  assert.equal(result.sessions, result.before, 'and no session was deleted');
  await store.close();
});

// patchThread checks the thread pending, then found its room with rt.lineage, which reads the published state: for a
// conversation started behind a held commit that’s nothing, so the chain limit went nowhere and the route answered
// with nothing.
test('setting the chain limit of a conversation started behind a held commit sets it on that conversation', async () => {
  const { result, store } = await whileHeld(({ rt }) => {
    const room = rt.createThread({ projectId: 'p1', title: 'New room' });
    try {
      return patchThread(rt, room.id, { chainLimit: 5 });
    } catch (e) {
      return e;
    }
  });
  assert.equal(result?.chainLimit, 5, `set: ${result?.message ?? JSON.stringify(result)}`);
  assert.equal(store.state.threads[result.id].chainLimit, 5, 'on the conversation');
  await store.close();
});
