// #585: the conformance tool’s guards against a run that checked nothing. A CLI that can’t run, a check that throws
// and a check that reports nothing each give a failing result, and the summary prints each as FAIL. The table and
// the version reader are injected, so no CLI runs; tests/process/conformance-app-server.test.mjs runs a real one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBackend, summary } from '../tools/conformance/run.mjs';

const passing = async () => [{ name: 'it holds', ok: true, detail: 'fine' }];
const runs = (/** @type {any[]} */ checks, version = async () => 'fake-cli 1.0') => checkBackend('fake', { fake: { bin: () => '/bin/fake', checks } }, version);

test('a CLI that can’t run is one failing result, no check runs, and the summary says FAIL', async () => {
  let ran = false;
  const check = async () => {
    ran = true;
    return [{ name: 'x', ok: true, detail: '' }];
  };
  const run = await runs([check], async () => null);
  assert.equal(run.version, null);
  assert.deepEqual(
    run.results.map((r) => r.ok),
    [false],
  );
  assert.equal(ran, false);
  assert.match(summary([run]).join('\n'), /^ {2}FAIL {2}its CLI runs: \/bin\/fake --version failed$/m);
});

test('a check that throws is a failing result that says why, and the others still run', async () => {
  const run = await runs([
    async function brokenCheck() {
      throw new Error('codex app-server exited (1)');
    },
    passing,
  ]);
  assert.deepEqual(
    run.results.map((r) => [r.name, r.ok]),
    [
      ['brokenCheck', false],
      ['it holds', true],
    ],
  );
  assert.match(summary([run]).join('\n'), /^ {2}FAIL {2}brokenCheck: the probe failed: codex app-server exited \(1\)$/m);
});

test('a check that reports nothing fails, rather than leaving the run to pass on the rest', async () => {
  const run = await runs([
    async function silentCheck() {
      return [];
    },
    passing,
  ]);
  assert.deepEqual(
    run.results.map((r) => [r.name, r.ok]),
    [
      ['silentCheck', false],
      ['it holds', true],
    ],
  );
});

test('the summary prints each result as it is, with the version', () => {
  const lines = summary([
    {
      backend: 'fake',
      version: 'fake-cli 1.0',
      results: [
        { name: 'a', ok: true, detail: 'x' },
        { name: 'b', ok: false, detail: 'y' },
      ],
    },
  ]);
  assert.deepEqual(lines, ['fake (fake-cli 1.0)', '  PASS  a: x', '  FAIL  b: y']);
});
