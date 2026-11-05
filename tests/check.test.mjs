import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, STAGES } from '../tools/check.mjs';
import { SLOT_DIR } from '../tools/heavy-lock.mjs';

/** A run whose stages take the given ms each and exit with the given codes, on a clock that only it moves. */
function fake(/** @type {Record<string, [number, number]>} */ stages) {
  let t = 0;
  /** @type {string[]} */
  const ran = [];
  /** @type {string[]} */
  const log = [];
  return {
    ran,
    log,
    now: () => t,
    log1: (/** @type {string} */ m) => log.push(m),
    run: async (/** @type {string} */ s) => {
      ran.push(s);
      const [ms, code] = stages[s] ?? [0, 0];
      t += ms;
      return code;
    },
  };
}

test('npm run check runs the same stages as before, in order: the quick ones first, the heavy ones last', () => {
  assert.deepEqual(STAGES, ['lint', 'typecheck', 'lint:project', 'check:contrast', 'test', 'test:integration', 'test:process']);
});

test('each stage’s time is printed as it ends, and a summary of every stage’s time at the end', async () => {
  const f = fake({ lint: [900, 0], test: [4300, 0], 'test:integration': [62_600, 0] });
  const code = await check({ stages: ['lint', 'test', 'test:integration'], run: f.run, now: f.now, log: f.log1 });
  assert.equal(code, 0);
  assert.deepEqual(f.log, [
    '✔ lint in 0.9 s',
    '✔ test in 4.3 s',
    '✔ test:integration in 62.6 s',
    'npm run check passed in 67.8 s: lint 0.9 s, test 4.3 s, test:integration 62.6 s.',
  ]);
});

test('a failing stage stops the check with its exit code, and the summary names it', async () => {
  const f = fake({ lint: [900, 0], test: [4300, 3] });
  const code = await check({ stages: ['lint', 'test', 'test:integration'], run: f.run, now: f.now, log: f.log1 });
  assert.equal(code, 3);
  assert.deepEqual(f.ran, ['lint', 'test'], 'nothing ran after the failure');
  assert.deepEqual(f.log.slice(1), ['✖ test failed (exit 3) in 4.3 s', 'npm run check failed at test after 5.2 s: lint 0.9 s, test 4.3 s.']);
});

/** A gate run folder that records whether it was closed. */
function fakeRunDir() {
  const r = { opened: 0, closed: 0, path: '/tmp/pb-gate-1-AbC123' };
  const open = () => {
    r.opened++;
    return { path: r.path, close: () => void r.closed++ };
  };
  return { r, runDir: { open } };
}

test('the test stages run with TMPDIR set to the run’s own folder, and the others with the environment unchanged', async () => {
  /** @type {Record<string, Record<string, string> | undefined>} */
  const envs = {};
  const { runDir } = fakeRunDir();
  const run = async (/** @type {string} */ s, /** @type {Record<string, string> | undefined} */ env) => {
    envs[s] = env;
    return 0;
  };
  await check({ run, runDir, now: () => 0, log: () => {} });
  for (const s of ['test', 'test:integration', 'test:process'])
    assert.deepEqual(envs[s], { TMPDIR: '/tmp/pb-gate-1-AbC123', POSTBOX_HEAVY_DIR: SLOT_DIR }, `${s}: its heavy-lock slots stay shared`);
  for (const s of ['lint', 'typecheck', 'lint:project', 'check:contrast']) assert.equal(envs[s], undefined, s);
});

test('the run’s folder is removed at the end of a passing check, and of a failing one', async () => {
  const pass = fakeRunDir();
  await check({ stages: ['test'], run: async () => 0, runDir: pass.runDir, now: () => 0, log: () => {} });
  const fail = fakeRunDir();
  await check({ stages: ['test', 'test:process'], run: async () => 1, runDir: fail.runDir, now: () => 0, log: () => {} });
  assert.deepEqual(
    [pass.r, fail.r].map(({ opened, closed }) => ({ opened, closed })),
    [
      { opened: 1, closed: 1 },
      { opened: 1, closed: 1 },
    ],
  );
});

test('the run’s folder is removed when a stage throws', async () => {
  const { r, runDir } = fakeRunDir();
  const run = async () => {
    throw new Error('spawn failed');
  };
  await assert.rejects(check({ stages: ['test'], run, runDir, now: () => 0, log: () => {} }), /spawn failed/);
  assert.equal(r.closed, 1);
});
