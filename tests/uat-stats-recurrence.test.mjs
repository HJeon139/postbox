// #213: uat-stats prints recurrence by issue, counted as tests/uat/e2e/README.md (“Recurring findings”) counts it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECURRENCE_COLUMNS, recurrence, recurrenceTable } from '../tools/uat/stats.mjs';

const check = (issue, over = {}) => ({ source: 'check', check: 'a-check', issue, key: `k${issue}`, ...over });
const runs = [
  {
    run: '2026-10-22T01-01-16-scifact',
    findings: [
      // The run that filed an issue is part of its recurrence count.
      { source: 'tester', title: 'Filed finding', verdict: 'confirmed', filed: 106 },
      // #250: the run that filed #156, and one later run that caught it again, are two runs.
      { source: 'tester', title: 'Filed it', verdict: 'confirmed', filed: 156 },
      check(63),
      check(63, { key: 'again' }),
      check(106),
      // Not counted: a measurement, a coverage row, a tester’s guess, and a closed issue’s match that wasn’t verified.
      { source: 'check', check: 'prose-instead-of-block', issue: null, key: 'block-use:1-of-2', verdict: 'measurement' },
      { source: 'run', check: 'coverage-gap', issue: 123, key: 'phase-2', verdict: 'duplicate' },
      { source: 'tester', title: 'Something', issue: 128 },
      check(49, { closedIssue: { issue: 49, hasFix: null } }),
      // A closed issue’s match from a run without its fix: the defect as it was, not a recurrence.
      check(63, { key: 'before-fix', verdict: 'duplicate', verdictBy: 'runner', duplicateOf: 63, closedIssue: { issue: 63, hasFix: false } }),
    ],
  },
  {
    run: '2026-10-23T21-18-25-p0',
    findings: [
      check(63),
      // A verifier’s match counts by the issue it named.
      { source: 'tester', title: 'Draft lost', issue: null, verdict: 'duplicate', verdictBy: 'verifier', duplicateOf: 106 },
      // The verifier found the check wrong: harness, not a recurrence.
      check(123, { verdict: 'harness', verdictBy: 'verifier' }),
      check(156),
    ],
  },
  { run: '2026-10-23T21-31-02-workroom', findings: [check(106)] },
];
const issues = new Map([
  [63, { state: 'CLOSED', closedAt: '2026-10-23T16:16:31Z', priority: 'P1' }],
  [106, { state: 'OPEN', closedAt: null, priority: 'P1' }],
  [156, { state: 'OPEN', closedAt: null, priority: null }],
]);

test('recurrence counts duplicate verdicts, and the finding that filed the issue, once per run, with the runs after each issue closed', () => {
  assert.deepEqual(
    recurrence(runs, issues).map((x) => [x.issue, x.state, x.priority, x.runs, x.findings, x.after]),
    [
      [106, 'OPEN', 'P1', 3, 4, 0],
      [156, 'OPEN', null, 2, 2, 0],
      // #63 closed at 16:16 on 23 October: only the run after that counts.
      [63, 'CLOSED', 'P1', 1, 1, 1],
    ],
  );
  // Without gh, nothing is known about the issues, nor which runs came after they closed.
  assert.deepEqual(
    recurrence(runs).map((x) => [x.issue, x.state, x.after]),
    [
      [106, undefined, null],
      [63, undefined, null],
      [156, undefined, null],
    ],
  );
});

test('the table keeps its columns: issue, state, priority, runs, findings, runs after close', () => {
  assert.deepEqual(RECURRENCE_COLUMNS, ['Issue', 'State', 'Priority', 'Runs', 'Findings', 'Runs after close']);
  const [, head, first, second, third] = recurrenceTable(recurrence(runs, issues));
  assert.equal(head, '  Issue  State   Priority  Runs  Findings  Runs after close');
  assert.equal(first, '  #106   open    P1        3     4         0');
  assert.equal(second, '  #156   open    —         2     2         0');
  assert.equal(third, '  #63    closed  P1        1     1         1');
  assert.equal(recurrenceTable(recurrence(runs))[2], '  #106   ?      —         3     4         ?');
  assert.deepEqual(recurrenceTable([]), ['Recurrence by issue: no run filed or caught a known issue.']);
});
