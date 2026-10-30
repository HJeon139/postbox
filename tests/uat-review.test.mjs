// The verifier after a run (tools/uat/review.mjs). Its two calls, one for the findings on closed issues and one for the
// rest, ran one after the other: in the delivery run of 30 October (uat-runs/2026-10-30T05-16-46-delivery, run.log)
// the first took 74 s of the run’s 8 minutes before the second began. They judge separate findings, so they run at
// once, with the verdicts, the comment and the filing as before. gh, git and the verifier are stand-ins here.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runBudget } from '../tools/uat/budget.mjs';
import { presetFindings } from '../tools/uat/regressions.mjs';
import { reviewFindings } from '../tools/uat/review.mjs';

const FIX = '9dd3c46c9116c2e0ca64ba31ca93c8617d5251ec';
const RUN = '7fa3a6df70ba2eb9f0c71a75d98fd4be9f9d5f12';
const ok = (stdout) => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout) });
// #484 was closed by a commit the run has; #106 is open. Filing makes #600.
const gh = (calls) => (args) => {
  calls.push(args);
  const [cmd, sub, n] = args;
  if (cmd === 'issue' && sub === 'list') return ok([{ number: 106, title: 'Open issue', body: '' }]);
  if (cmd === 'issue' && sub === 'view' && args.includes('title,body')) return ok({ title: `Issue ${n}`, body: 'What went wrong.' });
  if (cmd === 'issue' && sub === 'view' && args.includes('comments')) return ok({ comments: [] });
  if (cmd === 'issue' && sub === 'view') return ok(n === '106' ? { state: 'OPEN' } : { state: 'CLOSED', closedByPullRequestsReferences: [] });
  if (cmd === 'api') return ok(`-\n${FIX}\n`);
  if (cmd === 'issue' && sub === 'comment') return ok(`https://github.com/HJeon139/postbox/issues/${n}#issuecomment-1`);
  if (cmd === 'issue' && sub === 'create') return ok('https://github.com/HJeon139/postbox/issues/600');
  return { status: 1, stdout: '' };
};
const git = () => ({ status: 0, stdout: '' });
const FILING = { title: 'T', component: 'conversation', urgency: 'soon', steps: ['Send it.'], expected: 'E', actual: 'A' };

/** The delivery run’s two kinds of finding: a check’s on closed #484, and the tester’s new one. */
function deliveryFindings(calls) {
  const findings = [
    { source: 'check', check: 'unlabeled-repeat', issue: 484, key: 'k1', title: 'Repeat without a label', evidence: 'E' },
    { source: 'tester', severity: 'high', category: 'bug', title: 'Held message never reached @critic', evidence: 'E', step: 5 },
  ];
  presetFindings(findings, { root: '.', commit: RUN, gh: gh(calls), git });
  return findings;
}

/** A verifier whose answers wait for `release`, so a test can see which calls started before any ended. */
function heldVerifier() {
  const started = [];
  let open;
  const gate = new Promise((r) => (open = r));
  const ask = async ({ prompt }) => {
    started.push(prompt);
    await gate;
    if (/closed issue/.test(prompt)) return { value: { results: [{ index: 0, shown: true, note: 'It came back.' }] } };
    return { value: { results: [{ index: 0, verdict: 'confirmed', note: 'Reproduced.', ...FILING }] } };
  };
  return { ask, started, release: () => open() };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
};

test('the verifier asks about closed issues and new findings at once, not one after the other', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'uat-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const findings = deliveryFindings(calls);
  const v = heldVerifier();
  const done = reviewFindings({
    root: '.',
    testerModel: 'm',
    dir,
    scenario: { title: 'Delivery' },
    findings,
    timeline: [],
    log: () => {},
    verify: true,
    file: true,
    ask: v.ask,
    gh: gh(calls),
  });
  await flush();
  const before = v.started.length;
  v.release();
  await done;
  assert.equal(before, 2, 'both calls were in flight before either answered');
  const [regression, fresh] = findings;
  assert.deepEqual([regression.verdict, regression.duplicateOf, regression.regression], ['duplicate', 484, true]);
  assert.equal(regression.regressionComment, 'https://github.com/HJeon139/postbox/issues/484#issuecomment-1');
  assert.deepEqual([fresh.verdict, fresh.filed], ['confirmed', 600]);
  assert.equal(calls.filter((a) => a[1] === 'create').length, 1);
  assert.equal(calls.filter((a) => a[1] === 'comment').length, 1);
});

test('two verifier calls at once share what’s left of the run’s budget, not each the whole of it', async () => {
  const b = runBudget({ cap: 5, testerShare: 1 });
  b.track({ streams: () => [], tester: { spent: 1.5 } });
  const caps = [];
  let open;
  const gate = new Promise((r) => (open = r));
  const ask = b.verifier(async (args) => {
    caps.push(args.budgetUsd);
    await gate;
    return { value: { results: [] }, cost: 0.2 };
  });
  const both = Promise.all([ask({}), ask({})]);
  await flush();
  open();
  await both;
  // $5 less the tester’s $1.50 leaves $3.50: the first holds its $2, the second gets the $1.50 after it.
  assert.deepEqual(caps, [2, 1.5]);
  assert.equal(b.summary()?.spent.verifier, 0.4);
});
