// The view’s check rows-skipped (#712a, tools/uat/checks-view.mjs): it fires when a room of more than 1,000 items has
// fewer than half of them skipped, the defect of the rule that lets the browser skip items off screen not working. It
// reads the skipped-items probe tools/uat/observe.mjs records each step (tools/uat/skip-probe.mjs), here as samples
// recorded in Chromium (tests/browser/skip-probe.spec.mjs) and edge cases made from them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHECKS, runChecks } from '../tools/uat/checks.mjs';

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
