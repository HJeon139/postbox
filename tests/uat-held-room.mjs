// The room of #1760, for the tests of the UAT runner’s wait: an agent shows a block that asks and keeps its turn open.
// The blocks are the ones recorded runs showed (tests/fixtures/uat/quiet-rooms.json); when each is shown, when it’s
// answered and how long the turn stays open are set by the test, on a fake clock, since the run of 25 November that
// stalled left no records in uat-runs/.

import { readFileSync } from 'node:fs';
import { stepPrompt } from '../tools/uat/step-prompt.mjs';

const runs = JSON.parse(readFileSync(new URL('./fixtures/uat/quiet-rooms.json', import.meta.url), 'utf8')).runs;
const recorded = (/** @type {any} */ run, /** @type {string} */ id) => run.events.find((/** @type {any} */ e) => e.data?.item?.id === id).data.item;

/** @researcher’s choice “Fix the load script?”, as the addressed run recorded it. */
export const ASK = recorded(runs.addressed, 'it_A7KpEE1Q');
/** @critic’s choice “Which file name should the app use?”, as the holdstill run recorded it. */
export const SECOND_ASK = recorded(runs.holdstill, 'it_VxaKDGXv');

export const THREADS = ['th_main', 'th_side'];

/**
 * Postbox’s state, read on the fake clock: @researcher at a turn until `endAt`, and each of `asks` on screen from its
 * `at`, in its `thread` (the main one unless it says), unanswered until its `answeredAt`.
 * @param {{ endAt?: number, asks?: { item: any, at?: number, answeredAt?: number, thread?: string }[] }} [o]
 */
export function heldRoom({ endAt = 600_000, asks = [{ item: ASK }] } = {}) {
  return async () => {
    const now = Date.now();
    const se = { id: ASK.sessionId, handle: 'researcher', threadId: 'th_main', state: now < endAt ? 'tool' : 'idle' };
    /** @type {Record<string, any[]>} */
    const items = { th_main: [], th_side: [] };
    for (const { item, at = 0, answeredAt = Infinity, thread = 'th_main' } of asks) if (now >= at) items[thread].push({ ...item, answered: now >= answeredAt });
    const threads = {
      th_main: { id: 'th_main', title: 'Deletes', members: [se.id] },
      th_side: { id: 'th_side', parentId: 'th_main', title: 'Release notes', members: [] },
    };
    return { state: { threads, sessions: { [se.id]: se }, apps: {}, items } };
  };
}

/** A fake driver: no working rows, and when Stop was pressed. */
export function fakeDriver() {
  /** @type {{ stop: number | null }} */
  const at = { stop: null };
  return {
    at,
    working: async () => [],
    stopAll: async () => {
      at.stop = Date.now();
    },
  };
}

/** What settle() takes from the run, with a log the test reads. */
export function waitCtx(/** @type {() => Promise<any>} */ api, over = {}) {
  /** @type {string[]} */
  const lines = [];
  return {
    api,
    d: fakeDriver(),
    threadsUnderTest: () => THREADS,
    facts: { samples: [] },
    midTurnChecks: async () => {},
    opt: { 'turn-timeout': '900' },
    told: new Set(),
    handBack: true,
    log: (/** @type {string} */ l) => lines.push(l),
    lines,
    ...over,
  };
}

/** The step’s prompt as tools/uat-run.mjs builds it, with nothing new on screen. */
export const promptFor = (
  /** @type {{ waiting: string[], lastAction?: any, actionError?: string | null }} */ { waiting, lastAction = null, actionError = null },
) =>
  stepPrompt({
    step: 2,
    steps: 15,
    phase: 0,
    scenario: { phases: [{ title: 'An ask shown while its agent still works', text: 'Ask for a choice, then move on.' }] },
    goal: {},
    lastAction,
    actionError,
    actionResult: null,
    timedOut: null,
    obs: { items: [], states: ['@researcher: tool'] },
    waiting,
    jobsAsk: null,
    fresh: [],
  });
