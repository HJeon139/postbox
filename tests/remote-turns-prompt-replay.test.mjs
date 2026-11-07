// #353 on a host, while its stream is still being read up to where the host has it (server/remote/turns-replay.mjs):
// after a restart the turn is replayed from the start, and after a reconnect read on, and a long stream can take longer
// than PROMPT_CALL_WAIT_MS. A prompt waits for its call’s line until the read has caught up, then up to the bound. The
// rig is tests/remote-turns-helpers.mjs, over tests/fake-daemon.mjs, whose holdCaughtUp keeps a read from catching up
// until the test says so; the clock is held, so the bound runs only when a test moves it. A read that never catches up
// holds a prompt PROMPT_REPLAY_WAIT_MS at most, from when it first came.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFUSED } from '../server/prompt-claim.mjs';
import { Store } from '../server/store.mjs';
import { heldPrompts } from '../server/turn-work.mjs';
import { PROMPT_CALL_WAIT_MS, PROMPT_REPLAY_WAIT_MS } from '../shared/limits.mjs';
import { callLine, createFakeDaemon, FIXTURE_PROMPT } from './fake-daemon.mjs';
import { rig, running, settled, startUp, until } from './remote-turns-helpers.mjs';

const cards = (r) => r.store.items(r.t.id).filter((i) => i.kind === 'permission');
const refusals = (r) => r.store.items(r.t.id).filter((i) => i.kind === 'system' && i.variant === 'prompt-refused');
const lag = async () => {
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
};
const NEVER = { tool_name: 'Bash', input: { command: 'git push' }, tool_use_id: 'toolu_01NeverInThisStream' };

/**
 * Waits for `fn` on a held clock, moving it 2 ms a step as until() sleeps, so the restart’s own short waits run: a
 * second at most, well short of the bound. Resolves to how far it moved the clock. @param {any} t @param {() => boolean} fn @param {string} label
 */
async function lagUntil(t, fn, label) {
  let moved = 0;
  for (let i = 0; i < 500 && !fn(); i++) {
    t.mock.timers.tick(2);
    moved += 2;
    await lag();
  }
  assert.ok(fn(), `Timed out waiting for ${label}`);
  return moved;
}

/**
 * A Postbox restarted while its turn on the host waited on prompt `request`: the daemon sends it again at the welcome,
 * and the turn is read again from the start, its `caught-up` held until the test sends it, as a long stream’s is. The
 * clock is held from before the welcome, so the prompt’s wait runs on it.
 */
async function restartedReplaying(t, request) {
  const store = new Store(null);
  const d = createFakeDaemon({ autoEnd: false, holdCaughtUp: ['out'] });
  const first = rig({ store, d });
  first.rt.remote.close();
  first.rt.updateSession(first.se().id, {
    backendState: { claudeSessionId: 'e6f7d942-4a4f-4015-b186-0ef8d5c103ca' },
    remoteTurn: { hostId: first.host.id, turn: 'host-turn-1', offset: 0, rtTurn: 'turn_old', threadId: first.t.id, state: 'running', at: 1 },
  });
  d.addTurn('host-turn-1', { exit: null });
  d.prompt('host-turn-1', request, 'p-1');
  d.drop();
  d.connect();
  const r = rig({ store, d });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  startUp(r);
  await lagUntil(t, () => d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the replay');
  await lag();
  return { r, d };
}

test('#353 after a restart, a replay slower than the bound still lets the prompt reach its card when its call’s line comes', async (t) => {
  let r;
  let d;
  try {
    ({ r, d } = await restartedReplaying(t, FIXTURE_PROMPT));
    // The replay goes on past the bound: the prompt still waits.
    t.mock.timers.tick(PROMPT_CALL_WAIT_MS * 2);
    await lag();
    assert.equal(d.answers.length, 0, 'no answer while the stream is still being read');
    assert.equal(cards(r).length, 0);
    // The call’s line comes at last, still before the read has caught up.
    d.append('host-turn-1', callLine(FIXTURE_PROMPT));
    await lagUntil(t, () => cards(r).some((c) => c.status === 'open'), 'the card');
  } finally {
    t.mock.timers.reset();
  }
  d.caughtUp('host-turn-1', 'out');
  r.rt.resolvePermission(r.t.id, cards(r)[0].id, 'allow');
  await until(() => d.answers.length === 1, 'the answer');
  assert.deepEqual(d.answers[0], { turn: 'host-turn-1', id: 'p-1', result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
  assert.equal(refusals(r).length, 0);
  d.end('host-turn-1');
  await settled(r);
});

test('#353 after a restart, a prompt whose call the replayed stream never shows is refused its bound after the replay', async (t) => {
  let r;
  let d;
  try {
    ({ r, d } = await restartedReplaying(t, NEVER));
    t.mock.timers.tick(PROMPT_CALL_WAIT_MS * 2);
    await lag();
    assert.equal(d.answers.length, 0, 'it waits for the replay');
    d.caughtUp('host-turn-1', 'out');
    await lag();
    t.mock.timers.tick(PROMPT_CALL_WAIT_MS - 1);
    await lag();
    assert.equal(d.answers.length, 0, 'then for its bound');
    t.mock.timers.tick(1);
    await lagUntil(t, () => d.answers.length === 1, 'the answer');
  } finally {
    t.mock.timers.reset();
  }
  assert.deepEqual(d.answers[0], { turn: 'host-turn-1', id: 'p-1', result: { behavior: 'deny', message: REFUSED.unseen } });
  assert.equal(cards(r).length, 0);
  d.end('host-turn-1');
  await settled(r);
});

test('#353 after a reconnect, a prompt waits for the read to catch up, then its call’s line lets it through', async (t) => {
  const r = rig({ daemon: { callLines: false, holdCaughtUp: ['out'] } });
  const turn = await running(r);
  r.d.caughtUp(turn, 'out');
  const reads = () => r.d.received.filter((m) => m.type === 'read' && m.turn === turn).length;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // The link drops and comes back: the turn is read on from where it was, and that read hasn’t caught up yet.
    r.link.reconnect();
    await lagUntil(t, () => reads() === 2, 'the read after the reconnect');
    r.d.prompt(turn, FIXTURE_PROMPT, 'p-1');
    await lag();
    t.mock.timers.tick(PROMPT_CALL_WAIT_MS * 2);
    await lag();
    assert.equal(r.d.answers.length, 0, 'no answer while the read is still catching up');
    r.d.append(turn, callLine(FIXTURE_PROMPT));
    await lagUntil(t, () => cards(r).some((c) => c.status === 'open'), 'the card');
  } finally {
    t.mock.timers.reset();
  }
  r.d.caughtUp(turn, 'out');
  r.rt.resolvePermission(r.t.id, cards(r)[0].id, 'deny');
  await until(() => r.d.answers.length === 1, 'the answer');
  r.d.end(turn);
  await settled(r);
});

test('#353 a prompt waiting for a replay that never catches up is refused once its turn stops, within its bound', async (t) => {
  let r;
  let d;
  try {
    ({ r, d } = await restartedReplaying(t, NEVER));
    // Stop: the read is over here, so its bound starts, as a laptop prompt’s does when its turn ends.
    r.rt.stop(r.se().id);
    await lag();
    t.mock.timers.tick(PROMPT_CALL_WAIT_MS);
    await lagUntil(t, () => d.answers.length === 1, 'the answer');
  } finally {
    t.mock.timers.reset();
  }
  assert.deepEqual(d.answers[0], { turn: 'host-turn-1', id: 'p-1', result: { behavior: 'deny', message: REFUSED.ended } });
  assert.equal(cards(r).length, 0);
  await settled(r);
});

/**
 * A turn whose read after a reconnect never catches up, and a prompt for a call its stream never shows, which came just
 * now on the held clock. @param {any} t
 */
async function reconnectedNeverCaughtUp(t) {
  const r = rig({ daemon: { callLines: false, holdCaughtUp: ['out'] } });
  const turn = await running(r);
  r.d.caughtUp(turn, 'out');
  const reads = () => r.d.received.filter((m) => m.type === 'read' && m.turn === turn).length;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  r.link.reconnect();
  await lagUntil(t, () => reads() === 2, 'the read after the reconnect');
  r.d.prompt(turn, NEVER, 'p-1');
  await lag();
  const held = () => heldPrompts(r.rt.turns.get(r.se().id));
  assert.equal(held(), 1, 'the prompt waits for the read');
  return { r, turn, reads, held };
}

test('#353 a prompt waiting for a read that never catches up is refused at its ceiling, and no longer waits', async (t) => {
  let r;
  let turn;
  try {
    let held;
    ({ r, turn, held } = await reconnectedNeverCaughtUp(t));
    t.mock.timers.tick(PROMPT_REPLAY_WAIT_MS - 1);
    await lag();
    assert.equal(r.d.answers.length, 0, 'still waiting just short of the ceiling');
    assert.equal(held(), 1);
    t.mock.timers.tick(1);
    await lag();
    assert.equal(r.d.answers.length, 1, 'refused at the ceiling');
    assert.equal(held(), 0, 'its watcher is gone');
    assert.equal(r.rt.remote.byTurn.get(turn).ceilings.size, 0, 'and its ceiling');
  } finally {
    t.mock.timers.reset();
  }
  assert.deepEqual(r.d.answers[0], { turn, id: 'p-1', result: { behavior: 'deny', message: REFUSED.unseen } });
  assert.equal(cards(r).length, 0, 'nobody was asked');
  assert.equal(refusals(r).length, 1, 'the person sees it was refused');
  r.d.end(turn);
  await settled(r);
});

test('#353 a reconnect that starts the read over, and the prompt sent again, don’t move its ceiling from when it first came', async (t) => {
  let r;
  let turn;
  try {
    let reads;
    let held;
    ({ r, turn, reads, held } = await reconnectedNeverCaughtUp(t));
    t.mock.timers.tick(PROMPT_REPLAY_WAIT_MS / 2);
    await lag();
    // The link drops and comes back: the read starts over, and the daemon sends the waiting prompt again at its hello.
    const before = r.d.sent.filter((m) => m.type === 'prompt').length;
    r.link.reconnect();
    const moved = await lagUntil(t, () => reads() === 3 && r.d.sent.filter((m) => m.type === 'prompt').length > before, 'the read and the resend');
    await lag();
    assert.equal(held(), 2, 'the resend waits too');
    t.mock.timers.tick(PROMPT_REPLAY_WAIT_MS / 2 - moved - 1);
    await lag();
    assert.equal(r.d.answers.length, 0, 'still waiting just short of the ceiling from when it first came');
    t.mock.timers.tick(1);
    await lag();
    assert.equal(r.d.answers.length, 1, 'refused at that ceiling');
    assert.equal(held(), 0, 'the resend’s wait ended at the same ceiling');
  } finally {
    t.mock.timers.reset();
  }
  assert.deepEqual(r.d.answers, [{ turn, id: 'p-1', result: { behavior: 'deny', message: REFUSED.unseen } }]);
  assert.equal(cards(r).length, 0);
  r.d.end(turn);
  await settled(r);
});

test('#353 the ceiling bounds only the wait for the read: one that catches up just before it still gives the prompt its bound', async (t) => {
  let r;
  let turn;
  try {
    ({ r, turn } = await reconnectedNeverCaughtUp(t));
    t.mock.timers.tick(PROMPT_REPLAY_WAIT_MS - 1);
    await lag();
    r.d.caughtUp(turn, 'out');
    await lag();
    t.mock.timers.tick(PROMPT_CALL_WAIT_MS - 1);
    await lag();
    assert.equal(r.d.answers.length, 0, 'past the ceiling, still within its bound');
    t.mock.timers.tick(1);
    await lag();
    assert.equal(r.d.answers.length, 1, 'refused at its bound');
  } finally {
    t.mock.timers.reset();
  }
  assert.deepEqual(r.d.answers[0], { turn, id: 'p-1', result: { behavior: 'deny', message: REFUSED.unseen } });
  r.d.end(turn);
  await settled(r);
});

test('#353 after a restart, a prompt the daemon ends while it waits for the replay gets no card when its call’s line comes', async (t) => {
  let r;
  let d;
  try {
    ({ r, d } = await restartedReplaying(t, FIXTURE_PROMPT));
    // The host’s permissionWaitMax runs out (or the harness gives up) while the turn is still being read.
    d.expire('host-turn-1', 'p-1');
    await lagUntil(t, () => r.rt.remote.endedPrompts.has('host-turn-1\np-1'), 'the expiry');
    d.append('host-turn-1', callLine(FIXTURE_PROMPT));
    await lagUntil(t, () => heldPrompts(r.rt.turns.get(r.se().id)) === 0, 'the line to end the wait');
    await lag();
    assert.equal(cards(r).length, 0, 'no card for a prompt nobody can answer');
    assert.equal(r.rt.permissionWaits.size, 0, 'no permission wait left open');
    assert.equal(d.answers.length, 0, 'no answer goes to a prompt the host ended');
  } finally {
    t.mock.timers.reset();
  }
  d.caughtUp('host-turn-1', 'out');
  d.end('host-turn-1');
  await settled(r);
});
