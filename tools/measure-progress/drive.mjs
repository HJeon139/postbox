// Turns replayed on a virtual clock (tools/measure-progress.mjs). Pushed in one tick, a recording would compress time:
// a throttle would fire once a stream and a timer of seconds never. So the clock is node:test’s mock timers
// (setTimeout, setInterval and Date), advanced a fixed cadence after each line, while the store’s real I/O runs between
// ticks; and the agents of a room are played a line each in turn, interleaved, as they’d stream at once.

import { mock } from 'node:test';

/** The virtual clock’s start, fixed so the numbers each run writes have the same length. */
export const START = Date.UTC(2026, 10, 17, 12);
/** The virtual time between a stream’s lines, about what a harness streams at. */
export const CADENCE_MS = 50;

/** Puts the process on the virtual clock. */
export function virtualClock() {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
}

/** Lets real I/O and promises run. */
const turnOver = () => new Promise((r) => setImmediate(r));

/**
 * Advances the clock in steps, letting real work run between them, until done() or a bound, which throws: a
 * measurement that never settles is a fault of the harness, not a number.
 * @param {() => boolean} done @param {number} [step] @param {number} [most]
 */
export async function until(done, step = 10, most = 200_000) {
  for (let i = 0; i < most && !done(); i++) {
    mock.timers.tick(step);
    await turnOver();
  }
  if (!done()) throw new Error('The measurement waited past its bound for something that never settled.');
}

/** How long ticking() waits, in real time, before it fails: a measurement that never settles is the harness’s fault. */
const TICKING_MS = 120_000;

/**
 * Waits for a promise while the clock runs, never ahead of real time: what it waits for, a flush or a close, is real
 * disk work, and the store bounds that work with timers (a write making no progress, store-recover.mjs). Run ahead,
 * the clock tripped those bounds while the disk was still working (#1471’s finding). @template T @param {Promise<T>} p
 * @returns {Promise<T>}
 */
export async function ticking(p) {
  let over = false;
  p.then(
    () => (over = true),
    () => (over = true),
  );
  const from = performance.now();
  // Real time not yet ticked; the clock moves in whole milliseconds, as Date does, so the times events carry keep
  // their length.
  let owed = 0;
  let last = from;
  while (!over) {
    await turnOver();
    const now = performance.now();
    if (now - from > TICKING_MS) throw new Error('The measurement waited past its bound for something that never settled.');
    owed += now - last;
    last = now;
    const step = Math.min(10, Math.floor(owed));
    if (step) mock.timers.tick(step);
    owed -= step;
  }
  return p;
}

/**
 * Until the runtime has no turn running or exiting, then on for `quietMs` of virtual time, so what a turn’s end starts
 * after it (its ledger record, a lint turn, a summary) is written before the store closes, and again until quiet.
 * @param {any} rt @param {number} [quietMs]
 */
export async function settled(rt, quietMs = 5000) {
  await until(() => !rt.turns.size && !rt.exiting.size);
  let left = quietMs / 10;
  await until(() => --left <= 0);
  await until(() => !rt.turns.size && !rt.exiting.size);
}

/**
 * @typedef {{ name: string, events: any[], mapper: (c: any) => { push: (e: any) => void, end?: () => void } }} Recording
 * @typedef {{ rec: Recording, m: any, release: () => void, errors: number }} Slot
 */

/**
 * Scripts the adapter’s next turns, one per recording, in the order they’re delivered: each makes its mapper and waits
 * for play() to feed it, or for its turn to be stopped.
 * @param {any} adapter  tests/side-threads-fixture.mjs’s ScriptedAdapter @param {Recording[]} recordings @returns {Slot[]}
 */
export function scriptTurns(adapter, recordings) {
  /** @type {Slot[]} */
  const slots = recordings.map((rec) => ({ rec, m: null, release: () => {}, errors: 0 }));
  for (const slot of slots)
    adapter.next.push(async (/** @type {any} */ c) => {
      slot.m = slot.rec.mapper(c);
      await new Promise((r) => {
        slot.release = () => r(undefined);
        c.signal?.addEventListener('abort', () => r(undefined), { once: true });
      });
      slot.m.end?.();
    });
  return slots;
}

/**
 * Feeds every slot its recording a line each in turn, the clock a cadence on after each round, from `from` up to
 * `upTo` of each recording (0 and 1 for all of it), so a turn can be played in parts. A mapper’s exception is counted on its slot, never swallowed unseen. Returns the
 * lines pushed and the time the pushes took, the event loop’s own work for each delta.
 * @param {Slot[]} slots @param {{ from?: number, upTo?: number, release?: boolean }} [o]
 */
export async function play(slots, { from = 0, upTo = 1, release = true } = {}) {
  await until(() => slots.every((s) => s.m));
  let pushes = 0;
  let pushMs = 0;
  const longest = Math.max(...slots.map((s) => s.rec.events.length));
  for (let i = 0; i < longest; i++) {
    for (const s of slots) {
      if (i < Math.ceil(s.rec.events.length * from) || i >= Math.ceil(s.rec.events.length * upTo)) continue;
      const at = performance.now();
      try {
        s.m.push(s.rec.events[i]);
      } catch {
        s.errors++;
      }
      pushMs += performance.now() - at;
      pushes++;
    }
    mock.timers.tick(CADENCE_MS);
    await turnOver();
  }
  if (release) for (const s of slots) s.release();
  return { pushes, pushMs, errors: slots.reduce((a, s) => a + s.errors, 0) };
}

/**
 * Rooms of agents in the fixture’s runtime: `rooms` conversations of `per` agents each, each conversation’s agents
 * named after it. Returns each room’s thread and the message that wakes all its agents.
 * @param {any} rt @param {number} rooms @param {number} per
 */
export function makeRooms(rt, rooms, per) {
  return Array.from({ length: rooms }, (_, r) => {
    const handles = Array.from({ length: per }, (_, i) => `r${r}a${i}`);
    const personas = handles.map((handle) => rt.createPersona({ handle }));
    const t = rt.createThread({ projectId: 'p1', title: `Room ${r}`, personaIds: personas.map((p) => p.id) });
    return { threadId: t.id, wake: `${handles.map((h) => `@${h}`).join(' ')} go` };
  });
}
