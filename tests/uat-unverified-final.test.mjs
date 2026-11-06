// The runner’s check findings that say a check couldn’t vouch for the run (unverified rows) describe the whole run, so
// the last pass decides them (tools/uat/checks.mjs, dropUnverified): a row an early step found, such as view-moved’s
// “1 sample, so no pair”, isn’t kept once the run has more (critic’s pass on #773).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropUnverified, lastCheckPass } from '../tools/uat/checks.mjs';

test('dropUnverified removes the check rows that say a check couldn’t vouch, and keeps every other finding, another source’s too', () => {
  const findings = new Map([
    ['view-moved:view-moved:unverified:no-pair:main:t', { source: 'check', check: 'view-moved', unverified: { check: 'view-moved' } }],
    ['view-moved:view-moved:moved:main:t:1-2', { source: 'check', check: 'view-moved' }],
    ['tester:1', { source: 'tester', title: 'A tester finding' }],
    ['coverage-gap:p1', { source: 'coverage', unverified: null }],
    ['telemetry:t', { source: 'telemetry', unverified: { check: 'delivery-dropped' } }],
  ]);
  dropUnverified(findings);
  assert.deepEqual([...findings.keys()], ['view-moved:view-moved:moved:main:t:1-2', 'tester:1', 'coverage-gap:p1', 'telemetry:t']);
});

test('lastCheckPass drops the early unverified rows before the pass that adds the final ones', () => {
  const findings = new Map([['view-moved:early', { source: 'check', check: 'view-moved', unverified: { check: 'view-moved' }, evidence: '1 sample' }]]);
  const added = lastCheckPass(findings, () => {
    assert.equal(findings.size, 0, 'the early row is gone when the last pass runs');
    findings.set('view-moved:final', { source: 'check', unverified: { check: 'view-moved' }, evidence: '6 samples' });
    return ['view-moved:final'];
  });
  assert.deepEqual(added, ['view-moved:final']);
  assert.equal(findings.get('view-moved:final').evidence, '6 samples');
});
