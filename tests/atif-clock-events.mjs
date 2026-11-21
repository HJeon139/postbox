// The store’s event table with the run clock’s seven events in it, public, as #1526 adds them to EVENTS
// (shared/state.mjs): until it lands, the UAT kit and the exporter read clock events only from a recording that has
// them, and these tests give keepEvent and the data-folder export a table that lets them through. The names and their
// fields are the run clock’s event contract: clock.started { sessionId, threadId, budgetMs, at }, clock.paused
// { sessionId, stopping?, at }, clock.resumed, clock.turn { turnId, elapsedMs, budgetMs, state }, clock.restored
// { elapsedMs, budgetMs }, clock.expired { elapsedMs, budgetMs, stopping? } and clock.stopped { turn, forced?, why? }.

import { EVENTS } from '../shared/state.mjs';

export const CLOCK_TYPES = Object.freeze(['clock.started', 'clock.paused', 'clock.resumed', 'clock.turn', 'clock.restored', 'clock.expired', 'clock.stopped']);

/** EVENTS with the clock’s events, each public and changing no state here. */
export const CLOCK_EVENTS = Object.freeze({ ...EVENTS, ...Object.fromEntries(CLOCK_TYPES.map((t) => [t, { apply: () => {}, public: true }])) });
