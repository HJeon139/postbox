// The tester’s scroll while an agent works (#805): an interrupt {after, do: scroll, moves} pages the conversation back
// and forth while a reply streams, as a person reading along does. A step can’t, since the run waits for the agents
// before each one. Each move is the scroll step’s own (tools/uat/scroll-step.mjs): the input recorded first, then the
// key. Once the view has stopped moving, it takes a sample from the view probe (tools/uat/view-probe.mjs), and a
// second a pause later with no input between, so view-moved compares a pair while the turn runs.

import { sleep } from '../browser.mjs';
import { KEYS, scrollStep } from './scroll-step.mjs';
import { recordViews } from './view-probe.mjs';

/** The most moves one interrupt makes: enough to page back a few times and come back. */
export const MOVES_MAX = 8;
/** After each move’s first sample, before its second: the reply streams on between them, in ms. */
const BETWEEN_MS = 1000;
/** The longest wait for a key’s scroll to stop before sampling, in ms: a view following a stream never stops. */
const STILL_MAX_MS = 1500;

/**
 * The interrupt’s moves, checked before the agent works its seconds, so a bad one fails at once.
 * @param {{ moves?: unknown }} interrupt  @returns {string[]}
 */
export function scrollMoves({ moves }) {
  if (!Array.isArray(moves) || !moves.length || moves.length > MOVES_MAX)
    throw new Error(`A scroll while an agent works needs moves: 1 to ${MOVES_MAX} of up, down, end or start.`);
  const bad = moves.find((m) => !Object.hasOwn(KEYS, String(m)));
  if (bad !== undefined) throw new Error(`A move is up, down, end or start, not “${bad}”.`);
  return moves;
}

/**
 * Resolves once the page’s scroll has held still for three frames, or after STILL_MAX_MS: a key’s scroll may be
 * smooth, and a sample taken mid-scroll doesn’t count as settled. A timer backs the frames up, so a page that draws
 * none can’t hold the run.
 */
const STILL = `new Promise((done) => {
  setTimeout(() => done(false), ${STILL_MAX_MS + 200});
  const s = document.scrollingElement;
  const start = performance.now();
  let last = s.scrollTop;
  let same = 0;
  const tick = () => {
    same = s.scrollTop === last ? same + 1 : 0;
    last = s.scrollTop;
    if (same >= 3 || performance.now() - start > ${STILL_MAX_MS}) done(true);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;

// Whether the conversation’s Stop shows: the agent was still working at that move, so its sample was mid-stream.
const WORKING = `(() => {
  const c = [...document.querySelectorAll('.composer')].find((x) => !x.closest('.sidepanel'));
  const b = c?.querySelector('button.stop');
  return !!b && b.offsetParent !== null;
})()`;

/** What the conversation’s view was at the last sample, for the tester. @param {any[]} views */
function viewSaid(views) {
  const s = views.findLast((v) => v.where === 'main');
  if (!s) return 'the view probe read nothing';
  return s.mode === 'reading' ? `reading, at ${s.anchorId}` : String(s.mode);
}

/**
 * Makes each move while the agent works, sampling the view after each, and again a pause later.
 * @param {{ d: any, facts: any, step: number, pause?: () => Promise<void> }} ctx  pause: the wait between a move’s two
 *   samples
 * @param {{ moves?: unknown }} interrupt
 * @returns {Promise<string>}  what happened, for the tester
 */
export async function scrollMidTurn({ d, facts, step, pause = () => sleep(BETWEEN_MS) }, interrupt) {
  const said = [];
  for (const by of scrollMoves(interrupt)) {
    await scrollStep({ page: d.kit.page, facts, step }, { by });
    await d.kit.ev(STILL);
    const before = (facts.probes.views ?? []).length;
    await recordViews(d.kit.ev, facts, step);
    const view = viewSaid((facts.probes.views ?? []).slice(before));
    // A second sample a pause later, with no input since the first: the pair view-moved compares while the reply
    // streams, where a view that moves on its own shows.
    await pause();
    await recordViews(d.kit.ev, facts, step);
    const live = (await d.kit.ev(WORKING)) ? 'while the agent worked' : 'after the agent had finished';
    said.push(`${KEYS[/** @type {keyof typeof KEYS} */ (by)]} (${view}, ${live})`);
  }
  return `Scrolled: ${said.join('; ')}.`;
}
