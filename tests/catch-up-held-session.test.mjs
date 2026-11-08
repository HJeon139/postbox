// #506 behind a held commit: a turn's summary records what it gave (givenMentions, seenItem) as a session write, and
// behind a held commit that write is only pending. A delivery that read the published session didn't see it: the
// mention the last summary gave in full came again in full, the summary repeated what the last one gave, and a notice
// held for the agent was cleared unread with the published ones (#796's class in sessions, server/runtime.mjs deliver).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip } from '../server/helpers.mjs';
import { settle, setup } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

// Longer than the pointer's quote of a message's start (pointerIfSeen), so a repeat in full can be told from it.
const THEIRS = `@alpha the review of the totals is done: two fixes needed. ${'Details follow on each fix. '.repeat(8)}`;

/** The side-thread room on a store whose log sync can be held; hold() holds a commit and returns its release. */
async function heldRoom() {
  const h = await heldStore();
  const f = setup(h.store);
  await h.store.flush();
  const hold = async () => {
    h.hold();
    const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
    await h.atSync;
    return async () => {
      h.release();
      await commit;
      await h.store.flush();
    };
  };
  return { ...f, h, hold };
}

/** Everything one call gave the agent, in order. @param {any} call */
const given = (call) => [call.message.text, call.message.taskContext, ...(call.message.context ?? [])].filter(Boolean).join('\n\n');
const toAlpha = (/** @type {any} */ f) => f.adapter.calls.filter((/** @type {any} */ c) => c.handle === 'alpha');

/** Beta's mention of alpha and a line of beta's, both published; then a held commit. */
async function mentionThenHold() {
  const f = await heldRoom();
  const it = f.rt.addItem(f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text: THEIRS, status: 'done' });
  f.rt.addItem(f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text: 'FILLER-LINE noted.', status: 'done' });
  await f.store.flush();
  const release = await f.hold();
  return { f, it, release };
}

test('#506 behind a held commit: a mention the last summary gave in full comes as a pointer when its wake is delivered', async () => {
  const { f, it, release } = await mentionThenHold();
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.deliver(f.alpha.id, { kind: 'agent', from: '@beta', text: THEIRS, itemId: it.id });
  await settle(f.rt);
  const [first, second] = toAlpha(f);
  assert.equal(given(first).split(THEIRS).length - 1, 1, 'the first summary gave it in full');
  assert.equal(
    second.message.text,
    `@beta’s message above, which your last summary gave you in full: “${clip(THEIRS, 200)}”. It’s addressed to you: act on it now if you haven’t. read_message { id: "${it.id}" } has it whole.`,
  );
  assert.equal(given(second).includes(THEIRS), false, 'nothing in the second repeats it');
  await release();
  await f.store.close();
});

test('#506 behind a held commit: the next turn’s summary starts where the last one ended', async () => {
  const { f, release } = await mentionThenHold();
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'And the tests.' });
  await settle(f.rt);
  const [first, second] = toAlpha(f);
  assert.equal(given(first).includes('FILLER-LINE'), true, 'the first summary gave it');
  assert.equal(given(second).includes('FILLER-LINE'), false, 'the second doesn’t give it again');
  await release();
  await f.store.close();
});

test('a Postbox notice held for an agent reaches its next turn with the published ones, and none is cleared unread', async () => {
  const f = await heldRoom();
  f.rt.tellAgent(f.alpha.id, 'First notice.');
  await f.store.flush();
  const release = await f.hold();
  f.rt.tellAgent(f.alpha.id, 'Second notice.');
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  const [first] = toAlpha(f);
  assert.deepEqual(
    (first.message.context ?? []).filter((/** @type {string} */ c) => c.startsWith('[Postbox] ') && c.endsWith('notice.')),
    ['[Postbox] First notice.', '[Postbox] Second notice.'],
  );
  await release();
  assert.deepEqual(f.store.state.sessions[f.alpha.id].context, []);
  await f.store.close();
});
