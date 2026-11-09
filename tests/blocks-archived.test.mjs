// #848: a block in an archived conversation took an answer and lost it. act() marked the item answered and saved the
// answer, then deliver refused the archived session with a 409, so the block read answered, couldn’t be answered again,
// and the agent never heard it. The answer is now refused before anything is recorded, and the block still asks once the
// conversation is restored.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choice, setup, turn } from './blocks-fixture.mjs';

test('#848 an answer to a block in an archived conversation is refused before anything is recorded', async () => {
  const { store, rt, adapter, t } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: choice }));
  const item = store.items(t.id).find((i) => i.block?.id === choice.id);
  const voices = () => store.items(t.id).filter((i) => i.kind === 'voice').length;
  const before = voices();
  rt.archiveThread(t.id);
  assert.throws(
    () => rt.act(t.id, item.id, 'choose', { selected: ['issue'] }),
    (e) => e.status === 409 && /archived\. Restore it first/.test(e.message),
  );
  const after = store.item(t.id, item.id);
  assert.equal(after.answered, false, 'the block still asks');
  assert.equal(after.answer, undefined, 'and holds no answer');
  assert.equal(voices(), before, 'no “Chose:” line was added');

  rt.restoreThread(t.id);
  const calls = adapter.calls.length;
  rt.act(t.id, item.id, 'choose', { selected: ['issue'] });
  assert.equal(store.item(t.id, item.id).answered, true, 'restored, it takes the answer');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(adapter.calls.length > calls, 'and the agent hears it');
});
