// The callers that release a card without the person answering it (#366; the independent review of #633): an agent
// withdrawing its block, a wake card retired because its target got a turn another way, a retired app's card, and a
// host prompt that ended with no wait. Each falls back to the next card that still waits, as an answer does; main set
// the need to null, and no other spec covered these four.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endCard } from '../server/remote/turns-prompts.mjs';
import { retireStale } from '../server/wake-cards.mjs';
import { room } from './card-needs-fixture.mjs';
import { settle } from './side-threads-fixture.mjs';

test('#366: an agent withdrawing its asking block leaves it needing you for its app card', async () => {
  const r = room();
  const app = r.appCard();
  const b = r.block();
  r.setNeed('block', b.id);
  const res = r.rt.toolsFor(r.alpha.id).update_block({ block: { id: b.block.id, withdraw: 'You answered in chat.' } });
  assert.equal(res.ok, true, res.message);
  assert.equal(r.needs()?.itemId, app.id);
  assert.equal(r.rt.s.sessions[r.alpha.id].state, 'needs');
  await settle(r.rt);
});

test('#366: a wake card retired because its target got a turn another way leaves its agent needing you for its app card', async () => {
  const r = room();
  const app = r.appCard();
  const card = r.hop();
  r.setNeed('hop', card.id);
  retireStale(r.rt, r.t.id, r.beta, 'you wrote to it', { byPerson: true });
  assert.equal(r.rt.store.pending.items(r.t.id).find((x) => x.id === card.id).status, 'retired');
  assert.equal(r.needs()?.itemId, app.id);
  assert.equal(r.rt.s.sessions[r.alpha.id].state, 'needs');
  await settle(r.rt);
});

test('#366: retiring an app leaves its agent needing you for its wake request', async () => {
  const r = room();
  const tools = r.rt.toolsFor(r.alpha.id);
  assert.equal(tools.show_app({ id: 'app1', title: 'App', code: '<p>1</p>' }).ok, true);
  const card = r.hop();
  const app = r.appCard();
  r.setNeed('appsend', app.id);
  const res = tools.retire_app({ id: 'app1', reason: 'Not needed.' });
  assert.equal(res.ok, true, res.message);
  assert.equal(r.rt.store.pending.items(r.t.id).find((x) => x.id === app.id).status, 'declined');
  assert.equal(r.needs()?.itemId, card.id);
  assert.equal(r.rt.s.sessions[r.alpha.id].state, 'needs');
  await settle(r.rt);
});

test('#366: a host prompt that ends with no wait leaves its agent needing you for its app card', async () => {
  const r = room();
  const app = r.appCard();
  // A host's permission card: the host holds the wait, so the runtime has none registered for it.
  const it = r.rt.addItem(r.t.id, { kind: 'permission', sessionId: r.alpha.id, handle: 'alpha', summary: 'run ls', status: 'open' });
  r.setNeed('permission', it.id);
  endCard({ rt: r.rt, now: () => Date.now() }, { it, threadId: r.t.id }, 'ended', 'The prompt ended.', Date.now());
  assert.equal(r.rt.store.pending.items(r.t.id).find((x) => x.id === it.id).status, 'ended');
  assert.equal(r.needs()?.itemId, app.id);
  assert.equal(r.rt.s.sessions[r.alpha.id].state, 'needs');
  await settle(r.rt);
});
