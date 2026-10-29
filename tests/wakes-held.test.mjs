// #439: while one wake card waited for the person, a wake that needed a second card was held on it, and allowing the
// card delivered it too, without its agent sending it again; not allowing it told its agent. Since #492 no limit raises
// a card, and no wake is held, but a card Postbox stored before then, open with wakes held on it, is still settled as
// it was: Allow delivers them, Don’t allow tells their agents, and a Stop or archive drops the ones held for that agent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup } from './side-threads-fixture.mjs';

const HANDOFF = 'Count the lines in work/*.txt and post the total.';

/** The fixture's room with @gamma, and a wake-limit card from @alpha to @beta as stored before #492, with gamma's hand-off to alpha held on it. */
function storedCard() {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  const card = f.rt.addItem(f.t.id, {
    kind: 'hop',
    fromSessionId: f.alpha.id,
    from: 'alpha',
    to: 'beta',
    text: 'alpha to beta',
    reason: 'alpha to beta',
    status: 'open',
    n: 11,
    held: [{ fromSessionId: gamma.id, from: 'gamma', to: 'alpha', text: HANDOFF, replyIn: null, fromTurnId: null, itemId: null, at: Date.now() }],
  });
  return { ...f, gamma, card };
}

const got = (f, handle, text) => f.adapter.calls.filter((c) => c.handle === handle && c.message?.text === text);

test('#439 allowing a stored card delivers the wakes held on it, as their agents sent them', async () => {
  const f = storedCard();
  f.rt.resolveHop(f.t.id, f.card.id, true);
  for (let i = 0; i < 20 && !got(f, 'alpha', HANDOFF).length; i++) await settle(f.rt);
  assert.equal(got(f, 'alpha', HANDOFF).length, 1, 'alpha gets gamma’s hand-off once, with no resend from gamma');
  assert.ok(got(f, 'beta', 'alpha to beta').length >= 1, 'the card’s own wake goes too');
});

test('#439 not allowing a stored card tells each held wake’s agent, and delivers nothing', async () => {
  const f = storedCard();
  f.rt.resolveHop(f.t.id, f.card.id, false);
  await settle(f.rt);
  assert.deepEqual(got(f, 'alpha', HANDOFF), []);
  const told = f.adapter.calls.filter((c) => c.handle === 'gamma' && c.message?.kind === 'notice').map((c) => c.message.text);
  assert.ok(
    told.some((l) => /didn’t go to @alpha/.test(l)),
    `gamma is told: ${told.join(' | ')}`,
  );
});

test('#439 stopping a held wake’s target drops it, so allowing the card doesn’t undo the Stop, and its agent is told', async () => {
  const f = storedCard();
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
  const f = storedCard();
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
