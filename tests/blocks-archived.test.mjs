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

/** A conversation whose agent has shown an app, as apps-needs.test.mjs makes one. */
function withApp() {
  const { store, rt, adapter, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  rt.toolsFor(se.id).show_app({ id: 'spam', title: 'Spam', code: '<p>x</p>', permissions: [] });
  return { store, rt, adapter, t, se };
}
const archivedRefusal = (e) => e.status === 409 && /archived\. Restore it first/.test(e.message);

test('#848 an app’s send in an archived conversation is refused before anything is recorded', () => {
  const { store, rt, t, se } = withApp();
  const voices = () => store.items(t.id).filter((i) => i.kind === 'voice').length;
  const before = voices();
  rt.archiveThread(t.id);
  assert.throws(() => rt.appEvent('spam', 'pick', { n: 1 }), archivedRefusal);
  assert.equal(voices(), before, 'no “You said” line');
  assert.throws(() => rt.appEvent('spam', 'pick', { n: 1 }, { hold: true }), archivedRefusal);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'appsend').length, 0, 'no card that waits on the person');
  assert.notEqual(rt.s.sessions[se.id].needs?.kind, 'appsend', 'and the archived agent doesn’t need them');
});

test('#848 allowing an app’s held send in a conversation archived since is refused, and the card still asks', () => {
  const { store, rt, t } = withApp();
  rt.appEvent('spam', 'pick', { n: 1 }, { hold: true });
  const card = store.items(t.id).find((i) => i.kind === 'appsend');
  rt.archiveThread(t.id);
  assert.throws(() => rt.resolveAppSend(t.id, card.id, 'allow'), archivedRefusal);
  assert.equal(store.item(t.id, card.id).status, 'open', 'the card still asks once the conversation is restored');
});
