// #1928: a turn the person stops leaves its own asking block (#1748), tool request or view request (#1868) waiting
// quietly. Before, the stopped turn stayed the session’s last turn, whose cards count, so its card became the need
// again once another card was answered, a restart settled the needs, or another agent’s wake kept the turns before it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { settleInterrupted } from '../server/restart-sweep.mjs';
import { Runtime } from '../server/runtime.mjs';
import { askToSee } from '../server/view-app/consent.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import * as arrange from './arrange.mjs';
import { room } from './card-needs-fixture.mjs';
import { held, settle, sleep } from './side-threads-fixture.mjs';
import { until } from './stop-reply-fixture.mjs';

const form = {
  block: { id: 'f1', type: 'form', version: 1, title: 'Which window?', fallback: 'Which window?', fields: [{ id: 'w', label: 'Window', kind: 'text' }] },
};

/** What a turn shows that asks the person, by the kind of need it makes. */
const raisers = {
  block: (/** @type {any} */ _r, /** @type {any} */ tools) => tools.show_block(form),
  toolask: (/** @type {any} */ _r, /** @type {any} */ tools) => tools.ask_for_tool({ tool: 'shell', why: 'To run the tests.' }),
  viewask: (/** @type {any} */ r) => askToSee(r.rt, r.alpha.id, r.t.id, () => {}),
};

/** You start a turn of @alpha’s that raises a card of `kind`, which is its need, then holds until released. */
async function turnAsking(r, kind) {
  const work = held();
  r.adapter.next.push(async (c) => {
    await raisers[kind](r, c.tools);
    await work.step(c);
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await until(() => r.needs()?.kind === kind, `the ${kind} as the need`);
  return { card: r.needs(), release: work.release };
}

/** You stop @alpha’s turn (or Postbox does, by `opts.by`), and its stand-in harness exits, as a stopped CLI does. */
async function stopped(r, release, opts) {
  arrange.stopTurn(r.rt, r.alpha.id, opts);
  release();
  await until(() => !arrange.exiting(r.rt, r.alpha.id), 'the stopped turn to exit');
  await settle(r.rt);
}

/** A second runtime on the same store, as a restart makes one, and its sweep. */
function restart(r) {
  const rt = new Runtime({
    store: r.store,
    adapters: new AdapterRegistry().register(r.adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  settleInterrupted(rt);
  return rt;
}

/** The card is still open to answer. @param {any} r @param {string} itemId */
const stillOpen = (r, itemId) => {
  const it = r.rt.s.items[r.t.id].find((x) => x.id === itemId);
  return it && !it.answered && (it.status ?? 'open') === 'open';
};

for (const kind of Object.keys(raisers)) {
  test(`a stopped turn’s ${kind} stays quiet when another card of the agent’s is answered`, async () => {
    const r = room();
    const wake = r.hop();
    r.offerHop(wake);
    const { card, release } = await turnAsking(r, kind);
    await stopped(r, release);
    assert.equal(r.needs()?.itemId, wake.id, 'after Stop, the wake request is the need again');
    r.declineHop(wake);
    const se = r.rt.s.sessions[r.alpha.id];
    assert.equal(se.needs ?? null, null, 'the stopped turn’s card isn’t the need');
    assert.ok(!needsYouNow(se), 'the top bar doesn’t count it');
    assert.ok(stillOpen(r, card.itemId), 'the card is still there to answer');
  });
}

for (const kind of Object.keys(raisers)) {
  test(`a stopped turn’s ${kind} stays quiet after a restart settles the needs`, async () => {
    const r = room();
    const { card, release } = await turnAsking(r, kind);
    // Postbox stops before the stopped turn has exited: the restart finds the agent still stopping.
    arrange.stopTurn(r.rt, r.alpha.id);
    await sleep(5);
    restart(r);
    const se = r.store.state.sessions[r.alpha.id];
    assert.equal(se.needs ?? null, null, 'the stopped turn’s card isn’t the need');
    assert.ok(!needsYouNow(se), 'the top bar doesn’t count it');
    assert.ok(stillOpen(r, card.itemId), 'the card is still there to answer');
    release();
    await settle(r.rt);
  });
}

test('a stopped turn’s form stays quiet through another agent’s wake, which keeps the turns still asking', async () => {
  const r = room();
  const { release } = await turnAsking(r, 'block');
  await stopped(r, release);
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.turnService.run(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Here are the numbers.' }); // not you moving on
  await until(() => r.rt.turns.has(r.alpha.id), 'the woken turn');
  work.release();
  await settle(r.rt);
  const se = r.rt.s.sessions[r.alpha.id];
  assert.deepEqual(se.keptTurnIds ?? [], [], 'the wake kept no stopped turn');
  assert.equal(se.needs ?? null, null, 'the stopped turn’s form isn’t the need at the wake’s end');
});

test('you write again after Stop: the stopped turn’s form stays quiet and your turn’s own form is the need, as before #1928', async () => {
  const r = room();
  const first = await turnAsking(r, 'block');
  await stopped(r, first.release);
  const next = held();
  r.adapter.next.push(async (c) => {
    await c.tools.show_block({ block: { ...form.block, id: 'f2', title: 'Which region?', fallback: 'Which region?' } });
    await next.step(c);
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha try again' });
  await until(() => r.needs()?.text === 'Which region?', 'the new turn’s form as the need');
  next.release();
  await settle(r.rt);
  assert.equal(r.needs()?.text, 'Which region?', 'the new turn’s end keeps its own form');
  assert.ok(stillOpen(r, first.card.itemId), 'and the stopped turn’s form is still there to answer');
});

test('answering the stopped turn’s form itself works and leaves the other need as it was', async () => {
  const r = room();
  const wake = r.hop();
  r.offerHop(wake);
  const { card, release } = await turnAsking(r, 'block');
  await stopped(r, release);
  await r.rt.act(r.t.id, card.itemId, 'submit', { w: '30 days' });
  assert.ok(r.rt.s.items[r.t.id].find((x) => x.id === card.itemId)?.answered, 'the form is answered');
  assert.equal(r.needs()?.itemId, wake.id, 'the wake request is still the need');
  await settle(r.rt);
  assert.equal(r.needs()?.itemId, wake.id, 'and after the turn the answer started');
});

// Only the Stop button quiets a turn’s cards: a run clock’s stop, its pause or its budget (server/run-clock.mjs), leaves
// the need the form made, so the form counts through the stop and after another card is answered, never going quiet
// and then ringing again (#1928).
for (const by of ['pause', 'clock']) {
  test(`a turn a run clock stopped (${by}) keeps its form the need through the stop and another answer`, async () => {
    const r = room();
    const wake = r.hop();
    r.offerHop(wake);
    const { card, release } = await turnAsking(r, 'block');
    await stopped(r, release, { by, silent: true });
    assert.equal(r.needs()?.itemId, card.itemId, 'after the clock’s stop, the form is still the need');
    r.declineHop(wake);
    assert.equal(r.needs()?.itemId, card.itemId, 'and after the wake request is declined');
  });
}
