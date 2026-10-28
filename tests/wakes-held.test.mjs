// #439: while one wake card waits for the person, a wake that needs a second card is held on it, not dropped. Allowing
// the card delivers it too, without its agent sending it again; not allowing it tells its agent. The hold names the card,
// and a held wake is recorded and posted only when it's delivered, which the hostwakes UAT's checks rely on (#451).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_ROUTES } from '../shared/remote-protocol.mjs';
import { held, settle, setup } from './side-threads-fixture.mjs';

/** The fixture's room with @gamma, and a pair card from @alpha's third wake of @beta in a row, left open. */
async function cardOpen() {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  const wake = async (from, to, text = `${from.handle} to ${to}`) => {
    const r = f.rt.agentWake(from.id, to, text);
    await settle(f.rt);
    return r;
  };
  await wake(f.alpha, 'beta');
  await wake(f.beta, 'alpha');
  assert.equal((await wake(f.alpha, 'beta')).waiting, true, 'the third wake in a row raised the card');
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop' && x.status === 'open');
  // gamma and alpha reach their own pair's limit while the card waits: gamma's hand-off needs a second card.
  await wake(gamma, 'alpha');
  await wake(f.alpha, 'gamma');
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

test('#439 a card whose target got a turn another way is retired, its agent told, and the wakes held on it go on', async () => {
  const f = await cardOpen();
  await f.wake(f.gamma, 'alpha', HANDOFF);
  // The person writes to the card's target, beta, which then has a turn without the card.
  f.rt.sendMessage(f.t.id, { text: '@beta the review is done, thanks' });
  await settle(f.rt);
  assert.equal(f.store.item(f.t.id, f.card.id).status, 'retired');
  assert.deepEqual(got(f, 'beta', 'alpha to beta').length, 1, 'only the first wake of beta; the card’s own isn’t sent');
  // Told at its next turn: here, the one gamma’s held hand-off starts, so the note comes with that message.
  const told = [
    ...(f.store.state.sessions[f.alpha.id].context ?? []),
    ...f.adapter.calls.filter((c) => c.handle === 'alpha').flatMap((c) => c.message?.context ?? []),
  ].map(String);
  assert.ok(
    told.some((l) => /@beta got a turn another way/.test(l)),
    `alpha is told: ${told.join(' | ')}`,
  );
  assert.equal(got(f, 'alpha', HANDOFF).length, 1, 'gamma’s held hand-off goes on to alpha');
});

test('#439 another agent’s wake that reaches the card’s target retires the card too', async () => {
  const f = await cardOpen();
  // gamma’s first wake of beta is under its own limits, so it goes, and beta has a turn without the card.
  await f.wake(f.gamma, 'beta', 'the line count is 42');
  assert.equal(f.store.item(f.t.id, f.card.id).status, 'retired');
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
