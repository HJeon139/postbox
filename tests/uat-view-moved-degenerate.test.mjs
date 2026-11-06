// #531’s view-moved check (server/room-checks-view.mjs) on runs where it compared no pair of samples: a count of 0
// needs a cause, so each says it checked nothing, rather than passing silently (critic’s pass on #773). Synthetic
// samples, as tools/uat/view-probe.mjs records them in facts.probes.views.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VIEW_CHECKS } from '../server/room-checks-view.mjs';

const T0 = Date.UTC(2026, 10, 6, 9);
const ORIGIN = T0 - 60_000;
/** A settled reading sample of #main at a step, its anchor where it was. */
const sample = (step, o = {}) => ({
  step,
  at: T0 + step * 1000,
  where: 'main',
  thread: 't_big',
  origin: ORIGIN,
  mode: 'reading',
  anchorId: 'it_big0500',
  expected: 120,
  actual: 120,
  gap: 40_000,
  prev: { anchorId: 'it_big0500', actual: 120 },
  settled: true,
  ...o,
});
const check = VIEW_CHECKS.find((c) => c.id === 'view-moved');
/** @param {any[]} views  @param {any[]} [inputs]  @param {number} [viewMisses] */
const run = (views, inputs = [], viewMisses = 0) => check.run({ probes: { views, inputs, viewMisses } });
const unverified = (out) => out.filter((x) => x.unverified);
/** A scroll between each pair of steps 1..n. */
const scrollsBetween = (n) => Array.from({ length: n - 1 }, (_, i) => ({ step: i + 1, at: T0 + (i + 1) * 1000 + 500, kind: 'scroll' }));

test('view-moved says it checked nothing when no sample settled', () => {
  const views = Array.from({ length: 8 }, (_, i) => sample(i + 1, { settled: false }));
  const rows = unverified(run(views));
  assert.equal(rows.length, 1);
  assert.match(rows[0].evidence, /8 samples, 0 settled, so there was nothing to compare/);
  assert.equal(rows[0].unverified.check, 'view-moved');
});

test('view-moved says it checked nothing when only one sample settled', () => {
  const rows = unverified(run([sample(1)]));
  assert.equal(rows.length, 1);
  assert.match(rows[0].evidence, /1 sample, 1 settled, so there was no pair to compare/);
});

test('view-moved says it checked nothing when an input came between every pair, as phase 1’s paging does', () => {
  const views = Array.from({ length: 6 }, (_, i) => sample(i + 1));
  const rows = unverified(run(views, scrollsBetween(6)));
  assert.equal(rows.length, 1);
  assert.match(rows[0].evidence, /all 5 pairs of settled samples had an input between them/);
});

test('view-moved says when the probe missed the view at some steps, even with samples', () => {
  const rows = unverified(run([sample(1), sample(2)], [], 7));
  assert.equal(rows.length, 1);
  assert.match(rows[0].evidence, /missed the view at 7 steps/);
});

test('view-moved says nothing more when it compared a pair with no input between', () => {
  const views = [sample(1), sample(2), sample(3)];
  assert.deepEqual(run(views, [{ step: 1, at: T0 + 1500, kind: 'scroll' }]), []);
});

test('view-moved tallies each transcript on its own: a compared pair in one doesn’t cover the other', () => {
  const panel = (step) => sample(step, { where: 'panel', thread: 't_side' });
  const views = [sample(1), sample(2), panel(1)];
  const rows = unverified(run(views));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unverified.thread, 't_side');
});
