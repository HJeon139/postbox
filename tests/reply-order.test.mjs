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
