// #283: after its agent was deleted, Summarize back in a side thread it was part of brought it back. sideSession made
// it a fresh session to write the summary, with no line saying it joined. Only a pair member still in the conversation
// can write it: the other one by default, and a refusal that says who’s gone when it’s named, or when neither is left.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { oldSide, settle, setup } from './side-threads-fixture.mjs';

/** A side thread between alpha, who started it, and beta, then the conversation’s alpha deleted. */
function afterDelete(keepThird = false) {
  const f = setup();
  const side = oldSide(f, ['Which editions differ?', 'The 1908 edition drops two chapters.']);
  // A third agent keeps the conversation when both of the pair are deleted, as deleting its last would erase it.
  if (keepThird) f.rt.ensureSession(f.t.id, f.c.id);
  f.rt.deleteSession(f.alpha.id);
  return { ...f, side };
}
const alphas = (f) => arrange.sessionsIn(f.rt, f.t.id).filter((x) => x.personaId === f.a.id);

test('#283: with alpha deleted, Summarize back in its side thread is written by beta, and alpha stays gone', async () => {
  const f = afterDelete();
  f.adapter.next.push(async (c) => c.text('The 1908 edition drops two chapters.'));
  f.rt.summarizeBack(f.side.id);
  await settle(f.rt);
  assert.equal(f.adapter.calls.at(-1).sessionId, f.beta.id, 'beta writes it');
  assert.equal(f.store.items(f.t.id).at(-1).handle, 'beta');
  assert.deepEqual(alphas(f), [], 'no alpha session made');
});

test('#283: naming the deleted agent is refused, saying it’s gone and who can write it', () => {
  const f = afterDelete();
  assert.throws(() => f.rt.summarizeBack(f.side.id, { handle: 'alpha' }), {
    status: 409,
    message: '@alpha is no longer in this conversation. Ask @beta to write the summary.',
  });
  assert.deepEqual(alphas(f), [], 'no alpha session made');
});

test('#283: with both of the pair deleted, it’s refused, and no one is brought back', () => {
  const f = afterDelete(true);
  f.rt.deleteSession(f.beta.id);
  assert.throws(() => f.rt.summarizeBack(f.side.id), {
    status: 409,
    message: '@alpha and @beta are no longer in this conversation. @-mention one there to bring it back, then ask again.',
  });
  const back = arrange.sessionsIn(f.rt, f.t.id).filter((x) => [f.a.id, f.b.id].includes(x.personaId));
  assert.deepEqual(back, [], 'neither brought back');
});

test('#283: in a topic thread whose agent was deleted, another agent still in the conversation writes it', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('Hi.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha start' });
  await settle(f.rt);
  const { threadId } = f.rt.startTopic(f.t.id, f.store.items(f.t.id).find((x) => x.kind === 'user').id);
  f.adapter.next.push(async (c) => c.text('Noted.'));
  f.rt.sendMessage(threadId, { text: 'Go on.' });
  await settle(f.rt);
  f.rt.deleteSession(f.alpha.id);
  f.adapter.next.push(async (c) => c.text('Alpha started it; nothing is open.'));
  f.rt.summarizeBack(threadId);
  await settle(f.rt);
  assert.equal(f.adapter.calls.at(-1).sessionId, f.beta.id, 'beta writes it');
  assert.deepEqual(alphas(f), [], 'no alpha session made');
});

test('#283: nor does the person’s message with no @-mention in that topic thread bring the deleted agent back', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('Hi.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha start' });
  await settle(f.rt);
  const { threadId } = f.rt.startTopic(f.t.id, f.store.items(f.t.id).find((x) => x.kind === 'agent').id);
  f.adapter.next.push(async (c) => c.text('Noted.'));
  f.rt.sendMessage(threadId, { text: 'Go on.' });
  await settle(f.rt);
  f.rt.deleteSession(f.alpha.id);
  f.adapter.next.push(async (c) => c.text('Beta here.'));
  f.rt.sendMessage(threadId, { text: 'And then?' });
  await settle(f.rt);
  assert.equal(f.adapter.calls.at(-1).sessionId, f.beta.id, 'beta answers');
  assert.deepEqual(alphas(f), [], 'no alpha session made');
});

test('#283: a pair member with no session in the conversation, and no line saying it left, isn’t brought back either (critic’s review)', async () => {
  const f = setup();
  const side = oldSide(f, ['Which editions differ?', 'The 1908 edition drops two chapters.']);
  // alpha’s session goes with no “left” line, as a session lost another way would.
  f.rt.sessions.remove(f.alpha.id);
  f.adapter.next.push(async (c) => c.text('Beta writes it.'));
  f.rt.summarizeBack(side.id);
  await settle(f.rt);
  assert.equal(f.adapter.calls.at(-1).sessionId, f.beta.id, 'beta writes it');
  assert.deepEqual(alphas(f), [], 'no alpha session made');
  assert.throws(() => f.rt.summarizeBack(side.id, { handle: 'alpha' }), { status: 409 });
});
