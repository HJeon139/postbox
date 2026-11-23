// The end of a run, after its last step (tools/uat-run.mjs): the report, the verifier, #995’s picture judges, and the
// report again with what they added. The judges come after the verifier: both draw on the budget’s after-run reserve
// (tools/uat/budget.mjs, AFTER_RUN_USD), and a run’s findings come before its pictures. Judging first let a capped run
// spend the reserve on pictures and leave its findings unverified.

/**
 * @param {{ refresh: () => unknown, report: () => Promise<void>, review: (() => Promise<unknown>) | null, judge: () => Promise<void> }} o
 *   refresh: reads what the agents spent again; report: writes the report with the budget so far; review: verifies and
 *   files the findings, or null with --verify no and --file no; judge: the picture judges
 */
export async function endRun({ refresh, report, review, judge }) {
  // A turn the budget let finish may report after the run’s last wait, which doesn’t wait on a turn with a card open:
  // each report reads the agents’ streams when it’s written, as the budget does, so they give one total (#1696).
  refresh();
  await report();
  if (review) await review();
  await judge();
  refresh();
  await report();
}

/**
 * The end of a run that threw before it (#1664): the failure is a finding, and the run still writes its report,
 * findings.json and run.json through `end`, then fails with what threw. An end that fails as well is logged, so the
 * first error is the one the run reports. In the Kiro wall-time run of batch 4, the wait after a step pressed Stop on a
 * page that had none, and the run ended with no report.
 * @param {Error} error @param {{ findings: Map<string, any>, step: number, end: () => Promise<unknown>, log: (line: string) => void }} o
 * @returns {Promise<never>}
 */
export async function endFailedRun(error, { findings, step, end, log }) {
  findings.set('run-failed', { source: 'run', check: 'run-failed', issue: null, title: 'The run failed before its last step', evidence: error.message, step });
  log(`The run failed at step ${step}, so it writes its report with what it has: ${error.message}`);
  try {
    await end();
  } catch (e) {
    log(`The run couldn’t finish its report after it failed: ${e instanceof Error ? e.message : e}`);
  }
  throw error;
}
