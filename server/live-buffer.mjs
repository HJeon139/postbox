// A running turn’s live buffer (designs/architecture/live-progress.md, “Commit points” and “The buffer”): Turns’
// module. Each update to a step goes to the pages as a live frame, with a rev that rises at each change, and is stored
// only at a commit point: a new step of the agent’s own, which ends the words and step before it, the turn’s end, or
// more changed steps than the buffer holds. A step is stored without the live view’s detail (its input, output and
// diff), with its detail whole and `at` and `part`, which place it among the words; the fold at its end cuts the rest. The session’s
// live fields (its tool calls, current step, glimpse and subagents) go as frames only; its state and context stay
// stored, as do the writes at a turn’s edges. The buffer rides on the turn (turn.live), so it goes with the turn, and
// it’s bounded where it’s built (LIVE_CAPS), whatever a harness reports.

import { LIVE_CAPS } from '../shared/limits.mjs';
import { CARRIED_FIELDS, SESSION_FIELDS } from '../shared/live-kinds.mjs';
import { committed } from './live-sent.mjs';
import { sessionPatch } from './session-patch.mjs';
import { onSessionWrite, sendLive } from './store-live.mjs';

/** A string at most LIVE_CAPS.string long; anything else as it is. @param {unknown} v */
const capString = (v) => (typeof v === 'string' && v.length > LIVE_CAPS.string ? v.slice(0, LIVE_CAPS.string) : v);

/** An object with each string capped. @param {Record<string, any>} o */
function capFields(o) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k in o) if (Object.hasOwn(o, k)) out[k] = capString(o[k]);
  return out;
}

/** A list at most `n` long, each entry’s strings capped. @param {unknown} v @param {number} n */
const capList = (v, n) => (Array.isArray(v) ? v.slice(0, n).map((x) => (x && typeof x === 'object' ? capFields(x) : capString(x))) : undefined);

/** The stores whose stored session writes the buffers follow (watchStored). */
const watched = new WeakSet();

/**
 * Which wins (live-progress.md): a stored write of a session while its turn runs is made after the turn’s waiting
 * frame, which goes first, and a live field it writes, such as “Stopping” or “Waiting for you”, replaces the buffer’s
 * value, so a snapshot and the next frame start from it. Taken when the write is made, so a write held behind a
 * commit can’t undo a newer live value when it’s published. Followed once a store. @param {any} rt
 */
function watchStored(rt) {
  if (watched.has(rt.store)) return;
  watched.add(rt.store);
  onSessionWrite(rt.store, (data) => {
    const turn = rt.running?.turnOf?.(data.id);
    if (!turn?.live) return;
    liveFlush(rt, turn);
    const { session } = turn.live;
    for (const k of SESSION_FIELDS) if (Object.hasOwn(data.patch ?? {}, k)) session[k] = data.patch[k];
    for (const k of data.unset ?? []) if (SESSION_FIELDS.includes(k)) delete session[k];
  });
}

/**
 * Sends a turn’s waiting session frame, if it has one: at the end of the tick it was made in, or before anything that
 * must follow it (a stored session write, a commit point, the turn’s end). @param {any} rt @param {any} turn
 */
export function liveFlush(rt, turn) {
  const frame = turn.live?.frame;
  if (!frame) return;
  turn.live.frame = null;
  sendLive(rt.store, frame);
}

/**
 * The turn’s buffer, made on its first use: the steps changed since the last commit point by id, each step’s rev, and
 * the session’s live fields. @param {any} rt @param {any} turn
 */
function bufferOf(rt, turn) {
  watchStored(rt);
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
  liveFlush(rt, turn);
  if (!live?.changed.size) return;
  for (const { itemId, step } of live.changed.values()) {
    const data = { threadId: turn.threadId, id: itemId, activityStep: storedStep(step) };
    committed.add(data); // not sent to a page that had the step live (server/live-sent.mjs)
    rt.store.emit('item.patch', data);
  }
  live.changed.clear();
}

/**
 * A step’s update: a commit point first, when it’s a new step of the agent’s own or the buffer is full; then the step,
 * kept and sent live with its rev. @param {any} rt @param {any} turn @param {any} step
 */
export function liveStep(rt, turn, step) {
  const live = bufferOf(rt, turn);
  if (startsOwn(live, step) || (!live.changed.has(step.id) && live.changed.size >= LIVE_CAPS.steps)) liveCommit(rt, turn);
  const rev = (live.rev.get(step.id) ?? 0) + 1;
  live.rev.set(step.id, rev);
  const before = live.changed.get(step.id)?.step;
  const sent = before ? changedOf(before, step) : capFields(step);
  live.changed.set(step.id, { itemId: turn.first, step: before ? { ...before, ...sent } : { ...sent } });
  sendLive(rt.store, { kind: 'step', threadId: turn.threadId, itemId: turn.first, rev, step: sent });
}

/**
 * What a step’s update changed since the buffer last had it, capped, with its id: what a frame sends of a step the page
 * has, so a step isn’t sent whole each time, which would cost the wire more than the log saves. A page merges it over
 * the step it holds (shared/live-apply.mjs); one that joins later gets the whole step from the snapshot or the store.
 * @param {Record<string, any>} before @param {Record<string, any>} now
 */
function changedOf(before, now) {
  /** @type {Record<string, any>} */
  const out = { id: now.id };
  for (const k in now) {
    if (!Object.hasOwn(now, k)) continue;
    const v = capString(now[k]);
    if (before[k] !== v) out[k] = v;
  }
  return out;
}

/**
 * Whether two lists of flat entries (tool calls, subagents) hold the same values, entry by entry.
 * @param {unknown} a @param {unknown} b
 */
function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (!x || !y || typeof x !== 'object' || typeof y !== 'object') return false;
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length || keys.some((k) => x[k] !== y[k])) return false;
  }
  return true;
}

/**
 * The session’s live fields: merged into the buffer, and what changed of them sent live, with any stored change the
 * frame carries (liveUpdate). A turn’s changes in one tick go as one frame, at its end (liveFlush): a harness reports a
 * call’s end and the words after it together, and the page draws only the last. @param {any} rt @param {any} turn
 * @param {Record<string, any>} patch @param {Record<string, any>} [carried]
 */
export function liveSession(rt, turn, patch, carried) {
  const live = bufferOf(rt, turn);
  const { session } = live;
  /** @type {Record<string, any>} */
  const frame = {};
  let any = false;
  /** @type {any} */
  let stored;
  for (const k in patch) {
    if (!Object.hasOwn(patch, k)) continue;
    const v = k === 'toolCalls' || k === 'subagents' ? capList(patch[k], LIVE_CAPS[k]) : capString(patch[k]);
    // Only what changed goes, as with a step: a page holds the rest from an earlier frame, the snapshot or the store,
    // which is read only for a field the buffer hasn’t had.
    const was = Object.hasOwn(session, k) ? session[k] : (stored ??= rt.store.pending.session(turn.sessionId) ?? {})[k];
    session[k] = v;
    if (v === was || sameList(v, was)) continue;
    frame[k] = v;
    any = true;
  }
  if (carried) Object.assign(frame, carried);
  if (!any && !carried) return;
  if (!live.frame) {
    live.frame = { kind: 'session', sessionId: turn.sessionId };
    queueMicrotask(() => liveFlush(rt, turn));
  }
  Object.assign(live.frame, frame);
}

/**
 * The turn’s end, or its stop: a last commit point, with the session’s tool calls and their count as the turn leaves
 * them, which nothing at a turn’s edge writes; then the buffer goes. Its step, glimpse and subagents are the edges’ to
 * write (turn-needs.mjs, turn-finish.mjs, turn-stop.mjs). @param {any} rt @param {any} turn
 */
export function liveEnd(rt, turn) {
  liveCommit(rt, turn);
  const session = turn.live?.session ?? {};
  const { toolCalls, toolCount } = session;
  // The pages had both live, so the write isn’t sent to them again (server/live-sent.mjs).
  if (toolCalls !== undefined || toolCount !== undefined)
    rt.sessions.update(turn.sessionId, { ...(toolCalls !== undefined ? { toolCalls } : {}), ...(toolCount !== undefined ? { toolCount } : {}) }, (data) =>
      committed.add(data),
    );
  if (turn.live) closeLive(rt, turn, session);
  turn.live = null;
}

/**
 * The turn’s last frames: its session’s live fields put back to what’s stored, which the edge writes then change as
 * ever, since a write the same as what’s stored (a glimpse of '', no subagents) isn’t stored or sent; and the end of
 * its steps, so each stream forgets the ones it was sent (server/live-sent.mjs). @param {any} rt @param {any} turn
 * @param {Record<string, any>} session
 */
function closeLive(rt, turn, session) {
  const stored = rt.store.pending.session(turn.sessionId) ?? {};
  /** @type {Record<string, any>} */
  const back = {};
  for (const k of Object.keys(session)) {
    const now = Object.hasOwn(stored, k) ? stored[k] : emptyLike(session[k]);
    if (now !== session[k] && !sameList(now, session[k])) back[k] = now;
  }
  if (Object.keys(back).length) sendLive(rt.store, { kind: 'session', sessionId: turn.sessionId, ...back });
  sendLive(rt.store, { kind: 'end', threadId: turn.threadId, itemId: turn.first });
}

/** A field’s empty value: what a page shows of it when nothing is stored. @param {unknown} v */
const emptyLike = (v) => {
  if (Array.isArray(v)) return [];
  return typeof v === 'number' ? 0 : '';
};

/**
 * A step stored outside the buffer while its turn runs (a background job’s end, a step moved to a new part): its
 * change goes into the buffer’s copy too, so the next commit point stores the newest, not the copy from before it
 * (live-progress.md, “Which wins”). @param {any} turn @param {string} itemId @param {Record<string, any>} patch
 */
export function liveStored(turn, itemId, patch) {
  const held = turn?.live?.changed.get(patch.id);
  if (held && held.itemId === itemId) held.step = { ...held.step, ...patch };
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
 * its context) is stored, only when it changed, and carried to the pages on the same frame. @param {any} rt @param {any} turn @param {Record<string, any>} patch
 */
export function liveUpdate(rt, turn, patch) {
  /** @type {Record<string, any>} */
  const stored = {};
  /** @type {Record<string, any>} */
  const live = {};
  for (const [k, v] of Object.entries(patch)) (SESSION_FIELDS.includes(k) ? live : stored)[k] = v;
  // Only a change is stored: a write of the same state would still store its updatedAt, and send it.
  const se = Object.keys(stored).length ? rt.store.pending.session(turn.sessionId) : null;
  const change = se ? sessionPatch(se, stored) : null;
  /** @type {Record<string, any> | undefined} */
  let carried;
  // A change of state or context rides on the live frame, and its stored event isn’t sent to the pages again:
  // marked before it’s emitted, as the streams build its frames then.
  const carry = (/** @type {any} */ data) => {
    if (data.unset || !Object.keys(data.patch).every((k) => CARRIED_FIELDS.includes(k))) return;
    committed.add(data);
    carried = data.patch;
  };
  if (change && (Object.keys(change.patch).length || change.unset)) rt.sessions.update(turn.sessionId, stored, carry);
  if (Object.keys(live).length || carried) liveSession(rt, turn, live, carried);
}

/**
 * The session’s live fields as the running turn has them: the buffer’s, over what was stored when it began.
 * @param {any} rt @param {any} turn
 */
export function liveFields(rt, turn) {
  const se = rt.store.pending.session(turn.sessionId) ?? rt.s.sessions[turn.sessionId] ?? {};
  return { toolCalls: se.toolCalls ?? [], toolCount: se.toolCount ?? 0, currentStep: se.currentStep, subagents: se.subagents ?? [], ...turn.live?.session };
}
