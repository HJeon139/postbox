// A running turn’s steps as they happen (designs/rooms-at-scale.md, “Live state”). Its own words, and its thoughts
// whole, sit between its steps in the order it wrote and ran them. The newest step shows in full, an edit as its small
// diff and a command with the end of its output; older ones are a line each, “✓ Edited notes.txt +1 −1”. Detail fades
// with age within a height budget: the visible transcript shared by the agents working in it. Past what fits, older
// steps are “N earlier steps”, and with eight or more agents working, a turn’s steps are one line: what it’s doing now
// and how many steps it took.

import { stepRow } from './activity-steps.mjs';
import { busy, itemsOf, placeIn, sessionsAt } from './client.mjs';
import { h, plural } from './dom.mjs';

// Heights the budget counts in, in pixels: one step’s line, the newest step in full, a line of a thought capped at up
// to THOUGHT_LINES and its button, a line of the reply’s words and the space between its paragraphs, and what each agent at work has
// besides: its reply’s name line and its working row under the transcript.
const LINE = 24;
const FULL = 80;
const THOUGHT_LINES = 3;
const THOUGHT_LINE = 20;
const THOUGHT_MORE = 22;
const WORD_LINE = 21;
const PARAGRAPH = 10;
const AROUND = 28 + 30;
// About how many characters of the reply’s words fill a line of the transcript’s column.
const LINE_CHARS = 95;
// With this many agents working in one conversation, each turn’s steps are one line.
const CROWD = 8;
/** How far apart, in items, a turn’s parts are looked for: a long room’s old turns cost no more than a new one’s. */
export const PARTS_WITHIN = 200;
const GLYPH = { running: 'running', failed: 'failed', denied: 'failed', done: 'done', stopped: 'stalled' };

/** The sessions at work in a conversation now: busy, with their turn here rather than in a side thread (#110). */
const atWork = (/** @type {string} */ threadId) =>
  sessionsAt(threadId).filter((se) => !se.archived && busy(se) && (!se.sideTurn || se.sideTurn.threadId === threadId));

/** How many agents are at work in a conversation now. @param {string} threadId */
export const liveAgents = (threadId) => atWork(threadId).length;

/**
 * Whether a reply’s turn still runs: it’s still being written, or its agent is at work here and this is its newest
 * turn. A part ends early when anything is posted below it (reply-segment.mjs), and shows its steps while the turn runs.
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
 * Whether an agent’s reply here is live, its thoughts and words shown as they’re written, so its working row needn’t
 * say them again. @param {any} se @param {string} threadId
 */
export function liveHere(se, threadId) {
  const items = itemsOf(threadId);
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'agent' && items[i].sessionId === se.id) return isLive(items[i], threadId);
  return false;
}

/**
 * A turn’s first part, which keeps all its steps (server/reply-segment.mjs, placeStep): this one, or the nearest above
 * of its turn. @param {any} it @param {string} threadId
 */
export function firstPart(it, threadId) {
  if (it.activity || !it.turnId) return it;
  const items = itemsOf(threadId);
  const from = placeIn(threadId, it.id);
  for (let i = from - 1; i >= Math.max(0, from - PARTS_WITHIN); i--) {
    const x = items[i];
    if (x.kind === 'agent' && x.turnId === it.turnId && x.activity) return x;
  }
  return null;
}

/**
 * The steps a part of a reply shows while its turn runs: the ones that fell in it. A post below the reply puts the
 * steps after it in a later part, with the words they led to. @param {any} it @param {string} threadId
 */
export function partSteps(it, threadId) {
  const first = firstPart(it, threadId);
  return (first?.activity?.steps ?? []).filter((/** @type {any} */ s) => (s.part ?? first.id) === it.id);
}

/**
 * The drawn parts of a reply that a step patch on its first part draws again: all its later ones, when the step shows
 * in one of them or moves to one from the part before (server/reply-segment.mjs, placeStep).
 * @param {{ id: string, activityStep?: any }} d  the item.patch's data @param {string} threadId @param {any[]} drawn
 */
export function laterParts(d, threadId, drawn) {
  // Or the turn ended, or a finished turn’s step changed: its record may show on a later part (work-record.mjs).
  const it = d.activityStep?.part || d.foldSteps || d.activityStep ? itemsOf(threadId)[placeIn(threadId, d.id)] : null;
  const turnId = it && (d.activityStep?.part || d.foldSteps || !isLive(it, threadId)) ? it.turnId : null;
  return turnId ? drawn.filter((x) => x.id !== d.id && x.kind === 'agent' && x.turnId === turnId).map((x) => x.id) : [];
}

/**
 * Each conversation’s visible height, read once and again only after the window is resized: reading it after a reply
 * changed forces a layout of the page, once a step. A composer grown by what you type isn’t counted until then.
 */
const heights = /** @type {Map<string, number>} */ (new Map());
addEventListener('resize', () => heights.clear());

/**
 * What the conversation shows at once: its scrolling box, or the window, less the sticky top bar and composer.
 * @param {string} threadId
 */
function visibleHeight(threadId) {
  if (!heights.has(threadId)) heights.set(threadId, measureHeight(threadId));
  return /** @type {number} */ (heights.get(threadId));
}

/** @param {string} threadId */
function measureHeight(threadId) {
  const transcript = document.querySelector(`.transcript[data-thread="${CSS.escape(threadId)}"]`);
  let el = transcript?.parentElement;
  while (el && !/auto|scroll/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
  const bar = el ? 0 : Math.max(0, document.querySelector('header.topbar')?.getBoundingClientRect().bottom ?? 0);
  const composer = /** @type {HTMLElement | null | undefined} */ (transcript?.parentElement?.querySelector(':scope > .composer'))?.offsetHeight ?? 0;
  return (el?.clientHeight || window.innerHeight) - bar - composer;
}

/** About how tall a reply’s words draw. @param {string} text */
const wordsHeight = (text) =>
  text
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .reduce((sum, p) => sum + Math.ceil(p.length / LINE_CHARS) * WORD_LINE + PARAGRAPH, 0);

/**
 * How a running reply’s steps fit its share of the visible transcript, once its words and what each agent at work has
 * besides are counted: { lines, full, thought }. thought: how many lines its newest thought shows, up to THOUGHT_LINES
 * and 0 for none; full: whether its newest call shows in full; lines: how many of its older steps show as a line each.
 * With eight agents or more, or when even a line beside its words doesn’t fit, its steps are one line, and no thought.
 * @param {string} threadId @param {string} text  the reply’s words @param {boolean} thinks  whether it has a thought
 */
function fit(threadId, text, thinks) {
  const agents = Math.max(1, liveAgents(threadId));
  const room = visibleHeight(threadId) / agents - AROUND - wordsHeight(text);
  const fits = Math.floor((room - LINE - THOUGHT_MORE) / THOUGHT_LINE);
  const thought = thinks && agents < CROWD ? Math.max(0, Math.min(THOUGHT_LINES, fits)) : 0;
  const left = room - (thought ? thought * THOUGHT_LINE + THOUGHT_MORE : 0);
  if (agents >= CROWD || left < LINE) return { lines: -1, full: false, thought: 0 };
  if (left < FULL) return { lines: 0, full: false, thought };
  return { lines: Math.max(0, Math.floor((left - FULL) / LINE)), full: true, thought };
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
  // An edit’s diff says what its input and its “ok” would: its label names the file.
  if (s.diff) for (const said of text?.querySelectorAll(':scope > .step-input, :scope > .step-output') ?? []) said.remove();
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
  const steps = ownSteps(partSteps(it, threadId));
  if (
    !steps.length ||
    fit(
      threadId,
      String(it.text ?? ''),
      steps.some((s) => s.kind === 'thought'),
    ).lines < 0
  )
    return 0;
  return Math.min(String(it.text ?? '').length, Math.max(0, ...steps.map((s) => Number(s.at) || 0)));
}

/** The id of a turn’s newest call, in whichever of its reply’s parts it fell. @param {any} it @param {string} threadId */
export const newestCall = (it, threadId) => callsOf(ownSteps(firstPart(it, threadId)?.activity?.steps ?? [])).at(-1)?.id;

/**
 * A running turn’s steps between its words: each run of steps with the words written before it, the words after the
 * last step left to the reply’s Markdown box (textFrom). Only the turn’s newest call shows in full (`newestId`), so a
 * reply in parts shows one. Crowded, one line.
 * @param {any} it  the agent item @param {string} threadId @param {(text: string) => HTMLElement} words  draws words
 * @param {string} [newestId]  the turn’s newest call (newestCall)
 */
export function liveParts(it, threadId, words, newestId) {
  const steps = ownSteps(it.activity?.steps ?? []);
  // A part with no steps of its own is marked live all the same, so it’s drawn again when its turn ends (liveStale).
  if (!steps.length) return h('div.live-steps', { hidden: true });
  const text = String(it.text ?? '');
  // Its newest thought shows, capped; an older one is a line among its steps, which fade into “N earlier steps”.
  const thinking = steps.findLast((s) => s.kind === 'thought');
  const { lines, full, thought } = fit(threadId, text, Boolean(thinking));
  const calls = steps.filter((s) => s !== thinking);
  const last = callsOf(steps).at(-1) ?? steps.at(-1);
  const newest = full && (newestId === undefined || last.id === newestId) ? last : null;
  // The number of agents at work it was drawn for (liveStale).
  const agents = { dataset: { agents: String(liveAgents(threadId)) } };
  if (lines < 0) {
    const line = lineRow(last);
    line.append(h('span.small.dim', `· ${plural(callsOf(steps).length, 'step')}`));
    return h('div.live-steps.crowded', agents, h('ul.steps.live', line));
  }
  const shownFrom = Math.max(0, calls.length - (full ? 1 : 0) - lines); // older than this, a step is one of “N earlier steps”
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
    // Its newest thought shows between the calls before and after it, capped at THOUGHT_LINES, whole a click away.
    if (s === thinking) {
      flush();
      if (thought) parts.push(...thoughtParts(s, thought));
    } else run.push(s);
  }
  flush();
  return h('div.live-steps', agents, parts);
}

/** The thoughts whose whole text you asked to see, by step id: they stay whole as their reply paints again. */
const wholeThoughts = new Set();

/** A thought, capped at `lines` with a button to show it whole when it’s longer. @param {any} s @param {number} lines */
function thoughtParts(s, lines) {
  const text = String(s.detail || s.label);
  const capped = text.length > lines * LINE_CHARS && !wholeThoughts.has(s.id);
  const el = h(`div.live-thought${capped ? '.clamped' : ''}`, { style: `--lines: ${lines}` }, text);
  if (!capped) return [el];
  const more = h(
    'button.thought-more',
    {
      type: 'button',
      onclick: () => {
        wholeThoughts.add(s.id);
        el.classList.remove('clamped');
        more.remove();
      },
    },
    'Show the whole thought',
  );
  return [el, more];
}

/**
 * Whether a reply was drawn for another moment than now: 'live' when its turn started or stopped running since, and
 * 'agents' when as many agents aren’t at work now, so its steps no longer fit its share of the screen.
 * @param {HTMLElement | undefined} node @param {any} it @param {string} threadId @returns {'live' | 'agents' | false}
 */
export function liveStale(node, it, threadId) {
  if (!node || it?.kind !== 'agent') return false;
  const live = /** @type {HTMLElement | null} */ (node.querySelector(':scope > .live-steps'));
  if (Boolean(live) !== isLive(it, threadId)) return 'live';
  return live && !live.hidden && live.dataset.agents !== String(liveAgents(threadId)) ? 'agents' : false;
}
