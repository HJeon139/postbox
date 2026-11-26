// A run clock in an ATIF trajectory (tools/atif-clock.mjs, tools/atif.mjs): its events go in the trajectory’s extra, not
// in steps, since the agent saw only the clock’s line in its prompt; a stop the agent may have outlived makes the
// trajectory partial; and a forced stop, a restart with the clock running, or a clock whose state says `voided` makes
// the timed run void. The clock events are the run clock’s contract (#1526, shared/run-clock.mjs), recorded in
// tests/fixtures/atif/dry-run.md’s run or built in its shape.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { CLOCK_WORDS, clockScope, clockStops, stopsScope } from '../tools/atif-clock.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';

const rec = readRecording(new URL('fixtures/atif/dry-run/', import.meta.url).pathname);
const sessionId = rec.events.find((e) => e.type === 'session' && e.data.handle === 'dry').data.id;
const last = Math.max(...rec.events.map((e) => e.seq));
const dry = (events = rec.events) =>
  trajectories(events, { version: POSTBOX_VERSION, live: rec.live, prompts: rec.prompts }).find((t) => t.handle === 'dry').trajectory;
const T0 = 1_800_000_000_000;

test('the clock’s events are in the trajectory’s extra, with their words, and none is a step the model was given', () => {
  const t = dry();
  const recorded = rec.events.filter((e) => e.type.startsWith('clock.') && e.data.sessionId === sessionId);
  assert.equal(recorded.length, 5);
  assert.equal(
    t.steps.some((s) => s.extra.event?.startsWith('clock.') || /Run clock/.test(s.source === 'system' ? s.message : '')),
    false,
  );
  assert.deepEqual(
    t.extra.clock_events.map((c) => [c.event, c.said, c.at]),
    recorded.map((e) => [e.type, CLOCK_WORDS[e.type](e.data), new Date(e.data.at).toISOString()]),
  );
  // What the agent saw of the clock: its line, in each turn’s prompt.
  for (const s of t.steps.filter((x) => x.extra.record === 'prompt')) assert.match(s.message, /\[Postbox\] Run clock: elapsed \d+s \/ budget 30s\. /);
  assert.equal(t.extra.clock_void, undefined);
});

test('a restart with the clock running voids the timed run, as a trial treats it', () => {
  const restored = { seq: last + 1, type: 'clock.restored', data: { sessionId, elapsedMs: 31_000, budgetMs: 30_000, at: T0 } };
  const t = dry([...rec.events, restored]);
  assert.deepEqual(t.extra.clock_void, { why: 'restored', at: new Date(T0).toISOString() });
  assert.match(t.notes, /^Void as a timed run: Postbox started again with the run clock running, so the time it was down is unrecorded/);
});

test('a forced stop voids the run, and the stop keeps its forced and why, never confirmed', () => {
  const forced = { seq: last + 1, type: 'clock.stopped', data: { sessionId, turn: 'turn:turn_x', forced: true, why: 'watchdog', at: T0 } };
  const t = dry([...rec.events, forced]);
  assert.deepEqual(t.extra.clock_void, { why: 'watchdog', at: new Date(T0).toISOString() });
  assert.match(t.notes, /^Void as a timed run: Postbox couldn’t confirm one of the agent’s stopped turns ended \(watchdog\)/);
  const stop = t.extra.stops.find((s) => s.turn === 'turn:turn_x');
  assert.equal(stop.forced, true);
  assert.equal(stop.why, 'watchdog');
  assert.equal(stop.confirmed_at, null, 'never confirmed: Postbox gave up');
  assert.equal(stop.gave_up_at, new Date(T0).toISOString());
});

test('stops say where they ran, and an expiry the turn may outlive says so', () => {
  const clocks = [
    { type: 'clock.paused', data: { sessionId, stopping: ['turn:turn_1'], at: T0 + 10_000 } },
    { type: 'clock.stopped', data: { sessionId, turn: 'turn:turn_1', at: T0 + 11_000 } },
    { type: 'clock.resumed', data: { sessionId, at: T0 + 20_000 } },
    { type: 'clock.expired', data: { sessionId, elapsedMs: 60_000, budgetMs: 60_000, stopping: ['host-turn-9'], at: T0 + 70_000 } },
    { type: 'clock.stopped', data: { sessionId, turn: 'host-turn-9', at: T0 + 71_000 } },
  ];
  assert.match(stopsScope(clockStops(clocks)).note, /^Partial: Postbox stopped the agent’s turn 2 times \(once on this computer, once on its host\)/);
  assert.equal(clockScope(clocks).extra.clock_void, undefined, 'stops that ended void nothing');
  assert.match(
    CLOCK_WORDS['clock.expired']({ budgetMs: 60_000, stopping: ['turn:turn_1'] }),
    /stopped the agent’s turn, which may run on until its CLI has exited/,
  );
  assert.deepEqual(clockScope([]), { note: null, extra: {} });
});

test('#1749 a run the person ended says so, with its time used, and the turn its end stopped is one stop', () => {
  const clocks = [
    { type: 'clock.started', data: { sessionId, budgetMs: 600_000, at: T0 } },
    { type: 'clock.ended', data: { sessionId, elapsedMs: 42_000, budgetMs: 600_000, stopping: ['turn:turn_1'], at: T0 + 42_000 } },
    { type: 'clock.stopped', data: { sessionId, turn: 'turn:turn_1', at: T0 + 43_000 } },
  ];
  const [stop] = clockStops(clocks);
  assert.deepEqual([stop.asked_by, stop.confirmed_at], ['clock.ended', T0 + 43_000]);
  assert.equal(
    CLOCK_WORDS['clock.ended'](clocks[1].data),
    'Run clock ended by the person at elapsed 42s of 600s: Postbox stopped the agent’s turn, which may run on until its CLI has exited.',
  );
  assert.equal(CLOCK_WORDS['clock.ended']({ elapsedMs: 9_500, budgetMs: 60_000 }), 'Run clock ended by the person at elapsed 9s of 60s.');
});
