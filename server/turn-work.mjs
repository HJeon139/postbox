// What a turn’s adapter tells the runtime about its tool calls, for the work ledger (#132): part of the turn’s context
// (adapterContext, server/turn-context.mjs), each taken only while the turn is live. The calls are also what a permission prompt may
// be for (#353, #665): server/prompt-claim.mjs reads them here.

import { recordScheduledTool } from './scheduled-wakes.mjs';

/**
 * Each tool call with its whole input, before it runs ({ id, name, input, who, parent }: parent is the Agent call a
 * subagent’s call is under); what it returned ({ id, isError, text, result: the tool’s own record, vcsCwd }); a
 * background task’s end ({ toolUseId, status, summary, outputFile }); and the process’s running spend ({ key, costUsd,
 * tokens }).
 * @param {any} rt @param {any} turn @param {() => boolean} live
 */
export function workEvents(rt, turn, live) {
  return {
    /** @param {any} u */
    toolUse(u) {
      if (!live()) return;
      seeCall(turn, u);
      recordScheduledTool(rt, turn, u);
    },
    /** @param {any} r */
    toolResult(r) {
      if (!live()) return;
      answerCall(turn, r?.id);
      rt.ledger.toolResult(turn, r);
    },
    /** @param {any} t */
    taskEnded(t) {
      if (live()) rt.ledger.taskEnded(turn, t);
    },
    /** @param {any} u */
    usage(u) {
      if (live()) rt.ledger.usage(turn, u);
    },
  };
}

// ── The calls a permission prompt can be for ────────────────────────────────────────────
// Every tool_use the turn’s stream showed, the agent’s own and its subagents’, by its id: its name, its whole input,
// and whether it’s still open, claimed by the one prompt it gets, or answered (its result came). They live on the turn
// object, so a new turn, a Retry or a restart starts with none: a prompt for a call of another turn matches nothing.

/**
 * parent: the subagent’s call it was made under, as the stream showed it, or null for the agent’s own.
 * @typedef {{ name: string, input: unknown, parent: string | null, state: 'open' | 'claimed' | 'answered', by?: unknown }} SeenCall
 */

/** @param {any} turn @returns {Map<string, SeenCall>} */
const seenOf = (turn) => (turn.seenCalls ??= new Map());
/** @param {any} turn @returns {Map<string, Set<() => void>>} */
const watchersOf = (turn) => (turn.callWatchers ??= new Map());

/** A call the stream showed, once, with its whole input. @param {any} turn @param {{ id?: unknown, name?: unknown, input?: unknown, parent?: unknown }} u */
function seeCall(turn, u) {
  if (typeof u?.id !== 'string' || !u.id || typeof u.name !== 'string') return;
  const seen = seenOf(turn);
  if (seen.has(u.id)) return;
  const parent = typeof u.parent === 'string' && u.parent ? u.parent : null;
  const ahead = turn.claimedAhead;
  const claim = ahead?.has(u.id) ? { state: /** @type {const} */ ('claimed'), by: ahead.get(u.id) } : { state: /** @type {const} */ ('open') };
  seen.set(u.id, { name: u.name, input: u.input ?? {}, parent, ...claim });
  const watchers = watchersOf(turn).get(u.id);
  watchersOf(turn).delete(u.id);
  for (const wake of watchers ?? []) wake();
}

/** Its result came: no prompt can be for it any more. @param {any} turn @param {unknown} id */
function answerCall(turn, id) {
  const call = typeof id === 'string' ? seenOf(turn).get(id) : undefined;
  if (call) call.state = 'answered';
}

/** The call the stream showed with this id, if it did. @param {any} turn @param {string} id */
export const seenCall = (turn, id) => seenOf(turn).get(id) ?? null;

/**
 * A call a card shown before a restart already asks about (a host’s, server/remote/turns-prompts.mjs): it counts as
 * claimed by that card’s prompt, `by`, now or once the replayed stream shows it, so a copy raises no second card.
 * @param {any} turn @param {string} id @param {unknown} by
 */
export function claimAhead(turn, id, by) {
  const call = seenCall(turn, id);
  if (!call) (turn.claimedAhead ??= new Map()).set(id, by);
  else if (call.state === 'open') Object.assign(call, { state: 'claimed', by });
}

/** How many prompts of this turn wait for their call’s line now, each in whenSeen. @param {any} turn */
export const heldPrompts = (turn) => [...watchersOf(turn).values()].reduce((n, set) => n + set.size, 0);

/**
 * Waits up to `ms` for the stream to show the call with this id, or until `signal` aborts. Resolves to the call, or
 * null. The watchers wake in the order they started, so the prompt that came first is the first to claim it. With
 * `ready`, the `ms` start only once it settles: the stream is still being read up to where it is. If `readyEnd` settles
 * first, the wait ends then, as the bound would: it’s the most the wait for `ready` may take.
 * @param {any} turn @param {string} id @param {number} ms @param {AbortSignal|null} [signal] @param {Promise<unknown>|null} [ready]
 * @param {Promise<unknown>|null} [readyEnd]
 * @returns {Promise<SeenCall | null>}
 */
export function whenSeen(turn, id, ms, signal = null, ready = null, readyEnd = null) {
  const now = seenCall(turn, id);
  if (now || signal?.aborted) return Promise.resolve(now);
  return new Promise((resolve) => {
    const watchers = watchersOf(turn);
    const set = watchers.get(id) ?? new Set();
    watchers.set(id, set);
    /** @type {any} the bound’s timer, once it has started */
    let timer;
    let over = false;
    const done = () => {
      over = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      set.delete(done);
      if (!set.size && watchers.get(id) === set) watchers.delete(id);
      resolve(seenCall(turn, id));
    };
    const bound = () => {
      if (over || timer) return;
      timer = setTimeout(done, ms);
      timer.unref?.();
    };
    if (ready) {
      void ready.then(bound, bound);
      const cut = () => {
        if (!timer) done();
      };
      void readyEnd?.then(cut, cut);
    } else bound();
    signal?.addEventListener('abort', done, { once: true });
    set.add(done);
  });
}
