// A1b (#711, designs/508/a1b-asks.md): every place that chooses between two of an agent’s cards ranks them the same
// way, rank then time, with ties to the challenger. `offerNeed` no longer lets an older card of the same rank take the
// need while the current need’s card still waits, and still lets it past a need whose card no longer waits (R8).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextNeed, offerNeed } from '../server/card-needs.mjs';
import { settledNeed } from '../server/restart-sweep.mjs';
import { settleOrphanTurns } from '../server/store-outage.mjs';
import { room } from './card-needs-fixture.mjs';
import { oldSide } from './side-threads-fixture.mjs';

const T0 = 1_000_000;

/** A permission card of @alpha's at a fixed time; `waits` puts it in permissionWaits, as its ask or waitOn does. */
function permissionAt(r, at, { waits = true, host = false } = {}) {
  const remote = host ? { remote: { hostId: 'h1', turn: 'turn_host', prompt: `p${at}` } } : {};
  const it = r.rt.addItem(r.t.id, { kind: 'permission', sessionId: r.alpha.id, handle: 'alpha', summary: `run ${at}`, status: 'open', at, ...remote });
  if (waits) waitOnCard(r, it);
  return it;
}

/** What waitOn does first: the card is waited on again. */
function waitOnCard(r, it) {
  r.rt.permissionWaits.set(it.id, { threadId: r.t.id, sessionId: r.alpha.id, timer: null, resolve: () => {} });
}

const hopAt = (r, at) => r.rt.addItem(r.t.id, { kind: 'hop', fromSessionId: r.alpha.id, from: 'alpha', to: 'beta', status: 'open', text: 'please', at });

const appAt = (r, at, threadId = r.t.id) =>
  r.rt.addItem(threadId, { kind: 'appsend', sessionId: r.alpha.id, appId: 'app1', title: 'App', events: [{ action: 'x' }], status: 'open', at });

const CARDS = { permission: permissionAt, hop: hopAt, appsend: appAt };

/** The need a card makes, as its caller offers it. */
function needFor(it) {
  if (it.kind === 'permission') return { kind: 'permission', itemId: it.id, text: `@alpha asks to ${it.summary}` };
  if (it.kind === 'hop') return { kind: 'hop', itemId: it.id, text: '@alpha wants to wake @beta' };
  return { kind: 'appsend', itemId: it.id, text: 'App wants to send 1 message for you' };
}

const session = (r) => r.rt.s.sessions[r.alpha.id];
const setNeedTo = (r, it) => r.rt.updateSession(r.alpha.id, { needs: needFor(it), state: 'needs' });
/** Offered as waitOn (remote/turns-prompts.mjs) and the other callers offer: the card's need, in the conversation. */
const offer = (r, it) => offerNeed(r.rt, session(r), needFor(it), 'needs');

/** The need, by what each spec asserts: its card, its kind and its thread. */
const shape = (need) => ({ itemId: need?.itemId, kind: need?.kind, threadId: need?.threadId });
const needIs = (r, it, threadId = undefined, why = undefined) => assert.deepEqual(shape(r.needs()), { itemId: it.id, kind: it.kind, threadId }, why);

test('waitOn offering an older permission doesn’t take the need from a newer one its host waits on again', () => {
  const r = room();
  const older = permissionAt(r, T0, { host: true });
  const newer = permissionAt(r, T0 + 1000, { host: true });
  setNeedTo(r, newer);
  assert.equal(offer(r, older), false);
  needIs(r, newer, undefined, 'the newer card stays the need');
});

test('waitOn offering an older permission takes the need once the newer one was answered', () => {
  const r = room();
  const older = permissionAt(r, T0, { host: true, waits: false });
  const newer = permissionAt(r, T0 + 1000, { host: true });
  setNeedTo(r, newer);
  r.rt.resolvePermission(r.t.id, newer.id, 'allow');
  assert.equal(r.needs(), null, 'nothing else waits yet: the older card isn’t waited on again');
  waitOnCard(r, older);
  assert.equal(offer(r, older), true);
  needIs(r, older);
});

test('answering the newer permission falls back to the older one waitOn offered', () => {
  const r = room();
  const older = permissionAt(r, T0, { host: true });
  const newer = permissionAt(r, T0 + 1000, { host: true });
  setNeedTo(r, newer);
  offer(r, older);
  r.rt.resolvePermission(r.t.id, newer.id, 'allow');
  needIs(r, older, undefined, 'nextNeed finds the older card that still waits');
});

test('a side thread’s app card takes the need from an older hop, and its need names the side thread', () => {
  const r = room();
  const side = oldSide(r);
  const hop = hopAt(r, T0);
  setNeedTo(r, hop);
  const card = appAt(r, T0 + 1000, side.id);
  r.rt.needAppSend({ sessionId: r.alpha.id, title: 'App', threadId: side.id }, card.id, 1);
  needIs(r, card, side.id);
});

test('an app card that is the need, sent again, updates the need’s count', () => {
  const r = room();
  const card = appAt(r, T0);
  const app = { sessionId: r.alpha.id, title: 'App', threadId: r.t.id };
  r.rt.needAppSend(app, card.id, 1);
  r.rt.needAppSend(app, card.id, 3);
  needIs(r, card);
  assert.equal(r.needs().text, 'App wants to send 3 messages for you');
});

test('a permission that is the need stays when a newer hop is offered', () => {
  const r = room();
  const permission = permissionAt(r, T0);
  setNeedTo(r, permission);
  assert.equal(offer(r, hopAt(r, T0 + 1000)), false);
  needIs(r, permission);
});

test('a permission need whose card no longer waits still keeps a newer hop out: R8 is for equal rank only', () => {
  const r = room();
  const permission = permissionAt(r, T0, { host: true, waits: false });
  setNeedTo(r, permission);
  assert.equal(offer(r, hopAt(r, T0 + 1000)), false);
  needIs(r, permission);
});

test('after a restart, an older permission takes the need from a newer one its host forgot, as nextNeed chooses', () => {
  const r = room();
  const older = permissionAt(r, T0, { host: true, waits: false });
  const newer = permissionAt(r, T0 + 1000, { host: true, waits: false });
  setNeedTo(r, newer); // kept by the restart sweep, not waited on again
  waitOnCard(r, older);
  assert.equal(offer(r, older), true);
  needIs(r, older, undefined, 'the live permission is flagged, not the dead one');
  assert.deepEqual(shape(nextNeed(r.rt, session(r))), shape(r.needs()), 'nextNeed agrees');
});

test('after a restart, the newer permission waited on again takes the need back from the older one', () => {
  const r = room();
  const older = permissionAt(r, T0, { host: true, waits: false });
  const newer = permissionAt(r, T0 + 1000, { host: true, waits: false });
  setNeedTo(r, newer);
  waitOnCard(r, older);
  offer(r, older);
  waitOnCard(r, newer);
  assert.equal(offer(r, newer), true);
  needIs(r, newer);
});

test('a laptop permission that waits stays the need when an older permission is offered', () => {
  const r = room();
  const older = permissionAt(r, T0);
  const newer = permissionAt(r, T0 + 1000);
  setNeedTo(r, newer);
  assert.equal(offer(r, older), false);
  needIs(r, newer);
});

test('a card offered when the need’s card is gone from pending is decided by rank alone', () => {
  const r = room();
  r.rt.updateSession(r.alpha.id, { needs: { kind: 'hop', itemId: 'it_gone', text: 'gone' }, state: 'needs' });
  const card = appAt(r, T0);
  assert.equal(offer(r, card), true);
  needIs(r, card);
});

test('a need of a kind RANK doesn’t list is never replaced', () => {
  const r = room();
  const old = hopAt(r, T0);
  r.rt.updateSession(r.alpha.id, { needs: { kind: 'mystery', itemId: old.id, text: 'mystery' }, state: 'needs' });
  assert.equal(offer(r, permissionAt(r, T0 + 1000)), false);
  assert.deepEqual(shape(r.needs()), { itemId: old.id, kind: 'mystery', threadId: undefined });
});

// Two cards in one thread, read in this order: `nextNeed` reads the second later, so it is the challenger; `offerNeed`
// is offered the second with the first as the need; `settledNeed` has the first as the need and nextNeed's as `next`.
// The winner is the same for all three: the lower rank, else the second unless it is older (ties to the second).
const PAIRS = [
  ['hop', T0, 'appsend', T0 + 1000, 'second'],
  ['hop', T0 + 1000, 'appsend', T0, 'first'],
  ['hop', T0, 'appsend', T0, 'second'],
  ['appsend', T0, 'hop', T0, 'second'],
  ['appsend', T0 + 1000, 'hop', T0, 'first'],
  ['permission', T0, 'permission', T0 + 1000, 'second'],
  ['permission', T0 + 1000, 'permission', T0, 'first'],
  ['permission', T0, 'permission', T0, 'second'],
  ['permission', T0, 'hop', T0 + 1000, 'first'],
  ['hop', T0, 'permission', T0 - 500, 'second'],
  ['appsend', T0 + 1000, 'permission', T0, 'second'],
];

/** The two cards of a pair, added in read order, and the one that should win. */
function pair(r, [firstKind, firstAt, secondKind, secondAt, winner]) {
  const first = CARDS[firstKind](r, firstAt);
  const second = CARDS[secondKind](r, secondAt);
  return { first, second, won: winner === 'first' ? first : second };
}

for (const row of PAIRS) {
  const name = `${row[0]}@${row[1] - T0} then ${row[2]}@${row[3] - T0}`;
  test(`one comparison: nextNeed, settledNeed and offerNeed agree on ${name}`, () => {
    const read = room();
    const read1 = pair(read, row);
    assert.deepEqual(shape(nextNeed(read.rt, session(read))), shape(needFor(read1.won)), 'nextNeed');

    const settled = room();
    const settled1 = pair(settled, row);
    setNeedTo(settled, settled1.first);
    assert.deepEqual(shape(settledNeed(settled.rt, session(settled)).needs), shape(needFor(settled1.won)), 'settledNeed');

    const offered = room();
    const offered1 = pair(offered, row);
    setNeedTo(offered, offered1.first);
    offer(offered, offered1.second);
    needIs(offered, offered1.won, undefined, 'offerNeed');
  });
}

test('one comparison: a Retry’s reset after a store outage keeps the newer card, and the later one on a tie', () => {
  for (const [firstAt, secondAt, winner] of [
    [T0 + 1000, T0, 'first'],
    [T0, T0, 'second'],
  ]) {
    const r = room();
    const { first, won } = pair(r, ['hop', firstAt, 'appsend', secondAt, winner]);
    r.rt.updateSession(r.alpha.id, { needs: needFor(first), state: 'gen' }); // mid-turn, with no turn running
    settleOrphanTurns(r.rt);
    needIs(r, won);
  }
});

test('one comparison: the restart keeps a block from an older turn against a newer one only when it isn’t older', () => {
  for (const [keptAt, nextAt, winner] of [
    [T0 + 1000, T0, 'kept'],
    [T0, T0 + 1000, 'next'],
    [T0, T0, 'next'],
  ]) {
    const r = room();
    const kept = r.block('turn_old');
    const next = r.block('turn_last');
    r.rt.patchItem(r.t.id, kept.id, { at: keptAt });
    r.rt.patchItem(r.t.id, next.id, { at: nextAt });
    r.rt.updateSession(r.alpha.id, { needs: { kind: 'block', itemId: kept.id, text: 'Pick' }, state: 'needs' });
    const won = winner === 'kept' ? kept : next;
    assert.deepEqual(shape(settledNeed(r.rt, session(r)).needs), { itemId: won.id, kind: 'block', threadId: undefined }, `${keptAt - T0} vs ${nextAt - T0}`);
  }
});
