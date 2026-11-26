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
 * waits while an agent works: the wait hands it back again (settle’s `again`, in tools/uat/turns.mjs, #1760).
 * @param {{ goals: { leave: (phase: number) => string | null }, log: (line: string) => void }} o
 * @returns {(a: any, at: { waiting: string[], idle: boolean, phase: number }) => string | null}
 */
export function stepHolds({ goals, log }) {
  let pushedBack = ''; // the waiting list the tester was last told to answer before moving on
  return (a, { waiting, idle, phase }) => {
    // Moving on, or waiting while no agent works, past something that waits on the person: say so once, and ask
    // again. A second try with the same list goes ahead, so a run can’t loop on a block it can’t answer.
    if (waiting.length && (a.type === 'next_phase' || a.type === 'done' || (a.type === 'wait' && idle)) && pushedBack !== waiting.join('\n')) {
      pushedBack = waiting.join('\n');
      log(`action held: ${waiting.length} waiting on the person`);
      // The same again goes ahead, so a scenario that says to leave a card open (for a minute, say) still can.
      return `Not yet: ${waiting.length === 1 ? 'this is' : 'these are'} still waiting on you: ${waiting.join('; ')}. Answer ${waiting.length === 1 ? 'it' : 'them'} first, or, to leave ${waiting.length === 1 ? 'it' : 'them'} waiting on purpose, as the scenario says to, ask for the same again: the second time it goes ahead.`;
    }
    // An interrupt acts on the turn running when it starts, and the wait can hand back while one runs (#289).
    if (a.interrupt && !idle) {
      log('action held: an interrupt while an agent works');
      return 'Not yet: an agent is still working, so an interrupt would act on its turn, not the one this starts. Answer what needs you, or wait, first.';
    }
    // Moving on from a phase whose triggers haven’t happened: held once, then a coverage gap.
    const held = a.type === 'next_phase' || a.type === 'done' ? goals.leave(phase) : null;
    if (held) log('action held: the phase’s triggers haven’t happened');
    return held;
  };
}
