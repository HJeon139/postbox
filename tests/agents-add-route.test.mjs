// #1620: the Agents header’s + adds an agent the person already has to the conversation, in one pick and with no
// message, so the person needn’t @-mention it to bring it in. POST /api/threads/:id/agents with its persona.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionRoute } from '../server/session-routes.mjs';
import * as arrange from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';

const add = (f, threadId, personaId) => sessionRoute(f.rt, `/api/threads/${threadId}/agents`, 'POST', { personaId });
const handlesIn = (f) =>
  arrange
    .sessionsIn(f.rt, f.t.id)
    .map((x) => x.handle)
    .sort();

test('#1620 + adds an agent the person has to the conversation, and it says it joined', async () => {
  const f = setup();
  const r = await add(f, f.t.id, f.c.id);
  assert.equal(r?.status, 201);
  assert.equal(r.body.handle, 'gamma');
  assert.deepEqual(handlesIn(f), ['alpha', 'beta', 'gamma']);
  assert.ok(
    f.store.items(f.t.id).some((i) => i.kind === 'system' && /gamma/.test(JSON.stringify(i))),
    'the conversation shows it joined',
  );
});

test('#1620 adding one already in the conversation makes no second session', async () => {
  const f = setup();
  const r = await add(f, f.t.id, f.a.id);
  assert.equal(r?.status, 201);
  assert.equal(r.body.id, f.alpha.id, 'its session as it was');
  assert.deepEqual(handlesIn(f), ['alpha', 'beta']);
  assert.equal(f.store.items(f.t.id).filter((i) => i.variant === 'joined').length, 0, 'no line says it joined again');
});

test('#1620 + brings back an agent the person deleted: it’s their own pick', async () => {
  const f = setup();
  f.rt.deleteSession(f.alpha.id);
  await add(f, f.t.id, f.a.id);
  assert.deepEqual(handlesIn(f), ['alpha', 'beta']);
});

test('#1620 from a topic thread, the agent joins its conversation', async () => {
  const f = setup();
  const root = arrange.post(f.rt, f.t.id, { kind: 'user', text: 'Start here.' });
  const { threadId } = f.rt.startTopic(f.t.id, root.id);
  await add(f, threadId, f.c.id);
  assert.deepEqual(handlesIn(f), ['alpha', 'beta', 'gamma']);
});

test('#1620 an agent or a conversation that doesn’t exist is refused, saying which', async () => {
  const f = setup();
  await assert.rejects(add(f, f.t.id, 'pe_gone'), { status: 404, message: 'That agent doesn’t exist. It may have been deleted.' });
  await assert.rejects(add(f, 'th_gone', f.c.id), { status: 404 });
  await assert.rejects(sessionRoute(f.rt, `/api/threads/${f.t.id}/agents`, 'POST', {}), { status: 400 });
  assert.deepEqual(handlesIn(f), ['alpha', 'beta']);
});

test('#1620 an agent whose session here was retired is refused, saying so, with no line', async () => {
  const f = setup();
  f.store.emit('session', { id: 'se_fork', personaId: f.c.id, handle: 'gamma', threadId: f.t.id, retiredFork: true });
  f.rt.threads.patch(f.t.id, (x) => ({ members: [...x.members, 'se_fork'] }));
  await assert.rejects(add(f, f.t.id, f.c.id), { status: 409 });
  assert.equal(f.store.items(f.t.id).filter((i) => i.variant === 'joined').length, 0);
});

test('#1620 − removing the last agent, as a remove that keeps the conversation, is refused and erases nothing', async () => {
  const f = setup();
  // The person’s − on alpha, then beta removed meanwhile: alpha is the last agent when the remove arrives.
  await sessionRoute(f.rt, `/api/sessions/${f.beta.id}`, 'DELETE', {});
  await assert.rejects(sessionRoute(f.rt, `/api/sessions/${f.alpha.id}/remove`, 'POST', {}), {
    status: 409,
    message: '@alpha is the last agent here, so removing it would delete the conversation. To end it, delete the conversation.',
  });
  assert.ok(f.store.state.threads[f.t.id], 'the conversation stays');
  assert.deepEqual(handlesIn(f), ['alpha']);
  // The plain delete of the last agent still deletes its conversation, as the agent’s own Delete does (#320).
  await sessionRoute(f.rt, `/api/sessions/${f.alpha.id}`, 'DELETE', {});
  assert.equal(f.store.state.threads[f.t.id], undefined);
});

test('#1620 − counts live agents, as the page does: beside only a retired fork, the last live agent stays (critic)', async () => {
  const f = setup();
  await sessionRoute(f.rt, `/api/sessions/${f.beta.id}`, 'DELETE', {});
  f.store.emit('session', { id: 'se_fork', personaId: f.c.id, handle: 'gamma', threadId: f.t.id, retiredFork: true });
  f.rt.threads.patch(f.t.id, (x) => ({ members: [...x.members, 'se_fork'] }));
  await assert.rejects(sessionRoute(f.rt, `/api/sessions/${f.alpha.id}/remove`, 'POST', {}), { status: 409 });
  assert.ok(f.store.state.sessions[f.alpha.id], 'alpha stays');
});

test('#1620 a retired agent is refused, saying how to bring it back, and a new one with its handle joins once', async () => {
  const f = setup();
  f.rt.updatePersona(f.c.id, { retired: true });
  await assert.rejects(add(f, f.t.id, f.c.id), { status: 409, message: '@gamma is retired. Bring it back in Settings › Personas to add it.' });
  const again = f.rt.createPersona({ handle: 'gamma' });
  await add(f, f.t.id, again.id);
  assert.deepEqual(handlesIn(f), ['alpha', 'beta', 'gamma'], 'one gamma, never two');
});
