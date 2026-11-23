// The end of a run (tools/uat/run-end.mjs): the verifier runs before #995’s picture judges, so a capped run whose judges
// would spend the after-run reserve still verifies its findings.

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunBudget } from '../tools/uat/budget.mjs';
import { agentsSpent, dollarFolders, dollarStreams, streamResults } from '../tools/uat/cost.mjs';
import { endRun } from '../tools/uat/run-end.mjs';
import { readSpend } from '../tools/uat/run-files.mjs';

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
    refresh: () => {},
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
  await endRun({ refresh: () => {}, report: async () => void order.push('report'), review: null, judge: async () => void order.push('judge') });
  assert.deepEqual(order, ['report', 'judge', 'report']);
});

// #1664: in the Kiro wall-time run of batch 4, the wait after a step pressed Stop on a page that had none, which threw
// out of the run before its end: no report.md, findings.json or run.json. A run that throws still writes them.
test('#1664 a run that throws before its end still writes its report, with the failure as a finding, then fails', async () => {
  const { endFailedRun } = /** @type {any} */ (await import('../tools/uat/run-end.mjs'));
  assert.equal(typeof endFailedRun, 'function', 'the runner has an end for a run that threw');
  const findings = new Map();
  const written = [];
  const thrown = new Error('In the page: Error: No Stop control is visible.');
  await assert.rejects(
    endFailedRun(thrown, {
      findings,
      step: 1,
      end: async () => void written.push('report.md', 'findings.json', 'run.json', [...findings.values()]),
      log: () => {},
    }),
    (e) => e === thrown,
  );
  assert.deepEqual(written.slice(0, 3), ['report.md', 'findings.json', 'run.json']);
  const [failed] = /** @type {any[]} */ (written[3]);
  assert.equal(failed.check, 'run-failed');
  assert.match(failed.evidence, /No Stop control is visible/);
});

test('#1664 an end that fails as well is logged, and the run fails with what threw first', async () => {
  const { endFailedRun } = /** @type {any} */ (await import('../tools/uat/run-end.mjs'));
  const lines = [];
  const thrown = new Error('In the page: Error: No Stop control is visible.');
  const end = async () => {
    throw new Error('The verifier refused.');
  };
  await assert.rejects(endFailedRun(thrown, { findings: new Map(), step: 3, end, log: (l) => lines.push(l) }), (e) => e === thrown);
  assert.ok(
    lines.some((l) => /The verifier refused/.test(l)),
    lines.join('\n'),
  );
});

// #1696: an Agent SDK run stopped at its budget while a turn the budget let finish was at work. The report and run.json
// said the agents spent $0.72, from the streams read before that turn reported, and the budget in the same files $0.84,
// read live. The run reads the agents’ streams again before each report, so both give one total.
test('#1696 each report reads what the agents spent as the budget does, after a turn at work reports', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'uat-run-end-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = {
    streams: join(root, 'cc'),
    sdkStreams: join(root, 'sdk'),
    kiroStreams: join(root, 'kiro'),
    agyStreams: join(root, 'agy'),
    codexStreams: join(root, 'codex'),
  };
  for (const folder of Object.values(paths)) mkdirSync(folder);
  const result = (usd) => `${JSON.stringify({ type: 'result', total_cost_usd: usd })}\n`;
  // What the run last read, before a failed step’s turn reported: the first report reads the streams again too.
  const facts = readSpend(paths);
  writeFileSync(join(paths.sdkStreams, '1-researcher.jsonl'), result(0.72));
  writeFileSync(join(paths.sdkStreams, '2-researcher.jsonl'), '');
  const budget = new RunBudget({ cap: 10, testerShare: 1, agentsShare: 8, now: () => 0 });
  budget.track({ streams: streamResults(...dollarFolders(paths)), tester: { spent: 0 } });
  const reports = [];
  await endRun({
    refresh: () => Object.assign(facts, readSpend(paths)),
    report: async () => void reports.push({ usage: agentsSpent(dollarStreams(facts)), budget: budget.spent().agents }),
    review: async () => appendFileSync(join(paths.sdkStreams, '2-researcher.jsonl'), result(0.12)),
    judge: async () => {},
  });
  assert.ok(Math.abs((reports[0]?.usage ?? 0) - 0.72) < 1e-9, `the first report’s usage line: ${reports[0]?.usage}`);
  const last = reports.at(-1);
  assert.ok(Math.abs((last?.usage ?? 0) - 0.84) < 1e-9, `the last report’s usage line: ${last?.usage}`);
  assert.ok(Math.abs((last?.budget ?? 0) - 0.84) < 1e-9, `its budget: ${last?.budget}`);
});
