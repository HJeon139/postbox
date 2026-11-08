// The end of a run, after its last step (tools/uat-run.mjs): the report, the verifier, #995’s picture judges, and the
// report again with what they added. The judges come after the verifier: both draw on the budget’s after-run reserve
// (tools/uat/budget.mjs, AFTER_RUN_USD), and a run’s findings come before its pictures. Judging first let a capped run
// spend the reserve on pictures and leave its findings unverified.

/**
 * @param {{ report: () => Promise<void>, review: (() => Promise<unknown>) | null, judge: () => Promise<void> }} o
 *   report: writes the report with the budget so far; review: verifies and files the findings, or null with --verify no
 *   and --file no; judge: the picture judges
 */
export async function endRun({ report, review, judge }) {
  await report();
  if (review) await review();
  await judge();
  await report();
}
