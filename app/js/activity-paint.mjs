// A reply’s activity list and its background-job rows, drawn with the reply and painted again in place when one step
// arrives (#573). A step used to rebuild the whole reply: its Markdown, its node, and a new frame for each diagram in it.

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

/**
 * Moves the summary’s words and the steps into the list already drawn, so it keeps its open state and the summary its
 * focus. An expanded thought stays expanded, and a focused one keeps focus.
 * @param {HTMLDetailsElement} old @param {HTMLElement} next
 */
function moveSteps(old, next) {
  /** @type {HTMLElement} */ (old.querySelector(':scope > summary')).replaceChildren(
    .../** @type {HTMLElement} */ (next.querySelector(':scope > summary')).childNodes,
  );
  const tree = /** @type {HTMLElement} */ (old.querySelector(':scope > ul.steps'));
  const fresh = /** @type {HTMLElement} */ (next.querySelector(':scope > ul.steps'));
  const opened = new Set([...tree.querySelectorAll('details.step-text[open]')].map((d) => /** @type {HTMLElement} */ (d).dataset.stepId));
  const focused = tree.contains(document.activeElement) ? document.activeElement?.closest('details.step-text')?.getAttribute('data-step-id') : null;
  for (const d of fresh.querySelectorAll('details.step-text')) if (opened.has(/** @type {HTMLElement} */ (d).dataset.stepId)) d.setAttribute('open', '');
  tree.replaceWith(fresh);
  if (focused) /** @type {HTMLElement | null} */ (fresh.querySelector(`details.step-text[data-step-id="${CSS.escape(focused)}"] > summary`))?.focus();
}

/**
 * Whether an item.patch changes only a reply’s steps: one step (#452), or the whole list, which a terminal’s mirror
 * sends for each tool call and a turn sends when it ends.
 * @param {{ patch?: Record<string, any>, activityStep?: any }} d  the event’s data
 */
export const stepsOnly = (d) => Boolean(d.activityStep || d.patch?.activity) && Object.keys(d.patch ?? {}).every((k) => k === 'activity');

/**
 * Paints a reply’s activity list and job rows again from its item, leaving the rest of the reply as it is.
 * @param {HTMLElement | undefined} node  the reply as drawn @param {any} it  the agent item
 * @returns {boolean} false when it couldn’t, and the caller draws the whole reply instead
 */
export function paintActivity(node, it) {
  if (!node || it?.kind !== 'agent' || it.status === 'replaced') return false;
  const [, list, jobs] = activityParts(it);
  const oldList = /** @type {HTMLDetailsElement | null} */ (node.querySelector(':scope > details.activity'));
  const oldJobs = node.querySelector(':scope > ul.bg-jobs');
  // A list the reply didn’t have goes before what follows it: the job rows, then the Markdown box. Job rows come only
  // with steps, so they go after the list.
  const before = oldJobs ?? node.querySelector(':scope > .md');
  if (list && !oldList && !before) return false;
  if (oldList && list) moveSteps(oldList, list);
  else if (list) node.insertBefore(list, before);
  else oldList?.remove();
  if (oldJobs && jobs) oldJobs.replaceWith(jobs);
  else if (jobs) (list?.isConnected ? list : oldList)?.after(jobs);
  else oldJobs?.remove();
  return true;
}
