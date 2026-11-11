// The browser’s report on a diagram reaches its agent once (server/diagram-check.mjs): a diagram it has heard about is
// remembered on its session, so the same diagram drawn again in a later reply isn’t reported again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './blocks-fixture.mjs';

const DIAGRAM = '```mermaid\ngraph LR\nA-->B\n```';
const src = 'graph LR\nA-->B';
const tooSmall = { src, textPx: 7, width: 728 };

test('a diagram the agent heard is too small isn’t reported again when a later reply draws it again', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.text(DIAGRAM));
  rt.sendMessage(t.id, { text: 'draw it' });
  await settle(rt);
  const first = store.items(t.id).findLast((i) => i.kind === 'agent');
  assert.equal(rt.diagramCheck(t.id, first.id, tooSmall).sent, true, 'the first report reaches the agent');
  await settle(rt); // its lint turn

  adapter.next.push(async (c) => c.text(`Again:\n\n${DIAGRAM}`));
  rt.sendMessage(t.id, { text: 'draw it again' });
  await settle(rt);
  const again = store.items(t.id).findLast((i) => i.kind === 'agent' && !i.lintReply);
  assert.notEqual(again.id, first.id);
  assert.equal(rt.diagramCheck(t.id, again.id, tooSmall).sent, false, 'the same diagram in a later reply');
});
