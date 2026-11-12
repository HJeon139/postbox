// tests/server-log.mjs: what a Postbox in a test’s process logs fails that test when it’s a route’s 500, an unhandled
// rejection, a process warning, a TypeError or ReferenceError, or any stack trace; a test names what it expects.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowServerLog, captureServerLog, failsTest, takeServerFailures } from './server-log.mjs';

captureServerLog();

/** Runs fn with the console’s and stderr’s own output dropped, so the test’s output stays clean. */
function quietly(fn) {
  const write = process.stderr.write;
  // The console’s capture records each line before the console writes it, so dropping the write loses nothing here.
  process.stderr.write = () => true;
  try {
    fn();
  } finally {
    process.stderr.write = write;
  }
}

test('a route’s 500, a TypeError, a ReferenceError and a stack trace fail; a plain line Postbox explains doesn’t', () => {
  const at = '    at route (server/index.mjs:323:18)';
  assert.equal(failsTest({ kind: 'console.error', text: 'Postbox couldn’t answer POST /api/threads: oops' }), true);
  assert.equal(failsTest({ kind: 'console.error', text: 'TypeError [ERR_INVALID_ARG_TYPE]: The first argument must be…' }), true);
  assert.equal(failsTest({ kind: 'console.warn', text: 'ReferenceError: x is not defined' }), true);
  assert.equal(failsTest({ kind: 'stderr', text: `Error: boom\n${at}` }), true);
  assert.equal(failsTest({ kind: 'unhandled rejection', text: 'Error: boom' }), true);
  assert.equal(failsTest({ kind: 'process warning', text: 'MaxListenersExceededWarning: …' }), true);
  assert.equal(failsTest({ kind: 'console.error', text: 'Postbox couldn’t stop the hosts’ link cleanly as it shut down: closed' }), false);
});

test('what a test logs is taken once, and a log it names is allowed as many times as it says', () => {
  quietly(() => {
    allowServerLog(/expected failure/);
    console.error(new Error('an expected failure'));
    console.error(new Error('an expected failure'));
    console.error(new TypeError('not expected'));
  });
  const failures = takeServerFailures();
  assert.equal(failures.length, 2, failures.join('\n'));
  assert.match(failures[0], /^console\.error: Error: an expected failure\n\s+at /, 'the second one, past its one allowed time');
  assert.match(failures[1], /^console\.error: TypeError: not expected/);
  assert.deepEqual(takeServerFailures(), [], 'taken once');
});
