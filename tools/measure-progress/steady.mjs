// A crowd’s steady state (tools/measure-progress.mjs, the `steady` section): one crowd with one count of tabs, in a
// process of its own, run WARM times and then MEASURED times, its times reported as the median of the measured runs.
// The crowd section runs all nine crowds one after another in one process, so where the JIT’s tiering and the GC land
// among them moves its times by as much as a change does: on #1502, 10x with 1 tab came out x1.49 of main’s in a second
// pass of that section, and x1.000 run on its own and warmed, in 16 pairs each. This reads the time a long-running
// Postbox pays for a crowd; the crowd section still reads a cold process’s.

import { turnsOfAll } from './fixtures.mjs';
import { CROWD_TABS, CROWDS, crowdRun } from './sections.mjs';

/** Runs before the measured ones, so the code a crowd runs is compiled and the heap settled. */
export const WARM = 4;
/** Runs measured, a crowd’s times reported as their median. */
export const MEASURED = 8;

/** Every crowd with every count of tabs, each the arguments of one steady run. */
export const STEADY_CROWDS = CROWDS.flatMap(([label, rooms, per]) => CROWD_TABS.map((tabs) => /** @type {const} */ ([label, rooms, per, tabs])));

/** The median of numbers, the lower of the middle two for an even count. @param {number[]} xs */
export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

/**
 * One crowd’s steady state, in this process: its CPU, event loop and mappers’ times, each the median of MEASURED runs
 * after WARM, as one row. @param {string} index  which of STEADY_CROWDS
 */
export async function steadyOne(index) {
  const crowd = STEADY_CROWDS[Number(index)];
  if (!crowd) throw new Error(`No steady crowd ${index}: name 0 to ${STEADY_CROWDS.length - 1}.`);
  const [label, rooms, per, tabs] = crowd;
  const pool = turnsOfAll();
  for (let i = 0; i < WARM; i++) await crowdRun(pool, rooms, per, tabs);
  /** @type {Record<'cpuMs' | 'loopMs' | 'pushMs', number[]>} */
  const times = { cpuMs: [], loopMs: [], pushMs: [] };
  for (let i = 0; i < MEASURED; i++) {
    const m = await crowdRun(pool, rooms, per, tabs);
    for (const k of /** @type {const} */ (['cpuMs', 'loopMs', 'pushMs'])) times[k].push(m[k]);
  }
  return [{ row: `${label}, ${tabs} tabs, warm`, cpuMs: median(times.cpuMs), loopMs: median(times.loopMs), pushMs: median(times.pushMs) }];
}
