// The end of a run (tools/uat/run-end.mjs): the verifier runs before #995’s picture judges, so a capped run whose judges
// would spend the after-run reserve still verifies its findings.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunBudget } from '../tools/uat/budget.mjs';
import { endRun } from '../tools/uat/run-end.mjs';

/** A capped run’s budget with $1 left, and an ask that spends all it’s allowed. */
function capped() {
  const budget = new RunBudget({ cap: 1, testerShare: 0, agentsShare: 0, now: () => 0 });
  budget.track({ streams: () => [], tester: { spent: 0 } });
  const asked = [];
  const ask = (who) =>
    budget.verifier(async (args) => {
      asked.push(who);
      return { value: {}, cost: args.budgetUsd };
    });
  return { budget, asked, ask };
}

test('#995 a capped run verifies its findings before the picture judges can spend what’s left', async () => {
  const { asked, ask } = capped();
  const order = [];
  await endRun({
    report: async () => {
      order.push('report');
    },
    review: async () => {
      order.push('review');
      await ask('verifier')({ budgetUsd: 2 });
    },
    judge: async () => {
      order.push('judge');
      await ask('judge')({ budgetUsd: 2 }).catch(() => order.push('judge refused'));
    },
  });
  assert.deepEqual(asked, ['verifier'], 'the verifier got the reserve; the judges found it spent');
  assert.deepEqual(order, ['report', 'review', 'judge', 'judge refused', 'report']);
});

test('#995 judging first would have left the verifier nothing: the order is what keeps it', async () => {
  const { ask } = capped();
  await ask('judge')({ budgetUsd: 2 });
  await assert.rejects(ask('verifier')({ budgetUsd: 2 }), /too little to verify/);
});

test('#995 a run with --verify no and --file no still judges, and writes the report after', async () => {
  const order = [];
  await endRun({ report: async () => void order.push('report'), review: null, judge: async () => void order.push('judge') });
  assert.deepEqual(order, ['report', 'judge', 'report']);
});
