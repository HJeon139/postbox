// Recording an outcome on an answered block, and updates that ask nothing new (#286, #330): server/blocks.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choice, review, settle, setup, turn } from './blocks-fixture.mjs';

// #286: the agent in the needsnav UAT changed only a fallback on an answered choice, which reopened it, and then its
// outcome was refused because the block was no longer answered.
test('#286 an update that changes only what the person can’t see leaves an answered block answered, so an outcome follows', async () => {
  const { rt, store, t, adapter } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: choice }));
  const item = store.items(t.id).find((i) => i.kind === 'block');
  rt.act(t.id, item.id, 'choose', { selected: ['issue'] });
  await settle(rt);
  let quiet;
  let recorded;
  await turn(rt, adapter, t, (tools) => {
    quiet = tools.update_block({ block: { ...choice, fallback: 'Report it as a new issue or a comment on #94?' } });
    recorded = tools.update_block({ block: { ...choice, outcome: 'Filed as #286.' } });
  });
  assert.equal(quiet.ok, true, quiet.message);
  assert.match(quiet.message, /stays answered/);
  assert.equal(recorded.ok, true, recorded.message);
  const it = store.item(t.id, item.id);
  assert.equal(it.answered, true);
  assert.deepEqual(it.answer.values.selected, ['issue']);
  assert.equal(it.block.outcome, 'Filed as #286.');
  assert.equal(it.block.fallback, 'Report it as a new issue or a comment on #94?');
  assert.equal(store.items(t.id).filter((i) => i.kind === 'block').length, 1, 'nothing was asked again');
  // Changing what it asks still asks again, as before.
  const asked = await turn(rt, adapter, t, (tools) => tools.update_block({ block: { ...choice, title: 'Where now?' } }));
  assert.match(asked.message, /asks again/);
  assert.equal(store.item(t.id, item.id).answered, false);
});

// #330: the tool’s description says an outcome changes nothing else, but the whole block had to be sent with it.
test('#330 { id, outcome } records an outcome on an answered review, and warns only about fields sent that differ', async () => {
  const { rt, store, t, adapter } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: review }));
  const item = store.items(t.id).find((i) => i.kind === 'block');
  rt.act(t.id, item.id, 'submit', { verdict: 'approve', comments: [] });
  await settle(rt);
  let bare;
  let typed;
  let changed;
  let wrongType;
  await turn(rt, adapter, t, (tools) => {
    bare = tools.update_block({ block: { id: review.id, outcome: 'Filed as #105.' } });
    typed = tools.update_block({ block: { id: review.id, type: 'review', version: 1, outcome: 'Filed as #105, labeled.' } });
    changed = tools.update_block({ block: { id: review.id, content: '# Another draft', outcome: 'Filed as #106.' } });
    wrongType = tools.update_block({ block: { id: review.id, type: 'choice', outcome: 'Filed.' } });
  });
  assert.equal(bare.ok, true, bare.message);
  assert.doesNotMatch(bare.message, /weren’t applied/);
  assert.equal(typed.ok, true, typed.message);
  assert.doesNotMatch(typed.message, /weren’t applied/);
  assert.equal(changed.ok, true, changed.message);
  assert.match(changed.message, /Your other changes \(content\) weren’t applied/);
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.message, /can’t change a block’s type/);
  const it = store.item(t.id, item.id);
  assert.equal(it.block.outcome, 'Filed as #106.');
  assert.equal(it.block.content, '# Draft', 'the draft the person approved stays');
  assert.equal(it.answered, true);
});
