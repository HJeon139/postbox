// A reply’s steps and its background-job rows, drawn with the reply and painted again in place when one step arrives
// (#573). A step used to rebuild the whole reply: its Markdown, its node, and a new frame for each diagram in it. While
// the turn runs, its steps show live between its words (activity-live.mjs); once it ends, they fold into its work record.

import { firstPart, isLive, liveParts, newestCall, partSteps } from './activity-live.mjs';
import { activityLabel, stepTree } from './activity-steps.mjs';
import { agentMarkdown, markTerms } from './agent-markdown.mjs';
import { h, icon, trusted } from './dom.mjs';
import { jobRows, runningNote } from './reply-stop.mjs';
import { kiroStep } from './thread-host.mjs';
import { recordOf, recordWords, workLink } from './work-record.mjs';

/** Each list’s steps, which its first open builds; a live step changes them. */
const stepsOf = /** @type {WeakMap<HTMLElement, any[]>} */ (new WeakMap());

/** Words of a running turn, drawn between its steps. @param {any} it @param {string} threadId */
const wordsOf = (it, threadId) => (/** @type {string} */ text) => {
  const box = h('div.md.live-words', { html: trusted(agentMarkdown({ ...it, text, status: 'done' }, threadId)) });
  markTerms(box, threadId);
  return box;
};

/**
 * The parts of an agent reply its steps decide: a notice, its steps (live while it runs, else folded under its work
 * record), and the running jobs’ rows.
 * @param {any} it  the agent item @param {string} threadId @returns {[any, HTMLElement | null, HTMLElement | null]}
 */
export function activityParts(it, threadId) {
  const [notice, steps] = kiroStep(it);
  const live = isLive(it, threadId);
  if (live) {
    const [, own] = kiroStep({ activity: { steps: partSteps(it, threadId) } });
    const drawn = liveParts({ ...it, activity: { ...it.activity, steps: own } }, threadId, wordsOf(it, threadId), newestCall(it, threadId));
    return [notice, drawn, jobRows(it, steps)];
  }
  // The record, on the part it shows with (work-record.mjs, recordOf): this one, or the turn’s first part with words.
  const of = recordOf(it, threadId);
  const record = of ? kiroStep(of)[1] : [];
  const total = record.reduce((a, s) => a + (s.ms ?? 0), 0);
  const fallback = [activityLabel(record), total ? ` · ${(total / 1000).toFixed(total < 10000 ? 1 : 0)} s in tools` : ''];
  const list = record.length
    ? foldedList(
        h('summary', icon('right', 'i-sm'), recordWords(it, threadId, fallback), runningNote(of, record)),
        record,
        it.turnId ? workLink(it, threadId) : null,
      )
    : null;
  return [notice, list, jobRows(it, steps)];
}

/**
 * A finished turn’s first part with only steps, whose record shows with the turn’s words below it (recordOf): it shows
 * nothing. One with a job still running, or that failed or was stopped, still shows. @param {any} it @param {string} threadId
 */
export function recordMoved(it, threadId) {
  if (it?.kind !== 'agent' || it.status !== 'done' || !it.activity?.steps?.length || String(it.text ?? '').trim()) return false;
  if (it.activity.steps.some((/** @type {any} */ s) => s.job && s.state === 'running') || isLive(it, threadId)) return false;
  return recordOf(it, threadId) === null;
}

/**
 * Whether a finished turn’s work record says its line: its first part, which holds it, has steps. The work list under
 * the turn’s last item then leaves its own copy of the line out. @param {any} it  an item of the turn @param {string} threadId
 */
export const hasRecord = (it, threadId) => {
  const first = firstPart(it, threadId);
  return Boolean(first?.activity && kiroStep(first)[1].length);
};

/**
 * A folded list holds its summary and the steps’ labels as text, not the steps (#1028): most lists are never opened,
 * and in a long room their steps were most of the page’s elements. The text sits in the details, so it’s hidden with
 * them and Find still finds a step, opening them in Chromium. The first open builds the steps, and they stay built.
 * @param {HTMLElement} summary @param {any[]} steps @param {HTMLElement | null} link  to the turn in Work
 */
function foldedList(summary, steps, link) {
  const text = h('div.steps-folded', steps.map((s) => s.label).join('\n'));
  const list = h(
    'details.activity',
    {
      ontoggle: () => {
        if (list.open) buildSteps(list);
      },
    },
    summary,
    link,
    text,
  );
  // A click or key on the summary builds before the browser opens the list, so no frame shows the text open. Find opens
  // it with no click, and its toggle builds then.
  summary.addEventListener('click', () => buildSteps(list));
  stepsOf.set(list, steps);
  return list;
}

/**
 * Builds a list’s steps in place of their text, once. A list a redraw opens again is built at once
 * (rerender-state.mjs), so a thought expanded in it can be expanded again. @param {HTMLElement} list
 */
export function buildSteps(list) {
  list.querySelector(':scope > .steps-folded')?.replaceWith(stepTree(stepsOf.get(list) ?? []));
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
  else old.querySelector(':scope > .steps-folded')?.replaceWith(/** @type {HTMLElement} */ (next.querySelector(':scope > .steps-folded')));
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
 * @param {HTMLElement | undefined} node  the reply as drawn @param {any} it  the agent item @param {string} threadId
 * @returns {boolean} false when it couldn’t, and the caller draws the whole reply instead
 */
export function paintActivity(node, it, threadId) {
  // A running turn’s steps sit between its words, which a step moves: the reply is drawn again.
  if (!node || it?.kind !== 'agent' || it.status === 'replaced' || isLive(it, threadId)) return false;
  const [, list, jobs] = activityParts(it, threadId);
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
