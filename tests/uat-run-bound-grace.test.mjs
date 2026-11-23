// A UAT run’s bound past its wall time (tools/uat/run-bound.mjs): a run held by a Postbox that answers nothing reaches
// its own cleanup after the grace; one in a long wait it chose, with Postbox answering, finishes and reports.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overdueStop, runBound, watchRun } from '../tools/uat/run-bound.mjs';
import { runStop } from '../tools/uat/stop.mjs';
import { clock, se } from './uat-run-bound-fixture.mjs';

/** Waits until `done` or 2 s, polling every 2 ms. @param {() => unknown} done */
const until = async (done) => {
  const end = Date.now() + 2000;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
};

test('past --max-minutes, a run whose Postbox answers nothing for the grace reaches its cleanup, once', async () => {
  const t = clock();
  const bound = runBound({ minutes: '5', now: t.now });
  let cleaned = 0;
  const lines = [];
  // The runner sits in settle()’s state read, which never answers: only the grace’s cleanup ends it.
  const end = watchRun({
    bound,
    budget: { on: false },
    api: () => new Promise(() => {}),
    threadsUnderTest: () => [],
    stop: async () => {},
    log: (l) => lines.push(l),
    every: 1,
    grace: 30,
    overdue: () => (cleaned += 1),
  });
  t.pass(6);
  await until(() => cleaned);
  await new Promise((r) => setTimeout(r, 40));
  end();
  assert.equal(cleaned, 1, 'the cleanup ran, once');
  assert.ok(
    lines.some((l) => /answered nothing.*exiting without a report/.test(l)),
    lines.join('\n'),
  );
});

test('past --max-minutes, a run in a long wait it chose, with Postbox answering, isn’t cleaned up', async () => {
  const t = clock();
  const bound = runBound({ minutes: '5', now: t.now });
  let cleaned = 0;
  // A phase’s named wait of minutes, say: the runner is busy, and Postbox answers every read.
  const end = watchRun({
    bound,
    budget: { on: false },
    api: async () => ({ state: { sessions: {} } }),
    threadsUnderTest: () => [],
    stop: async () => {},
    every: 1,
    grace: 30,
    overdue: () => (cleaned += 1),
  });
  t.pass(6);
  await until(() => bound.stopped);
  await new Promise((r) => setTimeout(r, 150));
  end();
  assert.ok(bound.stopped, 'the run stops at its bound');
  assert.equal(cleaned, 0, 'and finishes its wait, to report as any run does');
});

test('a run stopped at its turn cap, then held by a silent Postbox past --max-minutes, still reaches its cleanup', async () => {
  const t = clock();
  const bound = runBound({ turns: '1', minutes: '5', now: t.now });
  bound.see([se('a', 't1')]);
  bound.beforeStep(2);
  assert.match(String(bound.stopped?.why), /--max-turns 1/);
  let cleaned = 0;
  const end = watchRun({
    bound,
    budget: { on: false },
    api: () => new Promise(() => {}),
    threadsUnderTest: () => [],
    stop: async () => {},
    every: 1,
    grace: 30,
    overdue: () => (cleaned += 1),
  });
  t.pass(6);
  await until(() => cleaned);
  end();
  assert.equal(cleaned, 1);
});

test('the overdue cleanup is the run’s own stop, then an exit that keeps a signal’s code', async () => {
  const done = [];
  const stop = runStop({ keep: () => done.push('kept the transcripts'), postbox: { kill: async () => void done.push('stopped Postbox') }, log: () => {} });
  const exits = [];
  const was = process.exitCode;
  try {
    process.exitCode = undefined;
    overdueStop(stop, (code) => exits.push(code))();
    await until(() => exits.length);
    assert.deepEqual(done, ['kept the transcripts', 'stopped Postbox'], 'the run’s cleanup ran');
    assert.deepEqual(exits, [1]);
    process.exitCode = 130;
    overdueStop(stop, (code) => exits.push(code))();
    await until(() => exits.length > 1);
    assert.deepEqual(exits, [1, 130], 'after a signal, its 130');
    assert.equal(done.length, 2, 'and the cleanup ran once');
  } finally {
    process.exitCode = was;
  }
});
