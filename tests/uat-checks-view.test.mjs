// The view’s checks: rows-skipped (#712a, tools/uat/checks-view.mjs): it fires when a room of more than 1,000 items has
// fewer than half of them skipped, the defect of the rule that lets the browser skip items off screen not working. It
// reads the skipped-items probe tools/uat/observe.mjs records each step (tools/uat/skip-probe.mjs), here as samples
// recorded in Chromium (tests/browser/skip-probe.spec.mjs) and edge cases made from them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHECKS, runChecks } from '../tools/uat/checks.mjs';
import { failsRun } from '../tools/uat/checks-postbox.mjs';

const recorded = JSON.parse(readFileSync(new URL('fixtures/uat/skip-probe-samples.json', import.meta.url), 'utf8'));
const [on] = recorded.on;
const [off] = recorded.off;
const run = (skipped) => runChecks({ probes: { skipped } }, { only: ['rows-skipped'] });
const defects = (skipped) => run(skipped).filter((x) => !x.unverified);

test('the UAT runs rows-skipped among its checks, for #712, on the probes alone', () => {
  const c = CHECKS.find((x) => x.id === 'rows-skipped');
  assert.ok(c, 'rows-skipped is in CHECKS');
  assert.deepEqual([c.issue, c.inputs], [712, ['probes']]);
});

test('on samples recorded in Chromium, rows-skipped is silent with the rule on and fires with it off', () => {
  assert.ok(on.skipped * 2 > on.items, `the recorded 'on' sample skipped most items (${on.skipped} of ${on.items})`);
  assert.deepEqual(run(recorded.on), []);
  const hits = run(recorded.off);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].issue, 712);
  assert.match(hits[0].evidence, /step 2, 0 of the conversation’s 1200 items were skipped[\s\S]*didn’t have the cv-skip class/);
});

test('rows-skipped names a long room whose items aren’t skipped though cv-skip is on', () => {
  const [hit] = run([{ ...off, gated: true }]);
  assert.match(hit.evidence, /had the cv-skip class/);
});

test('rows-skipped fires on any sample of a run, once', () => {
  assert.equal(run([...recorded.on, ...recorded.off]).length, 1);
});

test('rows-skipped is silent on a room of exactly 1,000 items, none of them skipped', () => {
  assert.deepEqual(run([{ ...off, items: 1000 }]), []);
});

test('rows-skipped fires on 1,001 items with 500 skipped, and is silent with exactly half skipped', () => {
  assert.equal(defects([{ ...on, items: 1001, skipped: 500 }]).length, 1);
  assert.deepEqual(run([{ ...on, items: 2000, skipped: 1000 }]), []);
});

test('rows-skipped skips a sample taken before the page drew its frames', () => {
  assert.deepEqual(run([{ ...off, settled: false }]), []);
});

test('rows-skipped can’t tell in a browser that can’t say what it skips, and lists that as unverified', () => {
  const hits = run([{ ...off, supported: false, skipped: null }]);
  assert.equal(defects([{ ...off, supported: false, skipped: null }]).length, 0, 'no defect');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].unverified, { check: 'rows-skipped', thread: off.thread });
  assert.equal(hits[0].issue, null);
  assert.match(hits[0].evidence, /can’t be told/);
});

test('rows-skipped says nothing of an unsupported browser’s short room, or of a run from before the probe', () => {
  assert.deepEqual(run([{ ...off, items: 900, supported: false, skipped: null }]), []);
  assert.deepEqual(runChecks({ probes: {} }, { only: ['rows-skipped'] }), []);
  assert.deepEqual(runChecks({}, { only: ['rows-skipped'] }), []);
});

// text-layout (#681, tools/uat/checks-view.mjs): the layout check of each whole-window screenshot
// (tools/uat/layout-probe.mjs), here as samples recorded in Chromium on tests/browser/text-layout.spec.mjs’s page built
// to draw text over text and a button, cut it off and break a word, and on its clean page, at 375 and 1280 px.
const layout = JSON.parse(readFileSync(new URL('fixtures/uat/layout-probe-samples.json', import.meta.url), 'utf8'));
const sampled = (samples, step = 4) => samples.map((s) => ({ step, at: 0, ...s }));
const runLayout = (samples) => runChecks({ probes: { layout: samples } }, { only: ['text-layout'] });

test('the UAT runs text-layout among its checks, for #681, on the probes alone', () => {
  const c = CHECKS.find((x) => x.id === 'text-layout');
  assert.ok(c, 'text-layout is in CHECKS');
  assert.deepEqual([c.issue, c.inputs], [681, ['probes']]);
});

test('text-layout is silent on the clean page at both widths, and doesn’t fail the run', () => {
  assert.deepEqual(
    layout.clean.map((s) => s.width),
    [375, 1280],
  );
  const found = runLayout(sampled(layout.clean));
  assert.deepEqual(found, []);
  assert.equal(failsRun(found), false);
});

for (const [i, width] of [375, 1280].entries())
  test(`at ${width} px text-layout finds each problem the bad page was built with, and they fail the run`, () => {
    const found = runLayout(sampled([layout.bad[i]]));
    assert.deepEqual(found.map((f) => f.key.split(':')[1]).sort(), ['mid-word-break', 'text-cut-off', 'text-on-control', 'text-overlap']);
    for (const f of found) {
      assert.equal(f.issue, 681);
      assert.match(f.evidence, new RegExp(`^At step 4, in a window ${width} px wide: At ${width} px, “`));
    }
    assert.equal(failsRun(found), true);
  });

test('the same problems on screenshots at both widths are one finding each, the first one’s', () => {
  const found = runLayout([...sampled([layout.bad[0]], 2), ...sampled([layout.bad[1]], 7)]);
  assert.equal(found.length, 4, JSON.stringify(found.map((f) => f.key)));
  for (const f of found) assert.match(f.evidence, /^At step 2, in a window 375 px wide/);
});

test('a problem measured at another size on a later screenshot is the same finding', () => {
  const moved = layout.bad[1].problems.map((p) => ({ ...p, message: p.message.replace(/by \d+ × \d+ px/, 'by 3 × 9 px') }));
  assert.equal(runLayout([...sampled([layout.bad[0]]), ...sampled([{ width: 1280, problems: moved }])]).length, 4);
});

test('a screenshot text-layout couldn’t measure is unverified, and fails nothing', () => {
  const found = runLayout(sampled([{ error: 'Execution context was destroyed' }]));
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].unverified, { check: 'text-layout', step: 4 });
  assert.equal(found[0].issue, null);
  assert.match(found[0].evidence, /^At step 4: Execution context was destroyed/);
  assert.equal(failsRun(found), false);
});

test('a check that threw is unverified, while the problems the others found still fail the run', () => {
  const threw = { code: 'check-error', message: 'At 375 px, Postbox couldn’t check for mid-word-break: boom' };
  const alone = runLayout(sampled([{ width: 375, problems: [threw] }]));
  assert.deepEqual(
    alone.map((f) => !!f.unverified),
    [true],
  );
  assert.equal(failsRun(alone), false);
  const found = runLayout(sampled([{ width: 375, problems: [threw, layout.bad[0].problems[0]] }]));
  assert.deepEqual(
    found.map((f) => !!f.unverified),
    [true, false],
  );
  assert.equal(failsRun(found), true);
});

test('text-layout says nothing of a run from before the probe', () => {
  assert.deepEqual(runChecks({ probes: {} }, { only: ['text-layout'] }), []);
});
