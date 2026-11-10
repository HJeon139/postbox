// The daemon’s look at its turn folders, and its timers (daemon.mjs’s header, #120): scan classifies every turn, the
// idle exit waits for nobody attached and no turn running, and the sweep runs cleanup.mjs every sweepMs.

import { promises as fsp } from 'node:fs';
import { REMOTE_LIMITS, TURN_FILES, validateStartRecord } from '../../../shared/remote-protocol.mjs';
import { readExit, readJson, sizeOf } from './daemon-files.mjs';
import { forgetSilence, turnRunning, unkilled } from './daemon-running.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').TurnFound} TurnFound */

/**
 * Every turn folder: exit.json is ended, a turn daemon-running.mjs finds running is running, and one that’s neither is
 * interrupted, and unkilled if its process was still there after the silence ceiling’s SIGKILL (#872). A folder without a valid start.json isn’t a turn the daemon started, and is skipped.
 * @param {Daemon} d @returns {Promise<TurnFound[]>}
 */
export async function scan(d) {
  let names = [];
  try {
    names = await fsp.readdir(d.p.turns);
  } catch (e) {
    if (e.code !== 'ENOENT') d.log(`Couldn’t list ${d.p.turns}: ${e.message}`);
    return [];
  }
  const found = await Promise.all(names.slice(0, REMOTE_LIMITS.turns).map((turn) => scanTurn(d, turn)));
  return /** @type {TurnFound[]} */ (found.filter(Boolean));
}

/** One turn folder, as scan finds it, or null for one that isn’t a turn. @param {Daemon} d @param {string} turn */
async function scanTurn(d, turn) {
  let dir;
  try {
    dir = d.p.turn(turn);
  } catch {
    return null;
  }
  const start = validateStartRecord(await readJson(`${dir}/${TURN_FILES.start}`));
  if (!start.ok) return null;
  const { state, exit } = await turnState(d, turn);
  return /** @type {TurnFound} */ ({
    turn,
    harness: start.msg.harness,
    state,
    size: (await d.cleanup.deletedSize(turn)) ?? (await sizeOf(`${dir}/${TURN_FILES.out}`)),
    exit,
    // As the follower's ended says it, for a laptop that wasn't there for that ended (#872).
    ...(state === 'interrupted' && unkilled(d, turn) ? { unkilled: true } : {}),
  });
}

/**
 * A turn’s state and exit: ended with exit.json, else running or interrupted as daemon-running.mjs finds it.
 * @param {Daemon} d @param {string} turn @returns {Promise<Pick<TurnFound, 'state' | 'exit'>>}
 */
async function turnState(d, turn) {
  if (await turnRunningNow(d, turn)) return { state: 'running', exit: null };
  // A runner may write exit.json between the two looks.
  const exit = await readExit(d, turn);
  if (!exit) return { state: 'interrupted', exit: null };
  forgetSilence(d, turn);
  return { state: 'ended', exit };
}

/** Whether the turn has no exit.json and runs. @param {Daemon} d @param {string} turn */
async function turnRunningNow(d, turn) {
  if (await readExit(d, turn)) return false;
  return turnRunning(d, turn);
}

/**
 * The idle time: hello’s idleTimeout, unless POSTBOX_DAEMON_TIMINGS (JSON) shortens it. For tests only, as shim.mjs’s
 * POSTBOX_SHIM_TIMINGS: the idle-exit integration test runs a real daemon, and the setting’s floor is a minute. A value
 * can only shorten it. @param {Daemon} d
 */
export function idleTimeout(d) {
  try {
    const v = JSON.parse(d.env.POSTBOX_DAEMON_TIMINGS ?? 'null')?.idleTimeout;
    if (Number.isFinite(v) && v >= 1 && v < d.settings.idleTimeout) return v;
  } catch {}
  return d.settings.idleTimeout;
}

/** Arms the idle exit when nobody is attached; it fires once no turn runs, idleTimeout after the last client left. @param {Daemon} d */
export function checkIdle(d) {
  if (d.closed) return;
  if (d.idleTimer) d.timers.clearTimeout(d.idleTimer);
  d.idleTimer = null;
  if (d.conns.size) return;
  const wait = Math.max(0, d.lastActive + idleTimeout(d) - d.now());
  d.idleTimer = d.timers.setTimeout(() => idleFired(d), wait);
}

/** @param {Daemon} d */
async function idleFired(d) {
  d.idleTimer = null;
  if (d.closed || d.conns.size) return;
  if (d.now() - d.lastActive < idleTimeout(d)) return checkIdle(d);
  const running = (await scan(d)).filter((t) => t.state === 'running');
  if (d.closed || d.conns.size) return;
  if (running.length) {
    // Look again later; the idle time counts from when the last turn was seen running.
    d.lastActive = d.now();
    return checkIdle(d);
  }
  await d.cleanup.sweep().catch((e) => d.log(`The cleanup before exiting failed: ${e.message}`));
  if (d.closed || d.conns.size) return;
  d.log(`Idle for ${Math.round(idleTimeout(d) / 1000)} s with no turn running and nobody attached; exiting.`);
  d.onIdle();
}

/** Sweeps every sweepMs (cleanup.mjs); the timer is unref’d, like the others. @param {Daemon} d */
export function armSweep(d) {
  if (d.closed) return;
  d.sweepTimer = d.timers.setTimeout(() => {
    d.sweepTimer = null;
    if (d.closed) return;
    d.cleanup
      .sweep()
      .catch((e) => d.log(`The cleanup sweep failed: ${e.message}`))
      .then(() => armSweep(d));
  }, d.sweepMs);
}
