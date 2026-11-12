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
