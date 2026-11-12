// What Postbox logs while a test runs in the same process, so a test fails on a server error it didn’t expect. A
// Postbox a browser spec or an integration test starts runs in that test’s process, and its console.error,
// console.warn and stderr went only to the run’s output: a route that threw a TypeError on every Send now on a queued
// wake printed its stack in CI’s passing browser jobs, and shipped in v4.0.7 (#1247). The owner’s bar is any error,
// crash or warning, so everything recorded fails the test it’s logged in, a line without a stack too: a TypeError
// logged as its message alone (“… couldn’t record something: Cannot read properties of undefined”) reads like any
// other. A test that causes one on purpose names it with allowServerLog.

import { format, inspect } from 'node:util';

/** @typedef {{ kind: string, text: string }} Logged */

/** What was logged since the last take, in order. @type {Logged[]} */
let logged = [];
/** What the running test expects to be logged, each as many times as it said. @type {{ pattern: RegExp, left: number }[]} */
let allowed = [];
let installed = false;

/**
 * Node’s own warnings about its test runner’s experimental APIs, which the tests use and Postbox doesn’t, each by its
 * message: Node 22, which CI runs, warns once a process on t.mock.timers, and Node 24 doesn’t (CI run 43295324441).
 * Only the warning itself is left out: a process warning named ExperimentalWarning with that message, and the line
 * Node prints for it. An error, a rejection or another warning that only quotes the text still fails the test.
 */
const NODE_TEST_RUNNER = ['The MockTimers API is an experimental feature and might change at any time'];
const escaped = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The line Node prints for one of them, with its hint: `(node:123) ExperimentalWarning: …`. */
const NODE_LINE = new RegExp(
  `^\\(node:\\d+\\) ExperimentalWarning: (${NODE_TEST_RUNNER.map(escaped).join('|')})\\n?(\\(Use \`node --trace-warnings \\.\\.\\.\` to show where the warning was created\\)\\n?)?$`,
);
/** Records a line, unless it’s Node’s print of one of its test-runner warnings above. @param {Logged} entry */
const record = (entry) => {
  if ((entry.kind === 'stderr' || entry.kind.startsWith('console.')) && NODE_LINE.test(entry.text)) return;
  logged.push(entry);
};

/**
 * From now on, records what this process writes to console.error, console.warn and stderr, its unhandled promise
 * rejections and its process warnings. Each still reaches the output as before. Installed once a process.
 */
export function captureServerLog() {
  if (installed) return;
  installed = true;
  // A console call writes to stderr itself: that write is the console line, recorded once.
  let inConsole = false;
  for (const level of /** @type {const} */ (['error', 'warn'])) {
    const write = console[level];
    console[level] = (...args) => {
      record({ kind: `console.${level}`, text: format(...args) });
      inConsole = true;
      try {
        write.apply(console, args);
      } finally {
        inConsole = false;
      }
    };
  }
  const write = process.stderr.write;
  process.stderr.write = /** @type {any} */ (
    function (/** @type {any} */ chunk, /** @type {any[]} */ ...rest) {
      if (!inConsole) record({ kind: 'stderr', text: String(chunk) });
      return write.call(this, chunk, ...rest);
    }
  );
  process.on('unhandledRejection', (reason) => record({ kind: 'unhandled rejection', text: reason instanceof Error ? String(reason.stack) : inspect(reason) }));
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning' && NODE_TEST_RUNNER.includes(w.message)) return; // Node’s test runner’s, above
    record({ kind: 'process warning', text: String(w.stack ?? w) });
  });
}

/**
 * Lets the running test log a server error it causes on purpose, named by a pattern its text matches: as many times as
 * the test says, and no more (Infinity, for an outage fixture’s lines, whose count depends on the turns it stops). It
 * lasts until the test’s log is taken.
 * @param {RegExp} pattern  @param {{ times?: number }} [options]
 */
export function allowServerLog(pattern, { times = 1 } = {}) {
  allowed.push({ pattern, left: times });
}

/**
 * What was logged since the last take that the test didn’t allow, each as its kind and text; then starts a new log,
 * with nothing allowed. Call it once a test has ended.
 * @returns {string[]}
 */
export function takeServerFailures() {
  const failures = logged.filter((entry) => {
    const a = allowed.find((x) => x.left > 0 && x.pattern.test(entry.text));
    if (a) a.left--;
    return !a;
  });
  logged = [];
  allowed = [];
  return failures.map((entry) => `${entry.kind}: ${entry.text.trimEnd()}`);
}

/** Takes the log, and throws with what the test didn’t allow: for a node:test hook after each test that starts Postbox. */
export function assertNoServerFailures() {
  const failures = takeServerFailures();
  if (failures.length) throw new Error(`Postbox logged errors or warnings the test didn’t expect:\n${failures.join('\n')}`);
}
