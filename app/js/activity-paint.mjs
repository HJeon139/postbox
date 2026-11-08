// A reply’s activity list and its background-job rows, drawn with the reply and painted again in place when one step
// arrives (#573). A step used to rebuild the whole reply: its Markdown, its node, and a new frame for each diagram in it.

import { activityLabel, stepTree } from './activity-steps.mjs';
import { h, icon } from './dom.mjs';
import { jobRows, runningNote } from './reply-stop.mjs';
import { kiroStep } from './thread-host.mjs';

/** Each list’s steps, which its first open builds; a live step on a list still folded changes them. */
const stepsOf = /** @type {WeakMap<HTMLElement, any[]>} */ (new WeakMap());

/**
 * The parts of an agent reply its steps decide: a notice, the folded list of steps, and the running jobs’ rows.
 * @param {any} it  the agent item @returns {[any, HTMLElement | null, HTMLElement | null]}
 */
export function activityParts(it) {
  const [notice, steps] = kiroStep(it);
  const total = steps.reduce((a, s) => a + (s.ms ?? 0), 0);
  const list = steps.length
    ? foldedList(
        h(
          'summary',
          icon('right', 'i-sm'),
          activityLabel(steps),
          total ? ` · ${(total / 1000).toFixed(total < 10000 ? 1 : 0)} s in tools` : '',
          runningNote(it, steps),
        ),
        steps,
      )
    : null;
  return [notice, list, jobRows(it, steps)];
}

/**
 * A folded list holds its summary and the steps’ labels as text, not the steps (#1028): most lists are never opened,
 * and in a long room their steps were most of the page’s elements. The text sits in the details, so it’s hidden with
 * them and Find still finds a step, opening them in Chromium. The first open builds the steps, and they stay built.
 * @param {HTMLElement} summary @param {any[]} steps
 */
function foldedList(summary, steps) {
  const list = h('details.activity', { ontoggle: () => list.open && buildSteps(list) }, summary, h('div.steps-text', steps.map((s) => s.label).join('\n')));
  stepsOf.set(list, steps);
  return list;
}

/**
 * Builds a list’s steps in place of their text, once. A list a redraw opens again is built at once
 * (rerender-state.mjs), so a thought expanded in it can be expanded again. @param {HTMLElement} list
 */
export function buildSteps(list) {
  list.querySelector(':scope > .steps-text')?.replaceWith(stepTree(stepsOf.get(list) ?? []));
}

/**
 * Moves the summary’s words and the steps into the list already drawn, so it keeps its open state and the summary its
 * focus. A list still folded takes the steps’ text, and stays unbuilt.
 * @param {HTMLDetailsElement} old @param {HTMLElement} next
 */
function moveInto(old, next) {
  /** @type {HTMLElement} */ (old.querySelector(':scope > summary')).replaceChildren(
    .../** @type {HTMLElement} */ (next.querySelector(':scope > summary')).childNodes,
  );
  const steps = stepsOf.get(next) ?? [];
  stepsOf.set(old, steps);
  const tree = /** @type {HTMLElement | null} */ (old.querySelector(':scope > ul.steps'));
  if (tree) moveSteps(tree, steps);
  else old.querySelector(':scope > .steps-text')?.replaceWith(/** @type {HTMLElement} */ (next.querySelector(':scope > .steps-text')));
}

/**
 * Builds a built list’s steps again in its place. An expanded thought stays expanded, and a focused one keeps focus.
 * @param {HTMLElement} tree  the list’s ul.steps @param {any[]} steps
 */
function moveSteps(tree, steps) {
  const fresh = stepTree(steps);
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
  if (oldList && list) moveInto(oldList, list);
  else if (list) node.insertBefore(list, before);
  else oldList?.remove();
  if (oldJobs && jobs) oldJobs.replaceWith(jobs);
  else if (jobs) (list?.isConnected ? list : oldList)?.after(jobs);
  else oldJobs?.remove();
  return true;
}
