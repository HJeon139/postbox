// #848: a block whose agent couldn’t hear it took an answer and lost it. act() marked the item answered and saved the
// answer, then deliver refused the session with a 409, so the block read answered, couldn’t be answered again, and the
// agent never heard it. The answer is now refused before anything is recorded. The one session deliver refuses is a fork
// #228 retired, so these tests retire one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choice, setup, turn } from './blocks-fixture.mjs';

/** Retires every agent in the conversation, as #228’s migration did a fork. */
const retire = (rt, t) => {
  for (const se of rt.sessionsIn(t.id)) rt.updateSession(se.id, { retiredFork: true });
};
const retiredRefusal = (e) => e.status === 409 && /was retired/.test(e.message);

test('#848 an answer to a block of a retired fork is refused before anything is recorded', async () => {
  const { store, rt, adapter, t } = setup();
  await turn(rt, adapter, t, (tools) => tools.show_block({ block: choice }));
  const item = store.items(t.id).find((i) => i.block?.id === choice.id);
  const voices = () => store.items(t.id).filter((i) => i.kind === 'voice').length;
  const before = voices();
  retire(rt, t);
  assert.throws(() => rt.act(t.id, item.id, 'choose', { selected: ['issue'] }), retiredRefusal);
  const after = store.item(t.id, item.id);
  assert.equal(after.answered, false, 'the block still asks');
  assert.equal(after.answer, undefined, 'and holds no answer');
  assert.equal(voices(), before, 'no “Chose:” line was added');
});

/** A conversation whose agent has shown an app, as apps-needs.test.mjs makes one. */
function withApp() {
  const { store, rt, adapter, t } = setup();
  const se = rt.sessionsIn(t.id)[0];
  rt.toolsFor(se.id).show_app({ id: 'spam', title: 'Spam', code: '<p>x</p>', permissions: [] });
  return { store, rt, adapter, t, se };
}

test('#848 an app’s send to a retired fork is refused before anything is recorded', () => {
  const { store, rt, t, se } = withApp();
  const voices = () => store.items(t.id).filter((i) => i.kind === 'voice').length;
  const before = voices();
  retire(rt, t);
  assert.throws(() => rt.appEvent('spam', 'pick', { n: 1 }), retiredRefusal);
  assert.equal(voices(), before, 'no “You said” line');
  assert.throws(() => rt.appEvent('spam', 'pick', { n: 1 }, { hold: true }), retiredRefusal);
  assert.equal(store.items(t.id).filter((i) => i.kind === 'appsend').length, 0, 'no card that waits on the person');
  assert.notEqual(rt.s.sessions[se.id].needs?.kind, 'appsend', 'and the retired fork doesn’t need them');
});

test('#848 allowing an app’s held send to a fork retired since is refused, and the card still asks', () => {
  const { store, rt, t } = withApp();
  rt.appEvent('spam', 'pick', { n: 1 }, { hold: true });
  const card = store.items(t.id).find((i) => i.kind === 'appsend');
  retire(rt, t);
  assert.throws(() => rt.resolveAppSend(t.id, card.id, 'allow'), retiredRefusal);
  assert.equal(store.item(t.id, card.id).status, 'open', 'the card still asks');
});
