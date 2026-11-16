// Each source step 3 makes an inbox entry (designs/rooms-at-scale.md, “What an entry is”): while its agent is busy, what
// it sends waits in the agent’s inbox, with its source and the item it points at, and starts the agent’s next turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** The room with alpha busy in a turn held open. */
async function alphaBusy() {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha start' });
  await sleep(5);
  return { ...f, busy };
}

test('the person’s answer to a busy agent’s block waits in its inbox as an answer, and starts its next turn', async () => {
  const f = await alphaBusy();
  const block = { type: 'choice', id: 'pick-1', version: 1, title: 'Which first?', options: [{ id: 'papers', label: 'The papers' }] };
  const shown = arrange.post(f.rt, f.t.id, { kind: 'block', sessionId: f.alpha.id, personaId: f.alpha.personaId, handle: 'alpha', valid: true, block });
  await f.rt.act(f.t.id, shown.id, 'choose', { selected: ['papers'] });
  assert.deepEqual(
    arrange.waitingEntries(f.rt, f.alpha.id).map((e) => [e.source, e.itemId, e.from]),
    [['answer', shown.id, 'you']],
  );
  f.busy.release();
  await settle(f.rt);
  assert.match(JSON.stringify(f.adapter.calls.filter((c) => c.sessionId === f.alpha.id).at(-1).message), /papers/);
});

test('the person’s answer to a busy agent’s tool ask waits in its inbox as an answer, pointing at the card', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => c.tools.ask_for_tool({ tool: 'shell', why: 'To run the tests.' }));
  f.rt.sendMessage(f.t.id, { text: '@alpha run the tests' });
  await settle(f.rt);
  const card = f.store.items(f.t.id).find((i) => i.kind === 'toolask');
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha meanwhile, read the notes' });
  await sleep(5);
  await f.rt.act(f.t.id, card.id, 'on');
  assert.deepEqual(
    arrange.waitingEntries(f.rt, f.alpha.id).map((e) => [e.source, e.itemId, e.from]),
    [['answer', card.id, 'you']],
  );
  busy.release();
  await settle(f.rt);
  assert.match(JSON.stringify(f.adapter.calls.filter((c) => c.sessionId === f.alpha.id).at(-1).message), /turned on shell/);
});

test('the person’s / command is a command entry pointing at its line, and its turn is the whole command', async () => {
  const f = setup();
  const { item } = f.rt.runAgentCommand(f.t.id, { sessionId: f.alpha.id, text: '/review src/a.js' });
  await settle(f.rt);
  const entries = Object.values(f.store.state.inbox).flat();
  assert.deepEqual(
    entries.filter((e) => e.itemId === item.id).map((e) => [e.source, e.from, e.state]),
    [['command', 'you', 'delivered']],
  );
  const turn = f.adapter.calls.filter((c) => c.sessionId === f.alpha.id).at(-1);
  assert.deepEqual([turn.message.text, turn.message.slash], ['/review src/a.js', true]);
});
