// A turn of plain entries is given turn-input.mjs’s text (#1427): the person’s messages and agents’ mentions, with
// notices riding. An entry with a message of its own (here, the person’s answer to a block) keeps it, in a turn of its
// own: a plain batch with one waiting behind it in the same thread never folds it in, and each goes in arrival order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

test('#1427 a plain batch is an input; an answer waiting behind it in its thread keeps its own turn, after it', async () => {
  const { rt, t, adapter, alpha, beta } = setup();
  const block = { type: 'choice', id: 'pick-1', version: 1, title: 'Which source first?', options: [{ id: 'papers', label: 'The papers' }] };
  const shown = arrange.post(rt, t.id, { kind: 'block', sessionId: beta.id, personaId: beta.personaId, handle: 'beta', valid: true, block });
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  await sleep(5);
  rt.agentWake(alpha.id, 'beta', 'The totals are in.');
  await rt.act(t.id, shown.id, 'choose', { selected: ['papers'] });
  busy.release();
  await settle(rt);
  const [, first, second] = adapter.calls.filter((c) => c.sessionId === beta.id);
  assert.equal(first.message.kind, 'input', 'the mention is a plain batch');
  assert.match(first.message.text, /@alpha, \d\d:\d\d UTC: The totals are in\./);
  assert.doesNotMatch(first.message.text, /pick-1/, 'the answer isn’t folded in');
  assert.equal(second.message.kind, 'event', 'the answer keeps its own message, in a turn of its own');
  assert.equal(second.message.event.blockId, 'pick-1');
});
