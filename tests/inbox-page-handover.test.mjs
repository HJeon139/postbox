// Retry hands the failed turn’s entries to the turn it starts (server/deliver.mjs, Delivery’s retry). They were
// delivered when the turn failed, so a page left open dropped them (shared/inbox-page.mjs): the hand-over writes each
// whole, and that page holds what a page loaded from /api/state holds, through the retried turn and after it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOnPage, pageInbox } from '../shared/inbox-page.mjs';
import { emptyState } from '../shared/state.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

test('a page left open holds the retried turn’s entry as a reloaded page does, while it runs and once it ends', async () => {
  const f = setup();
  const page = emptyState();
  f.store.subscribe((ev) => applyOnPage(page, ev.type, ev.data));
  f.adapter.next.push(async () => {
    throw new Error('API 500');
  });
  f.rt.agentWake(f.alpha.id, 'beta', 'Which editions?');
  await settle(f.rt);
  assert.equal(page.inbox[f.beta.id], undefined, 'delivered to the failed turn, it left the page');
  const retried = held();
  f.adapter.next.push(retried.step);
  const failed = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.status === 'failed' && i.sessionId === f.beta.id);
  await f.rt.retry(f.t.id, failed.id);
  await sleep(5);
  assert.deepEqual(page.inbox, pageInbox(f.store.state.inbox));
  assert.deepEqual(
    page.inbox[f.beta.id].map((e) => [e.state, e.resend]),
    [['taken', true]],
  );
  retried.release();
  await settle(f.rt);
  assert.deepEqual(page.inbox, pageInbox(f.store.state.inbox));
});
