// One session per persona per conversation (intent.md), behind a held commit too: a session made there is only in
// store.pending until the release, so a second @-mention of the same new agent in that window, read from the published
// members and sessions, didn't find it and made a second session (#796's class in sessions, server/runtime.mjs
// ensureSession).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicState } from '../server/public-state.mjs';
import { sessionsOfPersona, settle, setup } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

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

test('two @-mentions of the same new agent behind a held commit make one session, which answers both in order', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  f.rt.sendMessage(f.t.id, { text: '@gamma First.' });
  f.rt.sendMessage(f.t.id, { text: '@gamma Second.' });
  await release();
  await settle(f.rt);
  const gammas = sessionsOfPersona(f.store, f.c.id);
  assert.equal(gammas.length, 1, 'one session for gamma');
  assert.deepEqual(f.store.state.threads[f.t.id].members, [f.alpha.id, f.beta.id, gammas[0].id]);
  const second = f.store.items(f.t.id).find((x) => x.kind === 'user' && x.text === '@gamma Second.');
  // Its first turn's summary gave the second, so it comes after the first as #506's pointer, from the same session.
  assert.deepEqual(
    f.adapter.calls.filter((c) => c.handle === 'gamma').map((c) => [c.sessionId, c.message.text]),
    [
      [gammas[0].id, '@gamma First.'],
      [
        gammas[0].id,
        `The person’s message above, which your last summary gave you in full: “@gamma Second.”. It’s addressed to you: act on it now if you haven’t. read_message { id: "${second?.id}" } has it whole.`,
      ],
    ],
  );
  await f.store.close();
});

test('an @-mention of an agent whose session was deleted behind a held commit makes it a new session, as with nothing held', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  f.rt.deleteSession(f.alpha.id);
  f.rt.sendMessage(f.t.id, { text: '@alpha Start over.' });
  await release();
  await settle(f.rt);
  const alphas = sessionsOfPersona(f.store, f.a.id);
  assert.deepEqual(
    alphas.map((x) => x.id === f.alpha.id),
    [false],
  );
  assert.deepEqual(
    f.adapter.calls.filter((c) => c.handle === 'alpha').map((c) => [c.sessionId === f.alpha.id, c.message.text]),
    [[false, '@alpha Start over.']],
  );
  await f.store.close();
});

test('a member whose session was removed behind a held commit doesn’t stop a new agent joining', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  f.store.emit('remove', { kind: 'session', id: f.beta.id });
  f.rt.sendMessage(f.t.id, { text: '@gamma Check the totals.' });
  await release();
  await settle(f.rt);
  assert.equal(sessionsOfPersona(f.store, f.c.id).length, 1);
  assert.deepEqual(
    f.adapter.calls.filter((c) => c.handle === 'gamma').map((c) => c.message.text),
    ['@gamma Check the totals.'],
  );
  await f.store.close();
});

test('an agent archived behind a held commit is still its persona’s one session in the conversation, as with nothing held', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  f.rt.archive(f.alpha.id);
  assert.equal(f.rt.ensureSession(f.t.id, f.a.id).id, f.alpha.id);
  await release();
  await settle(f.rt);
  assert.deepEqual(
    sessionsOfPersona(f.store, f.a.id).map((x) => [x.id === f.alpha.id, Boolean(x.archived)]),
    [[true, true]],
  );
  await f.store.close();
});

test('a page reloaded behind a held commit loads the published state, with no session for the new agent yet; the release brings one', async () => {
  const f = await heldRoom();
  const seq = f.store.state.seq;
  const release = await f.hold();
  f.rt.sendMessage(f.t.id, { text: '@gamma First.' });
  f.rt.sendMessage(f.t.id, { text: '@gamma Second.' });
  // What /api/state gives (server/page-state.mjs): the published state, and its seq, which the stream counts on from.
  const loaded = publicState(f.store.state);
  assert.equal(f.store.state.seq, seq);
  assert.deepEqual(loaded.threads[f.t.id].members, [f.alpha.id, f.beta.id]);
  assert.equal(Object.values(loaded.sessions).filter((x) => x.personaId === f.c.id).length, 0);
  await release();
  await settle(f.rt);
  const after = publicState(f.store.state);
  assert.equal(Object.values(after.sessions).filter((x) => x.personaId === f.c.id).length, 1);
  await f.store.close();
});
