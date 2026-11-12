// tests/server-log.mjs: anything a Postbox in a test’s process logs as an error or a warning fails that test, unless
// the test names it as expected.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowServerLog, captureServerLog, takeServerFailures } from './server-log.mjs';

// What reaches stderr in this file goes nowhere, so its output stays clean: the capture records each line first.
process.stderr.write = () => true;
captureServerLog();

test('every line Postbox writes to console.error, console.warn or stderr fails the test, a plain one too', () => {
  console.error('The work ledger couldn’t record something: Cannot read properties of undefined (reading ’id’)');
  console.warn('Postbox couldn’t stop the hosts’ link cleanly as it shut down: closed');
  process.stderr.write('a bare line\n');
  const failures = takeServerFailures();
  assert.deepEqual(
    failures.map((f) => f.split(':')[0]),
    ['console.error', 'console.warn', 'stderr'],
    failures.join('\n'),
  );
});

test('what a test logs is taken once, and a log it names is allowed as many times as it says', () => {
  allowServerLog(/expected failure/);
  console.error(new Error('an expected failure'));
  console.error(new Error('an expected failure'));
  console.error(new TypeError('not expected'));
  const failures = takeServerFailures();
  assert.equal(failures.length, 2, failures.join('\n'));
  assert.match(failures[0], /^console\.error: Error: an expected failure\n\s+at /, 'the second one, past its one allowed time');
  assert.match(failures[1], /^console\.error: TypeError: not expected/);
  assert.deepEqual(takeServerFailures(), [], 'taken once');
});

// Node 22, which CI runs, warns once a process when a test uses t.mock.timers; Node 24 doesn’t. That warning is Node’s
// test runner’s, not Postbox’s (CI run 43295324441, conversation-lifecycle.test.mjs). It’s named, so another warning,
// experimental or not, still fails the test.
test('Node’s warning about the test runner’s MockTimers doesn’t fail a test, and another ExperimentalWarning does', async () => {
  process.emitWarning('The MockTimers API is an experimental feature and might change at any time', 'ExperimentalWarning');
  process.emitWarning('Something else is an experimental feature', 'ExperimentalWarning');
  await new Promise((r) => setImmediate(r)); // warnings are emitted on the next tick
  const failures = takeServerFailures();
  assert.ok(failures.length > 0, 'the other warning fails');
  assert.ok(
    failures.every((f) => /Something else is an experimental feature/.test(f)),
    failures.join('\n'),
  );
});

// The exception is Node’s warning itself, by its name and its line, never a line that only quotes its text. (An unhandled
// rejection is recorded whatever it says; node:test fails a test on one itself, so it isn’t raised here.)
test('an error or a warning that only quotes the MockTimers text still fails the test', async () => {
  const text = 'ExperimentalWarning: The MockTimers API is an experimental feature and might change at any time';
  console.error(new TypeError(`Cannot read properties of undefined, near ${text}`));
  process.emitWarning(`The MockTimers API is an experimental feature and might change at any time`, 'DeprecationWarning');
  await new Promise((r) => setImmediate(r));
  const failures = takeServerFailures();
  assert.ok(
    failures.some((f) => /^console\.error: TypeError: Cannot read properties of undefined, near ExperimentalWarning/.test(f)),
    `the TypeError fails:\n${failures.join('\n')}`,
  );
  assert.ok(
    failures.some((f) => /^process warning: DeprecationWarning: The MockTimers API/.test(f)),
    `a warning of another name fails:\n${failures.join('\n')}`,
  );
});
