// A failed turn's need (#366; the integrator's re-review of #633 at 289bf2da): Retry is what you owe the agent, so no
// card that opens after it takes the need, and the failed turn is the last turn, so a block you moved past stays quiet.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { room } from './card-needs-fixture.mjs';
import { held, settle, sleep } from './side-threads-fixture.mjs';

/** Block B is the need; you send a message, and that turn fails. */
async function failedAfterBlock() {
  const r = room();
  const b = r.block(); // open, from turn_last
  r.setNeed('block', b.id);
  r.adapter.next.push(async () => {
    throw new Error('the model went away');
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await settle(r.rt);
  return { ...r, b };
}

test('the integrator’s probe: an app card that opens after a failed turn, then is denied, leaves the need on the failure', async () => {
  const r = await failedAfterBlock();
  assert.equal(r.needs()?.kind, 'failed', 'the failed turn is the need');
  const card = r.appCard();
  r.rt.needAppSend({ sessionId: r.alpha.id, title: 'App', threadId: r.t.id }, card.id, 1);
  assert.equal(r.needs()?.kind, 'failed', 'the app card waits behind Retry');
  r.rt.resolveAppSend(r.t.id, card.id, 'deny');
  assert.equal(r.needs()?.kind, 'failed', 'and the block you moved past doesn’t come back');
});

test('a failed turn is the last turn: its id is recorded on the session', async () => {
  const r = await failedAfterBlock();
  const failed = r.store.items(r.t.id).find((x) => x.kind === 'agent' && x.status === 'failed');
  assert.ok(failed?.turnId);
  assert.equal(r.store.state.sessions[r.alpha.id].lastTurnId, failed.turnId);
});

test('Retry clears the failure without the block you moved past flashing as the need', async () => {
  const r = await failedAfterBlock();
  const failed = r.store.items(r.t.id).find((x) => x.kind === 'agent' && x.status === 'failed');
  const kinds = [];
  const update = r.rt.updateSession.bind(r.rt);
  r.rt.updateSession = (id, patch) => {
    if (id === r.alpha.id && 'needs' in patch) kinds.push(patch.needs?.kind ?? null);
    return update(id, patch);
  };
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.retry(r.t.id, failed.id);
  await sleep(5);
  work.release();
  await settle(r.rt);
  assert.ok(!kinds.includes('block'), `the needs Retry set: ${JSON.stringify(kinds)}`);
});

test('Retry doesn’t flash a block the failed turn showed before it threw', async () => {
  const r = room();
  r.adapter.next.push(async (_c, _m, se) => {
    r.rt.addItem(r.t.id, {
      kind: 'block',
      sessionId: se.id,
      handle: 'alpha',
      turnId: r.rt.turns.get(se.id).id,
      valid: true,
      block: { id: 'b_mid', type: 'choice', version: 1, fallback: 'Pick', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] },
    });
    throw new Error('the model went away');
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await settle(r.rt);
  assert.equal(r.needs()?.kind, 'failed');
  const failed = r.store.items(r.t.id).find((x) => x.kind === 'agent' && x.status === 'failed');
  const kinds = [];
  const update = r.rt.updateSession.bind(r.rt);
  r.rt.updateSession = (id, patch) => {
    if (id === r.alpha.id && 'needs' in patch) kinds.push(patch.needs?.kind ?? null);
    return update(id, patch);
  };
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.retry(r.t.id, failed.id);
  await sleep(5);
  work.release();
  await settle(r.rt);
  assert.ok(!kinds.includes('block'), `the needs Retry set: ${JSON.stringify(kinds)}`);
});
