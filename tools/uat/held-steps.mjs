// What waits on the person at a step of a run, and the actions the runner holds rather than does: moving on past
// something that waits, an interrupt while an agent works, and leaving a phase whose triggers haven’t happened
// (tools/uat-run.mjs asks before it does the tester’s action).

import { waitingOnYou } from './checks.mjs';

/**
 * What “needs you” counts, every step, whether or not it changed: an old review draft stays on the list. Each says what
 * it is and where: its item’s label, and its thread when that isn’t the main one.
 * @param {any} state  @param {string[]} threads  the threads under test
 * @param {{ labels: Map<string, string>, mainThread: string }} o
 * @returns {string[]}
 */
export function waitingList(state, threads, { labels, mainThread }) {
  return waitingOnYou(state, threads).map((w) => {
    const label = w.itemId ? labels.get(w.itemId) : null;
    const where = state.threads[w.threadId];
    return `${label ? `[${label}] ` : ''}${w.what}${where && w.threadId !== mainThread ? ` (in the thread “${where.title}”${label ? '' : ', not on screen: open it'})` : ''}`;
  });
}

/**
 * The run’s holds. The function it returns says why the tester’s action `a` is held, for the tester to read at its
 * next step, or null when the action goes ahead. That step comes at once when something the tester has had still
 * waits while an agent works: the wait hands it back again (settle’s `again`, in tools/uat/turns.mjs, #1760). Each hold
 * is logged, and kept on the step’s entry in the run’s timeline as `held`, when and why, for the report (#482).
 * @param {{ goals: { leave: (phase: number) => string | null }, log: (line: string) => void, timeline?: any[], now?: () => number }} o
 *   timeline: the run’s, whose last entry is the step that asked for the action
 * @returns {(a: any, at: { waiting: string[], idle: boolean, phase: number }) => string | null}
 */
export function stepHolds({ goals, log, timeline, now = Date.now }) {
  // The run’s own timeline, which the report reads: without it a hold would go unrecorded (#482).
  if (!Array.isArray(timeline)) throw new Error('stepHolds needs the run’s timeline, to record each hold on it.');
  let pushedBack = ''; // the waiting list the tester was last told to answer before moving on
  /** @param {string} why */
  const hold = (why) => {
    log(`action held: ${why}`);
    const entry = timeline.at(-1);
    if (entry) entry.held = { at: now(), why };
  };
  return (a, { waiting, idle, phase }) => {
    // Moving on, or waiting while no agent works, past something that waits on the person: say so once, and ask
    // again. A second try with the same list goes ahead, so a run can’t loop on a block it can’t answer.
    if (waiting.length && (a.type === 'next_phase' || a.type === 'done' || (a.type === 'wait' && idle)) && pushedBack !== waiting.join('\n')) {
      pushedBack = waiting.join('\n');
      hold(`${waiting.length} waiting on the person: ${waiting.join('; ')}`);
      // The same again goes ahead, so a scenario that says to leave a card open (for a minute, say) still can.
      return `Not yet: ${waiting.length === 1 ? 'this is' : 'these are'} still waiting on you: ${waiting.join('; ')}. Answer ${waiting.length === 1 ? 'it' : 'them'} first, or, to leave ${waiting.length === 1 ? 'it' : 'them'} waiting on purpose, as the scenario says to, ask for the same again: the second time it goes ahead.`;
    }
    // An interrupt acts on the turn running when it starts, and the wait can hand back while one runs (#289).
    if (a.interrupt && !idle) {
      hold('an interrupt while an agent works');
      return 'Not yet: an agent is still working, so an interrupt would act on its turn, not the one this starts. Answer what needs you, or wait, first.';
    }
    // Moving on from a phase whose triggers haven’t happened: held once, then a coverage gap.
    const held = a.type === 'next_phase' || a.type === 'done' ? goals.leave(phase) : null;
    if (held) hold('the phase’s triggers haven’t happened');
    return held;
  };
}
