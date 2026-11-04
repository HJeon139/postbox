// #531’s view-moved check (server/room-checks-view.mjs): what you were reading moved, or the view’s mode changed, with
// no input of yours or the runner’s between two settled samples of the view probe (tools/uat/view-probe.mjs). It
// should never fire. Synthetic samples, as the probe records them in facts.probes.views, with the run’s inputs in
// facts.probes.inputs (B1b-b).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../server/room-checks.mjs';
import { VIEW_CHECKS } from '../server/room-checks-view.mjs';

const T0 = Date.UTC(2026, 10, 4, 9);
const ORIGIN = T0 - 60_000;
/** A settled reading sample of #main at a step, as the probe records it. */
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
  prev: null,
  settled: true,
  ...o,
});
const following = (step, o = {}) => sample(step, { mode: 'following', anchorId: '', expected: null, actual: null, gap: 0, ...o });
const check = VIEW_CHECKS.find((c) => c.id === 'view-moved');
const run = (views, inputs = []) => check.run({ probes: { views, inputs } });
const findings = (views, inputs) => run(views, inputs).filter((x) => !x.unverified);

// A jump of more than half the view: the anchor across the middle is a new item, and the old one is 780 px lower.
const jump = [
  sample(1, { anchorId: 'it_big0500', actual: 120, expected: 120 }),
  sample(2, { anchorId: 'it_big0480', actual: 140, expected: 140, prev: { anchorId: 'it_big0500', actual: 900 } }),
];
// The rule of the design’s second revision: compare only an anchor that stayed the same.
const sameAnchorRule = (views) => views.slice(1).filter((b, i) => b.anchorId === views[i].anchorId && Math.abs(b.actual - views[i].actual) > 1);

test('view-moved fires on a jump past half the view with no input, which a same-anchor rule misses', () => {
  assert.deepEqual(sameAnchorRule(jump), [], 'the anchor changed, so comparing only the same anchor says nothing');
  const hits = findings(jump);
  assert.equal(hits.length, 1);
  assert.match(hits[0].evidence, /it_big0500[\s\S]*120[\s\S]*900/);
});

test('view-moved fires when the view went from following to reading, or back, with no input', () => {
  assert.equal(findings([following(1), sample(2)]).length, 1);
  assert.equal(findings([sample(1), following(2)]).length, 1);
});

test('view-moved stays silent when a scroll, or a runner’s click, came between the two samples', () => {
  assert.deepEqual(findings(jump, [{ step: 1, at: T0 + 1500, kind: 'scroll' }]), []);
  assert.deepEqual(findings(jump, [{ step: 1, at: T0 + 1500, kind: 'runner-click' }]), []);
  assert.deepEqual(findings([following(1), sample(2)], [{ step: 1, at: T0 + 1500, kind: 'scroll' }]), []);
});

test('view-moved fires for an input outside the two samples: one before the first doesn’t excuse the move', () => {
  assert.equal(findings(jump, [{ step: 0, at: T0 + 500, kind: 'scroll' }]).length, 1);
});

test('view-moved doesn’t compare samples from two page loads', () => {
  assert.deepEqual(findings([jump[0], { ...jump[1], origin: ORIGIN + 30_000 }]), []);
  assert.deepEqual(findings([following(1), sample(2, { origin: ORIGIN + 30_000 })]), []);
});

test('view-moved doesn’t compare two transcripts: main and the panel, or the panel on another thread', () => {
  assert.deepEqual(findings([following(1), sample(2, { where: 'panel' })]), []);
  assert.deepEqual(findings([following(1, { where: 'panel' }), sample(2, { where: 'panel', thread: 't_other' })]), []);
});

test('view-moved skips an unsettled sample', () => {
  assert.deepEqual(findings([jump[0], { ...jump[1], settled: false }]), []);
  assert.deepEqual(findings([following(1), sample(2, { settled: false })]), []);
  assert.deepEqual(findings([sample(1, { actual: 130, settled: false })]), []);
});

test('view-moved says nothing on a run with no inputs recorded: it can’t tell a scroll from a move', () => {
  assert.deepEqual(check.run({ probes: { views: jump } }), []);
  assert.deepEqual(check.run({ probes: { views: [following(1), sample(2), sample(3, { actual: 150 })] } }), []);
  assert.deepEqual(check.run({ probes: {} }), []);
});

test('view-moved skips a step the runner caused', () => {
  assert.deepEqual(findings([jump[0], { ...jump[1], cause: 'runner' }]), []);
  assert.deepEqual(findings([following(1), sample(2, { cause: 'runner' })]), []);
});

test('view-moved fires on one sample whose published offset is stale by more than a pixel', () => {
  const hits = findings([sample(1, { expected: 120, actual: 125.5 })]);
  assert.equal(hits.length, 1);
  assert.match(hits[0].evidence, /120[\s\S]*125\.5/);
  assert.deepEqual(findings([sample(1, { expected: 120, actual: 121 })]), []);
});

test('view-moved fires when following leaves the view more than 2 px above the end, and not at 2 px', () => {
  assert.equal(findings([following(1), following(2, { gap: 3 })]).length, 1);
  assert.deepEqual(findings([following(1), following(2, { gap: 2 })]), []);
});

test('view-moved stays silent when the anchor stayed within a pixel', () => {
  assert.deepEqual(findings([sample(1), sample(2, { actual: 120.8, expected: 120.8, prev: { anchorId: 'it_big0500', actual: 120.8 } })]), []);
});

test('view-moved records that it skipped a pair whose earlier anchor is no longer mounted, as unverified, not a finding', () => {
  const out = run([sample(1), sample(2, { anchorId: 'it_big0300', prev: null })]);
  assert.deepEqual(
    out.filter((x) => !x.unverified),
    [],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].unverified.check, 'view-moved');
  assert.match(out[0].evidence, /1 of 1/);
});

test('view-moved is one of the room checks, and reads only the probes', () => {
  assert.deepEqual(check.inputs, ['probes']);
  const out = runChecks({ probes: { views: jump, inputs: [] } }, { only: ['view-moved'] });
  assert.deepEqual(
    out.map((x) => x.check),
    ['view-moved'],
  );
});
