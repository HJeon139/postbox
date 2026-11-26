// A stalled run (#1760): the tester has had no step for a while, though an agent’s turn is open. The wait between
// steps says so once in run.log, and the run records it as a finding of the runner’s own. It ends nothing: the wait
// still ends when the turn does, at the turn’s time limit, or at the run’s bounds.

/**
 * How long the tester may go without a step, while a turn is open, before the run says it has stalled: five minutes.
 * That’s the longest wait the tester can ask for itself (WAIT_MAX_S in tools/uat/turns.mjs), so a wait past it is one
 * the tester didn’t choose. In the recorded runs up to 25 November, of 2,560 steps that weren’t such a wait, 99% came
 * within 256 s of the action before them, and 18 took five minutes or more. The run of #1746’s second stretch went nine.
 */
export const STALL_MS = 5 * 60_000;

/**
 * The stall watch of one wait between steps. The function it returns takes each read of the room: who is at a turn,
 * and what’s waiting on the person. At the first read with a turn open once the wait has run STALL_MS, it logs one
 * “stalled” line and gives `onStall` the same words, as the finding’s evidence. A wait that nobody’s turn holds, such
 * as one on an app being checked, is no stall. With `on` false it does nothing: after the run’s last step, no step is
 * left to give.
 * @param {{ on: boolean, log: (line: string) => void, onStall: (evidence: string) => void }} o
 * @returns {(working: { handle: string }[], asks: { what: string }[]) => void}
 */
export function stallWatch({ on, log, onStall }) {
  const start = Date.now();
  let said = false;
  return (working, asks) => {
    if (!on || said || !working.length || Date.now() - start < STALL_MS) return;
    said = true;
    const waits = asks.length ? `waiting on the person: ${asks.map((x) => x.what).join('; ')}` : 'nothing waits on the person';
    const evidence = `the tester has had no step for ${STALL_MS / 60_000} min while @${working.map((se) => se.handle).join(', @')} works; ${waits}`;
    log(`stalled: ${evidence}`);
    onStall(evidence);
  };
}

/** The run’s finding for a stall, after the step whose action the wait followed. @param {string} evidence  @param {number} step */
export const stalledFinding = (evidence, step) => ({
  source: 'run',
  check: 'stalled',
  issue: null,
  title: `The tester had no step for ${STALL_MS / 60_000} minutes while a turn was open`,
  evidence,
  step,
});
