// Arrival order across the person’s queue and the inbox (#733): when a busy agent’s turn ends, what waited for it goes
// in the order it arrived, whether it waited in its thread’s queue or as an inbox entry. An answer or a lint turn that
// came before the person’s next queued message runs before it, as it did before entries (the review of #1402).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

const block = { type: 'choice', id: 'pick-1', version: 1, title: 'Which first?', options: [{ id: 'papers', label: 'The papers' }] };

/** The room with alpha busy in a turn held open, and the number of calls before what the test sends. */
async function alphaBusy() {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha start' });
  await sleep(5);
  return { ...f, busy, from: f.adapter.calls.length };
}

/** One message as the tests compare it: the person’s words, who an agent’s is from, or the kind of anything else. */
function seen(m) {
  if (m.kind === 'user') return m.text;
  if (m.kind === 'agent') return `from ${m.from}`;
  return m.kind;
}

/** Alpha’s turns after the first, each as what it was given, in order. */
const after = (f) =>
  f.adapter.calls
    .slice(f.from)
    .filter((c) => c.sessionId === f.alpha.id)
    .map((c) => c.parts.map(seen));

test('an answer that came before the person’s queued message runs first, as it did before entries', async () => {
  const f = await alphaBusy();
  const shown = arrange.post(f.rt, f.t.id, { kind: 'block', sessionId: f.alpha.id, personaId: f.alpha.personaId, handle: 'alpha', valid: true, block });
  await f.rt.act(f.t.id, shown.id, 'choose', { selected: ['papers'] });
  f.rt.sendMessage(f.t.id, { text: '@alpha and then the next thing' });
  f.busy.release();
  await settle(f.rt);
  await settle(f.rt);
  assert.deepEqual(after(f), [['event'], ['@alpha and then the next thing']]);
});

test('an answer, then another agent’s mention, then the person’s queued message go in that order', async () => {
  const f = await alphaBusy();
  const shown = arrange.post(f.rt, f.t.id, { kind: 'block', sessionId: f.alpha.id, personaId: f.alpha.personaId, handle: 'alpha', valid: true, block });
  await f.rt.act(f.t.id, shown.id, 'choose', { selected: ['papers'] });
  f.adapter.next.push(async (c) => c.text('@alpha have a look at this'));
  f.rt.sendMessage(f.t.id, { text: '@beta say' });
  await sleep(30);
  f.rt.sendMessage(f.t.id, { text: '@alpha and then the next thing' });
  f.busy.release();
  await settle(f.rt);
  await settle(f.rt);
  // The mention comes as the catch-up’s pointer (#484), since the answer’s turn already read it: who sent it is what counts.
  assert.deepEqual(after(f), [['event'], ['from @beta', '@alpha and then the next thing']]);
});

test('a lint turn that came before the person’s queued message runs first', async () => {
  const f = await alphaBusy();
  const problems = [{ code: 'table', message: 'Fix the table.', scope: { kind: 'item', id: 'it_x' } }];
  arrange.armLint(f.rt, 'tu_lint', { sessionId: f.alpha.id, kind: null, ended: true, sent: false, problems, timer: null, threadId: f.t.id });
  arrange.sendLint(f.rt, 'tu_lint');
  f.rt.sendMessage(f.t.id, { text: '@alpha queued one' });
  f.busy.release();
  await settle(f.rt);
  await settle(f.rt);
  assert.deepEqual(after(f), [['lint'], ['@alpha queued one']]);
});
