// --phases (tools/uat-run.mjs): a run of some of a scenario’s phases, such as `--phases 1,2`. The run plays only
// those, in the scenario’s order, and checks only their triggers and host triggers for existence, so a scenario whose
// later phases name triggers that don’t exist yet can run its earlier ones. It doesn’t combine with --phase (the
// phase a run starts at, which still checks every phase): a run passes one or the other.

import { isTargeted } from './scenario.mjs';

/**
 * The phases --phases names, as phase numbers from 1, sorted, each once; null without it.
 * @param {{ phases?: string, phase?: string }} opt  @param {number} count  how many phases the scenario has
 * @returns {number[]|null}
 */
export function phasesOf(opt, count) {
  const raw = opt.phases;
  if (raw === undefined || raw === null) return null;
  if (opt.phase !== undefined && opt.phase !== null)
    throw new Error(
      `--phases and --phase don’t combine: --phases ${raw} plays only those phases, and --phase ${opt.phase} starts at one and plays the rest. Pass one or the other.`,
    );
  const parts = String(raw).split(',');
  if (!parts.every((p) => /^\s*\d+\s*$/.test(p) && Number(p) >= 1 && Number(p) <= count))
    throw new Error(
      `--phases takes phase numbers from 1 to ${count}, separated by commas (such as --phases 1,2), not “${raw}”: this scenario has ${count} phases.`,
    );
  return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}

/**
 * The scenario as a run of only `phases` plays it. A targeted one’s step cap is then those phases’ caps added up,
 * not its own `- steps:`, which is for the whole scenario. The tester’s summary says which phases the run left out,
 * with the titles of those before its last, as context it sets up briefly, as it does for --phase.
 * @template {{ steps?: number|null, summary?: string, phases: { title: string }[] }} S
 * @param {S} scenario  @param {number[]|null} phases  from phasesOf
 * @returns {S}
 */
export function selectPhases(scenario, phases) {
  if (!phases) return scenario;
  const chosen = { ...scenario, phases: phases.map((n) => scenario.phases[n - 1]) };
  if (isTargeted(chosen)) chosen.steps = null;
  const last = phases[phases.length - 1];
  const before = scenario.phases.filter((_, i) => i + 1 < last && !phases.includes(i + 1));
  const words = phases.length > 1 ? `${phases.slice(0, -1).join(', ')} and ${last}` : `${last}`;
  const note = `This run plays only phase${phases.length > 1 ? 's' : ''} ${words} of this scenario (--phases).${
    before.length
      ? ` The ones it leaves out before them are only context, so first set up briefly what a phase needs from them: ${before.map((p) => p.title).join('; ')}.`
      : ''
  }`;
  chosen.summary = scenario.summary ? `${scenario.summary}\n\n${note}` : note;
  return chosen;
}

/** The phases a run’s record says a --phases run played, for a recheck; null for a run of every phase. */
export const recordedPhases = (record) => (Array.isArray(record?.phases) && record.phases.every((n) => Number.isInteger(n) && n >= 1) ? record.phases : null);
