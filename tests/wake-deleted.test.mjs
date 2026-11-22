// #283: an agent deleted from a conversation came back as a blocking “Add @alpha to this conversation?” card as soon as
// another agent there @-mentioned it, so the person had to answer again to keep their own delete. The waker is told the
// agent was deleted, and carries on; no card, and no one waits. The person’s own @-mention still brings it back.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deletedFrom } from '../server/side-threads.mjs';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

test('#283: an agent’s @-mention of a deleted agent raises no card, and the waker is told it was deleted', async () => {
  const f = setup();
  f.rt.deleteSession(f.alpha.id);
  f.adapter.next.push(async (c) => c.text('@alpha can you check the 1908 edition?'));
  f.rt.sendMessage(f.t.id, { text: '@beta go' });
  await settle(f.rt);
  const items = f.store.items(f.t.id);
  assert.deepEqual(
    items.filter((x) => x.kind === 'hop'),
    [],
    'no card asks the person to add alpha back',
  );
  assert.notEqual(f.store.state.sessions[f.beta.id].state, 'needs', 'beta doesn’t wait on the person');
  assert.deepEqual(
    arrange.sessionsIn(f.rt, f.t.id).filter((x) => x.personaId === f.a.id),
    [],
    'alpha not brought back',
  );
  assert.deepEqual(
    f.store.state.sessions[f.beta.id].context.filter((x) => x.includes('@alpha')),
    ['[Postbox] Your mention of @alpha woke no one: @alpha was deleted from this conversation, so it didn’t get your message. Carry on without it.'],
    'beta is told why, at its next turn',
  );
});

test('#283: another agent’s delete doesn’t count as this one’s: an agent never in the conversation can still be asked in', () => {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.personaId === f.c.id);
  f.rt.deleteSession(gamma.id);
  const delta = f.rt.createPersona({ handle: 'delta' });
  assert.equal(deletedFrom(f.rt, f.t, f.c), true, 'gamma was deleted');
  assert.equal(deletedFrom(f.rt, f.t, delta), false, 'delta was never here, so it can join (#874)');
  assert.equal(deletedFrom(f.rt, f.t, f.a), false, 'alpha is still here');
});

test('#283: a new agent given a deleted one’s handle is asked for on a card: the delete was of the other agent', async () => {
  const f = setup();
  f.rt.deleteSession(f.alpha.id);
  // The person deletes the persona too, then makes a new one with the same handle.
  f.rt.deletePersona(f.a.id);
  const again = f.rt.createPersona({ handle: 'alpha' });
  assert.notEqual(again.id, f.a.id);
  assert.equal(deletedFrom(f.rt, f.t, again), false, 'the new alpha was never deleted from here');
  const r = f.rt.agentWake(f.beta.id, 'alpha', 'Can you check the 1908 edition?', { itemId: 'it_new', prose: true });
  assert.equal(r.waiting, true, 'a card asks the person to add the new alpha');
});

test('#283: a line from before the persona id was recorded still counts by handle', () => {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.personaId === f.c.id);
  f.rt.deleteSession(gamma.id);
  // As an older Postbox wrote it: the handle only.
  for (const it of f.store.items(f.t.id)) if (it.variant === 'left') delete it.personaId;
  assert.equal(deletedFrom(f.rt, f.t, f.c), true);
});

test('#283: a handle-only line doesn’t count against an agent created after it: that one came later', () => {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.personaId === f.c.id);
  f.rt.deleteSession(gamma.id);
  // As an older Postbox wrote it: the handle only, a minute before the new persona.
  for (const it of f.store.items(f.t.id)) if (it.variant === 'left') Object.assign(it, { personaId: undefined, at: Date.now() - 60_000 });
  f.rt.deletePersona(f.c.id);
  const again = f.rt.createPersona({ handle: 'gamma' });
  assert.equal(deletedFrom(f.rt, f.t, again), false, 'the new gamma was made after the old one left');
  assert.equal(f.rt.agentWake(f.beta.id, 'gamma', 'Gamma?', { itemId: 'it_g', prose: true }).waiting, true, 'a card asks the person');
});
