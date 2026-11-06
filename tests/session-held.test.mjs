// #796's class in sessions: a session read published behind a held commit misses what is held. A session just made
// there doesn't exist yet for the turn its message starts, a change back to the published value is diffed away, and
// a second notice for an agent drops the first (designs/508/601-held-view.md, “a read that decides a write reads pending”).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveBackendState } from '../server/store-outage.mjs';
import { withUrgent } from '../server/subagent-end.mjs';
import { settle, setup } from './side-threads-fixture.mjs';
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

/** What each of an agent's turns was given to answer, its messages in order. @param {any} f @param {string} handle */
const asked = (f, handle) =>
  f.adapter.calls.filter((c) => c.handle === handle).map((c) => (c.message.messages ? c.message.messages.map((m) => m.text) : [c.message.text]));

test('your first @-mention of an agent behind a held commit reaches it once the commit is released', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  f.rt.sendMessage(f.t.id, { text: '@gamma Check the totals.' });
  await release();
  await settle(f.rt);
  const toGamma = f.adapter.calls.filter((c) => c.handle === 'gamma');
  assert.deepEqual(
    toGamma.map((c) => c.message.text),
    ['@gamma Check the totals.'],
  );
  assert.equal(f.store.items(f.t.id).filter((x) => x.kind === 'user').length, 1, 'your message posted once');
  await f.store.close();
});

test('a session change back to its published value behind a held commit lands', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  f.rt.updateSession(f.alpha.id, { currentStep: 'Reading' });
  f.rt.updateSession(f.alpha.id, { currentStep: '' });
  await release();
  assert.equal(f.store.state.sessions[f.alpha.id].currentStep, '');
  await f.store.close();
});

test('two Postbox notices for an agent behind a held commit both wait for its next turn', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  f.rt.tellAgent(f.alpha.id, 'First notice.');
  f.rt.tellAgent(f.alpha.id, 'Second notice.');
  await release();
  assert.deepEqual(f.store.state.sessions[f.alpha.id].context, ['[Postbox] First notice.', '[Postbox] Second notice.']);
  await f.store.close();
});

test('a delivery to a session that is neither published nor held behind a commit answers 404 at once', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  assert.throws(() => f.rt.deliver('se_gone', { kind: 'user', text: 'Hello.' }), { status: 404 });
  await release();
  await settle(f.rt);
  assert.equal(f.adapter.calls.length, 0, 'no turn started');
  await f.store.close();
});

test('a session removed behind a held commit stays gone in the pending read, as a later patch leaves it', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  f.store.emit('remove', { kind: 'session', id: f.alpha.id });
  f.store.emit('session.patch', { id: f.alpha.id, patch: { currentStep: 'Reading' } });
  assert.equal(f.store.pending.session(f.alpha.id), undefined);
  f.rt.tellAgent(f.alpha.id, 'Too late.');
  await release();
  assert.equal(f.store.state.sessions[f.alpha.id], undefined);
  await f.store.close();
});

test('your follow-up to a new agent, sent after the release but before its flush, reaches it after your first message', async () => {
  const f = await heldRoom();
  f.h.hold();
  const commit = f.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await f.h.atSync;
  f.rt.sendMessage(f.t.id, { text: '@gamma First.' });
  f.h.release();
  await commit;
  const gamma = () => Object.values(f.store.state.sessions).find((x) => x.handle === 'gamma');
  let flushed = false;
  const flush = f.store.flush().then(() => {
    flushed = true;
  });
  for (let i = 0; i < 1000 && !gamma(); i++) await Promise.resolve();
  assert.ok(gamma() && !flushed, 'gamma is published, and the flush its first message waits on hasn’t settled');
  f.rt.sendMessage(f.t.id, { text: '@gamma Second.' });
  await flush;
  await settle(f.rt);
  const [first, second, ...more] = asked(f, 'gamma');
  assert.deepEqual([first, more], [['@gamma First.'], []]);
  // Its first turn's summary gave the follow-up, so it comes after it as a pointer (#506), never ahead of it.
  assert.match(second[0], /^The person’s message above, which your last summary gave you in full: “@gamma Second\.”/);
  await f.store.close();
});

test('a delivery that waited for a new agent and can’t start once it’s published is logged, not an unhandled rejection', async (t) => {
  const f = await heldRoom();
  const errors = t.mock.method(console, 'error', () => {});
  const unhandled = [];
  const onUnhandled = (/** @type {unknown} */ e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const release = await f.hold();
  f.rt.sendMessage(f.t.id, { text: '@gamma Check the totals.' });
  const gamma = f.store.pending.thread(f.t.id).members.at(-1);
  assert.equal(f.store.pending.session(gamma).handle, 'gamma');
  f.store.emit('remove', { kind: 'session', id: gamma });
  await release();
  await settle(f.rt);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(unhandled, []);
  assert.equal(f.adapter.calls.filter((c) => c.handle === 'gamma').length, 0, 'no turn started');
  assert.ok(
    errors.mock.calls.some((c) => String(c.arguments[0]).startsWith('A message for a new agent wasn’t delivered:')),
    'the failed delivery is logged',
  );
  await f.store.close();
});

test('a backend’s resume id and its model, saved in one turn behind a held commit, are both kept', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  saveBackendState(f.rt, f.alpha.id, { kiroSessionId: 'k-1' });
  saveBackendState(f.rt, f.alpha.id, { model: 'm-1' });
  await release();
  assert.deepEqual(f.store.state.sessions[f.alpha.id].backendState, { kiroSessionId: 'k-1', model: 'm-1' });
  await f.store.close();
});

test('an urgent note given on a tool result behind a held commit keeps a notice held after it', async () => {
  const f = await heldRoom();
  const urgent = '[Postbox] URGENT: the person ended your subagent Scout (id sub-1).';
  f.rt.updateSession(f.alpha.id, { context: [urgent] });
  await f.store.flush();
  const release = await f.hold();
  f.rt.tellAgent(f.alpha.id, 'Later notice.');
  const text = withUrgent(f.rt, f.alpha.id, 'Result.', null);
  await release();
  assert.equal(text, `${urgent}\n\nResult.`);
  assert.deepEqual(f.store.state.sessions[f.alpha.id].context, ['[Postbox] Later notice.']);
  await f.store.close();
});

test('a reply streamed behind a held commit holds one session change for its state, not one per chunk', async () => {
  const f = await heldRoom();
  const patches = () => f.store.heldLog.filter((j) => j.held.type === 'session.patch' && j.held.data.id === f.alpha.id);
  /** @type {any[][]} */
  const during = [];
  let streamed = () => {};
  const done = new Promise((r) => {
    streamed = () => r(undefined);
  });
  f.adapter.next.push(async (/** @type {any} */ c) => {
    const before = patches().length;
    for (let i = 0; i < 40; i++) c.text(`chunk ${i} `);
    during.push(
      patches()
        .slice(before)
        .map((j) => j.held.data.patch),
    );
    streamed();
  });
  const release = await f.hold();
  f.rt.sendMessage(f.t.id, { text: '@alpha Go.' });
  await done;
  assert.deepEqual(
    during[0].map(({ updatedAt, ...rest }) => rest),
    [{ state: 'gen', currentStep: 'Writing a reply' }],
  );
  await release();
  await settle(f.rt);
  await f.store.close();
});

test('3,000 session changes behind a held commit each read the session in far less than the whole held log', async () => {
  const f = await heldRoom();
  f.rt.updateSession(f.alpha.id, { context: Array.from({ length: 20 }, (_, i) => `[Postbox] Notice ${i}.`) });
  await f.store.flush();
  const release = await f.hold();
  const started = performance.now();
  for (let i = 0; i < 3000; i++) f.rt.updateSession(f.alpha.id, { currentStep: `Step ${i}` });
  const ms = performance.now() - started;
  // Measured at 4,589 ms when each read applied the whole held log again (QS-1's review); about 20 ms incrementally.
  assert.ok(ms < 1500, `3,000 held session changes took ${Math.round(ms)} ms`);
  await release();
  assert.equal(f.store.state.sessions[f.alpha.id].currentStep, 'Step 2999');
  await f.store.close();
});

test('a conversation whose last agent is purged keeps its room for an agent that joined it behind a held commit', async () => {
  const f = await heldRoom();
  const solo = f.rt.createThread({ projectId: 'p1', title: 'Solo', personaIds: [f.c.id] });
  const [gamma] = f.rt.sessionsIn(solo.id);
  const d = f.rt.createPersona({ handle: 'delta' });
  f.rt.deleteSession(gamma.id);
  await f.store.flush();
  const release = await f.hold();
  const delta = f.rt.ensureSession(solo.id, d.id);
  f.rt.purgeSession(gamma.id);
  await release();
  assert.deepEqual(f.store.state.threads[solo.id]?.members, [delta.id]);
  assert.equal(f.store.state.sessions[delta.id]?.handle, 'delta');
  await f.store.close();
});
