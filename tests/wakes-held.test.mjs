// #439: while one add card waits for the person, a wake that needs a second card is held on it, not dropped. Allowing
// the card delivers it too, without its agent sending it again; not allowing it tells its agent. The hold names the card,
// and a held wake is recorded and posted only when it's delivered, which the hostwakes UAT's checks rely on (#451).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_ROUTES } from '../shared/remote-protocol.mjs';
import * as arrange from './arrange.mjs';
import { held, settle, setup } from './side-threads-fixture.mjs';

/**
 * The fixture's room, and the card from @alpha's wake of @gamma, which the conversation doesn't have (#228), left open.
 * While it waits, a wake that needs a card too is held on it. Until #1623 this was the card past the room's chain limit,
 * which nothing raises now (tests/chain-stop.test.mjs).
 */
async function cardOpen() {
  const f = setup();
  const wake = async (from, to, text = `${from.handle} to ${to}`) => {
    const r = f.rt.agentWake(from.id, to, text);
    await settle(f.rt);
    return r;
  };
  assert.equal((await wake(f.alpha, 'gamma')).waiting, true, 'the wake of an agent the conversation doesn’t have raised the card');
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  return { ...f, wake, card };
}
/** The person adds @gamma themselves while the card waits, with its turn on their message held open. */
async function personAddsGamma(f) {
  const h = held();
  f.adapter.next.push(h.step);
  f.rt.sendMessage(f.t.id, { text: '@gamma carry on' });
  await new Promise((r) => setTimeout(r, 5));
  const gamma = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.handle === 'gamma');
  return { gamma, h };
}

const HANDOFF = 'Count the lines in work/*.txt and post the total.';
const got = (f, handle, text) => f.adapter.calls.filter((c) => c.handle === handle && c.parts.some((m) => m.text === text));
const posted = (f, handle, text) => f.store.items(f.t.id).filter((x) => x.kind === 'agent' && x.handle === handle && x.text === text);
const received = (f, se, from, text) =>
  (f.store.state.sessions[se.id].agentMessages ?? []).filter((m) => m.dir === 'from' && m.other === from && m.text === text);

test('#439 a wake that needs a second card while one waits is held, and delivered when the person allows the card', async () => {
  const f = await cardOpen();
  const r = await f.wake(f.beta, 'gamma', HANDOFF);
  assert.equal(r.waiting, true, 'held, not refused');
  // Held: nothing reaches gamma, and nothing says it did, until the person answers (#451's checks read both).
  assert.deepEqual(got(f, 'gamma', HANDOFF), []);
  assert.deepEqual(posted(f, 'beta', HANDOFF), []);
  assert.equal(f.store.items(f.t.id).filter((x) => x.kind === 'hop').length, 1, 'it waits on the open card, not a card of its own');
  f.rt.resolveHop(f.t.id, f.card.id, true);
  await settle(f.rt);
  const gamma = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.handle === 'gamma');
  assert.equal(got(f, 'gamma', HANDOFF).length, 1, 'gamma gets beta’s hand-off once, with no resend from beta');
  assert.equal(posted(f, 'beta', HANDOFF).length, 1);
  assert.equal(received(f, gamma, 'beta', HANDOFF).length, 1);
  assert.equal(got(f, 'gamma', 'alpha to gamma').length >= 1, true, 'the card’s own wake goes too');
});

test('#439 the hold names the waiting card: who it’s between, and that it waits for the person', async () => {
  const f = await cardOpen();
  const r = await f.wake(f.beta, 'gamma', HANDOFF);
  assert.match(r.message, /@alpha’s request to add @gamma/);
  assert.match(r.message, /waiting for the person/);
  assert.match(r.message, /don’t send it again/i);
});

test('#439 not allowing the card tells each held wake’s agent, and delivers nothing', async () => {
  const f = await cardOpen();
  await f.wake(f.beta, 'gamma', HANDOFF);
  f.rt.resolveHop(f.t.id, f.card.id, false);
  await settle(f.rt);
  assert.deepEqual(got(f, 'gamma', HANDOFF), []);
  assert.deepEqual(posted(f, 'beta', HANDOFF), []);
  const told = f.adapter.calls.filter((c) => c.handle === 'beta' && c.message?.kind === 'notice').map((c) => c.parts[0].text);
  assert.ok(
    told.some((l) => /didn’t go to @gamma/.test(l)),
    `beta is told: ${told.join(' | ')}`,
  );
});

test('#439 an agent on a host waits for Postbox’s answer to wake_agent, so it hears of a hold as the call’s result', () => {
  // A queued route answers at once with “Sent your message…”, whatever Postbox does with it.
  assert.equal(TOOL_ROUTES.wake_agent, 'ask');
});

test('#439 stopping the held wake’s target drops it, so allowing the card doesn’t undo the Stop, and its agent is told', async () => {
  const f = await cardOpen();
  await f.wake(f.beta, 'gamma', HANDOFF);
  const { gamma, h } = await personAddsGamma(f);
  f.rt.stop(gamma.id);
  h.release();
  await settle(f.rt);
  f.rt.resolveHop(f.t.id, f.card.id, true);
  await settle(f.rt);
  assert.deepEqual(got(f, 'gamma', HANDOFF), [], 'the Stop holds');
  const told = f.store.state.sessions[f.beta.id].context ?? [];
  assert.ok(
    told.some((l) => /@gamma was stopped before your message held for it/.test(l)),
    `beta is told: ${told.join(' | ')}`,
  );
});

test('#439 a held wake whose target was removed tells its agent it didn’t go when the card is allowed', async () => {
  const f = await cardOpen();
  await f.wake(f.beta, 'gamma', HANDOFF);
  const { gamma, h } = await personAddsGamma(f);
  h.release();
  await settle(f.rt);
  f.rt.deleteSession(gamma.id);
  await settle(f.rt);
  f.rt.resolveHop(f.t.id, f.card.id, true);
  await settle(f.rt);
  assert.deepEqual(got(f, 'gamma', HANDOFF), []);
  const told = f.store.state.sessions[f.beta.id].context ?? [];
  assert.ok(
    told.some((l) => /@gamma was removed before your message held for it/.test(l)),
    `beta is told: ${told.join(' | ')}`,
  );
});

test('#517 allowing the card tells each held wake’s agent its message went, so it stops reporting it as waiting', async () => {
  const f = await cardOpen();
  await f.wake(f.beta, 'gamma', HANDOFF);
  f.rt.resolveHop(f.t.id, f.card.id, true);
  await settle(f.rt);
  // beta’s next turn, on gamma’s answer, carries the note as its context.
  const told = f.adapter.calls.filter((c) => c.handle === 'beta').flatMap((c) => c.message?.context ?? []);
  assert.ok(
    told.some((l) => /Your message to @gamma \(“Count the lines.*”\), held on @alpha’s request to add @gamma.*, went: the person allowed it\./.test(l)),
    `beta is told: ${told.join(' | ')}`,
  );
});
