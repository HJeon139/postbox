// A reply’s steps and its background-job rows, drawn with the reply and painted again in place when one step arrives
// (#573). A step used to rebuild the whole reply: its Markdown, its node, and a new frame for each diagram in it. While
// the turn runs, its steps show live between its words (activity-live.mjs); once it ends, they fold into its work record.

import { firstPart, isLive, liveParts, liveStale, newestCall, partSteps, textFrom } from './activity-live.mjs';
import { activityLabel, stepTree } from './activity-steps.mjs';
import { agentMarkdown, markTerms, paintAgentMarkdown } from './agent-markdown.mjs';
import { itemsOf, placeIn } from './client.mjs';
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

/** Whether an item.patch changes only whether a reply is still being written. @param {{ patch?: Record<string, any> }} d */
const statusOnly = (d) => Boolean(d.patch) && Object.keys(/** @type {object} */ (d.patch)).every((k) => k === 'status');

/**
 * Paints what an item.patch changed in a reply, and only that, when it can: its steps (paintActivity), or, while its
 * turn runs, whether this part is still being written, which another part of the reply starting ends.
 * @param {HTMLElement | undefined} node @param {any} it @param {string} threadId @param {any} d  the patch’s data
 * @returns {boolean} false when the caller draws the whole reply instead
 */
export function paintPatch(node, it, threadId, d) {
  if (!it || d.reaction) return false;
  if (stepsOnly(d)) return paintActivity(node, it, threadId);
  return Boolean(node) && it.kind === 'agent' && statusOnly(d) && isLive(it, threadId) && liveSoon(/** @type {HTMLElement} */ (node), it.id, threadId);
}

/**
 * Whether a reply has to be drawn again whole for what it was drawn for (liveStale): when its turn started or stopped
 * running. When only the number of agents at work changed, its live block is painted again instead.
 * @param {HTMLElement | undefined} node @param {any} it @param {string} threadId
 */
export function drawnStale(node, it, threadId) {
  const why = liveStale(node, it, threadId);
  return why === 'live' || (why === 'agents' && !liveSoon(/** @type {HTMLElement} */ (node), it.id, threadId));
}

/**
 * Paints a reply’s activity list and job rows again from its item, leaving the rest of the reply as it is.
 * @param {HTMLElement | undefined} node  the reply as drawn @param {any} it  the agent item @param {string} threadId
 * @returns {boolean} false when it couldn’t, and the caller draws the whole reply instead
 */
export function paintActivity(node, it, threadId) {
  if (!node || it?.kind !== 'agent' || it.status === 'replaced') return false;
  // A running turn’s live block is painted again at the next frame, once for all the steps that landed (paintLive).
  if (isLive(it, threadId)) return liveSoon(node, it.id, threadId);
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

/** The live replies to paint at the next frame: their nodes, with the thread each is in. */
const live = /** @type {Map<HTMLElement, { id: string, threadId: string }>} */ (new Map());
let frame = 0;

/**
 * Queues a running reply’s live block to paint at the next frame, so a burst of steps paints it once (#573: a step
 * paints its reply’s steps, not the reply). False when the reply has no live block yet, and is drawn whole instead.
 * @param {HTMLElement} node @param {string} id @param {string} threadId
 */
function liveSoon(node, id, threadId) {
  if (!node.querySelector(':scope > .live-steps')) return false;
  live.set(node, { id, threadId });
  if (!frame)
    frame = requestAnimationFrame(() => {
      frame = 0;
      const queued = [...live];
      live.clear();
      for (const [n, q] of queued) if (n.isConnected) paintLive(n, itemsOf(q.threadId)[placeIn(q.threadId, q.id)], q.threadId);
    });
  return true;
}

/**
 * Paints a running reply’s live block, its job rows, and its Markdown box when a step moved where the box starts, and
 * nothing else. “N earlier steps” stays open, and its summary keeps focus, as the person left them.
 * @param {HTMLElement} node @param {any} it @param {string} threadId
 */
function paintLive(node, it, threadId) {
  const old = node.querySelector(':scope > .live-steps');
  if (!it || !old) return;
  const [, block, jobs] = activityParts(it, threadId);
  if (!block) return;
  const earlier = old.querySelector('details.earlier');
  // Focus stays where you left it: on “N earlier steps”, or on a control or a thought that says which it is (data-focus).
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  const focused = earlier?.querySelector(':scope > summary') === active;
  const focusKey = old.contains(active) ? active?.dataset.focus : undefined;
  old.replaceWith(block);
  const now = block.querySelector('details.earlier');
  if (earlier?.hasAttribute('open')) now?.setAttribute('open', '');
  if (focused) /** @type {HTMLElement | null} */ (now?.querySelector(':scope > summary'))?.focus();
  if (focusKey) /** @type {HTMLElement | null} */ (block.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`))?.focus();
  const oldJobs = node.querySelector(':scope > ul.bg-jobs');
  if (oldJobs && jobs) oldJobs.replaceWith(jobs);
  else if (jobs) block.after(jobs);
  else oldJobs?.remove();
  const box = /** @type {HTMLElement | null} */ (node.querySelector(':scope > .md'));
  if (box && box.dataset.from !== String(textFrom(it, threadId))) paintAgentMarkdown(box, it, threadId);
  // A part another part ended is no longer being written: its caret goes.
  if (it.status !== 'streaming') box?.querySelector(':scope > .caret')?.remove();
}

// A crowded reply’s “Show the whole reply” asks for it to be painted again (activity-live.mjs, wholeButton).
addEventListener('live-repaint', (e) => {
  const node = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.transcript > [data-key]'));
  const threadId = /** @type {HTMLElement | null} */ (node?.closest('.transcript'))?.dataset.thread;
  if (node && threadId && node.dataset.key) liveSoon(node, node.dataset.key, threadId);
});

// A resized window changes each running reply’s share of it: their live blocks paint again to the new budget.
addEventListener('resize', () => {
  for (const block of document.querySelectorAll('.transcript > [data-key] > .live-steps:not([hidden])')) {
    const node = /** @type {HTMLElement} */ (block.parentElement);
    const threadId = /** @type {HTMLElement | null} */ (node.closest('.transcript'))?.dataset.thread;
    if (threadId && node.dataset.key) liveSoon(node, node.dataset.key, threadId);
  }
});
