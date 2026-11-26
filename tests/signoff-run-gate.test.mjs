import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../tools/signoff/args.mjs';
import { MIN_FREE_INODES } from '../tools/signoff/gate-run.mjs';
import { PROGRESS_MS } from '../tools/signoff/wait.mjs';
import { EXIT, signoff } from '../tools/signoff.mjs';
import { GIT_DIR, NODE22, world } from './signoff-fake.mjs';

const line = (w, re) => w.lines.find((l) => re.test(l));
const ran = (w, re) => w.calls.filter((c) => re.test(c.argv.join(' ')));
const logOf = (w) => JSON.parse(w.files.get(`${GIT_DIR}/signoff/${w.head}.json`));

test('--run-gate writes a gate log for this head that a later run without it accepts', async () => {
  const w = world();
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.pass, w.lines.join('\n'));
  const log = logOf(w);
  assert.equal(log.head, w.head);
  assert.deepEqual(log.node, { major: 22, version: 'v22.11.0' });
  assert.deepEqual(
    log.commands.map((c) => [c.name, c.argv.join(' '), c.env.POSTBOX_STREAM_LAG, c.code]),
    [
      ['check', 'npm run check', undefined, 0],
      ['browser', 'npx playwright test', '', 0],
      ['browser, events late', 'npx playwright test', '300', 0],
    ],
  );
  w.lines.length = 0;
  assert.equal(await signoff(['840'], w.d), EXIT.pass, w.lines.join('\n'));
  assert.match(line(w, /^✔ 5\./), /passed on v22\.11\.0/);
});

test('--run-gate runs the gate on CI’s Node, holding the heavy-suite slot, which the suites inside don’t wait for again', async () => {
  const w = world();
  await signoff(['840', '--run-gate'], w.d);
  const check = ran(w, /^npm run check$/)[0];
  assert.ok(check.o.env.PATH.startsWith(`${NODE22.replace(/\/node$/, '')}:`));
  assert.equal(check.o.env.POSTBOX_HEAVY_HELD, '1');
  assert.equal(w.acquired.length, 1);
  assert.equal(w.acquired[0].dir, undefined, 'the repo’s own lock folder');
  assert.equal(w.released, 1);
});

test('--lock takes the slot in the folder given', async () => {
  const w = world();
  await signoff(['840', '--run-gate', '--lock', '/tmp/my-lock'], w.d);
  assert.equal(w.acquired[0].dir, '/tmp/my-lock');
});

test('a gate command that fails is in the log with its code, stops the run, and fails step 5', async () => {
  const w = world({ answers: [[/^npx playwright test$/, (_a, o) => ({ code: o.env.POSTBOX_STREAM_LAG ? 0 : 1, out: '' })]] });
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.gate);
  assert.deepEqual(
    logOf(w).commands.map((c) => [c.name, c.code]),
    [
      ['check', 0],
      ['browser', 1],
    ],
  );
  assert.match(line(w, /^✖ 5\./), /“browser” exited 1/);
  assert.equal(w.released, 1, 'the slot is let go');
});

test('each --spec is its own argv entry, and a log limited to specs doesn’t sign off', async () => {
  const w = world();
  for (const s of ['tests/browser/a.spec.mjs', 'tests/browser/b c.spec.mjs']) w.files.set(`/repo/${s}`, '');
  const code = await signoff(['840', '--run-gate', '--spec', 'tests/browser/a.spec.mjs', '--spec', 'tests/browser/b c.spec.mjs'], w.d);
  assert.equal(code, EXIT.gate);
  const runs = ran(w, /^npx playwright test/);
  assert.equal(runs.length, 2);
  for (const r of runs) assert.deepEqual(r.argv.slice(3), ['tests/browser/a.spec.mjs', 'tests/browser/b c.spec.mjs']);
  assert.match(line(w, /^✖ 5\./), /limited to 2 spec files/);
});

test('an empty spec list is an error before anything runs', async () => {
  for (const argv of [
    ['840', '--run-gate', '--spec'],
    ['840', '--run-gate', '--spec', ''],
    ['840', '--run-gate', '--spec', '--lock', '/tmp/l'],
  ]) {
    const w = world();
    assert.equal(await signoff(argv, w.d), EXIT.usage, argv.join(' '));
    assert.match(w.lines[0], /^--spec needs a value/);
    assert.equal(w.calls.length, 0, 'nothing ran');
  }
  assert.match(parseArgs(['840', '--spec', 'a.spec.mjs']).error, /only with --run-gate/);
  assert.match(parseArgs([]).error, /pull request’s number/);
});

test('a spec file that isn’t there fails step 5 before the gate runs', async () => {
  const w = world();
  assert.equal(await signoff(['840', '--run-gate', '--spec', 'tests/browser/nope.spec.mjs'], w.d), EXIT.gate);
  assert.match(line(w, /^✖ 5\./), /no such spec file: tests\/browser\/nope\.spec\.mjs/);
  assert.equal(ran(w, /^npm run check$/).length, 0);
});

test('too few free inodes in the temp folder fails step 5 before the slot is taken', async () => {
  const w = world();
  w.d.statfs = () => ({ ffree: MIN_FREE_INODES - 1 });
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.gate);
  assert.match(line(w, /^✖ 5\./), /free inodes/);
  assert.equal(w.acquired.length, 0);
});

test('a working tree with changes fails step 5: the log would not be for HEAD', async () => {
  const w = world({ answers: [[/^git status --porcelain --untracked-files=all$/, { code: 0, out: ' M server/store.mjs\n' }]] });
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.gate);
  assert.match(line(w, /^✖ 5\./), /working tree has changes/);
  assert.equal(ran(w, /^npm run check$/).length, 0);
});

test('the load is read once as the slot is taken, reported, warned above the core count, and in the summary', async () => {
  const w = world();
  let reads = 0;
  w.d.loadavg = () => [++reads === 1 ? 2 : 40, 0, 0];
  await signoff(['840', '--run-gate'], w.d);
  assert.ok(w.lines.includes('load 40.0 on 18 cores as the gate starts'));
  assert.ok(line(w, /^⚠ the load is above the core count/));
  assert.match(w.lines.at(-1), / load=40\.0\/18 /);
});

test('--run-gate doesn’t start the long run after an earlier step failed', async () => {
  const w = world({ prHead: '9'.repeat(40) });
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.head);
  assert.match(line(w, /^– 5\./), /skipped, an earlier step failed/);
  assert.equal(ran(w, /^npm run check$/).length, 0);
  assert.match(w.lines.at(-1), /failed=1 skipped=1/);
});

test('a long command prints a line at least once a minute while it runs, and stops when it ends', async () => {
  const w = world({
    answers: [
      [
        /^npm run check$/,
        (_a, _o, world) => {
          world.tick(PROGRESS_MS);
          world.tick(PROGRESS_MS);
          return { code: 0, out: '' };
        },
      ],
    ],
  });
  await signoff(['840', '--run-gate'], w.d);
  assert.ok(w.every <= 60_000, 'a line at least every minute');
  const waits = w.lines.filter((l) => l.startsWith('… still waiting on npm run check'));
  assert.deepEqual(waits, ['… still waiting on npm run check, 50 s so far', '… still waiting on npm run check, 100 s so far']);
  assert.equal(w.timers.size, 0, 'no timer outlives its command');
});

test('a working tree changed while the gate waits for its slot fails step 5, and writes no log', async () => {
  let waited = false;
  const w = world({ answers: [[/^git status --porcelain --untracked-files=all$/, () => ({ code: 0, out: waited ? ' M server/store.mjs\n' : '' })]] });
  const acquire = w.d.acquire;
  w.d.acquire = async (a) => {
    waited = true;
    return acquire(a);
  };
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.gate);
  assert.match(line(w, /^✖ 5\./), /the working tree changed while the gate waited for a heavy-suite slot \(1 paths\)/);
  assert.equal(w.files.has(`${GIT_DIR}/signoff/${w.head}.json`), false, 'no log');
  assert.equal(ran(w, /^npm run check$/).length, 0, 'nothing ran on a changed tree');
  assert.equal(w.released, 1, 'the slot is let go');
});

test('HEAD moved while the gate ran fails step 5, and writes no log', async () => {
  let moved = false;
  const w = world({
    answers: [
      [/^git rev-parse HEAD$/, (_a, _o, world) => ({ code: 0, out: `${moved ? '9'.repeat(40) : world.head}\n` })],
      [
        /^npm run check$/,
        () => {
          moved = true;
          return { code: 0, out: '' };
        },
      ],
    ],
  });
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.gate);
  assert.match(line(w, /^✖ 5\./), /HEAD moved from 82ffee08 to 99999999 while the gate ran/);
  assert.equal(w.files.has(`${GIT_DIR}/signoff/${w.head}.json`), false, 'no log');
  assert.equal(w.released, 1, 'the slot is let go');
});

test('a gate command that throws still lets the slot go, fails step 5 and writes no log', async () => {
  const w = world({
    answers: [
      [
        /^npx playwright test$/,
        () => {
          throw new Error('spawn npx EAGAIN');
        },
      ],
    ],
  });
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.gate);
  assert.match(line(w, /^✖ 5\./), /spawn npx EAGAIN/);
  assert.equal(w.released, 1, 'the slot is let go');
  assert.equal(w.files.has(`${GIT_DIR}/signoff/${w.head}.json`), false, 'no log');
});

test('a working tree changed while the gate ran fails step 5, and writes no log', async () => {
  let ran = false;
  const w = world({
    answers: [
      [/^git status --porcelain --untracked-files=all$/, () => ({ code: 0, out: ran ? '?? notes.md\n' : '' })],
      [
        /^npm run check$/,
        () => {
          ran = true;
          return { code: 0, out: '' };
        },
      ],
    ],
  });
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.gate);
  assert.match(line(w, /^✖ 5\./), /the working tree changed while the gate ran/);
  assert.equal(w.files.has(`${GIT_DIR}/signoff/${w.head}.json`), false, 'no log');
  assert.equal(w.released, 1, 'the slot is let go');
});

test('an untracked file fails the clean checks even where status.showUntrackedFiles=no would hide it', async () => {
  /** git status as it answers with showUntrackedFiles=no, unless the command asks for every untracked file. */
  const hidingUntracked = (out) => (argv) => {
    const all = argv.includes('--untracked-files=all');
    return { code: 0, out: all ? out() : out().replace(/^\?\? .*\n/gm, '') };
  };
  const before = world({ answers: [[/^git status --porcelain/, hidingUntracked(() => '?? scratch.mjs\n')]] });
  assert.equal(await signoff(['840', '--run-gate'], before.d), EXIT.gate);
  assert.match(line(before, /^✖ 5\./), /working tree has changes/);
  let ran = false;
  const during = world({
    answers: [
      [/^git status --porcelain/, hidingUntracked(() => (ran ? '?? notes.md\n' : ''))],
      [
        /^npm run check$/,
        () => {
          ran = true;
          return { code: 0, out: '' };
        },
      ],
    ],
  });
  assert.equal(await signoff(['840', '--run-gate'], during.d), EXIT.gate);
  assert.match(line(during, /^✖ 5\./), /the working tree changed while the gate ran/);
});
