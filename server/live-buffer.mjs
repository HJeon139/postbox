// A running turn’s live buffer (designs/architecture/live-progress.md, “Commit points” and “The buffer”): Turns’
// module. Each update to a step goes to the pages as a live frame, with a rev that rises at each change, and is stored
// only at a commit point: a new step of the agent’s own, which ends the words and step before it, the turn’s end, or
// more changed steps than the buffer holds. A step is stored without the live view’s detail (its input, output and
// diff), with its detail whole and `at` and `part`, which place it among the words; the fold at its end cuts the rest. The session’s
// live fields (its tool calls, current step, glimpse and subagents) go as frames only; its state and context stay
// stored, as do the writes at a turn’s edges. The buffer rides on the turn (turn.live), so it goes with the turn, and
// it’s bounded where it’s built (LIVE_CAPS), whatever a harness reports.

import { LIVE_CAPS } from '../shared/limits.mjs';
import { SESSION_FIELDS } from '../shared/live-kinds.mjs';
import { sendLive } from './store-live.mjs';

/** A string at most LIVE_CAPS.string long; anything else as it is. @param {unknown} v */
const capString = (v) => (typeof v === 'string' && v.length > LIVE_CAPS.string ? v.slice(0, LIVE_CAPS.string) : v);

/** An object with each string capped. @param {Record<string, any>} o */
const capFields = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, capString(v)]));

/** A list at most `n` long, each entry’s strings capped. @param {unknown} v @param {number} n */
const capList = (v, n) => (Array.isArray(v) ? v.slice(0, n).map((x) => (x && typeof x === 'object' ? capFields(x) : capString(x))) : undefined);

/**
 * The turn’s buffer, made on its first use: the steps changed since the last commit point by id, each step’s rev, and
 * the session’s live fields. @param {any} turn
 */
function bufferOf(turn) {
  turn.live ??= { changed: new Map(), rev: new Map(), session: {} };
  return turn.live;
}

/** Whether a step is a new one of the agent’s own: not a subagent’s, a thought or narration. @param {any} live @param {any} step */
const startsOwn = (live, step) => !live.rev.has(step.id) && step.state === 'running' && !step.who && step.kind !== 'thought' && step.kind !== 'said';

/**
 * A step as a commit point stores it: without the live view’s input, output and diff. Its detail stays whole (a thought
 * is shown whole while its turn runs, and a page merges the stored step over the live one); the fold at the turn’s end
 * cuts it, as it always has (shared/step-fold.mjs). @param {any} step
 */
function storedStep(step) {
  const { input, output, diff, ...kept } = step;
  return kept;
}

/** A commit point: stores each step changed since the last, then forgets them. @param {any} rt @param {any} turn */
export function liveCommit(rt, turn) {
  const live = turn.live;
  if (!live?.changed.size) return;
  for (const { itemId, step } of live.changed.values()) rt.store.emit('item.patch', { threadId: turn.threadId, id: itemId, activityStep: storedStep(step) });
  live.changed.clear();
}

/**
 * A step’s update: a commit point first, when it’s a new step of the agent’s own or the buffer is full; then the step,
 * kept and sent live with its rev. @param {any} rt @param {any} turn @param {any} step
 */
export function liveStep(rt, turn, step) {
  const live = bufferOf(turn);
  if (startsOwn(live, step) || (!live.changed.has(step.id) && live.changed.size >= LIVE_CAPS.steps)) liveCommit(rt, turn);
  const capped = capFields(step);
  const rev = (live.rev.get(step.id) ?? 0) + 1;
  live.rev.set(step.id, rev);
  live.changed.set(step.id, { itemId: turn.first, step: { ...(live.changed.get(step.id)?.step ?? {}), ...capped } });
  sendLive(rt.store, { kind: 'step', threadId: turn.threadId, itemId: turn.first, turnId: turn.id, rev, step: capped });
}

/**
 * The session’s live fields: merged into the buffer, and sent live as they changed.
 * @param {any} rt @param {any} turn @param {Record<string, any>} patch
 */
export function liveSession(rt, turn, patch) {
  /** @type {Record<string, any>} */
  const capped = {};
  for (const [k, v] of Object.entries(patch)) capped[k] = k === 'toolCalls' || k === 'subagents' ? capList(v, LIVE_CAPS[k]) : capString(v);
  Object.assign(bufferOf(turn).session, capped);
  sendLive(rt.store, { kind: 'session', sessionId: turn.sessionId, ...capped });
}

/**
 * The turn’s end, or its stop: a last commit point, with the session’s tool calls and their count as the turn leaves
 * them, which nothing at a turn’s edge writes; then the buffer goes. Its step, glimpse and subagents are the edges’ to
 * write (turn-needs.mjs, turn-finish.mjs, turn-stop.mjs). @param {any} rt @param {any} turn
 */
export function liveEnd(rt, turn) {
  liveCommit(rt, turn);
  const { toolCalls, toolCount } = turn.live?.session ?? {};
  if (toolCalls !== undefined || toolCount !== undefined)
    rt.sessions.update(turn.sessionId, { ...(toolCalls !== undefined ? { toolCalls } : {}), ...(toolCount !== undefined ? { toolCount } : {}) });
  turn.live = null;
}

/** The running turns’ snapshots, for a page that loads mid-turn (/api/state’s live). @param {any} rt */
export function liveSnapshots(rt) {
  return rt.running
    .all()
    .filter((/** @type {any} */ t) => t.live)
    .map((/** @type {any} */ t) => ({
      turnId: t.id,
      sessionId: t.sessionId,
      threadId: t.threadId,
      itemId: t.first,
      steps: [...t.live.changed.values()].map((c) => c.step),
      session: { ...t.live.session },
    }));
}

/**
 * A running turn’s change to its session: the live fields go to the buffer and the pages live, and the rest (its state,
 * its context) is stored, only when there is any. @param {any} rt @param {any} turn @param {Record<string, any>} patch
 */
export function liveUpdate(rt, turn, patch) {
  /** @type {Record<string, any>} */
  const stored = {};
  /** @type {Record<string, any>} */
  const live = {};
  for (const [k, v] of Object.entries(patch)) (SESSION_FIELDS.includes(k) ? live : stored)[k] = v;
  if (Object.keys(stored).length) rt.sessions.update(turn.sessionId, stored);
  if (Object.keys(live).length) liveSession(rt, turn, live);
}

/**
 * The session’s live fields as the running turn has them: the buffer’s, over what was stored when it began.
 * @param {any} rt @param {any} turn
 */
export function liveFields(rt, turn) {
  const se = rt.store.pending.session(turn.sessionId) ?? rt.s.sessions[turn.sessionId] ?? {};
  return { toolCalls: se.toolCalls ?? [], toolCount: se.toolCount ?? 0, currentStep: se.currentStep, subagents: se.subagents ?? [], ...turn.live?.session };
}
