// A turn's own id is the last turn's from its start (#366; critic's fresh-subagent review of #633 at 004f3e3d): a turn a
// restart cuts off never ends, and a permission that expires at the turn's end is released before the end records it, so
// a block you moved past came back on both paths. After a restart, the interrupted turn's own asks count.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { settleInterrupted } from '../server/restart-sweep.mjs';
import { Runtime } from '../server/runtime.mjs';
import { room } from './card-needs-fixture.mjs';
import { held, settle, sleep } from './side-threads-fixture.mjs';

/** A second runtime on the same store, as a restart makes one, with the restart's sweep run. */
function restart(r) {
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store: r.store,
    adapters: new AdapterRegistry().register(r.adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  settleInterrupted(rt);
  return rt;
}

test('after a restart cuts a turn off, denying its app card doesn’t bring back the block you moved past', async () => {
  const r = room();
  const b = r.block(); // from turn_last
  r.setNeed('block', b.id);
  r.adapter.next.push(held().step); // the turn never ends here
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' }); // you move on
  await sleep(5);
  const card = r.appCard();
  r.rt.needAppSend({ sessionId: r.alpha.id, title: 'App', threadId: r.t.id }, card.id, 1);
  assert.equal(r.needs()?.itemId, card.id);
  const rt = restart(r);
  rt.resolveAppSend(r.t.id, card.id, 'deny');
  assert.equal(r.store.state.sessions[r.alpha.id].needs, null, 'not the block from before you moved on');
});

test('after a restart, a block the interrupted turn showed is the need', async () => {
  const r = room();
  r.adapter.next.push(async (c, _m, se) => {
    r.rt.addItem(r.t.id, {
      kind: 'block',
      sessionId: se.id,
      handle: 'alpha',
      turnId: r.rt.turns.get(se.id).id,
      valid: true,
      block: { id: 'b_cut', type: 'choice', version: 1, fallback: 'Pick', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] },
    });
    c.text('Pick one.');
    await new Promise(() => {}); // cut off by the restart
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await sleep(5);
  restart(r);
  const se = r.store.state.sessions[r.alpha.id];
  assert.equal(se.needs?.kind, 'block', 'the agent needs you for the question it asked');
  assert.equal(se.state, 'needs');
});

test('a permission that expires at the turn’s end doesn’t flash the block you moved past', async () => {
  const r = room();
  const b = r.block(); // from turn_last
  r.setNeed('block', b.id);
  r.adapter.next.push(async () => {
    const p = r.permission();
    r.setNeed('permission', p.id);
    throw new Error('the model went away');
  });
  const kinds = [];
  const update = r.rt.updateSession.bind(r.rt);
  r.rt.updateSession = (id, patch) => {
    if (id === r.alpha.id && 'needs' in patch) kinds.push(patch.needs?.kind ?? null);
    return update(id, patch);
  };
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await settle(r.rt);
  assert.ok(!kinds.includes('block'), `the needs the turn set: ${JSON.stringify(kinds)}`);
});
