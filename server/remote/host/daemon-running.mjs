// Whether a turn without exit.json is still running (#738), for the follower (daemon-follow.mjs) and the scan
// (daemon-scan.mjs) alike. Its runner answering `who` is the first look. A runner can miss that answer while it’s still
// at work (stopped for a moment, its event loop held up), so a miss alone doesn’t end the turn: while runner.json still
// names a live process of this boot (proc.mjs’s sameProcess, as cleanup and Stop judge it), the turn runs on, until it
// has been silent for RUNNER_SILENT_MAX_MS. The silence is kept per turn, shared by every look, and timed on the daemon’s
// monotonic clock (d.mono), so setting the wall clock neither stretches the ceiling nor cuts it short. At the ceiling
// its process is killed (daemon-kill.mjs’s endHung, #872), and the turn ends once it’s gone, or KILL_WAIT_MS later,
// said to be unkilled, if it won’t go: a turn never ends here with its process still known to run unless it says so.

import { TURN_FILES, validateRunnerRecord } from '../../../shared/remote-protocol.mjs';
import { KILL_WAIT_MS, PROCESS_CHECK_MS, RUNNER_SILENT_MAX_MS } from './daemon-constants.mjs';
import { readJson, runnerAlive } from './daemon-files.mjs';
import { endHung } from './daemon-kill.mjs';
import { dropSilence, keepSilence, keptSilence } from './daemon-silence.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Silence} Silence */
/** @typedef {import('../../../shared/remote-protocol.mjs').RunnerRecord} RunnerRecord */

/**
 * Whether the turn runs: not one found dead, and its runner answers, or is silent but still runner.json’s process and
 * not yet for the ceiling. For a turn with no exit.json; the caller reads that first.
 * @param {Daemon} d @param {string} turn @returns {Promise<boolean>}
 */
export async function turnRunning(d, turn) {
  if (d.dead.has(turn)) {
    forgetSilence(d, turn);
    return false;
  }
  // Looks can cross, so each takes a number, and the newer one’s verdict stands (#872).
  const look = ++d.looks;
  if (await runnerAlive(d, turn)) {
    answered(d, turn, look);
    return true;
  }
  if (checkedLately(d, turn)) return true;
  const runner = await liveRunner(d, turn);
  if (runner === null) {
    processGone(d, turn);
    return false;
  }
  return withinCeiling(d, turn, runner, look);
}

/**
 * Whether a silence under the ceiling found its process there within PROCESS_CHECK_MS: then that check stands, since
 * on macOS each one runs sysctl and ps, and holds up the daemon (#872). The ceiling’s decision takes a fresh one.
 * @param {Daemon} d @param {string} turn
 */
function checkedLately(d, turn) {
  const silence = d.silentSince.get(turn);
  if (!silence || d.mono() - silence.since >= RUNNER_SILENT_MAX_MS) return false;
  return d.mono() - silence.checked < PROCESS_CHECK_MS;
}

/** runner.json, while it’s valid and names this runner’s process still, else null. @param {Daemon} d @param {string} turn */
async function liveRunner(d, turn) {
  const rec = validateRunnerRecord(await readJson(d.p.turn(turn, TURN_FILES.runner)));
  if (!rec.ok) return null;
  return (await d.proc.sameProcess(rec.msg)) ? rec.msg : null;
}

/**
 * The runner answered on this look: a silence it was in is over, unless a later look’s miss began it.
 * @param {Daemon} d @param {string} turn @param {number} look
 */
function answered(d, turn, look) {
  const silence = d.silentSince.get(turn);
  if (silence && silence.look > look) return;
  // One kept by a daemon before a restart, which this one never took up, is over too.
  forgetSilence(d, turn);
  d.answeredLook.set(turn, look);
  if (!silence) return;
  d.log(`Turn ${turn}’s runner (process ${silence.pid}) answered again after ${seconds(d.mono() - silence.since)} s of silence.`);
}

/** The runner’s process is gone: a silence it was in ends, and so does the turn. @param {Daemon} d @param {string} turn */
function processGone(d, turn) {
  const silence = d.silentSince.get(turn);
  if (!silence) return;
  forgetSilence(d, turn);
  d.log(`Turn ${turn}’s runner (process ${silence.pid}) is gone after ${seconds(d.mono() - silence.since)} s of silence.`);
}

/**
 * A silent runner whose process is still there: running while its silence is under the ceiling. The silence starts at
 * this miss if none is under way. At the ceiling its process is killed, and the turn runs on until it’s gone (the
 * caller sees that as a miss), through Stop’s grace period if one is under way, or for KILL_WAIT_MS. Past that the
 * silence stays recorded, unkilled, so the turn stays ended until the runner answers.
 * A miss on a look older than one that got an answer starts no silence: that answer is newer.
 * @param {Daemon} d @param {string} turn @param {RunnerRecord} runner @param {number} look
 */
async function withinCeiling(d, turn, runner, look) {
  const had = d.silentSince.get(turn);
  if (!had && (d.answeredLook.get(turn) ?? 0) > look) return true;
  const silence = had ?? startSilence(d, turn, runner.pid, look);
  silence.checked = d.mono();
  if (d.mono() - silence.since < RUNNER_SILENT_MAX_MS) return true;
  if (!silence.over) {
    silence.over = true;
    silence.killedAt = d.mono();
    d.log(
      `Turn ${turn}’s runner (process ${runner.pid}) hasn’t answered as its runner for ${seconds(RUNNER_SILENT_MAX_MS)} s; it’s killed, and the turn ends as interrupted once it’s gone.`,
    );
    await endHung(d, turn, runner);
    return true;
  }
  if (d.killTimers.has(turn) || d.mono() - (silence.killedAt ?? 0) < KILL_WAIT_MS) return true;
  if (!silence.unkilled) {
    silence.unkilled = true;
    d.log(`Turn ${turn}’s runner (process ${runner.pid}) is still there ${seconds(KILL_WAIT_MS)} s after its SIGKILL; the turn ends as interrupted, unkilled.`);
  }
  return false;
}

/** Whether the turn ends with its process still there after the ceiling’s kill (#872). @param {Daemon} d @param {string} turn */
export const unkilled = (d, turn) => d.silentSince.get(turn)?.unkilled === true;

/**
 * “Didn’t answer as its runner”: the daemon can’t tell no answer from one for another turn or a refused token, since
 * askRunner is false for each (runner-client.mjs). One a daemon before a restart kept for this runner goes on
 * (daemon-silence.mjs); else it starts now, and is kept.
 * @param {Daemon} d @param {string} turn @param {number} pid @param {number} look @returns {Silence}
 */
function startSilence(d, turn, pid, look) {
  const ago = keptSilence(d, turn, pid);
  /** @type {Silence} */
  const silence = { since: d.mono() - (ago ?? 0), checked: d.mono(), look, pid, over: false, killedAt: null, unkilled: false };
  d.silentSince.set(turn, silence);
  if (ago === null) keepSilence(d, turn, pid, 0);
  d.log(
    ago === null
      ? `Turn ${turn}’s runner (process ${pid}) didn’t answer as its runner, but its process is still running; it’s kept running for up to ${seconds(RUNNER_SILENT_MAX_MS)} s.`
      : `Turn ${turn}’s runner (process ${pid}) still doesn’t answer as its runner, ${seconds(ago)} s into a silence that began before this daemon started; it’s kept running for up to ${seconds(RUNNER_SILENT_MAX_MS)} s in all.`,
  );
  return silence;
}

const seconds = (/** @type {number} */ ms) => Math.round(ms / 1000);

/** Misses in a row that end a turn whose runner isn’t running (daemon-follow.mjs): one look can catch a runner mid-start. */
const MISSES_TO_END = 2;

/**
 * Whether the follower ends a turn on this look: at once if Stop found it gone (d.dead), else at its second miss in a
 * row (#738). @param {{ dead: boolean, misses: number }} look @returns {boolean}
 */
export function followerEnds({ dead, misses }) {
  if (dead) return true;
  return misses >= MISSES_TO_END;
}

/** The turn has ended with exit.json, or its silence is over: it’s forgotten, here and in the turn folder. @param {Daemon} d @param {string} turn */
export function forgetSilence(d, turn) {
  d.silentSince.delete(turn);
  d.answeredLook.delete(turn);
  dropSilence(d, turn);
}
