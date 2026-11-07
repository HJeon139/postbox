// A reply sits where its agent wrote it, not where the agent began (server/reply-segment.mjs, wordsSegment). A turn’s
// first step makes its reply’s first part, so a message posted while the agent thinks used to land below that part,
// and the words written after it went above it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

/** A turn that takes a step, waits for the test, then writes. */
function steppedTurn() {
  let go = () => {};
  const waited = new Promise((r) => {
    go = r;
  });
  /** @type {(ctx: any) => Promise<void>} */
  const step = async (ctx) => {
    ctx.activity({ id: 'read', label: 'Read the file', state: 'done', ms: 5 });
    await waited;
    ctx.text('Here’s what I found.');
  };
  return { step, go: () => go() };
}

const agentItems = (f) => f.store.items(f.t.id).filter((it) => it.kind === 'agent');
const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

test('words written after another message start a new part at the end; the steps stay where the agent began', async () => {
  const f = setup();
  const turn = steppedTurn();
  f.adapter.next.push(turn.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha look at the file' });
  await until(() => agentItems(f).length === 1);
  const posted = f.rt.addItem(f.t.id, { kind: 'user', text: 'While you look: it’s the second one.' });
  turn.go();
  await settle(f.rt);

  const items = f.store.items(f.t.id);
  const [first, words] = agentItems(f);
  assert.ok(words, 'the words are a part of their own');
  assert.equal(words.text, 'Here’s what I found.');
  assert.equal(first.text, '', 'the first part keeps no words');
  assert.deepEqual(
    first.activity.steps.map((s) => s.label),
    ['Read the file'],
    'the steps stay on the first part',
  );
  assert.ok(items.indexOf(words) > items.findIndex((it) => it.id === posted.id), 'the words come after the message posted while the agent worked');
  assert.equal(words.turnId, first.turnId, 'both parts are the one turn’s');
});

test('with nothing posted meanwhile, the steps and the words share one part', async () => {
  const f = setup();
  const turn = steppedTurn();
  f.adapter.next.push(turn.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha look at the file' });
  await until(() => agentItems(f).length === 1);
  turn.go();
  await settle(f.rt);

  const replies = agentItems(f);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'Here’s what I found.');
  assert.equal(replies[0].activity.steps.length, 1);
});

/** A turn that writes four chunks, each after the test lets it go, so two agents’ chunks interleave. */
function chunkedTurn(name, gates) {
  return async (ctx) => {
    for (let i = 0; i < 4; i++) {
      await gates[i];
      ctx.text(`${name}${i} `);
    }
  };
}

test('two agents writing at once each keep their words in one part, however their chunks interleave', async () => {
  const f = setup();
  /** @type {(() => void)[]} */
  const open = [];
  const gates = Array.from({ length: 4 }, () => new Promise((r) => open.push(() => r(undefined))));
  f.adapter.next.push(chunkedTurn('A', gates), chunkedTurn('B', gates));
  f.rt.sendMessage(f.t.id, { text: '@alpha @beta both of you count' });
  await until(() => f.adapter.calls.length === 2);
  for (const go of open) {
    go();
    await new Promise((r) => setTimeout(r, 10));
  }
  await settle(f.rt);

  for (const [se, name] of [
    [f.alpha, 'A'],
    [f.beta, 'B'],
  ]) {
    const parts = agentItems(f).filter((it) => it.sessionId === se.id && it.text);
    assert.equal(parts.length, 1, `${name}’s words are one part: ${JSON.stringify(parts.map((p) => p.text))}`);
    assert.equal(parts[0].text, `${name}0 ${name}1 ${name}2 ${name}3 `, 'with nothing put between its chunks');
  }
});

test('words after a tool call start a new part at the end once something was posted below the reply', async () => {
  const f = setup();
  let go = () => {};
  const looked = new Promise((r) => {
    go = r;
  });
  f.adapter.next.push(
    async (ctx) => {
      ctx.text('Let me look.');
      ctx.activity({ id: 'read', label: 'Read answer.txt', state: 'running' });
      await looked;
      ctx.activity({ id: 'read', label: 'Read answer.txt', state: 'done', ms: 5 });
      ctx.text('The answer is 42.');
    },
    async (ctx) => ctx.text('Hi.'),
  );
  f.rt.sendMessage(f.t.id, { text: '@alpha what is the answer?' });
  await until(() => agentItems(f).some((it) => it.text === 'Let me look.'));
  f.rt.sendMessage(f.t.id, { text: '@beta hi' });
  await until(() => agentItems(f).some((it) => it.sessionId === f.beta.id && it.status === 'done'));
  go();
  await settle(f.rt);

  const items = f.store.items(f.t.id);
  const alpha = agentItems(f).filter((it) => it.sessionId === f.alpha.id && it.text);
  assert.deepEqual(
    alpha.map((it) => it.text),
    ['Let me look.', 'The answer is 42.'],
    'the words after the Read are a part of their own',
  );
  const at = (it) => items.indexOf(it);
  const hi = items.find((it) => it.kind === 'user' && it.text === '@beta hi');
  const beta = agentItems(f).find((it) => it.sessionId === f.beta.id);
  assert.ok(at(alpha[1]) > at(hi) && at(alpha[1]) > at(beta), 'and they come after the message and beta’s reply');
  assert.ok(at(alpha[0]) < at(hi), 'the words before the Read stay where they were written');
});

test('a step with nothing posted meanwhile keeps the words in one part', async () => {
  const f = setup();
  f.adapter.next.push(async (ctx) => {
    ctx.text('Let me look.');
    ctx.activity({ id: 'read', label: 'Read answer.txt', state: 'done', ms: 5 });
    ctx.text(' The answer is 42.');
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha what is the answer?' });
  await settle(f.rt);
  assert.deepEqual(
    agentItems(f).map((it) => it.text),
    ['Let me look. The answer is 42.'],
  );
});
