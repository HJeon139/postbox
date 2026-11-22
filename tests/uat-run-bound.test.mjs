// A UAT run’s bound (tools/uat/run-bound.mjs): every run stops at a cap on its agents’ turns and its wall time,
// whatever harness they run on. Sessions here are shaped as /api/state gives them: a turn’s start sets lastTurnId
// (server/turn-run.mjs, atWork) on every backend alike.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepEvent } from '../tools/uat/room-events.mjs';
import { boundNote, DEFAULT_MAX_MINUTES, DEFAULT_MAX_TURNS, runBound, watchRun } from '../tools/uat/run-bound.mjs';

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, pass: (/** @type {number} */ minutes) => (t += minutes * 60000) };
};
/** A session at `state`, on its turn `turn`, on a backend: the bound reads only the first three. */
const se = (id, turn, state = 'idle', backend = 'claude-code') => ({ id, handle: id, lastTurnId: turn, state, backend });

test('a run’s bound defaults to 150 turns and 45 minutes, and refuses a cap that isn’t a whole number', () => {
  const b = runBound({});
  assert.deepEqual([b.maxTurns, b.maxMinutes], [DEFAULT_MAX_TURNS, DEFAULT_MAX_MINUTES]);
  assert.deepEqual([DEFAULT_MAX_TURNS, DEFAULT_MAX_MINUTES], [150, 45]);
  assert.equal(runBound({ turns: '20', minutes: '5' }).maxTurns, 20);
  for (const bad of ['0', '-3', '2.5', 'lots']) {
    assert.throws(() => runBound({ turns: bad }), /--max-turns takes a whole number from 1 to 10000/);
    assert.throws(() => runBound({ minutes: bad }), /--max-minutes takes a whole number from 1 to 1440/);
  }
});

test('turns on every harness count alike, and the run takes no step once the cap’s turns have started', () => {
  const b = runBound({ turns: '3', minutes: '60' });
  assert.deepEqual(b.see([se('a', 't1', 'idle', 'codex'), se('b', 't2', 'tool', 'kiro-cli')]), []);
  assert.equal(b.beforeStep(1), null, 'two turns of three: the step goes ahead');
  assert.deepEqual(b.see([se('a', 't3', 'think', 'antigravity-cli'), se('b', 't2', 'idle', 'kiro-cli')]), [], 'the third may run');
  assert.match(String(b.beforeStep(2)), /its agents started 3 turns, the most --max-turns 3 allows/);
  assert.equal(b.summary().turns, 3);
  assert.equal(b.summary().stopped?.step, 2);
});

test('a turn that starts past the turn cap is stopped, and one that started before it may finish', () => {
  const b = runBound({ turns: '2' });
  b.see([se('a', 't1', 'think'), se('b', 't2', 'think')]);
  // A reply-back loop takes no tester step: b’s next turn starts while a still works on the last allowed one.
  const stop = b.see([se('a', 't1', 'tool'), se('b', 't3', 'gen')]);
  assert.deepEqual(stop, ['b'], 'b’s turn past the cap is stopped; a’s, within it, goes on');
  assert.match(String(b.stopped?.why), /--max-turns 2/);
  // A turn past the cap that already ended still stops the run: the cap counts turns started, not turns at work.
  const c = runBound({ turns: '1' });
  c.see([se('a', 't1')]);
  assert.deepEqual(c.see([se('a', 't2', 'idle')]), []);
  assert.ok(c.stopped, 'a short turn past the cap, over between two polls, still stops the run');
});

test('past --max-minutes, the run takes no step and stops every turn at work, on any harness', () => {
  const t = clock();
  const b = runBound({ minutes: '10', now: t.now });
  t.pass(9);
  assert.deepEqual(b.see([se('a', 't1', 'think', 'codex')]), []);
  assert.equal(b.beforeStep(4), null);
  t.pass(1);
  assert.deepEqual(b.see([se('a', 't1', 'think', 'codex'), se('b', 't2', 'tool', 'kiro-cli'), se('c', 't3')]), ['a', 'b']);
  assert.match(String(b.stopped?.why), /it ran 10 minutes, past --max-minutes 10/);
  assert.equal(b.beforeStep(5), b.stopped?.why, 'and stays stopped');
  assert.equal(b.summary().minutes, 10);
});

test('the report says the run stopped at its bound, and says nothing when it didn’t', () => {
  const b = runBound({ turns: '1' });
  assert.equal(boundNote(b.summary()), '');
  b.see([se('a', 't1')]);
  b.beforeStep(3);
  assert.equal(boundNote(b.summary()), ' **It stopped at its bound** before step 3: its agents started a turn, the most --max-turns 1 allows.');
  assert.equal(boundNote(null), '');
});

test('the run’s watch stops a looping room’s turns past the cap with no step taken, and without --max-cost', async () => {
  // Two agents answering each other: each poll sees a new turn, as in the looping real-q1 run of 8 November.
  let n = 0;
  const api = async () => {
    n += 1;
    return { state: { sessions: { a: se('a', `a${n}`, 'think', 'codex'), b: se('b', `b${n}`, 'gen', 'kiro-cli') } } };
  };
  const stopped = [];
  const lines = [];
  const bound = runBound({ turns: '5' });
  const budgetOff = { on: false };
  const end = watchRun({
    bound,
    budget: budgetOff,
    api,
    threadsUnderTest: () => [],
    stop: async (id) => stopped.push(id),
    log: (l) => lines.push(l),
    every: 1,
  });
  try {
    // A deadline, so a watch that never stops anything fails here rather than at the runner’s timeout.
    const until = Date.now() + 2000;
    while (!stopped.length && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
  } finally {
    end();
  }
  assert.ok(bound.stopped, 'the bound stopped the run');
  assert.ok(bound.summary().turns <= 5, `it counted ${bound.summary().turns} turns of a cap of 5`);
  assert.ok(stopped.includes('a') || stopped.includes('b'));
  assert.ok(
    lines.some((l) => l.startsWith('Stopped at the run’s bound')),
    lines.join('\n'),
  );
});

test('the report says whether the bound stopped a step or the turns at work, and counts minutes to the watch’s end', () => {
  const t = clock();
  const b = runBound({ minutes: '10', now: t.now });
  t.pass(11);
  b.see([se('a', 't1', 'think')]);
  assert.match(boundNote(b.summary()), /stopped at its bound\*\* before its first step: it ran 11 minutes/);
  const c = runBound({ turns: '1' });
  c.beforeStep(2);
  c.see([se('a', 't1', 'think')]);
  c.see([se('a', 't2', 'think')]);
  assert.match(boundNote(c.summary()), /while step 2’s turns ran/);
  // The report is written again after the verifier: its minutes stay those of the steps, not the verifier’s.
  const d = runBound({ now: t.now });
  t.pass(30);
  d.end();
  t.pass(20);
  assert.equal(d.summary().minutes, 30, 'minutes to the watch’s end');
  assert.equal(d.summary().stopped, null, 'and a run that didn’t stop doesn’t read as past its cap');
});

test('past --max-minutes the run stops though the state can’t be read, while a tester step is still out', async () => {
  const t = clock();
  const bound = runBound({ minutes: '5', now: t.now });
  const api = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const lines = [];
  const end = watchRun({ bound, budget: { on: false }, api, threadsUnderTest: () => [], stop: async () => {}, log: (l) => lines.push(l), every: 1 });
  try {
    // The tester’s step is out, and Postbox doesn’t answer: the deadline passes all the same.
    t.pass(6);
    const until = Date.now() + 2000;
    while (!bound.stopped && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
  } finally {
    end();
  }
  assert.match(String(bound.stopped?.why), /past --max-minutes 5/, lines.join('\n'));
  assert.ok(bound.beforeStep(7), 'and the step after the tester’s answer isn’t taken');
});

test('two turns of one session between polls both count, from the run’s events, not the state’s snapshot', async () => {
  // Kept as the runner keeps them (tools/uat/room-events.mjs, keepEvent): each turn start is a session.patch of its
  // session’s lastTurnId, as server/turn-run.mjs’s atWork writes it.
  const events = [];
  const known = new Map();
  keepEvent(0, 'session', { id: 'a', state: 'idle' }, known);
  const started = (id, turn, state = 'think') => {
    const e = keepEvent(events.length + 1, 'session.patch', { id, patch: { state, lastTurnId: turn } }, known);
    if (e) events.push(e);
  };
  const bound = runBound({ turns: '2' });
  let st = { sessions: { a: se('a', 't1', 'think') } };
  const stopped = [];
  const end = watchRun({
    bound,
    budget: { on: false },
    api: async () => ({ state: st }),
    events: () => events,
    threadsUnderTest: () => [],
    stop: async (id) => stopped.push(id),
    every: 1,
  });
  try {
    started('a', 't1');
    started('a', 't1', 'idle');
    // Two more turns start and one ends between polls: the snapshot shows only the last.
    started('a', 't2');
    started('a', 't2', 'idle');
    started('a', 't3');
    st = { sessions: { a: se('a', 't3', 'think') } };
    const until = Date.now() + 2000;
    while (!stopped.length && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
  } finally {
    end();
  }
  assert.deepEqual(stopped.slice(0, 1), ['a'], 'the third turn is past a cap of 2, though no poll saw t2');
  assert.match(String(bound.stopped?.why), /--max-turns 2/);
  assert.equal(bound.summary().turns, 2);
});

test('past --max-minutes the run stops while a state read hangs, unanswered', async () => {
  const t = clock();
  const bound = runBound({ minutes: '5', now: t.now });
  // A Postbox that takes the connection and never answers.
  const api = () => new Promise(() => {});
  const lines = [];
  const end = watchRun({ bound, budget: { on: false }, api, threadsUnderTest: () => [], stop: async () => {}, log: (l) => lines.push(l), every: 1 });
  try {
    const first = Date.now() + 50;
    while (Date.now() < first) await new Promise((r) => setTimeout(r, 2));
    t.pass(6);
    const until = Date.now() + 2000;
    while (!bound.stopped && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
  } finally {
    end();
  }
  assert.match(String(bound.stopped?.why), /past --max-minutes 5/);
  assert.equal(lines.filter((l) => l.startsWith('Stopped at the run’s bound')).length, 1, 'said once');
});

test('a run held in a wait past --max-minutes reaches its cleanup after the grace, and one that ends in time doesn’t', async () => {
  const t = clock();
  const hung = () => new Promise(() => {});
  const watch = (/** @type {() => void} */ overdue) => {
    const bound = runBound({ minutes: '5', now: t.now });
    const end = watchRun({ bound, budget: { on: false }, api: hung, threadsUnderTest: () => [], stop: async () => {}, every: 1, grace: 30, overdue });
    return { bound, end };
  };
  // The runner sits in settle()’s state read, which never answers: only the grace’s cleanup ends it.
  let cleaned = 0;
  const held = watch(() => {
    cleaned += 1;
  });
  t.pass(6);
  const until = Date.now() + 2000;
  while (!cleaned && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
  held.end();
  assert.equal(cleaned, 1, 'the cleanup ran, once');
  assert.match(String(held.bound.stopped?.why), /past --max-minutes 5/);
  // A runner that gets past its waits ends the watch within the grace: no cleanup from here.
  let early = 0;
  const done = watch(() => {
    early += 1;
  });
  t.pass(6);
  const stopped = Date.now() + 2000;
  while (!done.bound.stopped && Date.now() < stopped) await new Promise((r) => setTimeout(r, 2));
  done.end();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(early, 0, 'no cleanup for a run that ended in time');
});
