// The runner’s exit code, and its record in run.json (#482). A run started detached leaves no exit status anyone saw, so
// run.json says how it ended: on a normal exit, and on a stop by the budget or the run’s bound, which end as a normal
// exit does, through the report. A run that’s killed, or that the bound’s overdue stop ends without a report
// (tools/uat/run-bound.mjs), can’t record its own.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { failsRun } from './checks-postbox.mjs';
import { writeJsonAtomic } from './runs.mjs';

/**
 * The code the runner exits with: one set already (a signal’s 130, tools/uat/stop.mjs) stands; else 1 when the run
 * failed, or its findings fail it (failsRun, #681); else 0. Recorded in the run folder’s run.json, when there is one.
 * @param {string | null} dir  the run’s folder; null for a recheck, whose run already recorded its own
 * @param {{ findings?: { check?: string, unverified?: any }[] | null, failed?: boolean, exitCode?: unknown }} o
 * @returns {number}
 */
export function runExit(dir, { findings = null, failed = false, exitCode = process.exitCode }) {
  const code = Number(exitCode) || (failed || (findings && failsRun(findings)) ? 1 : 0);
  if (dir) recordExit(dir, code);
  return code;
}

/**
 * Adds `exit` to run.json, keeping the rest. A run that ended before writing run.json gets none: its report and
 * findings aren’t there either. @param {string} dir @param {number} code
 */
function recordExit(dir, code) {
  const file = join(dir, 'run.json');
  if (!existsSync(file)) return;
  try {
    writeJsonAtomic(file, { ...JSON.parse(readFileSync(file, 'utf8')), exit: code });
  } catch (e) {
    // The exit goes ahead with its code: a run.json that can’t be read or written is said, not thrown over it.
    console.error(`Couldn’t record the exit code in run.json: ${/** @type {Error} */ (e).message}`);
  }
}
