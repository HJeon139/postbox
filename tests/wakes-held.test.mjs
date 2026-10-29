// #439: while one wake card waits for the person, a wake that needs a second card is held on it, not dropped. Allowing
// the card delivers it too, without its agent sending it again; not allowing it tells its agent. The hold names the card,
// and a held wake is recorded and posted only when it's delivered, which the hostwakes UAT's checks rely on (#451).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOP_LIMIT } from '../shared/limits.mjs';
import { TOOL_ROUTES } from '../shared/remote-protocol.mjs';
import { held, settle, setup } from './side-threads-fixture.mjs';

/**
 * The fixture's room with @gamma, and a card from @alpha's wake of @beta past the chain limit (HOP_LIMIT), left open.
 * While it waits the count stays at the limit, so any other agent's wake needs a card too. Until #492 this was the
 * pair limit's card, after a hand-off and its answer.
 */
async function cardOpen() {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  const wake = async (from, to, text = `${from.handle} to ${to}`) => {
    const r = f.rt.agentWake(from.id, to, text);
    await settle(f.rt);
    return r;
  };
  // All while the chain runs: one that ends starts the count again (#492).
  for (let i = 0; i < HOP_LIMIT; i++) f.rt.agentWake(...(i % 2 ? [f.beta.id, 'alpha'] : [f.alpha.id, 'beta']), `hand-off ${i + 1}`);
  assert.equal((await wake(f.alpha, 'beta')).waiting, true, 'the wake past the chain limit raised the card');
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  return { ...f, gamma, wake, card };
}

const HANDOFF = 'Count the lines in work/*.txt and post the total.';
const got = (f, handle, text) => f.adapter.calls.filter((c) => c.handle === handle && c.message?.text === text);
const posted = (f, handle, text) => f.store.items(f.t.id).filter((x) => x.kind === 'agent' && x.handle === handle && x.text === text);
const received = (f, se, from, text) =>
  (f.store.state.sessions[se.id].agentMessages ?? []).filter((m) => m.dir === 'from' && m.other === from && m.text === text);

test('#439 a wake that needs a second card while one waits is held, and delivered when the person allows the card', async () => {
  const f = await cardOpen();
  const r = await f.wake(f.gamma, 'alpha', HANDOFF);
  assert.equal(r.waiting, true, 'held, not refused');
  // Held: nothing reaches alpha, and nothing says it did, until the person answers (#451's checks read both).
  assert.deepEqual(got(f, 'alpha', HANDOFF), []);
  assert.deepEqual(posted(f, 'gamma', HANDOFF), []);
  assert.deepEqual(received(f, f.alpha, 'gamma', HANDOFF), []);
  assert.equal(f.store.items(f.t.id).filter((x) => x.kind === 'hop').length, 1, 'it waits on the open card, not a card of its own');
  f.rt.resolveHop(f.t.id, f.card.id, true);
  await settle(f.rt);
  assert.equal(got(f, 'alpha', HANDOFF).length, 1, 'alpha gets gamma’s hand-off once, with no resend from gamma');
  assert.equal(posted(f, 'gamma', HANDOFF).length, 1);
  assert.equal(received(f, f.alpha, 'gamma', HANDOFF).length, 1);
  assert.equal(got(f, 'beta', 'alpha to beta').length >= 1, true, 'the card’s own wake goes too');
});

test('#439 the hold names the waiting card: who it’s between, and that it waits for the person', async () => {
  const f = await cardOpen();
  const r = await f.wake(f.gamma, 'alpha', HANDOFF);
  assert.match(r.message, /@alpha’s request to wake @beta/);
  assert.match(r.message, /waiting for the person/);
  assert.match(r.message, /don’t send it again/i);
});

test('#439 not allowing the card tells each held wake’s agent, and delivers nothing', async () => {
  const f = await cardOpen();
  await f.wake(f.gamma, 'alpha', HANDOFF);
  f.rt.resolveHop(f.t.id, f.card.id, false);
  await settle(f.rt);
  assert.deepEqual(got(f, 'alpha', HANDOFF), []);
  assert.deepEqual(posted(f, 'gamma', HANDOFF), []);
  const told = f.adapter.calls.filter((c) => c.handle === 'gamma' && c.message?.kind === 'notice').map((c) => c.message.text);
  assert.ok(
    told.some((l) => /didn’t go to @alpha/.test(l)),
    `gamma is told: ${told.join(' | ')}`,
  );
});

test('#439 an agent on a host waits for Postbox’s answer to wake_agent, so it hears of a hold as the call’s result', () => {
  // A queued route answers at once with “Sent your message…”, whatever Postbox does with it.
  assert.equal(TOOL_ROUTES.wake_agent, 'ask');
});

test('#439 a card whose target you write to is retired, and its own wake and the wakes held on it go on', async () => {
  const f = await cardOpen();
  await f.wake(f.gamma, 'alpha', HANDOFF);
  // The person writes to the card's target, beta, which then has a turn without the card.
  f.rt.sendMessage(f.t.id, { text: '@beta the review is done, thanks' });
  // The card’s wake waits for beta’s turn on your message to end, and settle can return in the gap between the two.
  const toBeta = () => f.adapter.calls.filter((c) => c.handle === 'beta').map((c) => `${c.message?.from ?? 'you'}: ${c.message?.text}`);
  const yours = () => toBeta().findIndex((x) => /the review is done/.test(x));
  const after = () =>
    yours() >= 0 &&
    toBeta()
      .slice(yours() + 1)
      .some((x) => x.startsWith('@alpha'));
  for (let i = 0; i < 20 && !after(); i++) await settle(f.rt);
  assert.equal(f.store.item(f.t.id, f.card.id).status, 'retired');
  assert.ok(Number.isFinite(f.store.item(f.t.id, f.card.id).retiredAt), 'it says when, for the hostwakes checks (#451)');
  // Your message goes first, and the card’s own wake reaches beta after it: the wake you never allowed doesn’t go
  // ahead. It carries alpha’s latest post by then, as a queued wake does (#374).
  assert.ok(yours() > 0, `beta’s turns, in order: ${toBeta().join(' | ')}`);
  assert.ok(after(), `beta’s turns, in order: ${toBeta().join(' | ')}`);
  assert.equal(got(f, 'alpha', HANDOFF).length, 1, 'gamma’s held hand-off goes on to alpha');
  assert.equal(f.store.items(f.t.id).filter((x) => x.kind === 'hop' && x.status === 'open').length, 0, 'your message started the counts again');
});

test('#439 a card another agent’s wake retires keeps its own hand-off: it goes back through the limits', async () => {
  const f = await cardOpen();
  // You write to gamma, not the card's target, which starts the counts again; gamma's wake of beta is then under the
  // limit, so it goes, and beta has a turn without the card.
  f.rt.sendMessage(f.t.id, { text: '@gamma tell beta the line count' });
  await settle(f.rt);
  assert.equal(f.store.item(f.t.id, f.card.id).status, 'open', 'writing to another agent leaves the card');
  await f.wake(f.gamma, 'beta', 'the line count is 42');
  assert.equal(f.store.item(f.t.id, f.card.id).status, 'retired');
  // alpha's hand-off goes back through the limits, which it's now under, so it reaches beta rather than vanishing.
  for (let i = 0; i < 20 && got(f, 'beta', 'alpha to beta').length < 1; i++) await settle(f.rt);
  assert.equal(got(f, 'beta', 'alpha to beta').length, 1);
  assert.equal(f.store.items(f.t.id).filter((x) => x.kind === 'hop' && x.status === 'open').length, 0);
});

test('#439 stopping the held wake’s target drops it, so allowing the card doesn’t undo the Stop, and its agent is told', async () => {
  const f = await cardOpen();
  await f.wake(f.gamma, 'alpha', HANDOFF);
  // alpha is working when the person stops it.
  const h = held();
  f.adapter.next.push(h.step);
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'carry on' });
  await new Promise((r) => setTimeout(r, 5));
  f.rt.stop(f.alpha.id);
  h.release();
  await settle(f.rt);
  f.rt.resolveHop(f.t.id, f.card.id, true);
  await settle(f.rt);
  assert.deepEqual(got(f, 'alpha', HANDOFF), [], 'the Stop holds');
  const told = f.store.state.sessions[f.gamma.id].context ?? [];
  assert.ok(
    told.some((l) => /@alpha was stopped before your message held for it/.test(l)),
    `gamma is told: ${told.join(' | ')}`,
  );
});

test('#439 a held wake whose target was archived tells its agent it didn’t go when the card is allowed', async () => {
  const f = await cardOpen();
  await f.wake(f.gamma, 'alpha', HANDOFF);
  f.rt.archive(f.alpha.id);
  await settle(f.rt);
  f.rt.resolveHop(f.t.id, f.card.id, true);
  await settle(f.rt);
  assert.deepEqual(got(f, 'alpha', HANDOFF), []);
  const told = f.store.state.sessions[f.gamma.id].context ?? [];
  assert.ok(
    told.some((l) => /@alpha was archived before your message held for it/.test(l)),
    `gamma is told: ${told.join(' | ')}`,
  );
});
