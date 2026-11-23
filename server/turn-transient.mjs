// A turn its provider failed for a while (#1713): 529 Overloaded, or another status its adapter marks as one that
// passes (server/harness-failure.mjs, withTransient). It goes again on its own, through the person’s own Retry, after
// each wait of TRANSIENT_RETRY (shared/limits.mjs), so work doesn’t wait on that agent for hours. While it waits, the
// session stays failed, so what other agents sent waits for the retry, but it doesn’t need the person: its row says
// when it retries (shared/agent-state.mjs), its reply says so without an alert, and nothing blocking is raised, as the
// person could do no more than Retry (#1218’s rule). The count runs across the tries in a row (`autoRetry` on the
// session) and ends with any turn of the session that doesn’t fail. Once the tries run out, the agents whose messages
// the turn took hear in the room that it didn’t answer, so they can send the work elsewhere; the person isn’t asked.
//
// A wait is a timer in rt.watchdogs, which close() clears; a restart arms it again from the session (armAutoRetries),
// for what’s left of the wait, so the reply’s note stays true. A scheduled wake’s turn isn’t retried here: its failure
// is handled as on any other failure (server/scheduled-wakes.mjs), so it raises no alarm at each try.

import { TRANSIENT_RETRY } from '../shared/limits.mjs';
import { tookStep } from './empty-reply.mjs';

/** What each status says the provider did. */
const STATUS_WORDS = { 429: 'was rate limiting requests', 529: 'was overloaded' };
/** What the provider did, after its subject: “was overloaded (529)”. @param {number} status */
const didWhat = (status) => `${STATUS_WORDS[/** @type {429|529} */ (status)] ?? 'had a server error'} (${status})`;

/** The tools a turn started, by their labels, at most five: what its retry is asked to check before repeating. */
const startedLabels = (/** @type {any} */ turn) =>
  tookStep(turn)
    ? (turn.steps ?? [])
        .filter((/** @type {any} */ s) => !s.who && s.kind !== 'thought' && s.kind !== 'said')
        .map((/** @type {any} */ s) => String(s.label ?? s.tool ?? 'a tool').slice(0, 80))
        .slice(0, 5)
    : [];

/** What a retried turn that had started work is told first. @param {{ status: number, started: string[] }} r */
const checkWhatRan = (r) =>
  `Your last turn stopped because its provider ${didWhat(r.status)}, after it had started work: ${r.started.join('; ')}. Postbox sent it again. Check what those calls changed or sent before you repeat any of them.`;

/**
 * The session stops waiting to try a failed turn again: its wait ends, and the failed reply no longer says when it
 * would try. Any other failure, a Dismiss, a Stop, a host turn interrupted, a refused retry and a turn that went well
 * each end it (#1713). Read pending: it decides the writes. @param {any} rt @param {string} sessionId
 * @param {Record<string, any>} [also]  more of the session to write with it
 */
export function forgetWait(rt, sessionId, also = {}) {
  const r = rt.store.pending.session(sessionId)?.autoRetry;
  if (!r) return;
  rt.sessions.update(sessionId, { autoRetry: null, ...also });
  if (r.threadId && r.itemId && rt.store.pending.item(r.threadId, r.itemId)?.transient?.at)
    rt.threads.patchItem(r.threadId, r.itemId, { note: null, transient: { status: r.status, at: null } });
}

/** A wait in words: 30 s, 2 min. @param {number} ms */
const waitWords = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/**
 * The waits before each try, the test’s own when it gives them (config.transientRetryMs).
 * @param {any} rt @returns {readonly number[]}
 */
const delaysOf = (rt) => rt.config?.transientRetryMs ?? TRANSIENT_RETRY.delaysMs;

/**
 * What a turn that failed for its provider does next: try again after the next wait, or, with the tries run out, stop.
 * Null for any other failure, and for a scheduled wake’s turn. Read pending: the count decides a write.
 * @param {any} rt @param {any} se @param {any} turn @param {any} failure  failureClass’s
 * @returns {{ status: number, tries: number, at: number | null, delayMs: number, started: string[] } | null}  `at` is null
 *   once they ran out; `started`, the tools the turn started, which its retry is told to check (#1713)
 */
export function transientRetry(rt, se, turn, failure) {
  if (failure?.kind !== 'transient' || turn.asked?.message?.scheduledWakeId) return null;
  const tries = rt.store.pending.session(se.id)?.autoRetry?.tries ?? 0;
  const delays = delaysOf(rt);
  const started = startedLabels(turn);
  if (tries >= delays.length) return { status: failure.status, tries, at: null, delayMs: 0, started };
  return { status: failure.status, tries: tries + 1, at: Date.now() + delays[tries], delayMs: delays[tries], started };
}

/**
 * What the failed reply keeps: a note that says what happens next, and `transient`, which keeps its callout quiet.
 * @param {{ status: number, tries: number, at: number | null, delayMs: number }} r
 */
export function transientMarks(r) {
  const note =
    r.at === null
      ? `The provider ${didWhat(r.status)} on ${r.tries + 1} tries in a row, so Postbox stopped trying. Retry tries again.`
      : `The provider ${didWhat(r.status)}, so Postbox will try again in ${waitWords(r.delayMs)}.`;
  return { note, transient: { status: r.status, at: r.at } };
}

/**
 * The session’s fields while it waits to try again, or once the tries ran out, in place of a need for the person.
 * @param {{ status: number, tries: number, at: number | null, started?: string[] }} r @param {string} threadId @param {string} itemId
 */
export function transientSession(r, threadId, itemId) {
  if (r.at === null) return { needs: null, autoRetry: null, currentStep: 'Failed' };
  const started = r.started?.length ? { started: r.started } : {};
  return { needs: null, autoRetry: { tries: r.tries, at: r.at, status: r.status, threadId, itemId, ...started }, currentStep: 'Retrying' };
}

/**
 * After the failed reply and the session are written: the wait for the next try starts, or, with the tries run out,
 * the agents waiting on the turn hear so. @param {any} rt @param {any} se @param {any} turn
 * @param {{ status: number, tries: number, at: number | null }} r @param {string} itemId  the failed reply
 */
export function afterTransient(rt, se, turn, r, itemId) {
  if (r.at !== null) armRetry(rt, se.id, turn.threadId, itemId, r.at);
  else tellWaiting(rt, se, turn, r);
}

/**
 * The wait for one try: at its end, the person’s Retry of the failed reply, which does nothing once the session is no
 * longer waiting on this reply (a later failure, a Dismiss, a Stop or a turn that went well), or the reply isn’t
 * failed. A Retry refused leaves the reply failed, with Retry.
 * @param {any} rt @param {string} sessionId @param {string} threadId @param {string} itemId @param {number} at
 */
function armRetry(rt, sessionId, threadId, itemId, at) {
  const fire = () => {
    // Only the wait the session is still in: a later failure, a Dismiss, a Stop or a turn that went well ended this one.
    // And only while the agent is still failed: a turn the person started meanwhile moved past this one.
    const se = rt.store.pending.session(sessionId);
    if (rt.closing || se?.autoRetry?.itemId !== itemId || se.state !== 'failed') return;
    // A turn that started work before its provider failed: its retry is told to check what ran before repeating it,
    // as a scheduled wake’s recovery is (designs/508/design.md, “Record lifecycles”).
    if (se.autoRetry.started?.length) rt.sessions.tell(sessionId, checkWhatRan(se.autoRetry));
    Promise.resolve()
      .then(() => rt.turnService.retry(threadId, itemId))
      .catch((/** @type {any} */ e) => {
        // 409: the reply isn’t failed any more, so there’s nothing to try again. Anything else leaves it failed.
        if (e?.status !== 409) console.warn(`Postbox couldn’t retry @${rt.s.sessions[sessionId]?.handle ?? sessionId}’s turn: ${e?.message ?? e}`);
        if (rt.store.pending.session(sessionId)?.autoRetry?.itemId === itemId) forgetWait(rt, sessionId, { currentStep: 'Failed' });
      });
  };
  const wait = Math.max(0, at - Date.now());
  if (rt.config?.retryAfter) return rt.config.retryAfter(wait, fire);
  const timer = setTimeout(() => {
    rt.watchdogs.delete(timer);
    fire();
  }, wait);
  timer.unref?.();
  rt.watchdogs.add(timer);
}

/** After a restart: each wait a failed session was in starts again, for what’s left of it. @param {any} rt */
export function armAutoRetries(rt) {
  for (const se of Object.values(rt.s.sessions)) {
    const r = se.autoRetry;
    if (se.state === 'failed' && r?.itemId && r.threadId) armRetry(rt, se.id, r.threadId, r.itemId, r.at);
  }
}

/**
 * A turn of the session ended without failing: the next failure starts its count again. Read pending, as it decides
 * the write. @param {any} rt @param {any} se
 */
export function autoRetryEnds(rt, se) {
  forgetWait(rt, se.id);
}

/**
 * The tries ran out: one line in the room says so, and each agent whose message the turn took, still in the
 * conversation, is woken with it, so it can send the work to another agent. Not the agent that failed, nor the person,
 * who sees the failed reply. @param {any} rt @param {any} se @param {any} turn @param {{ status: number, tries: number }} r
 */
function tellWaiting(rt, se, turn, r) {
  const senders = new Set(
    rt.delivery
      .takenBy(se.id, turn.id)
      .map((/** @type {any} */ e) => e.from)
      .filter((/** @type {any} */ h) => h && h !== 'you' && h !== se.handle),
  );
  const conv = rt.threads.conversationToWrite(turn.threadId);
  const waiting = rt.sessions.pendingIn(conv).filter((/** @type {any} */ x) => senders.has(x.handle) && !x.retiredFork && x.id !== se.id);
  if (!waiting.length) return;
  const names = waiting.map((/** @type {any} */ x) => `@${x.handle}`).join(', ');
  const text = `${names}: @${se.handle}’s turn failed ${r.tries + 1} times in a row because its provider ${didWhat(r.status)}, so Postbox stopped trying it. What you sent @${se.handle} wasn’t answered: send the work to another agent, or ask @${se.handle} again later.`;
  const line = rt.threads.addItem(turn.threadId, { kind: 'system', variant: 'retries-out', handle: se.handle, text });
  for (const x of waiting) rt.delivery.send({ sessionId: x.id, threadId: turn.threadId, source: 'mention', itemId: line.id });
}
