// Whether this Postbox has run clocks (#1526). A clock serves a timed UAT trial, not the person in designs/intent.md
// (“Who it’s for”), so it is off unless the UAT runner starts Postbox with POSTBOX_RUN_CLOCK=1 (tools/uat/run-env.mjs).
// Off, nothing of it is installed: its route answers 404 (server/session-routes.mjs), no clock is ever stored, and each
// place a turn starts, stops or ends asks only whether `rt.runClock` is there, reading nothing else
// (designs/architecture/run-clock.md, “Off unless a timed run asks for it”).

import { clockHolds } from '../shared/run-clock.mjs';
import { rearmClocks } from './run-clock.mjs';

/** Whether the environment turns run clocks on. @param {NodeJS.ProcessEnv} [env] */
export const runClockOn = (env = process.env) => env.POSTBOX_RUN_CLOCK === '1';

/**
 * Turns run clocks on for a runtime: Delivery holds a paused or expired clock’s agent, the turn paths call the clock
 * (`rt.runClock`), and every clock in the state is armed again, as Postbox starts. Called once, before any turn starts.
 * @param {any} rt
 */
export function installRunClock(rt) {
  /** Whether the agent’s clock holds it, read pending (server/store-held.mjs). @param {string} sessionId */
  const holds = (sessionId) => clockHolds(rt.store.pending.clock(sessionId));
  rt.runClock = { holds };
  rt.delivery.clockHeld = holds;
  rearmClocks(rt);
}
