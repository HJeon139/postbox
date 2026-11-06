// Whether a turn without exit.json is still running (#738), for the follower (daemon-follow.mjs) and the scan
// (daemon-scan.mjs) alike. Its runner answering `who` is the first look. A runner can miss that answer while it’s still
// at work (stopped for a moment, its event loop held up), so a miss alone doesn’t end the turn: while runner.json still
// names a live process of this boot (proc.mjs’s sameProcess, as cleanup and Stop judge it), the turn runs on, until it
// has been silent for RUNNER_SILENT_MAX_MS. The silence is kept per turn, shared by every look, and timed on the daemon’s
// monotonic clock (d.mono), so setting the wall clock neither stretches the ceiling nor cuts it short.

import { TURN_FILES, validateRunnerRecord } from '../../../shared/remote-protocol.mjs';
import { RUNNER_SILENT_MAX_MS } from './daemon-constants.mjs';
import { readJson, runnerAlive } from './daemon-files.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Silence} Silence */

/**
 * Whether the turn runs: not one found dead, and its runner answers, or is silent but still runner.json’s process and
 * not yet for the ceiling. For a turn with no exit.json; the caller reads that first.
 * @param {Daemon} d @param {string} turn @returns {Promise<boolean>}
 */
export async function turnRunning(d, turn) {
  if (d.dead.has(turn)) {
    d.silentSince.delete(turn);
    return false;
  }
  if (await runnerAlive(d, turn)) {
    answered(d, turn);
    return true;
  }
  const pid = await liveRunnerPid(d, turn);
  if (pid === null) {
    processGone(d, turn);
    return false;
  }
  return withinCeiling(d, turn, pid);
}

/** runner.json’s PID, while it’s valid and names this runner’s process still, else null. @param {Daemon} d @param {string} turn */
async function liveRunnerPid(d, turn) {
  const rec = validateRunnerRecord(await readJson(d.p.turn(turn, TURN_FILES.runner)));
  if (!rec.ok) return null;
  return (await d.proc.sameProcess(rec.msg)) ? rec.msg.pid : null;
}

/** The runner answered: a silence it was in is over. @param {Daemon} d @param {string} turn */
function answered(d, turn) {
  const silence = d.silentSince.get(turn);
  if (!silence) return;
  d.silentSince.delete(turn);
  d.log(`Turn ${turn}’s runner (process ${silence.pid}) answered again after ${seconds(d.mono() - silence.since)} s of silence.`);
}

/** The runner’s process is gone: a silence it was in ends, and so does the turn. @param {Daemon} d @param {string} turn */
function processGone(d, turn) {
  const silence = d.silentSince.get(turn);
  if (!silence) return;
  d.silentSince.delete(turn);
  d.log(`Turn ${turn}’s runner (process ${silence.pid}) is gone after ${seconds(d.mono() - silence.since)} s of silence.`);
}

/**
 * A silent runner whose process is still there: running while its silence is under the ceiling. The silence starts at
 * this miss if none is under way. Past the ceiling it stays recorded, so the turn stays ended until the runner answers.
 * @param {Daemon} d @param {string} turn @param {number} pid
 */
function withinCeiling(d, turn, pid) {
  const silence = d.silentSince.get(turn) ?? startSilence(d, turn, pid);
  if (d.mono() - silence.since < RUNNER_SILENT_MAX_MS) return true;
  if (!silence.over) {
    silence.over = true;
    d.log(`Turn ${turn}’s runner (process ${pid}) hasn’t answered for ${seconds(RUNNER_SILENT_MAX_MS)} s; the turn is ended as interrupted.`);
  }
  return false;
}

/** @param {Daemon} d @param {string} turn @param {number} pid @returns {Silence} */
function startSilence(d, turn, pid) {
  /** @type {Silence} */
  const silence = { since: d.mono(), pid, over: false };
  d.silentSince.set(turn, silence);
  d.log(
    `Turn ${turn}’s runner (process ${pid}) didn’t answer, but its process is still running; it’s kept running for up to ${seconds(RUNNER_SILENT_MAX_MS)} s.`,
  );
  return silence;
}

const seconds = (/** @type {number} */ ms) => Math.round(ms / 1000);

/** The turn has ended with exit.json: its silence, if any, is forgotten. @param {Daemon} d @param {string} turn */
export function forgetSilence(d, turn) {
  d.silentSince.delete(turn);
}
