// A turn that dies says what it held (designs/rooms-at-scale.md, “Live state”): a failed reply with no words of its own
// keeps a small record of the turn, whom it was answering and which message, how far it got and the jobs it left
// running, and the reply shows it as one quiet line before the error. Handles and ids only, never a message’s text.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldWords } from '../shared/held-words.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

test('a failed reply with no words keeps whom the turn answered, its steps and its jobs still running', async () => {
  const { rt, store, t, adapter, beta } = setup();
  adapter.next.push(async (c) => {
    c.activity({ id: 's1', label: 'Read the shelf', state: 'done' });
    c.activity({ id: 's2', label: 'Thinking', kind: 'thought', state: 'done' });
    c.activity({ id: 's3', label: 'Ran npm test', state: 'running' });
    throw new Error('Claude Code exited with code 1.');
  });
  rt.sendMessage(t.id, { text: '@beta check the build' });
  await settle(rt);
  const asked = store.items(t.id).find((i) => i.kind === 'user');
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === beta.id);
  assert.equal(reply.status, 'failed');
  assert.equal(reply.error, 'Claude Code exited with code 1.', 'the error stays as it was');
  assert.deepEqual(reply.held, { took: [{ from: 'you', itemId: asked.id }], steps: 2, last: 'Ran npm test', jobs: [] });
  assert.ok(!JSON.stringify(reply.held).includes('check the build'), 'no message text is copied');
});

test('a failed reply that has words of its own keeps no record: its words say how far it got', async () => {
  const { rt, store, t, adapter, beta } = setup();
  adapter.next.push(async (c) => {
    c.text('Half of the answer.');
    throw new Error('Claude Code exited with code 1.');
  });
  rt.sendMessage(t.id, { text: '@beta check the build' });
  await settle(rt);
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === beta.id);
  assert.equal(reply.status, 'failed');
  assert.equal(reply.held, undefined);
});

test('a dead turn raises nothing new: no notice past the failure’s own, and the need is the failure’s', async () => {
  const { rt, store, t, adapter, beta } = setup();
  const notices = [];
  store.subscribe((/** @type {any} */ ev) => ev.type === 'notify' && notices.push(ev.data));
  adapter.next.push(async () => {
    throw new Error('Claude Code exited with code 1.');
  });
  rt.sendMessage(t.id, { text: '@beta check the build' });
  await settle(rt);
  assert.equal(notices.length, 1, 'the failure’s one notice, as before');
  assert.equal(store.state.sessions[beta.id].needs?.kind, 'failed');
});

test('heldWords: whom it answered, how far it got, and the jobs it left, in one line', () => {
  assert.equal(
    heldWords({
      took: [
        { from: 'critic', itemId: 'a' },
        { from: 'you', itemId: 'b' },
      ],
      steps: 4,
      last: 'Reading the shelf',
      jobs: ['npm test'],
    }),
    'It was answering @critic and you · got to step 4, Reading the shelf · 1 job still running: npm test',
  );
  assert.equal(heldWords({ took: [{ from: 'you', itemId: 'b' }], steps: 0, last: null, jobs: [] }), 'It was answering you, before its first step');
  assert.equal(
    heldWords({
      took: [
        { from: 'a', itemId: '1' },
        { from: 'b', itemId: '2' },
        { from: 'c', itemId: '3' },
        { from: 'a', itemId: '4' },
      ],
      steps: 1,
      last: 'Read',
      jobs: ['x', 'y'],
    }),
    'It was answering @a, @b and @c · got to step 1, Read · 2 jobs still running: x and y',
  );
  assert.equal(heldWords({ took: [], steps: 2, last: 'Read', jobs: [] }), 'It got to step 2, Read');
  assert.equal(heldWords({ took: [], steps: 0, last: null, jobs: [] }), 'It ended before its first step');
  assert.equal(heldWords(null), '');
});
