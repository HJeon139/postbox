// #213: a check that matches a closed issue isn’t a duplicate on sight. Whether the run had the fix comes from git, and a
// verifier judges whether the evidence shows the defect. gh, git and the verifier are stand-ins here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closedIssues, commentRegressions, hasFix, markClosed, presetFindings, verifyRegressions } from '../tools/uat/regressions.mjs';
import { setVerdict, verdictOf, withoutPreset } from '../tools/uat/verdicts.mjs';

const FIX = '9dd3c46c9116c2e0ca64ba31ca93c8617d5251ec';
const MERGE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';
const RUN = '7fa3a6df70ba2eb9f0c71a75d98fd4be9f9d5f12';
const OLD = 'c7a406692890b534054283cfc40fa21ade688482';
const ok = (stdout) => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout) });
// #123 was closed by a commit, #49 by pull request #173, and #106 is open.
// Comments posted through it land in `posted`, so a later pass sees them on the issue.
const gh =
  (calls = [], posted = []) =>
  (args) => {
    calls.push(args);
    const [cmd, sub, n] = args;
    if (cmd === 'issue' && sub === 'view' && args.includes('title,body')) return ok({ title: `Issue ${n}`, body: 'What went wrong.' });
    if (cmd === 'issue' && sub === 'view' && args.includes('comments')) return ok({ comments: posted.filter((c) => c.n === n) });
    if (cmd === 'issue' && sub === 'view')
      return ok(n === '106' ? { state: 'OPEN' } : { state: 'CLOSED', closedByPullRequestsReferences: n === '49' ? [{ number: 173 }] : [] });
    if (cmd === 'api') return ok(args[2].includes('/123/') ? `-\n${FIX}\n` : '-\n');
    if (cmd === 'pr') return ok({ mergeCommit: { oid: MERGE }, headRefOid: HEAD });
    if (cmd === 'issue' && sub === 'comment') {
      const url = `https://github.com/HJeon139/postbox/issues/${n}#issuecomment-${posted.length + 1}`;
      posted.push({ n, body: args[4], url });
      return ok(url);
    }
    return { status: 1, stdout: '' };
  };
// RUN has every fix; OLD has none; any other commit is unknown to this clone.
const git = (args) => ({ status: args[3] === RUN ? 0 : args[3] === OLD ? 1 : 128, stdout: '' });
const check = (issue, key = `k${issue}`) => ({
  source: 'check',
  check: issue === 123 ? 'approval-for-other-revision' : 'a-check',
  issue,
  key,
  title: 'T',
  evidence: 'E',
});

test('a closed issue’s fix is the commit that closed it, else its closing pull request’s commits', () => {
  const closed = closedIssues([123, 49, 106, 123], gh());
  assert.deepEqual(
    [...closed],
    [
      [123, { fix: [FIX], by: 'commit 9dd3c46' }],
      [49, { fix: [MERGE, HEAD], by: 'pull request #173' }],
    ],
  );
  assert.equal(hasFix([FIX], RUN, git), true);
  assert.equal(hasFix([FIX], OLD, git), false);
  assert.equal(hasFix([FIX], 'feedbeef', git), null);
  assert.equal(hasFix([], RUN, git), null);
});

test('isn’t preset as a duplicate: with the fix it waits for the verifier, before it it’s the defect as it was', () => {
  const run = (commit) => {
    const findings = [check(123), check(49), check(106)];
    presetFindings(findings, { root: '.', commit, gh: gh(), git });
    return findings;
  };
  const [after, afterPr, open] = run(RUN);
  assert.equal(after.verdict, undefined);
  assert.equal(verdictOf(after), null);
  assert.deepEqual(after.closedIssue, { issue: 123, fix: FIX, by: 'commit 9dd3c46', commit: RUN, hasFix: true });
  assert.match(after.note, /a possible regression, for the verifier/);
  assert.equal(afterPr.closedIssue.hasFix, true);
  // An open issue is preset as before.
  assert.deepEqual([open.verdict, open.verdictBy, open.duplicateOf], ['duplicate', 'check', 106]);
  const [before] = run(OLD);
  assert.deepEqual([before.verdict, before.verdictBy, before.duplicateOf], ['duplicate', 'runner', 123]);
  assert.equal(before.note, 'The run’s commit c7a4066 predates #123’s fix (commit 9dd3c46): the defect as it was.');
});

test('a run without a recorded commit says so, and its findings on closed issues aren’t verified', () => {
  const [f] = [check(123)];
  markClosed([f], { closed: closedIssues([123], gh()), commit: null, git });
  assert.equal(verdictOf(f), null);
  assert.equal(f.closedIssue.hasFix, null);
  assert.equal(f.note, '#123 is closed, and this run recorded no commit, so whether it had the fix can’t be told. Not verified.');
  // A verdict a reviewer already set stays.
  const judged = { ...check(123), verdict: 'harness', verdictBy: 'reviewer' };
  markClosed([judged], { closed: closedIssues([123], gh()), commit: RUN, git });
  assert.equal(judged.verdict, 'harness');
});

test('the verifier judges only the evidence: shown is a regression commented on the issue, not shown is harness', async () => {
  const findings = [check(123, 'a'), check(123, 'b'), check(49)];
  presetFindings(findings, { root: '.', commit: RUN, gh: gh(), git });
  const calls = [];
  const asked = [];
  const ask = async ({ prompt, schema }) => {
    asked.push({ prompt, schema });
    return {
      value: {
        results: [
          { index: 0, shown: true, note: 'The update erased an unread answer.' },
          { index: 1, shown: false, note: 'The block moved; the answer landed on the revision shown.' },
          { index: 2, shown: false, note: 'The app moved to the newest point.' },
        ],
      },
    };
  };
  await verifyRegressions({ root: '.', testerModel: 'm', dir: '/runs/2026-10-23T21-18-25-p0', findings, log: () => {}, file: true, ask, gh: gh(calls) });
  commentRegressions({ root: '.', dir: '/runs/2026-10-23T21-18-25-p0', findings, log: () => {}, gh: gh(calls) });
  assert.match(asked[0].prompt, /\[0\] #123 Issue 123\nIts fix: commit 9dd3c46\./);
  const [shown, stale] = findings;
  assert.deepEqual([shown.verdict, shown.verdictBy, shown.duplicateOf, shown.regression], ['duplicate', 'verifier', 123, true]);
  assert.equal(stale.verdict, 'harness');
  // Not caught again: the report doesn’t list it under #123.
  assert.deepEqual([stale.issue, stale.matchedIssue], [null, 123]);
  assert.match(stale.note, /^The approval-for-other-revision check matched closed #123, and the evidence doesn’t show it/);
  const comments = calls.filter((a) => a[1] === 'comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0][2], '123');
  assert.match(comments[0][4], /`2026-10-23T21-18-25-p0`, at 7fa3a6d.*which has the fix \(commit 9dd3c46\)/);
  assert.match(comments[0][4], /The runner doesn’t reopen issues/);
  assert.match(comments[0][4], /\*\*Verifier:\*\* The update erased an unread answer\./);
  assert.equal(shown.regressionComment, 'https://github.com/HJeon139/postbox/issues/123#issuecomment-1');
  // Nothing reopens, and a second pass comments nothing more: every finding has its verdict.
  assert.ok(!calls.some((a) => a.includes('reopen')));
  await verifyRegressions({ root: '.', testerModel: 'm', dir: '/r', findings, log: () => {}, file: true, ask, gh: gh(calls) });
  commentRegressions({ root: '.', dir: '/r', findings, log: () => {}, gh: gh(calls) });
  assert.equal(calls.filter((a) => a[1] === 'comment').length, 1);
});

test('with --file no, a confirmed regression is recorded, and the next pass that files comments on it', async () => {
  const findings = [check(123)];
  presetFindings(findings, { root: '.', commit: RUN, gh: gh(), git });
  const calls = [];
  const ask = async () => ({ value: { results: [{ index: 0, shown: true, note: 'It came back.' }] } });
  await verifyRegressions({ root: '.', testerModel: 'm', dir: '/r', findings, log: () => {}, file: false, ask, gh: gh(calls) });
  assert.equal(findings[0].regression, true);
  assert.deepEqual(
    calls.filter((a) => a[1] === 'comment'),
    [],
  );
  // A later recheck that files: the verdict is there, so nothing is verified again, and the issue gets its comment.
  await verifyRegressions({ root: '.', testerModel: 'm', dir: '/r', findings, log: () => {}, file: true, ask, gh: gh(calls) });
  commentRegressions({ root: '.', dir: '/r', findings, log: () => {}, gh: gh(calls) });
  assert.equal(calls.filter((a) => a[1] === 'comment').length, 1);
  assert.match(calls.find((a) => a[1] === 'comment')[4], /It came back\./);
});

test('when gh can’t read an issue, its match isn’t preset as a duplicate: it may be closed', () => {
  const down = () => ({ status: 1, stdout: '', stderr: 'gh: not signed in' });
  const findings = [check(123)];
  presetFindings(findings, { root: '.', commit: RUN, gh: down, git });
  assert.equal(findings[0].verdict, undefined);
  assert.equal(verdictOf(findings[0]), null);
  assert.equal(findings[0].note, 'gh couldn’t read #123, so whether it’s closed can’t be told, and it isn’t preset. Not verified.');
});

test('one comment per issue per run, listing its findings, and none again for a run that already commented', async () => {
  const findings = [check(123, 'a'), check(123, 'b')];
  presetFindings(findings, { root: '.', commit: RUN, gh: gh(), git });
  const ask = async () => ({ value: { results: [0, 1].map((index) => ({ index, shown: true, note: `Came back (${index}).` })) } });
  const calls = [];
  const posted = [];
  const dir = '/runs/2026-10-23T21-18-25-p0';
  await verifyRegressions({ root: '.', testerModel: 'm', dir, findings, log: () => {}, file: true, ask, gh: gh(calls, posted) });
  commentRegressions({ root: '.', dir, findings, log: () => {}, gh: gh(calls, posted) });
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /finding `a`: E \*\*Verifier:\*\* Came back \(0\)\.\n- `approval-for-other-revision`, finding `b`/);
  assert.match(posted[0].body, /<!-- uat-regression:2026-10-23T21-18-25-p0 -->$/);
  assert.deepEqual(
    findings.map((f) => f.regressionComment),
    [posted[0].url, posted[0].url],
  );
  // A recheck of the same run that lost the record (a copy, an older findings.json) finds its mark on the issue.
  for (const f of findings) delete f.regressionComment;
  commentRegressions({ root: '.', dir, findings, log: () => {}, gh: gh(calls, posted) });
  assert.equal(posted.length, 1);
  assert.equal(findings[0].regressionComment, posted[0].url);
});

test('a regression a person judged otherwise isn’t commented on, nor listed as caught again', async () => {
  const findings = [check(123)];
  presetFindings(findings, { root: '.', commit: RUN, gh: gh(), git });
  const ask = async () => ({ value: { results: [{ index: 0, shown: true, note: 'It came back.' }] } });
  await verifyRegressions({ root: '.', testerModel: 'm', dir: '/r', findings, log: () => {}, file: false, ask, gh: gh() });
  assert.equal(findings[0].regression, true);
  // Between that pass and a recheck that files, the person looks and calls it the runner’s.
  setVerdict(findings[0], { verdict: 'harness', by: 'person', note: 'The runner answered a stale revision.' });
  assert.deepEqual([findings[0].regression, findings[0].issue, findings[0].matchedIssue], [undefined, null, 123]);
  const posted = [];
  commentRegressions({ root: '.', dir: '/r', findings, log: () => {}, gh: gh([], posted) });
  // Even a stale mark doesn’t post without the duplicate verdict.
  commentRegressions({ root: '.', dir: '/r', findings: [{ ...findings[0], regression: true }], log: () => {}, gh: gh([], posted) });
  assert.deepEqual(posted, []);
});

test('a recheck drops a check’s own preset, live findings’ too, and keeps every other verdict', () => {
  const preset = {
    ...check(123),
    verdict: 'duplicate',
    verdictBy: 'check',
    verdictAt: 't',
    verdicts: [{}],
    note: 'A check caught #123 again.',
    duplicateOf: 123,
  };
  assert.deepEqual(withoutPreset(preset), check(123));
  // The preset is then set again against what’s known now: #123 has closed, so it isn’t one.
  const again = withoutPreset(preset);
  presetFindings([again], { root: '.', commit: RUN, gh: gh(), git });
  assert.equal(again.verdict, undefined);
  const reviewer = { ...preset, verdictBy: 'reviewer' };
  assert.equal(withoutPreset(reviewer), reviewer);
  const measured = { ...check(null), verdict: 'measurement', verdictBy: 'check' };
  assert.equal(withoutPreset(measured), measured);
});

test('the fix is present if any closing pull request’s commits are in the run', () => {
  const two = (args) =>
    args[0] === 'issue'
      ? ok({ state: 'CLOSED', closedByPullRequestsReferences: [{ number: 79 }, { number: 80 }] })
      : args[0] === 'api'
        ? ok('-\n')
        : ok(args[2] === '79' ? { mergeCommit: { oid: OLD }, headRefOid: OLD } : { mergeCommit: { oid: RUN }, headRefOid: HEAD });
  const c = closedIssues([62], two).get(62);
  assert.deepEqual(c, { fix: [OLD, OLD, RUN, HEAD], by: 'pull requests #79, #80' });
  // The first pull request’s commits aren’t in the run; the second’s are: one is enough.
  assert.equal(
    hasFix(c.fix, RUN, (args) => ({ status: args[2] === RUN ? 0 : 1, stdout: '' })),
    true,
  );
});

test('a finding whose issue can’t be read isn’t verified, and a verifier with no results changes nothing', async () => {
  const findings = [check(123)];
  presetFindings(findings, { root: '.', commit: RUN, gh: gh(), git });
  let asked = 0;
  const ask = async () => {
    asked++;
    return { value: {} };
  };
  const unreadable = (args) => (args.includes('title,body') ? { status: 1, stdout: '' } : gh()(args));
  const logs = [];
  await verifyRegressions({ root: '.', testerModel: 'm', dir: '/r', findings, log: (l) => logs.push(l), file: false, ask, gh: unreadable });
  assert.equal(asked, 0);
  assert.deepEqual(logs, ['Couldn’t read #123, so its findings weren’t verified.']);
  await verifyRegressions({ root: '.', testerModel: 'm', dir: '/r', findings, log: (l) => logs.push(l), file: false, ask, gh: gh() });
  assert.equal(asked, 1);
  assert.equal(findings[0].verdict, undefined);
  assert.match(logs.at(-1), /failed: the answer had no results/);
});
