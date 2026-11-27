// #1623: the wake chain’s cap is a loop guard, not a feature. At HOP_LIMIT wakes in a row without the person, the next
// wake doesn’t go: no card, no need and no notification, one line in the room per chain, and its agent is told. The
// person’s next message starts the count again. A wake-limit card from before closes at startup.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime } from '../server/runtime.mjs';
import { HOP_LIMIT } from '../shared/limits.mjs';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** A room whose chain is at the cap, as HOP_LIMIT wakes in a row leave it, and the notifications it raises from now. */
function atCap() {
  const f = setup();
  arrange.setThread(f.rt, f.t.id, { hops: HOP_LIMIT });
  const heard = [];
  f.store.subscribe((/** @type {any} */ ev) => ev.type === 'notify' && heard.push(ev.data));
  return { ...f, heard };
}

const lines = (f) => f.store.items(f.t.id).filter((x) => x.kind === 'system' && x.variant === 'chain-stopped');

test('#1623 at the cap a wake doesn’t go, and nothing waits on the person: no card, no need, no notification', async () => {
  const f = atCap();
  const r = f.rt.agentWake(f.alpha.id, 'beta', 'One more look.');
  assert.deepEqual([r.ok, r.waiting], [false, undefined]);
  assert.match(r.message, /woke each other 1,000 times in a row without the person, so Postbox stopped the chain/);
  assert.match(r.message, /this message didn’t go\. The person’s next message starts the chain again: send it then if it’s still needed\./);
  await settle(f.rt);
  assert.deepEqual(
    f.store.items(f.t.id).filter((x) => x.kind === 'hop'),
    [],
    'no card',
  );
  assert.equal(f.adapter.calls.length, 0, 'beta took no turn');
  assert.equal(f.store.state.sessions[f.alpha.id].needs ?? null, null, 'alpha needs no one');
  assert.notEqual(f.store.state.sessions[f.alpha.id].state, 'needs');
  assert.deepEqual(f.heard, [], 'no notification');
});

test('#1623 the room shows one line naming the cap, and later refusals in the same chain post nothing more', () => {
  const f = atCap();
  f.rt.agentWake(f.alpha.id, 'beta', 'One more look.');
  assert.deepEqual(
    lines(f).map((x) => x.wakes),
    [HOP_LIMIT],
  );
  for (const [from, to] of [
    [f.beta, 'alpha'],
    [f.alpha, 'beta'],
  ])
    assert.equal(f.rt.agentWake(from.id, to, 'Again.').ok, false);
  assert.equal(lines(f).length, 1, 'one line per chain');
});

test('#1623 a chain counted past a cap lowered across a restart still stops with its one line', () => {
  // POSTBOX_CHAIN_LIMIT lowered from a higher cap while this chain ran: its count is already past the cap now.
  const f = setup();
  arrange.setThread(f.rt, f.t.id, { hops: HOP_LIMIT + 5 });
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'One more look.').ok, false);
  assert.equal(f.rt.agentWake(f.beta.id, 'alpha', 'Again.').ok, false);
  assert.equal(lines(f).length, 1, 'one line, as at the cap');
});

test('#1623 the person’s next message starts the count again: the next wake goes, and a chain that loops again gets a line of its own', async () => {
  const f = atCap();
  f.rt.agentWake(f.alpha.id, 'beta', 'One more look.');
  f.rt.sendMessage(f.t.id, { text: '@alpha carry on' });
  assert.equal(f.store.state.threads[f.t.id].hops, 0);
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'Now it goes.').ok, true);
  await settle(f.rt);
  arrange.setThread(f.rt, f.t.id, { hops: HOP_LIMIT });
  assert.equal(f.rt.agentWake(f.alpha.id, 'beta', 'Looping again.').ok, false);
  assert.equal(lines(f).length, 2);
});

test('#1623 the person’s Allow on an add card at the cap still adds the agent and delivers the wake', async () => {
  const f = atCap();
  assert.equal(f.rt.agentWake(f.alpha.id, 'gamma', 'Check the numbers.').waiting, true);
  const card = f.store.items(f.t.id).find((x) => x.kind === 'hop' && x.join);
  f.rt.resolveHop(f.t.id, card.id, true);
  await settle(f.rt);
  assert.ok(
    f.adapter.calls.some((c) => c.handle === 'gamma'),
    'gamma took a turn',
  );
  assert.deepEqual(lines(f), []);
});

test('#1623 a wake-limit card from before, still open at startup, closes: its need goes and its agents are told, and an add card stays', () => {
  const f = setup();
  const old = arrange.post(f.rt, f.t.id, {
    kind: 'hop',
    fromSessionId: f.alpha.id,
    from: 'alpha',
    to: 'beta',
    text: 'Check it.',
    status: 'open',
    n: 1001,
    limit: 1000,
    held: [{ fromSessionId: f.beta.id, from: 'beta', to: 'alpha', text: 'And this.', at: Date.now() }],
  });
  arrange.setSession(f.rt, f.alpha.id, { needs: { kind: 'hop', itemId: old.id, text: 'hop' }, state: 'needs' });
  new Runtime({ store: f.store, adapters: f.rt.adapters, config: f.rt.config });
  assert.equal(f.store.item(f.t.id, old.id).status, 'closed');
  assert.equal(f.store.state.sessions[f.alpha.id].needs, null);
  const told = (se) => (f.store.state.sessions[se.id]?.context ?? []).join(' | ');
  assert.match(
    told(f.alpha),
    /Your request to wake @beta .*was closed: Postbox no longer asks the person to continue a chain of wakes\. Send your message again if you still need it\./,
  );
  assert.match(told(f.beta), /“And this\.”.*didn’t go: Postbox no longer asks/);
  const g = setup();
  g.rt.agentWake(g.alpha.id, 'gamma', 'Check the numbers.');
  new Runtime({ store: g.store, adapters: g.rt.adapters, config: g.rt.config });
  assert.equal(g.store.items(g.t.id).find((x) => x.kind === 'hop').status, 'open', 'an add card is still the person’s');
});
