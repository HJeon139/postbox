// #883: a failed reply can be dismissed, not only retried. Dismiss marks it `dismissed` and keeps its status `failed`
// (so Retry still works), then releases its need as Retry does: the agent stops asking for the person, the error text
// stays, and nothing runs. Packet r1 (sprint4/883-packet-r1.md) with critic's answers: a second Dismiss is a quiet
// no-op, and a dismissed reply stops announcing itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { dismissFailed } from '../server/card-needs.mjs';
import { settleInterrupted } from '../server/restart-sweep.mjs';
import { Runtime } from '../server/runtime.mjs';
import { room } from './card-needs-fixture.mjs';
import { held, settle, sleep } from './side-threads-fixture.mjs';

/** A turn of @alpha's that fails; gives the room and the failed reply. */
async function failedTurn(r = room()) {
  r.adapter.next.push(async () => {
    throw new Error('API Error: Request rejected (429). Too many tokens, please wait.');
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await settle(r.rt);
  const failed = r.store.items(r.t.id).find((x) => x.kind === 'agent' && x.status === 'failed');
  assert.ok(failed, 'the turn failed');
  return { ...r, failed };
}

/** Counts the times the session's need is set, from now on. */
function countNeedSets(r) {
  const sets = [];
  const update = r.rt.updateSession.bind(r.rt);
  r.rt.updateSession = (id, patch) => {
    if (id === r.alpha.id && 'needs' in patch) sets.push(patch.needs?.kind ?? null);
    return update(id, patch);
  };
  return sets;
}

test('#883 Dismiss releases a failed reply’s need, keeps its error and status, and runs nothing', async () => {
  const r = await failedTurn();
  assert.equal(r.needs()?.kind, 'failed');
  const turnsBefore = r.adapter.next.length;
  dismissFailed(r.rt, r.t.id, r.failed.id);
  const it = r.store.items(r.t.id).find((x) => x.id === r.failed.id);
  assert.equal(it.status, 'failed', 'still failed, so Retry stays');
  assert.equal(it.dismissed, true);
  assert.equal(it.error, r.failed.error, 'the error text stays');
  assert.equal(r.needs(), null, 'the agent no longer asks for the person');
  assert.equal(r.store.state.sessions[r.alpha.id].state, 'idle');
  await sleep(5);
  assert.equal(r.rt.turns.size, 0, 'no turn started');
  assert.equal(r.adapter.next.length, turnsBefore);
});

test('#883 Dismiss hands the need to the card that waits behind the failure', async () => {
  const r = await failedTurn();
  const card = r.appCard();
  r.rt.needAppSend({ sessionId: r.alpha.id, title: 'App', threadId: r.t.id }, card.id, 1);
  assert.equal(r.needs()?.kind, 'failed', 'the app card waits behind the failure');
  dismissFailed(r.rt, r.t.id, r.failed.id);
  assert.equal(r.needs()?.kind, 'appsend');
  assert.equal(r.needs()?.itemId, card.id);
});

test('#883 Dismiss makes a block the failed turn itself showed the need, since no new turn starts to decide it', async () => {
  const r = await failedTurn();
  // A block from the failed turn: added with that turn's id, as a block it showed before it threw would be.
  const b = r.rt.addItem(r.t.id, {
    kind: 'block',
    sessionId: r.alpha.id,
    handle: 'alpha',
    turnId: r.failed.turnId,
    valid: true,
    block: { id: 'b_failed_turn', type: 'choice', version: 1, fallback: 'Pick', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] },
  });
  dismissFailed(r.rt, r.t.id, r.failed.id);
  assert.equal(r.needs()?.kind, 'block');
  assert.equal(r.needs()?.itemId, b.id);
});

test('#883 only a failed reply can be dismissed', async () => {
  const r = await failedTurn();
  const done = r.rt.addItem(r.t.id, { kind: 'agent', sessionId: r.alpha.id, handle: 'alpha', status: 'done', text: 'ok' });
  const b = r.block();
  for (const id of [done.id, b.id, 'it_missing'])
    assert.throws(
      () => dismissFailed(r.rt, r.t.id, id),
      (e) => e.status === 409,
      id,
    );
  assert.equal(r.needs()?.kind, 'failed', 'the failure is still the need');
});

test('#883 a second Dismiss is a quiet no-op: it changes nothing and releases nothing again', async () => {
  const r = await failedTurn();
  const sets = countNeedSets(r);
  dismissFailed(r.rt, r.t.id, r.failed.id);
  const after = r.store.items(r.t.id).find((x) => x.id === r.failed.id);
  const patches = [];
  const patch = r.rt.patchItem.bind(r.rt);
  r.rt.patchItem = (...a) => {
    patches.push(a);
    return patch(...a);
  };
  assert.doesNotThrow(() => dismissFailed(r.rt, r.t.id, r.failed.id));
  assert.deepEqual(patches, [], 'nothing written again');
  assert.deepEqual(
    r.store.items(r.t.id).find((x) => x.id === r.failed.id),
    after,
    'unchanged',
  );
  assert.equal(sets.length, 1, `the need was set once: ${JSON.stringify(sets)}`);
});

test('#883 Retry still works on a dismissed reply', async () => {
  const r = await failedTurn();
  dismissFailed(r.rt, r.t.id, r.failed.id);
  const work = held();
  r.adapter.next.push(work.step);
  await r.rt.retry(r.t.id, r.failed.id);
  await sleep(5);
  assert.equal(r.store.items(r.t.id).find((x) => x.id === r.failed.id).status, 'retried');
  assert.ok(r.rt.turns.has(r.alpha.id), 'the retried turn runs');
  work.release();
  await settle(r.rt);
});

test('#883 Dismiss after the person moved past the turn marks it, with nothing left to release', async () => {
  const r = await failedTurn();
  r.adapter.next.push(async (c) => c.text('All right.'));
  r.rt.sendMessage(r.t.id, { text: '@alpha never mind' });
  await settle(r.rt);
  assert.equal(r.needs(), null, 'moving past cleared it');
  const sets = countNeedSets(r);
  dismissFailed(r.rt, r.t.id, r.failed.id);
  assert.equal(r.store.items(r.t.id).find((x) => x.id === r.failed.id).dismissed, true);
  assert.deepEqual(sets, [], 'nothing to release');
});

test('#883 a dismissed reply stays dismissed after a restart, and is never the need again', async () => {
  const r = await failedTurn();
  dismissFailed(r.rt, r.t.id, r.failed.id);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store: r.store,
    adapters: new AdapterRegistry().register(r.adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  settleInterrupted(rt);
  assert.equal(r.store.items(r.t.id).find((x) => x.id === r.failed.id).dismissed, true);
  // An app card that becomes the need and is denied: its release must not fall back to the dismissed failure.
  const card = r.appCard();
  rt.needAppSend({ sessionId: r.alpha.id, title: 'App', threadId: r.t.id }, card.id, 1);
  assert.equal(r.store.state.sessions[r.alpha.id].needs?.kind, 'appsend');
  rt.resolveAppSend(r.t.id, card.id, 'deny');
  assert.equal(r.store.state.sessions[r.alpha.id].needs, null, 'not the dismissed failure');
});

test('#883 no agent tool can dismiss: it’s the person’s action only', async () => {
  const { TOOL_DEFS } = await import('../shared/mcp-tools.mjs');
  assert.ok(Array.isArray(TOOL_DEFS));
  assert.ok(!TOOL_DEFS.some((t) => /dismiss/i.test(t.name)), TOOL_DEFS.map((t) => t.name).join(' '));
});

test('#883 after a restart, a need left pointing at a dismissed reply isn’t kept: the sweep agrees with needOf', async () => {
  const r = await failedTurn();
  // As if a turn was running when Postbox stopped, with the need still naming the failure, which was then dismissed.
  r.store.emit('item.patch', { threadId: r.t.id, id: r.failed.id, patch: { dismissed: true } });
  r.rt.updateSession(r.alpha.id, { state: 'think', needs: { kind: 'failed', itemId: r.failed.id, text: 'x' } });
  settleInterrupted(r.rt);
  assert.notEqual(r.store.state.sessions[r.alpha.id].needs?.itemId, r.failed.id, 'not the dismissed failure');
});
