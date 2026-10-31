// What waits for the store to take writes again (server/store-outage.mjs): a backend’s session id saved while writes
// are closed is saved once they reopen, its latest value per field, before any turn that waited.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveBackendState, whenWritable } from '../server/store-outage.mjs';
import { changed } from '../server/store-status.mjs';
import { settle, setup, sleep } from './side-threads-fixture.mjs';

/** A runtime whose store is closed for writes until open() is called. */
function closed() {
  const ctx = setup();
  let writable = false;
  Object.defineProperty(ctx.store, 'writable', { get: () => writable });
  const open = () => {
    writable = true;
    changed(ctx.store);
  };
  return { ...ctx, open };
}

// gpt’s regression (store outage review, finding 2): each save went in front of what waited, so they replayed newest
// first and the older id won.
test('backend-state saves during an outage restore the newest value, not the oldest', () => {
  const { rt, alpha, open } = closed();
  saveBackendState(rt, alpha.id, { codexThreadId: 'older' });
  saveBackendState(rt, alpha.id, { codexThreadId: 'newer' });
  open();
  assert.equal(rt.s.sessions[alpha.id].backendState.codexThreadId, 'newer');
});

test('backend-state saves during an outage coalesce per session, the latest value per field, before any waiting turn', () => {
  const { rt, store, alpha, beta, open } = closed();
  const seen = [];
  whenWritable(rt, () => seen.push(['turn', { ...rt.s.sessions[alpha.id].backendState }, { ...rt.s.sessions[beta.id].backendState }]));
  saveBackendState(rt, alpha.id, { a: 1, keep: 'x' });
  saveBackendState(rt, beta.id, { a: 'b1' });
  saveBackendState(rt, alpha.id, { a: 2 });
  saveBackendState(rt, alpha.id, { b: 3 });
  saveBackendState(rt, beta.id, { a: 'b2' });
  let writes = 0;
  store.subscribe((ev) => ev.type === 'session.patch' && writes++);
  open();
  assert.deepEqual(rt.s.sessions[alpha.id].backendState, { ...(alpha.backendState ?? {}), a: 2, keep: 'x', b: 3 });
  assert.equal(rt.s.sessions[beta.id].backendState.a, 'b2');
  assert.equal(writes, 2, 'one write per session');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0][1], rt.s.sessions[alpha.id].backendState, 'the waiting turn ran after the saves');
  assert.deepEqual(seen[0][2], rt.s.sessions[beta.id].backendState);
  // Once writes are open, a save is written at once, and an outage after starts afresh.
  saveBackendState(rt, alpha.id, { a: 4 });
  assert.equal(rt.s.sessions[alpha.id].backendState.a, 4);
});

/** A runtime whose store takes writes until close() is called, and again after open(). */
function toggled() {
  const ctx = setup();
  let writable = true;
  Object.defineProperty(ctx.store, 'writable', { get: () => writable });
  const set = (v) => {
    writable = v;
    changed(ctx.store);
  };
  return { ...ctx, close: () => set(false), open: () => set(true) };
}

// #541 ends a chain of wakes by writing its count back to 0 once the last turn has exited. A turn the outage stopped
// exits while writes are closed: that write must wait for them, as the exit’s own does, not run (or throw) meanwhile.
test('a chain whose last turn the outage stopped ends once writes reopen: its count waits, then resets', async () => {
  const { rt, store, adapter, t, alpha, close, open } = toggled();
  // beta’s turn works until it’s stopped, as a real adapter’s does when its process is told to.
  let working = false;
  adapter.next.push(async (c) => {
    working = true;
    c.text('working on it');
    if (!c.signal.aborted) await new Promise((ok) => c.signal.addEventListener('abort', ok, { once: true }));
  });
  assert.equal(rt.agentWake(alpha.id, 'beta', 'hand-off').ok, true);
  assert.equal(store.state.threads[t.id].hops, 1, 'the chain counts while it runs');
  for (let i = 0; i < 100 && !working; i++) await sleep(5);
  assert.equal(working, true, 'beta’s turn runs');
  close();
  // The stopped turn exits while writes are closed: nothing is written, and the chain still counts.
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(20);
  assert.equal(rt.turns.size, 0, 'the outage stopped the turn');
  assert.equal(rt.exiting.size, 1, 'its exit waits for writes');
  assert.equal(store.state.threads[t.id].hops, 1, 'the count isn’t written while the store is down');
  open();
  await settle(rt);
  assert.equal(rt.exiting.size, 0);
  assert.equal(store.state.threads[t.id].hops, 0, 'the chain ended once writes reopened');
});
