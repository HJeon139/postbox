// The behavior net for the inbox’s step 3 (designs/architecture/services.md, “Delivery and Turns, built as the inbox”):
// what a woken turn is given, which must hold once Turns starts every turn from inbox entries and builds its input with
// server/turn-input.mjs. Each test acts through the facade and reads only what the agent’s turn was given, as text,
// never the message’s shape, so the step keeps these as they are. Green on main before it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** Everything an agent’s turns were given, one string per turn, whatever shape each message had. */
const given = (adapter, sessionId) => adapter.calls.filter((c) => c.sessionId === sessionId).map((c) => JSON.stringify(c.message));

/** The last turn an agent was given, as text. */
const lastGiven = (adapter, sessionId) => given(adapter, sessionId).at(-1) ?? '';

test('the person’s message reaches the agent with its words and the files it attached (#1307)', async () => {
  const { rt, adapter, t, alpha } = setup();
  rt.sendMessage(t.id, { text: '@alpha read the plan first', attachments: [{ kind: 'project-file', path: 'notes/plan.md' }] });
  await settle(rt);
  const turn = lastGiven(adapter, alpha.id);
  assert.match(turn, /read the plan first/);
  assert.match(turn, /notes\/plan\.md/);
});

test('the person’s answer to a block reaches its agent with the block’s id and the option chosen (#1253, #791)', async () => {
  const { rt, adapter, t, alpha } = setup();
  const block = { type: 'choice', id: 'pick-1', version: 1, title: 'Which source first?', options: [{ id: 'papers', label: 'The papers' }] };
  const shown = arrange.post(rt, t.id, { kind: 'block', sessionId: alpha.id, personaId: alpha.personaId, handle: 'alpha', valid: true, block });
  await rt.act(t.id, shown.id, 'choose', { selected: ['papers'] });
  await settle(rt);
  const turn = lastGiven(adapter, alpha.id);
  assert.match(turn, /pick-1/);
  assert.match(turn, /papers/);
});

test('another agent’s review reaches the block’s author with the block’s id and its comment', async () => {
  const { rt, adapter, t, alpha } = setup();
  const review = { id: 'rv', type: 'review', version: 1, fallback: 'A draft.', format: 'markdown', title: 'Draft', content: 'one\ntwo\n' };
  arrange.post(rt, t.id, { kind: 'block', sessionId: alpha.id, personaId: alpha.personaId, handle: 'alpha', valid: true, block: review });
  adapter.next.push(async (c) => {
    c.tools.review_block({ blockId: 'rv', comments: [{ line: 1, text: 'Shorter, please.' }] });
    c.text('Reviewed.');
  });
  rt.sendMessage(t.id, { text: '@beta review alpha’s draft' });
  await settle(rt);
  const turn = lastGiven(adapter, alpha.id);
  assert.match(turn, /rv/);
  assert.match(turn, /Shorter, please\./);
});

test('a scheduled wake reaches its agent with the note it left itself', async () => {
  const { rt, store, adapter, alpha } = setup();
  const sc = rt.schedule(alpha.id, { inMs: 60_000, note: 'Check the nightly run.' });
  store.emit('schedule', { ...sc, at: Date.now() });
  rt.arm(sc);
  await settle(rt);
  assert.match(lastGiven(adapter, alpha.id), /Check the nightly run\./);
});

test('a woken agent is given what the room said since its last turn, not only what woke it', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  rt.sendMessage(t.id, { text: '@alpha first task' });
  await settle(rt);
  arrange.post(rt, t.id, { kind: 'agent', sessionId: beta.id, personaId: beta.personaId, handle: 'beta', text: 'The index is rebuilt.', status: 'done' });
  rt.sendMessage(t.id, { text: '@alpha second task' });
  await settle(rt);
  const turn = lastGiven(adapter, alpha.id);
  assert.match(turn, /second task/);
  assert.match(turn, /The index is rebuilt\./);
});

test('#484: a mention reaches its agent once, never both in the room’s catch-up and as the message that woke it', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start the survey' });
  await sleep(5);
  adapter.next.push(async (c) => c.text('@beta the editions differ in chapter three.'));
  rt.sendMessage(t.id, { text: '@alpha compare the editions' });
  for (let i = 0; i < 200 && arrange.running(rt, alpha.id); i++) await sleep(5);
  busy.release();
  await settle(rt);
  const turn = lastGiven(adapter, beta.id);
  assert.equal(turn.split('the editions differ in chapter three').length - 1, 1, turn);
});

test('a failed reply’s mention reaches its agent with a note that it failed and may be cut off (#485)', async () => {
  const { rt, adapter, t, beta } = setup();
  adapter.next.push(async (c) => {
    c.text('@beta the totals are in.');
    throw new Error('API 500');
  });
  rt.sendMessage(t.id, { text: '@alpha report' });
  await settle(rt);
  const turn = lastGiven(adapter, beta.id);
  assert.match(turn, /the totals are in\./);
  assert.match(turn, /failed/);
});
