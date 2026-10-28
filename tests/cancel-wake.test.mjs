// #458: an agent can cancel a wake it scheduled. schedule_wake gives it the wake's id, and cancel_wake cancels only that
// session's own pending wake, as the person's Cancel does: the schedule line reads canceled, and no turn starts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTool, isQuietTool } from '../server/adapters/claude-stream.mjs';
import { TOOL_ROUTES } from '../shared/remote-protocol.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';
import { setup, sleep } from './side-threads-fixture.mjs';

const idIn = (message) => /\b(sc_\w+)\b/.exec(message)?.[1] ?? null;

test('#458 schedule_wake says the wake’s id, and cancel_wake cancels it: the line reads canceled, and no timer is left', () => {
  const f = setup();
  const r = f.rt.toolsFor(f.alpha.id).schedule_wake({ in_minutes: 15, note: 'Check the run.' });
  const id = idIn(r.message);
  assert.ok(id && f.store.state.schedules[id], `the id is in “${r.message}”`);
  const c = f.rt.toolsFor(f.alpha.id).cancel_wake({ id });
  assert.equal(c.ok, true, c.message);
  assert.equal(f.store.state.schedules[id], undefined);
  assert.equal(f.rt.timers.has(id), false, 'its timer is gone, so it never starts a turn');
  const line = f.store.items(f.t.id).find((x) => x.kind === 'system' && x.scheduleId === id);
  assert.equal(line.status, 'canceled');
  assert.equal(f.store.items(f.t.id).filter((x) => x.kind === 'system' && x.variant === 'schedule').length, 1, 'no extra line');
});

test('#458 a canceled wake starts no turn when its time comes', async () => {
  const f = setup();
  // A second away, the shortest schedule allows (Runtime.schedule).
  const sc = f.rt.schedule(f.alpha.id, { inMs: 1000, note: 'Soon.' });
  assert.equal(f.rt.toolsFor(f.alpha.id).cancel_wake({ id: sc.id }).ok, true);
  await sleep(1300);
  assert.deepEqual(
    f.adapter.calls.filter((c) => c.handle === 'alpha'),
    [],
  );
  assert.equal(f.store.items(f.t.id).filter((x) => x.kind === 'system' && x.variant === 'wake').length, 0, 'no wake line either');
});

test('#458 cancel_wake refuses another agent’s wake, one that already fired or was canceled, and an id that doesn’t exist', () => {
  const f = setup();
  const id = idIn(f.rt.toolsFor(f.alpha.id).schedule_wake({ in_minutes: 15, note: 'Mine.' }).message);
  const theirs = f.rt.toolsFor(f.beta.id).cancel_wake({ id });
  assert.equal(theirs.ok, false);
  assert.ok(f.store.state.schedules[id], 'beta can’t cancel alpha’s wake');
  assert.equal(f.rt.toolsFor(f.alpha.id).cancel_wake({ id }).ok, true);
  assert.equal(f.rt.toolsFor(f.alpha.id).cancel_wake({ id }).ok, false, 'already canceled');
  assert.equal(f.rt.toolsFor(f.alpha.id).cancel_wake({ id: 'sc_nothere' }).ok, false);
  assert.equal(f.rt.toolsFor(f.alpha.id).cancel_wake({}).ok, false, 'no id');
});

test('#458 an agent on a host waits for schedule_wake’s answer, which carries the id, and for cancel_wake’s', () => {
  // A queued route answers at once, from the host, with no id.
  assert.equal(TOOL_ROUTES.schedule_wake, 'ask');
  assert.equal(TOOL_ROUTES.cancel_wake, 'ask');
});

test('#458 cancel_wake is one of Postbox’s quiet tools, with a step label of its own, on every backend', () => {
  // The Kiro, Codex and Antigravity adapters ask claude-stream.mjs too.
  assert.equal(isQuietTool('mcp__postbox__cancel_wake'), true);
  assert.equal(describeTool('mcp__postbox__cancel_wake', { id: 'sc_x' }), 'Canceling a wake-up');
});

test('#458 a schedule_wake from the host, sent again after a hello, schedules one wake: the one whose id the agent has', async () => {
  const r = rig();
  const turn = await running(r);
  const id = r.d.tool(turn, 'schedule_wake', { in_minutes: 30, note: 'Check the run.' });
  await until(() => r.d.replies.length === 1, 'the reply');
  r.link.hear({ type: 'tool', turn, id, name: 'schedule_wake', args: { in_minutes: 30, note: 'Check the run.' } });
  await until(() => r.link.sent.filter((m) => m.type === 'reply' && m.id === id).length === 2, 'the repeat’s reply');
  const wakes = Object.values(r.store.state.schedules).filter((x) => x.sessionId === r.se().id);
  assert.equal(wakes.length, 1, 'one wake');
  assert.match(r.d.replies[0].text, new RegExp(wakes[0].id), 'and its id is the one the agent was told');
  r.d.end(turn);
  await settled(r);
});
