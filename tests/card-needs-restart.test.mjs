// A turn's own id is the last turn's from its start (#366; the review of #633 at 004f3e3d): a turn a
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

/** Turn 1 left block B as the need; then @beta wakes @alpha, a turn that doesn't move on, and it keeps B. */
async function wokenWithBlockKept(r) {
  const b = r.block();
  r.setNeed('block', b.id);
  r.adapter.next.push(held().step);
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Here are the numbers.' });
  await sleep(5);
  return b;
}

test('after a restart cuts off a turn that didn’t move on, the block it kept is still the need', async () => {
  const r = room();
  const b = await wokenWithBlockKept(r);
  restart(r);
  assert.equal(r.store.state.sessions[r.alpha.id].needs?.itemId, b.id);
});

test('…and when a permission took the need mid-turn, the kept block is the need after the restart', async () => {
  const r = room();
  const b = await wokenWithBlockKept(r);
  const p = r.permission();
  r.setNeed('permission', p.id);
  restart(r);
  assert.equal(r.store.state.sessions[r.alpha.id].needs?.itemId, b.id);
});

test('a failed turn that showed a block, then asked permission, doesn’t flash its block as the need', async () => {
  const r = room();
  r.adapter.next.push(async (_c, _m, se) => {
    r.rt.addItem(r.t.id, {
      kind: 'block',
      sessionId: se.id,
      handle: 'alpha',
      turnId: r.rt.turns.get(se.id).id,
      valid: true,
      block: { id: 'b_own', type: 'choice', version: 1, fallback: 'Pick', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] },
    });
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
  assert.equal(kinds.at(-1), 'failed');
});

/** The need is `kind`'s card from the turn before; @beta wakes @alpha (a turn that doesn't move on), and a restart cuts it off. */
async function restartDuringWake(r, kind) {
  let need;
  if (kind === 'toolask') {
    const a = r.toolAsk();
    need = { kind, itemId: a.id };
  } else {
    const f = r.rt.addItem(r.t.id, { kind: 'agent', sessionId: r.alpha.id, handle: 'alpha', turnId: 'turn_last', text: '', status: 'failed', error: 'x' });
    need = { kind, itemId: f.id };
  }
  r.rt.updateSession(r.alpha.id, { needs: { ...need, text: kind }, state: kind === 'failed' ? 'failed' : 'needs' });
  r.adapter.next.push(held().step);
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Here are the numbers.' });
  await sleep(5);
  restart(r);
  return need;
}

for (const kind of ['toolask', 'failed'])
  test(`a restart during a turn that didn’t move on keeps a ${kind} need from the turn before, as main does`, async () => {
    const r = room();
    const need = await restartDuringWake(r, kind);
    const se = r.store.state.sessions[r.alpha.id];
    assert.equal(se.needs?.itemId, need.itemId);
    assert.equal(se.state, kind === 'failed' ? 'failed' : 'needs', 'a failed turn still shows Retry');
  });

test('a restart keeps a host turn’s permission as the need: its card stays open for the host to ask again', async () => {
  const r = room();
  r.adapter.next.push(held().step);
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await sleep(5);
  const p = r.permission();
  r.setNeed('permission', p.id);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store: r.store,
    adapters: new AdapterRegistry().register(r.adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  rt.remote.keepsCard = (it) => it.id === p.id; // its host keeps the prompt
  settleInterrupted(rt);
  assert.equal(r.store.state.sessions[r.alpha.id].needs?.itemId, p.id);
});

test('after a restart, a block the interrupted turn showed ranks ahead of a wake request that was the need', async () => {
  const r = room();
  const h = r.hop();
  r.setNeed('hop', h.id);
  r.adapter.next.push(async (c, _m, se) => {
    r.rt.addItem(r.t.id, {
      kind: 'block',
      sessionId: se.id,
      handle: 'alpha',
      turnId: r.rt.turns.get(se.id).id,
      valid: true,
      block: { id: 'b_rank', type: 'choice', version: 1, fallback: 'Pick', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] },
    });
    c.text('Pick one.');
    await new Promise(() => {});
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await sleep(5);
  assert.equal(r.needs()?.itemId, h.id, 'the wake request waits through the turn');
  restart(r);
  assert.equal(r.store.state.sessions[r.alpha.id].needs?.kind, 'block');
});

test('a refusal’s need saved before refusals stopped needing you is settled by a restart, so its ring doesn’t pulse', async () => {
  const r = room();
  const d = r.rt.addItem(r.t.id, { kind: 'denial', sessionId: r.alpha.id, handle: 'alpha', turnId: 'turn_last', summary: 'rm -rf build', status: 'open' });
  r.setNeed('denial', d.id);
  restart(r);
  const se = r.store.state.sessions[r.alpha.id];
  assert.equal(se.needs, null, 'no need for a refused call');
  assert.equal(se.state, 'idle');
  assert.equal(r.store.item(r.t.id, d.id).status, 'open', 'the card stays, as what happened');
});
