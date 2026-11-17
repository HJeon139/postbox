// A turn that dies says what it held (designs/rooms-at-scale.md, “Live state”): a failed reply with no words of its own
// keeps a small record of the turn, whom it was answering and which message, how far it got and the jobs it left
// running, and the reply shows it as one quiet line before the error. Handles and ids only, never a message’s text.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip, heldOfCutOff } from '../server/turn-held.mjs';
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
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === beta.id);
  assert.equal(reply.status, 'failed');
  assert.equal(reply.error, 'Claude Code exited with code 1.', 'the error stays as it was');
  assert.deepEqual(reply.held, { took: [{ from: 'you' }], steps: 2, last: 'Ran npm test', running: [], stopped: [] });
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

test('heldWords: whom it answered, how far it got, and its jobs as its end left them, as one sentence', () => {
  const held = (/** @type {any} */ o) => ({ took: [], steps: 0, last: null, running: [], stopped: [], ...o });
  assert.equal(
    heldWords(held({ took: [{ from: 'critic' }, { from: 'you' }], steps: 4, last: 'Reading the shelf', running: ['npm test'] })),
    'It was answering @critic and you · got to step 4, Reading the shelf · 1 job still running: npm test.',
  );
  assert.equal(heldWords(held({ took: [{ from: 'you' }] })), 'It was answering you, before its first step.');
  assert.equal(
    heldWords(held({ took: [{ from: 'a' }, { from: 'b' }, { from: 'c' }, { from: 'a' }], steps: 1, last: 'Read', stopped: ['x', 'y'] })),
    'It was answering @a, @b and @c · got to step 1, Read · 2 jobs stopped with it: x and y.',
  );
  assert.equal(heldWords(held({ steps: 2, last: 'Read' })), 'It got to step 2, Read.');
  assert.equal(heldWords(held({})), 'It ended before its first step.');
  assert.equal(heldWords(held({ steps: 1, last: 'Is the build green?' })), 'It got to step 1, Is the build green?', 'no second stop');
  assert.equal(heldWords(held({ took: [{}] })), 'It was answering Postbox, before its first step.');
  assert.equal(heldWords(null), '');
});

test('a job the turn left stops with it, and says so; one the person kept runs on; another turn’s kept job isn’t this turn’s', async () => {
  const { rt, store, t, adapter, beta } = setup();
  rt.sessions.update(beta.id, { jobs: [{ id: 'old', turnId: 'tu_other', label: 'An older kept job', state: 'running', kept: true }] });
  adapter.next.push(async (c) => {
    c.job({ id: 'j1', label: 'npm test', state: 'running' });
    c.job({ id: 'j2', label: 'npm run watch', state: 'running' });
    // The person kept j2 running, as Keep running does.
    rt.sessions.update(beta.id, (/** @type {any} */ s) => ({ jobs: s.jobs.map((j) => (j.id === 'j2' ? { ...j, kept: true } : j)) }));
    throw new Error('Claude Code exited with code 1.');
  });
  rt.sendMessage(t.id, { text: '@beta check the build' });
  await settle(rt);
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === beta.id);
  assert.deepEqual(reply.held.running, ['npm run watch']);
  assert.deepEqual(reply.held.stopped, ['npm test']);
  const jobs = store.state.sessions[beta.id].jobs ?? [];
  assert.ok(!jobs.some((/** @type {any} */ j) => j.id === 'j1' && j.state === 'running'), 'its end did stop it');
  assert.ok(jobs.some((/** @type {any} */ j) => j.id === 'j2' && j.state === 'running'), 'the kept one runs on');
});

test('a turn lost to the network and sent again keeps no record: its reply says it was retried', async () => {
  const { rt, store, t, adapter, beta } = setup();
  adapter.next.push(async () => {
    throw new Error('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  });
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  const retried = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === beta.id && i.status === 'retried');
  assert.ok(retried, 'the resend’s reply');
  assert.equal(retried.held, undefined);
});

test('a reply cut off with no words keeps a bounded record: five of whom, eighty characters, no subagent’s steps', () => {
  const took = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((from) => ({ from, text: `secret from ${from}` }));
  const rt = { delivery: { takenBy: (/** @type {string} */ se, /** @type {string} */ turn) => (se === 'se_1' && turn === 'tu_1' ? took : []) } };
  const long = `${'Reading every book on the shelf, '.repeat(3)}👩‍👩‍👧 the end`;
  const it = {
    sessionId: 'se_1',
    turnId: 'tu_1',
    text: '',
    activity: {
      steps: [
        { id: '1', label: 'Read' },
        { id: '2', label: long },
        { id: '3', label: 'A subagent’s step', who: 'helper' },
        { id: '4', label: 'Thought', kind: 'thought' },
      ],
    },
  };
  const { held } = /** @type {any} */ (heldOfCutOff(rt, it));
  assert.equal(held.took.length, 5);
  assert.ok(!JSON.stringify(held).includes('secret'), 'no message text');
  assert.equal(held.steps, 2, 'its own steps only');
  assert.equal(held.last, clip(long));
  assert.equal([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(held.last)].length, 80);
  assert.equal(clip(`${'x'.repeat(79)}👩‍👩‍👧b`), `${'x'.repeat(79)}👩‍👩‍👧`, 'an emoji is never split');
  assert.deepEqual(heldOfCutOff(rt, { ...it, text: 'Words of its own.' }), {});
});
