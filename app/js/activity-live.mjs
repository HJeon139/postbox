// A running turn’s steps as they happen (designs/rooms-at-scale.md, “Live state”). Its own words, and its thoughts
// whole, sit between its steps in the order it wrote and ran them. The newest step shows in full, an edit as its small
// diff and a command with the end of its output; older ones are a line each, “✓ Edited notes.txt +1 −1”. Detail fades
// with age within a height budget: the visible transcript shared by the agents working in it. Past what fits, older
// steps are “N earlier steps”, and with eight or more agents working, a turn’s steps are one line: what it’s doing now
// and how many steps it took.

import { stepRow } from './activity-steps.mjs';
import { busy, itemsOf, sessionsAt } from './client.mjs';
import { h, plural } from './dom.mjs';

// Heights the budget counts in, in pixels: one step’s line, and the newest step in full.
const LINE = 24;
const FULL = 80;
// With this many agents working in one conversation, each turn’s steps are one line.
const CROWD = 8;
const GLYPH = { running: 'running', failed: 'failed', denied: 'failed', done: 'done', stopped: 'stalled' };

/** The sessions at work in a conversation now: busy, with their turn here rather than in a side thread (#110). */
const atWork = (/** @type {string} */ threadId) =>
  sessionsAt(threadId).filter((se) => !se.archived && busy(se) && (!se.sideTurn || se.sideTurn.threadId === threadId));

/** How many agents are at work in a conversation now. @param {string} threadId */
export const liveAgents = (threadId) => atWork(threadId).length;

/**
 * Whether a reply’s turn still runs: it’s still being written, or its agent is at work here and this is its newest
 * turn. A turn’s steps stay on its first part, which ends early when anything is posted below it (reply-segment.mjs).
 * @param {any} it @param {string} threadId
 */
export function isLive(it, threadId) {
  if (it?.kind !== 'agent') return false;
  if (it.status === 'streaming') return true;
  if (!it.turnId || !atWork(threadId).some((se) => se.id === it.sessionId)) return false;
  const items = itemsOf(threadId);
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'agent' && items[i].sessionId === it.sessionId) return items[i].turnId === it.turnId;
  return false;
}

/**
 * What the conversation shows at once: its scrolling box, or the window, less the sticky top bar and composer.
 * @param {string} threadId
 */
function visibleHeight(threadId) {
  const transcript = document.querySelector(`.transcript[data-thread="${CSS.escape(threadId)}"]`);
  let el = transcript?.parentElement;
  while (el && !/auto|scroll/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
  const bar = el ? 0 : Math.max(0, document.querySelector('header.topbar')?.getBoundingClientRect().bottom ?? 0);
  const composer = /** @type {HTMLElement | null | undefined} */ (transcript?.parentElement?.querySelector(':scope > .composer'))?.offsetHeight ?? 0;
  return (el?.clientHeight || window.innerHeight) - bar - composer;
}

/** How many of a turn’s older steps show as a line each, from its share of the visible transcript. @param {string} threadId */
function linesFor(threadId) {
  const agents = Math.max(1, liveAgents(threadId));
  if (agents >= CROWD) return -1;
  const height = visibleHeight(threadId);
  return Math.max(0, Math.floor((height / agents - FULL - LINE) / LINE));
}

/** The steps a live turn shows: its own, at the top of its list (a subagent’s show under the step that started it). */
const ownSteps = (/** @type {any[]} */ steps) => steps.filter((s) => !s.parent && !s.who && s.kind !== 'said');
/** Its calls, without its thoughts, which show whole between them. @param {any[]} steps */
const callsOf = (steps) => steps.filter((s) => s.kind !== 'thought');

/** “+12 −3”, its counts green and red, as a finished post’s files show them. @param {any} s */
const counts = (s) => (typeof s.added === 'number' ? h('span.work-n', h('span.add', `+${s.added}`), ' ', h('span.del', `−${s.deleted ?? 0}`)) : null);

/** A step’s glyph and what it says to a screen reader: a thought, or its state. @param {any} s */
function glyphOf(s) {
  if (s.kind === 'thought') return { glyph: 'thought', said: 'thought' };
  return { glyph: GLYPH[/** @type {'done'} */ (s.state)] ?? 'done', said: s.state === 'denied' ? 'refused' : s.state };
}

/** A step in one line: its glyph, its label, and what an edit changed. @param {any} s */
function lineRow(s) {
  const { glyph, said } = glyphOf(s);
  return h('li.step-line', h(`span.g.g-${glyph}`, { role: 'img', 'aria-label': said }), h('span.mono', s.label), counts(s));
}

/** The newest step in full: as the list draws it, with an edit’s diff and its counts. @param {any} s */
function fullRow(s) {
  const row = stepRow(s);
  row.classList.add('step-full');
  const text = row.querySelector('.step-text');
  const n = counts(s);
  if (n) text?.querySelector('.mono')?.after(' ', n);
  if (s.diff)
    text?.append(
      h(
        'pre.step-diff',
        String(s.diff)
          .split('\n')
          .map((l) => h(l.startsWith('-') ? 'span.del' : 'span.add', `${l}\n`)),
      ),
    );
  return row;
}

/**
 * Where the reply’s Markdown box starts in its text: after the words the turn wrote before its last step. The words
 * before it are drawn between the steps (liveParts); crowded, the box has them all. @param {any} it
 */
export function textFrom(it, /** @type {string} */ threadId) {
  if (!isLive(it, threadId)) return 0;
  const steps = ownSteps(it.activity?.steps ?? []);
  if (!steps.length || linesFor(threadId) < 0) return 0;
  return Math.min(String(it.text ?? '').length, Math.max(0, ...steps.map((s) => Number(s.at) || 0)));
}

/**
 * A running turn’s steps between its words: each run of steps with the words written before it, the words after the
 * last step left to the reply’s Markdown box (textFrom). Crowded, one line.
 * @param {any} it  the agent item @param {string} threadId @param {(text: string) => HTMLElement} words  draws words
 */
export function liveParts(it, threadId, words) {
  const steps = ownSteps(it.activity?.steps ?? []);
  if (!steps.length) return null;
  const lines = linesFor(threadId);
  const calls = callsOf(steps);
  const newest = calls.at(-1) ?? steps.at(-1);
  // The number of agents at work it was drawn for (liveStale).
  const agents = { dataset: { agents: String(liveAgents(threadId)) } };
  if (lines < 0) {
    const line = lineRow(newest);
    line.append(h('span.small.dim', `· ${plural(calls.length, 'step')}`));
    return h('div.live-steps.crowded', agents, h('ul.steps.live', line));
  }
  const text = String(it.text ?? '');
  const shownFrom = Math.max(0, calls.length - 1 - lines); // older than this, a step is one of “N earlier steps”
  const parts = [];
  let cursor = 0;
  /** @type {any[]} */
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const earlier = run.filter((s) => calls.indexOf(s) < shownFrom);
    const shown = run.filter((s) => calls.indexOf(s) >= shownFrom);
    parts.push(
      h(
        'ul.steps.live',
        earlier.length
          ? h('li.step-earlier', h('details.earlier', h('summary', `${plural(earlier.length, 'earlier step')}`), h('ul.steps', earlier.map(lineRow))))
          : null,
        shown.map((s) => (s === newest ? fullRow(s) : lineRow(s))),
      ),
    );
    run = [];
  };
  for (const s of steps) {
    const at = Math.min(text.length, Number(s.at) || 0);
    if (at > cursor) {
      flush();
      parts.push(words(text.slice(cursor, at)));
      cursor = at;
    }
    // A thought shows whole, as its harness shows it, between the calls before and after it.
    if (s.kind === 'thought') {
      flush();
      parts.push(h('div.live-thought', s.detail || s.label));
    } else run.push(s);
  }
  flush();
  return h('div.live-steps', agents, parts);
}

/**
 * Whether a reply was drawn for another moment than now: live, or not, as its turn runs now; and for as many agents at
 * work as now, so its steps fit its share of the screen. @param {HTMLElement | undefined} node @param {any} it
 * @param {string} threadId
 */
export function liveStale(node, it, threadId) {
  if (!node || it?.kind !== 'agent' || !it.activity?.steps?.length) return false;
  const drawn = /** @type {HTMLElement | null} */ (node.querySelector(':scope > .live-steps'))?.dataset.agents;
  if ((drawn !== undefined) !== isLive(it, threadId)) return true;
  return drawn !== undefined && drawn !== String(liveAgents(threadId));
}
