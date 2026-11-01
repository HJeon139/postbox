// An agent being deleted receives nothing and loses nothing (design-597-deleting-1, D1): deliver holds what reaches it
// in its Undo window, in arrival order; Undo delivers it, and the purge drops it with a log line by kind and count. A
// purge stops a turn the session still has, so no backend outlives it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

test('a purge stops a turn its session still has, so no backend outlives the session', async () => {
  const { rt, adapter, t, alpha } = setup();
  const work = held();
  adapter.next.push(work.step);
  rt.sendMessage(t.id, { text: '@alpha a long job' });
  await sleep(5);
  assert.ok(rt.turns.has(alpha.id));
  rt.updateSession(alpha.id, { deleting: Date.now() });
  rt.purgeSession(alpha.id);
  await settle(rt);
  assert.equal(rt.turns.has(alpha.id), false);
  work.release();
});

test('no path starts a turn for an agent being deleted: deliver holds what comes (the class, rule 14)', async () => {
  const { rt, adapter, alpha } = setup();
  rt.updateSession(alpha.id, { deleting: Date.now() + 10_000 });
  rt.deliver(alpha.id, { kind: 'event', event: { type: 'probe' } });
  rt.deliver(alpha.id, { kind: 'wake', note: 'scheduled' });
  await settle(rt);
  assert.equal(adapter.calls.length, 0);
  assert.equal(rt.turns.has(alpha.id), false);
});

test('what reaches an agent in its Undo window is held: Undo delivers it in order, and nothing starts before (critic)', async () => {
  const { rt, adapter, alpha } = setup();
  rt.deleteSession(alpha.id);
  rt.deliver(alpha.id, { kind: 'event', event: { type: 'block-answer', values: { pick: 'a' } } });
  rt.deliver(alpha.id, { kind: 'wake', note: 'scheduled' });
  await settle(rt);
  assert.equal(adapter.calls.length, 0, 'no turn in the window');
  rt.undoDelete(alpha.id);
  await settle(rt);
  const seen = adapter.calls.filter((x) => x.sessionId === alpha.id).map((x) => JSON.stringify(x.message));
  assert.ok(
    seen.some((m) => /block-answer/.test(m)),
    'the person’s answer reaches it after Undo',
  );
  assert.ok(seen.join('\n').includes('scheduled'), 'the scheduled wake reaches it after Undo');
});

test('at the purge, what was held for Undo is dropped with the session; no turn starts', async () => {
  const { rt, adapter, alpha } = setup();
  rt.deleteSession(alpha.id);
  rt.deliver(alpha.id, { kind: 'event', event: { type: 'block-answer' } });
  clearTimeout(rt.timers.get(`del:${alpha.id}`));
  rt.purgeSession(alpha.id);
  await settle(rt);
  assert.equal(adapter.calls.length, 0);
  assert.equal(rt.heldForUndo?.has(alpha.id) ?? false, false, 'nothing left held for a session that’s gone');
});

test('Retry of a failed reply for an agent in its Undo window is held, then delivered on Undo (critic)', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(async (c) => {
    c.text('Half an answer');
    throw new Error('Claude Code exited with code 1.');
  });
  rt.sendMessage(t.id, { text: '@alpha try this' });
  await settle(rt);
  const failed = store.items(t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.ok(failed, 'a failed reply to retry');
  const before = adapter.calls.length;
  rt.deleteSession(alpha.id);
  await rt.retry(t.id, failed.id);
  await settle(rt);
  assert.equal(adapter.calls.length, before, 'no turn while it is being deleted');
  rt.undoDelete(alpha.id);
  await settle(rt);
  assert.ok(
    adapter.calls.slice(before).some((x) => x.sessionId === alpha.id && x.message.retry === true),
    'the retry reaches it after Undo',
  );
});

test('the purge logs what it dropped, by kind and count, with no message text (design-597-deleting-1)', async () => {
  const { rt, alpha } = setup();
  rt.deleteSession(alpha.id);
  rt.deliver(alpha.id, { kind: 'event', event: { type: 'secret-answer', values: { text: 'private words' } } });
  rt.deliver(alpha.id, { kind: 'wake', note: 'scheduled' });
  rt.deliver(alpha.id, { kind: 'event', event: { type: 'other' } });
  clearTimeout(rt.timers.get(`del:${alpha.id}`));
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    rt.purgeSession(alpha.id);
  } finally {
    console.warn = warn;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /@alpha was deleted with 3 held deliveries \(event ×2, wake\) undelivered/);
  assert.doesNotMatch(lines[0], /private words|scheduled/);
});
