// #1319: an agent’s invalid block is refused outright. show_block posts nothing, so no broken card stays in the
// conversation, and the reply names the problems and shows that type’s shape, so the agent can fix it and show it
// again with the same id. Only a block this Postbox can’t read but a newer host could still shows its fallback.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { choice, setup, turn } from './blocks-fixture.mjs';

const blocks = (store, t) => store.items(t.id).filter((i) => i.kind === 'block');

test('#1319 an invalid show_block posts nothing, says what’s wrong with the shape, and the same id then shows', async () => {
  const { rt, store, t, adapter } = setup();
  // As in the UAT streams: a choice with string options and no fallback.
  const bad = { id: choice.id, type: 'choice', version: 1, options: ['A new issue', 'A comment'] };
  const r = await turn(rt, adapter, t, (tools) => tools.show_block({ block: bad }));
  assert.equal(r.ok, false);
  assert.deepEqual(blocks(store, t), [], 'no item, so no broken card');
  assert.match(r.message, /^The block wasn’t shown: /);
  assert.match(r.message, /fallback is required\./);
  const example = JSON.parse(/A choice block looks like this: (\{.*\})\. /.exec(r.message)?.[1] ?? 'null');
  assert.equal(example?.type, 'choice');
  assert.match(r.message, /send it again with the same id: nothing was shown under it\.$/);
  // Fixed, under the same id: shown, and the only block.
  const again = await turn(rt, adapter, t, (tools) => tools.show_block({ block: choice }));
  assert.equal(again.ok, true, again.message);
  assert.equal(blocks(store, t).length, 1);
});

test('#1319 an invalid app from show_app posts nothing either', async () => {
  const { rt, store, t, adapter } = setup();
  const r = await turn(rt, adapter, t, (tools) => tools.show_app({ id: 'chart', title: 'Chart', code: '<p>Hi</p>', permissions: ['Not A Tool'] }));
  assert.equal(r.ok, false);
  assert.match(r.message, /permissions\[0\] isn’t a valid tool name\./);
  assert.match(r.message, /An app block looks like this: /);
  assert.deepEqual(blocks(store, t), []);
  assert.equal(rt.store.pending.app('chart'), undefined, 'no app is registered');
});

test('#1319 an unknown type from an agent here is refused, with the catalog’s types', async () => {
  const { rt, store, t, adapter } = setup();
  const r = await turn(rt, adapter, t, (tools) => tools.show_block({ block: { ...choice, type: 'chioce' } }));
  assert.equal(r.ok, false);
  assert.match(r.message, /Unknown type “chioce”\. This app’s catalog has choice, form/);
  assert.deepEqual(blocks(store, t), []);
});

test('#1319 a block this Postbox can’t read, from a newer host, still shows its fallback', () => {
  const { rt, store, t } = setup();
  const se = Object.values(store.state.sessions)[0];
  const ctx = { turn: { id: 'turn_1', remote: {} }, se: () => se, threadId: () => t.id, endSegment() {}, tools: {} };
  const newer = { id: 'map', type: 'map', version: 1, fallback: 'A map of the three sites.' };
  const r = arrange.showBlock(rt, se.id, ctx, { block: newer });
  assert.equal(r.ok, false);
  const [it] = blocks(store, t);
  assert.equal(it?.valid, false);
  assert.equal(it.fallback, 'A map of the three sites.');
  // A plain mistake from that host is still refused: the host’s own catalog would have caught it.
  const bad = arrange.showBlock(rt, se.id, ctx, { block: { id: 'x', type: 'choice', version: 1, options: [] } });
  assert.match(bad.message, /^The block wasn’t shown: /);
  assert.equal(blocks(store, t).length, 1);
});

test('#1319 update_block’s refusal shows the type’s shape too', async () => {
  const { rt, adapter, t } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: choice }));
  const r = await turn(rt, adapter, t, (tools) => tools.update_block({ block: { ...choice, options: ['Yes', 'No'] } }));
  assert.equal(r.ok, false);
  assert.match(r.message, /^The update was invalid and wasn’t applied: options must be objects like/);
  assert.match(r.message, /A choice block looks like this: \{/);
});
