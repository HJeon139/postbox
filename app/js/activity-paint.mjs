// A reply’s activity list and its background-job rows, drawn with the reply. Moved from app/js/thread.mjs.

import { activityLabel, stepTree } from './activity-steps.mjs';
import { h, icon } from './dom.mjs';
import { jobRows, runningNote } from './reply-stop.mjs';
import { kiroStep } from './thread-host.mjs';

/**
 * The parts of an agent reply its steps decide: a notice, the folded list of steps, and the running jobs’ rows.
 * @param {any} it  the agent item @returns {[any, HTMLElement | null, HTMLElement | null]}
 */
export function activityParts(it) {
  const [notice, steps] = kiroStep(it);
  const total = steps.reduce((a, s) => a + (s.ms ?? 0), 0);
  const list = steps.length
    ? h(
        'details.activity',
        h(
          'summary',
          icon('right', 'i-sm'),
          activityLabel(steps),
          total ? ` · ${(total / 1000).toFixed(total < 10000 ? 1 : 0)} s in tools` : '',
          runningNote(it, steps),
        ),
        stepTree(steps),
      )
    : null;
  return [notice, list, jobRows(it, steps)];
}
