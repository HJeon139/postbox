// Stop always leaves the turn’s reply saying it was stopped (#120 pipeline spec, remote-pipeline.test.mjs:216, which
// failed one run in three on main). The cause: stop() marked only a reply segment still streaming, and added a stopped
// reply only when the turn had none at all. A card that closes the segment mid-turn (a permission card, a refusal
// card) marks it done first, so a Stop while the card waits marked nothing, and the reply read as done. The rule now:
// if Stop marked no segment of the turn, it adds the stopped reply below whatever closed the last one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replies, setup, until } from './stop-reply-fixture.mjs';

/** Runs `step` as the turn, waits for `ready`, presses Stop, and returns the turn’s reply items. */
async function stopAfter(step, ready, what) {
  const env = await setup(step);
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => ready(env), what);
  assert.equal(env.rt.stop(env.se.id), true);
  await until(() => !env.rt.turns.size, 'the turn to end');
  return replies(env.store, env.t, env.se);
}
const cardOpen = (kind) => (env) => env.store.items(env.t.id).some((i) => i.kind === kind);

test('Stop while a permission card waits, after the reply has said something: the reply says it was stopped', async () => {
  const items = await stopAfter(
    async (c) => {
      c.text('Running the tests.');
      await c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'npm test' } });
    },
    cardOpen('permission'),
    'the permission card',
  );
  assert.ok(
    items.some((i) => i.status === 'stopped'),
    JSON.stringify(items.map((i) => [i.status, i.text])),
  );
  assert.equal(items.find((i) => i.text === 'Running the tests.')?.status, 'done', 'what it said above the card stays as it was');
});

test('Stop while a permission card waits, before the reply has any text (the integration case): the reply says it was stopped', async () => {
  const items = await stopAfter(
    async (c) => {
      c.activity({ tool: 'Bash', input: { command: 'npm test' } }); // the tool’s step opens an empty segment
      await c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'npm test' } });
    },
    cardOpen('permission'),
    'the permission card',
  );
  assert.ok(
    items.some((i) => i.status === 'stopped'),
    JSON.stringify(items.map((i) => [i.status, i.text])),
  );
});

test('Stop after a refusal card closed the segment: the reply says it was stopped', async () => {
  const items = await stopAfter(
    async (c) => {
      c.text('Trying the tests.');
      c.denied({ toolUseId: 'tu-1', tool: 'Bash', input: { command: 'npm test' }, label: 'Run the tests', reason: '[x]', reasonType: 'classifier' });
    },
    cardOpen('denial'),
    'the refusal card',
  );
  assert.ok(
    items.some((i) => i.status === 'stopped'),
    JSON.stringify(items.map((i) => [i.status, i.text])),
  );
});

test('neighbors: Stop with a segment still streaming marks that one, once; Stop before any reply adds one, once', async () => {
  const streaming = await stopAfter(
    async (c) => c.text('Halfway'),
    (env) => replies(env.store, env.t, env.se).some((i) => i.text === 'Halfway'),
    'the streaming text',
  );
  assert.deepEqual(
    streaming.map((i) => [i.status, i.text]),
    [['stopped', 'Halfway']],
    'the streaming segment is the stopped reply; nothing is added',
  );
  const silent = await stopAfter(
    async () => {},
    (env) => env.rt.turns.size === 1,
    'the turn to start',
  );
  assert.deepEqual(
    silent.map((i) => i.status),
    ['stopped'],
    'a turn that said nothing gets one stopped reply',
  );
});

test('the other callers of stop(): a shutdown while a permission card waits leaves the reply saying it was stopped', async () => {
  const env = await setup(async (c) => {
    c.text('Running the tests.');
    await c.askPermission({ tool: 'Bash', summary: 'run the tests', input: { command: 'npm test' } });
  });
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => cardOpen('permission')(env), 'the permission card');
  await env.rt.stopTurns({ graceMs: 200 }); // what Postbox’s own shutdown calls, with by: 'shutdown'
  const items = replies(env.store, env.t, env.se);
  assert.ok(
    items.some((i) => i.status === 'stopped'),
    JSON.stringify(items.map((i) => [i.status, i.text])),
  );
});
