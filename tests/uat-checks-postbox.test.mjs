// The check postbox-output (tools/uat/checks-postbox.mjs): a UAT run fails when its own Postbox prints an error or a
// warning, or exits by itself mid-run. A 500’s TypeError at Runtime.mcpContext reached the person’s terminal while
// every run’s log held such lines unread. The fixtures are real processes’ output, recorded through the runner’s own
// recorder (tools/uat/postbox-output.mjs): a clean Postbox started and stopped, a TypeError printed as server/index.mjs
// prints a 500’s, Node’s DeprecationWarning, and an uncaught error that ended its process.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECKS, runChecks } from '../tools/uat/checks.mjs';
import { failsRun } from '../tools/uat/checks-postbox.mjs';
import { OUTPUT_FILE, outputRecorder, writePostboxOutput } from '../tools/uat/postbox-output.mjs';
import { savedFacts } from '../tools/uat/recheck.mjs';
import { tempDir } from './temp-dirs.mjs';

/** @param {string} name */
const recorded = (name) => JSON.parse(readFileSync(new URL(`fixtures/uat/postbox-output/${name}.json`, import.meta.url), 'utf8'));
const check = (postboxOutput) => runChecks({ postboxOutput }, { only: ['postbox-output'] });
const clean = recorded('clean');

test('the UAT runs postbox-output among its checks, on Postbox’s output alone', () => {
  const c = CHECKS.find((x) => x.id === 'postbox-output');
  assert.ok(c, 'postbox-output is in CHECKS');
  assert.deepEqual(c.inputs, ['postboxOutput']);
});

test('a clean Postbox’s output, its banner, gives no finding and doesn’t fail the run', () => {
  assert.ok(clean.lines.length >= 3, 'the recorded start printed its banner');
  assert.deepEqual(check(clean), []);
  assert.equal(failsRun(check(clean)), false);
});

test('a 500’s TypeError and its stack are one finding, at the step it was printed, that fails the run', () => {
  const found = check({ lines: [...clean.lines, ...recorded('type-error').lines], exits: [] });
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].title, 'Postbox printed an error');
  assert.equal(found[0].severity, 'critical');
  assert.match(
    found[0].evidence,
    /^at step 3, on stderr: TypeError: \(\(intermediate value\) \?\? \[\]\)\.filter is not a function ⏎ at Runtime\.mcpContext \(.*server\/runtime\.mjs:3:37\)/,
  );
  assert.equal(failsRun(found), true);
});

test('the same error printed again is the same finding, counted, with the last step it was printed at', () => {
  const again = recorded('type-error').lines.map((l) => ({ ...l, step: 9 }));
  const found = check({ lines: [...recorded('type-error').lines, ...again], exits: [] });
  assert.equal(found.length, 1);
  assert.match(found[0].evidence, /^at step 3 and 1 more time\(s\), the last at step 9, on stderr: TypeError/);
});

test('Node’s DeprecationWarning is a warning finding, with its hint, that fails the run', () => {
  const found = check(recorded('deprecation'));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].title, 'Postbox printed a warning');
  assert.match(
    found[0].evidence,
    /^at step 5, on stderr: \(node:\d+\) \[DEP0005\] DeprecationWarning: Buffer\(\) is deprecated.* ⏎ \(Use `node --trace-deprecation/,
  );
  assert.equal(failsRun(found), true);
});

test('an exit mid-run is a crash finding, and the uncaught error Node printed before it is one more', () => {
  const found = check(recorded('crash'));
  assert.deepEqual(
    found.map((f) => f.title),
    ['Postbox printed an error', 'Postbox exited by itself mid-run'],
  );
  assert.match(
    found[0].evidence,
    /^at step 7, on stderr: file:.*crash\.mjs:2 ⏎ throw new Error\(.* ⏎ \^ ⏎ Error: The store’s lock was lost ⏎ at Timeout\._onTimeout .* ⏎ Node\.js v\d/,
  );
  assert.equal(found[1].evidence, 'It exited at step 7, with code 1, when the run hadn’t stopped it.');
  assert.equal(failsRun(found), true);
});

test('the recorder keeps whole lines, however the pipe splits and joins them', () => {
  let step = 2;
  const r = outputRecorder(() => step);
  r.feed('stderr', 'TypeError: x is not a func');
  r.feed('stderr', 'tion\n    at Runtime.mcpContext (runtime.mjs:3:37)\nlast');
  step = 4;
  r.flush();
  assert.deepEqual(r.output.lines, [
    { stream: 'stderr', text: 'TypeError: x is not a function', step: 2 },
    { stream: 'stderr', text: '    at Runtime.mcpContext (runtime.mjs:3:37)', step: 2 },
    { stream: 'stderr', text: 'last', step: 4 },
  ]);
});

/** A recheck’s facts from a run folder. @param {string} dir */
const rechecked = (dir) => savedFacts(dir, { state: { threads: {} }, mainId: 't1', saved: {}, logs: [], hostsRec: null, record: null });

test('a recheck reads the output a run kept, and finds its error and its exit again', () => {
  const dir = tempDir('uat-postbox-output-');
  writePostboxOutput(dir, { lines: [...clean.lines, ...recorded('crash').lines], exits: recorded('crash').exits });
  assert.ok(readFileSync(join(dir, OUTPUT_FILE), 'utf8'));
  const found = runChecks(rechecked(dir), { only: ['postbox-output'] });
  assert.deepEqual(
    found.map((f) => f.title),
    ['Postbox printed an error', 'Postbox exited by itself mid-run'],
  );
});

test('a recheck of a run from before the kept output reads its lines from run.log, and finds an error there', () => {
  const dir = tempDir('uat-postbox-output-');
  // As the runner logged each chunk: one timestamped line, its other lines after it without a timestamp.
  const chunk = (stream, lines) => `[10:00:0${lines.length % 10}] postbox${stream === 'stderr' ? ' (stderr)' : ''}: ${lines.map((l) => l.text).join('\n')}`;
  const log = [
    chunk('stdout', clean.lines),
    '[10:01:00] step 1 · The agents answered.',
    '[10:02:00] step 2 · The agents answered.',
    chunk('stderr', recorded('type-error').lines),
    '[10:03:00] step 3 · The agents answered.',
  ];
  writeFileSync(join(dir, 'run.log'), `${log.join('\n')}\n`);
  const found = runChecks(rechecked(dir), { only: ['postbox-output'] });
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0].evidence, /^at step 2, on stderr: TypeError: .* ⏎ at Runtime\.mcpContext/);
  writeFileSync(join(dir, 'run.log'), `${[chunk('stdout', clean.lines), '[10:01:00] step 1 · The agents answered.'].join('\n')}\n`);
  assert.deepEqual(runChecks(rechecked(dir), { only: ['postbox-output'] }), []);
});

test('only postbox-output’s findings fail the run, not another check’s or the tester’s', () => {
  assert.equal(failsRun([]), false);
  assert.equal(
    failsRun([
      { check: 'page-errors', source: 'check' },
      { source: 'tester', severity: 'critical' },
    ]),
    false,
  );
  assert.equal(failsRun([{ check: 'postbox-output', source: 'check' }]), true);
});
