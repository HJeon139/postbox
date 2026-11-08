// A silent runner’s silence kept in its turn folder (silence.json, daemon-running.mjs, #872), so a daemon restarted
// within the ceiling goes on from where it began instead of starting it over, and one restarted again and again still
// reaches it. Its start is kept on the wall clock, with this boot’s ID and the runner’s PID: a daemon on the same boot,
// with the same runner, takes it up; one on another boot, whose wall clock may have been set since, starts afresh.
// Written and removed synchronously, so the file always follows the in-memory silence, in the order they change.

import { rmSync } from 'node:fs';
import { TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { readJsonSync, writeAtomicSync } from './daemon-files.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon */

/**
 * How long ago, in ms, a silence kept for this runner began, or null if none was kept for it on this boot.
 * @param {Daemon} d @param {string} turn @param {number} pid
 */
export function keptSilence(d, turn, pid) {
  const kept = readJsonSync(d.p.turn(turn, TURN_FILES.silence));
  if (!kept || typeof kept !== 'object' || kept.pid !== pid || !Number.isFinite(kept.at)) return null;
  if (typeof kept.bootId !== 'string' || kept.bootId !== d.proc.bootId()) return null;
  return Math.max(0, d.now() - kept.at);
}

/** Keeps a silence that began `ago` ms ago. @param {Daemon} d @param {string} turn @param {number} pid @param {number} ago */
export function keepSilence(d, turn, pid, ago) {
  const bootId = d.proc.bootId();
  if (bootId === null) return;
  try {
    writeAtomicSync(d, d.p.turn(turn, TURN_FILES.silence), JSON.stringify({ pid, bootId, at: d.now() - ago }));
  } catch (e) {
    d.log(`Couldn’t keep turn ${turn}’s silence in its folder (${e.message}); a restart starts it over.`);
  }
}

/** The silence is over: nothing is kept for it. @param {Daemon} d @param {string} turn */
export function dropSilence(d, turn) {
  try {
    rmSync(d.p.turn(turn, TURN_FILES.silence), { force: true });
  } catch (e) {
    d.log(`Couldn’t remove turn ${turn}’s silence.json: ${e.message}`);
  }
}
