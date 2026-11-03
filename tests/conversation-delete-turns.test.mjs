// Deleting a conversation starts no turn in its Undo window and leaves none running after its purge (#725), as
// deleting one agent already does (tests/deleting-agent.test.mjs): deliver holds what reaches its agents, Undo
// delivers it in order, and the purge drops it with a log line and stops any turn its sessions still have.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** The warnings logged while fn runs. */
function warned(fn) {
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.warn = warn;
  }
  return lines;
}

test('#725: no delivery starts a turn while its conversation is being deleted, a side thread’s agent’s included', async () => {
  const { rt, adapter, t, alpha, a } = setup();
  const side = rt.createThread({ projectId: 'p1', title: 'Side', kind: 'side', parentId: t.id, personaIds: [a.id] });
  const [sider] = rt.sessionsIn(side.id);
  rt.deleteThread(t.id);
  rt.deliver(alpha.id, { kind: 'wake', note: 'scheduled' });
  rt.deliver(alpha.id, { kind: 'event', event: { type: 'probe' } });
  rt.deliver(sider.id, { kind: 'wake', note: 'side' });
  await settle(rt);
  assert.equal(adapter.calls.length, 0, 'no turn in the window');
});

test('#725: Undo of a conversation’s delete delivers what reached its agents, in the order it came', async () => {
  const { rt, adapter, t, alpha } = setup();
  rt.deleteThread(t.id);
  rt.deliver(alpha.id, { kind: 'wake', note: 'first' });
  rt.deliver(alpha.id, { kind: 'wake', note: 'second' });
  await settle(rt);
  assert.equal(adapter.calls.length, 0, 'held, not delivered, before Undo');
  rt.undoDeleteThread(t.id);
  await settle(rt);
  const notes = adapter.calls.filter((x) => x.sessionId === alpha.id).flatMap((x) => [x.message, ...(x.message.batch ?? [])].map((m) => m.note));
  assert.deepEqual(
    notes.filter((n) => n),
    ['first', 'second'],
  );
  assert.equal(rt.heldForUndo.has(alpha.id), false);
});

test('#725: the purge drops what was held, with a line by kind and count, and starts nothing', async () => {
  const { rt, adapter, t, alpha } = setup();
  rt.deleteThread(t.id);
  rt.deliver(alpha.id, { kind: 'wake', note: 'private words' });
  clearTimeout(rt.timers.get(`delt:${t.id}`));
  const lines = warned(() => rt.purgeThread(t.id));
  await settle(rt);
  assert.match(lines.join('\n'), /@alpha was removed with its conversation with 1 held delivery \(wake\) undelivered/);
  assert.ok(!lines.join('\n').includes('private words'), 'no message text in the log');
  assert.equal(adapter.calls.length, 0);
  assert.equal(rt.heldForUndo.has(alpha.id), false);
});

test('#725: the purge stops a turn its sessions still have, so no backend outlives the conversation', async () => {
  const { rt, adapter, t, alpha } = setup();
  const work = held();
  adapter.next.push(work.step);
  rt.sendMessage(t.id, { text: '@alpha a long job' });
  await sleep(5);
  assert.ok(rt.turns.has(alpha.id), 'a turn is running');
  // As if it started in the window: the delete’s own stop is what the purge can’t count on.
  rt.putThread({ ...rt.s.threads[t.id], deleting: Date.now() });
  rt.purgeThread(t.id);
  await settle(rt);
  work.release();
  assert.deepEqual({ running: rt.turns.has(alpha.id), session: Boolean(rt.s.sessions[alpha.id]) }, { running: false, session: false });
});
