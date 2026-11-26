// The stretches of a run in which the room was quiet: no agent under test in a turn and no new item (#1746, a room
// that went idle while work was waiting). Read from a run’s event history (facts.events): sessions’ states with their
// times, items as they’re added and answered, and each inbox’s entries, on whichever backend an agent runs.
// Each stretch says what was waiting while it lasted, and what moved the room again:
//   person      a session said it needs the person, as “needs you” counts it: a block that asks from its last turn, a
//               permission card, a wake request, a failed turn. A block left open from an earlier turn isn’t counted,
//               as Postbox stops counting it once the person moves on (server/card-needs.mjs, #69)
//   scheduled   an agent’s scheduled wake was pending
//   nothing     the work wasn’t done, nobody was asked and nothing was scheduled: nothing would restart it
//   done        the definition of done had been met
//   unknown     the run’s records can’t say whether work was waiting
// “Work is waiting” is the scenario’s own definition of done, as the records show it: from the person’s request that
// names the command that proves it, until that command first said the work passed (tools/uat/nightly-log.mjs reads
// both, for tests/uat/e2e/scenarios/idleroom.md). A run whose person never named the command has no such definition,
// so its stretches are “unknown” there, never “nothing”: an idle room after a finished chat isn’t a finding.

import { ASKING } from '../../shared/catalog.mjs';
import { workOf } from './board-log.mjs';
import { clip } from './trigger-facts.mjs';

const BUSY = new Set(['think', 'tool', 'gen']);

/**
 * @typedef {{ asked: number|null, queued: { at: number, due: number|null } | null, passed: { at: number } | null,
 *   customer?: { from: number, to: number, what: string }[] }} Work
 * when the person asked for the work, when its timed step was queued and due, and when its definition of done was
 * first met, or null for each that never happened; and, in a sprint room, when the room waited on the customer
 */

/** How a block that asks reads in a stretch’s evidence. @param {any} it */
const askOf = (it) => `@${it.handle}’s ${it.block.type} “${clip(it.block.title ?? it.block.prompt ?? '', 60)}”`;

/** What moved the room when an item arrived while it was quiet. @param {any} it */
function itemMove(it) {
  if (it.kind === 'user') return 'the person’s message';
  if (it.kind === 'voice') return 'the person’s answer';
  if (it.kind === 'system' && it.variant === 'wake' && it.scheduled) return `@${it.to}’s scheduled wake`;
  return `a new ${it.variant ?? it.kind} item`;
}

/**
 * What moved the room when an agent’s turn started while it was quiet, with no item first: the turn, and the newest
 * entry in the agent’s inbox, by its source as the server names it (person, mention, scheduled, check…).
 * @param {any} r @param {string} id
 */
function turnMove(r, id) {
  return `@${r.sessions.get(id)?.handle ?? id}’s turn, for its newest entry (${r.entries.get(id) ?? 'none recorded'})`;
}

const busy = (/** @type {any} */ r) => [...r.sessions.values()].some((se) => BUSY.has(se.state));

/** Adds what waits right now to the open stretch: a stretch says everything that waited while it lasted. @param {any} r */
function note(r) {
  if (!r.open) return;
  for (const se of r.sessions.values()) {
    if (!se.needs) continue;
    r.open.person.set(se.needs.itemId ?? `needs:${se.handle}`, r.asks.get(se.needs.itemId) ?? `@${se.handle}’s ${se.needs.kind ?? 'ask'}`);
  }
  for (const [id, w] of r.wakes) r.open.scheduled.set(id, w);
}

/** Ends the open stretch at a time, with what moved the room, or as still quiet when the records end. @param {any} r @param {number} at @param {any} movedBy */
function end(r, at, movedBy) {
  if (!r.open) return;
  note(r);
  const s = r.open;
  r.out.push({
    from: s.from,
    to: at,
    ms: Math.max(0, at - s.from),
    open: movedBy === null,
    person: [...s.person.values()],
    scheduled: [...s.scheduled.values()],
    movedBy,
  });
  r.open = null;
}

/** One event into the room’s record. @param {any} r @param {any} e @param {(threadId: string) => boolean} here */
function step(r, e, here) {
  const d = e?.data;
  if (!d) return;
  if (e.type === 'session' && d.id && here(d.threadId ?? r.sessions.get(d.id)?.threadId)) {
    const was = busy(r);
    const prev = r.sessions.get(d.id) ?? {};
    r.sessions.set(d.id, { handle: d.handle ?? prev.handle ?? d.id, threadId: d.threadId ?? prev.threadId, state: d.state, needs: d.needs ?? null });
    r.last = Math.max(r.last, d.updatedAt ?? 0);
    if (!was && busy(r)) end(r, r.last, turnMove(r, d.id));
    else if (was && !busy(r)) r.open = { from: r.last, person: new Map(), scheduled: new Map() };
  } else if (e.type === 'item.add' && d.item && here(d.threadId)) itemAdded(r, d.item);
  else if ((e.type === 'item.patch' || e.type === 'item.move') && d.patch) itemPatched(r, d);
  else if (e.type === 'entry.add' && d.entry) {
    r.entries.set(d.sessionId, d.entry.source);
    r.last = Math.max(r.last, d.entry.at ?? 0);
  }
  note(r);
}

/** A new item: a scheduled wake to keep, an ask’s words for the stretch that names it, and a quiet room moved. @param {any} r @param {any} it */
function itemAdded(r, it) {
  // A scheduled wake’s item carries the time it’s due, not when it was asked for, so it moves no clock.
  if (it.kind === 'system' && it.variant === 'schedule') {
    r.wakes.set(it.id, `@${it.handle}’s wake due at ${clockOf(it.at)}`);
    return;
  }
  if (it.kind === 'block' && ASKING.has(it.block?.type)) r.asks.set(it.id, askOf(it));
  r.last = Math.max(r.last, it.at ?? 0);
  if (busy(r)) return;
  end(r, r.last, itemMove(it));
  r.open = { from: r.last, person: new Map(), scheduled: new Map() };
}

/** A changed item: a scheduled wake that ran or was canceled. @param {any} r @param {any} d */
function itemPatched(r, d) {
  if (d.patch.status && d.patch.status !== 'pending') r.wakes.delete(d.id);
}

export const clockOf = (/** @type {number} */ ms) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

/** Whether the work was waiting or done as a stretch began, by the scenario’s definition of done. @param {{ from: number }} s @param {Work} w */
function workIn(s, { asked, passed }) {
  if (asked === null || s.from < asked) return 'unknown';
  return passed && passed.at <= s.from ? 'done' : 'waiting';
}

/** What was waiting through a stretch, by the order a person would act on it. @param {any} s @param {'waiting'|'done'|'unknown'} work */
function waitingIn(s, work) {
  if (s.person.length) return 'person';
  if (s.scheduled.length) return 'scheduled';
  return work === 'waiting' ? 'nothing' : work;
}

/**
 * Every stretch in which no agent under test was in a turn and no item arrived, in order, with what was waiting and
 * what moved the room. The last may still be open when the records end: nothing happens in a quiet room, so its
 * length runs to f.until, the last moment the run’s records cover (the runner’s clock as it reads the facts, or a
 * finished run’s end), and is 0 for facts without one. overdueMs is how long a “nothing” stretch went on past the
 * timed step’s end, when the step had been queued by then and the run recorded when it was due.
 * @param {any} f  @param {Work} [work]  read from the run’s workspace unless given
 * @returns {{ from: number, to: number, ms: number, open: boolean, waiting: 'person'|'scheduled'|'nothing'|'done'|'unknown', work: 'waiting'|'done'|'unknown', what: string[], movedBy: string|null, overdueMs: number|null }[]}
 */
export function quietStretches(f, work = workOf(f)) {
  const threads = new Set(f.threads ?? []);
  const here = (/** @type {string} */ id) => !threads.size || threads.has(id);
  const r = {
    sessions: new Map(),
    asks: new Map(),
    wakes: new Map(),
    entries: new Map(),
    open: null,
    out: /** @type {any[]} */ ([]),
    last: 0,
  };
  for (const e of f.events ?? []) step(r, e, here);
  end(r, Math.max(r.last, Number.isFinite(f.until) ? f.until : 0), null);
  const { queued } = work;
  return r.out.map((s) => {
    // A demo the customer hasn’t answered is an ask to the person, though no session says it needs them.
    for (const c of work.customer ?? []) if (s.from >= c.from && s.from < c.to) s.person.push(c.what);
    const state = workIn(s, work);
    const waiting = waitingIn(s, state);
    const overdue = waiting === 'nothing' && queued?.due != null && queued.at <= s.to;
    return {
      from: s.from,
      to: s.to,
      ms: s.ms,
      open: s.open,
      waiting,
      work: state,
      what: { person: s.person, scheduled: s.scheduled }[/** @type {string} */ (waiting)] ?? [],
      movedBy: s.movedBy,
      overdueMs: overdue ? Math.max(0, s.to - Math.max(s.from, /** @type {number} */ (queued.due))) : null,
    };
  });
}
