// #213: a check that matches a closed issue isn’t a duplicate on sight. Whether the run had the fix comes from git, and a
// verifier judges whether the evidence shows the defect. gh, git and the verifier are stand-ins here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closedIssues, hasFix, markClosed, presetFindings, verifyRegressions } from '../tools/uat/regressions.mjs';
import { verdictOf } from '../tools/uat/verdicts.mjs';

const FIX = '9dd3c46c9116c2e0ca64ba31ca93c8617d5251ec';
const MERGE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';
const RUN = '7fa3a6df70ba2eb9f0c71a75d98fd4be9f9d5f12';
const OLD = 'c7a406692890b534054283cfc40fa21ade688482';
const ok = (stdout) => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout) });
// #123 was closed by a commit, #49 by pull request #173, and #106 is open.
const gh =
  (calls = []) =>
  (args) => {
    calls.push(args);
    const [cmd, sub, n] = args;
    if (cmd === 'issue' && sub === 'view' && args.includes('title,body')) return ok({ title: `Issue ${n}`, body: 'What went wrong.' });
    if (cmd === 'issue' && sub === 'view')
      return ok(n === '106' ? { state: 'OPEN' } : { state: 'CLOSED', closedByPullRequestsReferences: n === '49' ? [{ number: 173 }] : [] });
    if (cmd === 'api') return ok(args[2].includes('/123/') ? `-\n${FIX}\n` : '-\n');
    if (cmd === 'pr') return ok({ mergeCommit: { oid: MERGE }, headRefOid: HEAD });
    if (cmd === 'issue' && sub === 'comment') return ok('https://github.com/HJeon139/postbox/issues/123#issuecomment-1');
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
  assert.match(asked[0].prompt, /\[0\] #123 Issue 123\nIts fix: commit 9dd3c46\./);
  const [shown, stale] = findings;
  assert.deepEqual([shown.verdict, shown.verdictBy, shown.duplicateOf, shown.regression], ['duplicate', 'verifier', 123, true]);
  assert.equal(stale.verdict, 'harness');
  assert.match(stale.note, /^The approval-for-other-revision check matched closed #123, and the evidence doesn’t show it/);
  const comments = calls.filter((a) => a[1] === 'comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0][2], '123');
  assert.match(comments[0][4], /`2026-10-23T21-18-25-p0`, at 7fa3a6d.*which has the fix \(commit 9dd3c46\)/);
  assert.match(comments[0][4], /The runner doesn’t reopen issues/);
  assert.equal(shown.regressionComment, 'https://github.com/HJeon139/postbox/issues/123#issuecomment-1');
  // Nothing reopens, and a second pass comments nothing more: every finding has its verdict.
  assert.ok(!calls.some((a) => a.includes('reopen')));
  await verifyRegressions({ root: '.', testerModel: 'm', dir: '/r', findings, log: () => {}, file: true, ask, gh: gh(calls) });
  assert.equal(calls.filter((a) => a[1] === 'comment').length, 1);
});

test('with --file no, a confirmed regression is recorded and the issue isn’t commented on', async () => {
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
});
