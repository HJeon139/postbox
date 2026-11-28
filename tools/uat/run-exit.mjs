// The runner’s exit code, and its record in run.json (#482). A run started detached leaves no exit status anyone saw, so
// run.json says how it ended: on a normal exit, and on a stop by the budget or the run’s bound, which end as a normal
// exit does, through the report. A run that’s killed, or that the bound’s overdue stop ends without a report
// (tools/uat/run-bound.mjs), can’t record its own.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { failsRun } from './checks-postbox.mjs';
import { writeJsonAtomic } from './runs.mjs';

/**
 * The code the runner exits with: one set already stands; else 1 when the run failed, or its findings fail it
 * (failsRun, #681); else 0. Recorded in the run folder’s run.json, when there is one. A run a signal stops exits 130
 * from tools/uat/stop.mjs, usually before it writes run.json, so it records none; it records 130 only when the run’s
 * own end finishes first.
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

/**
 * Sets the runner’s exit code once its run settles, and records it in run.json: the findings’ code when it ends, 1 when
 * it fails. A run stopped by a signal exits 130 from tools/uat/stop.mjs first, whatever it failed with meanwhile.
 * @param {Promise<any[] | null | undefined>} run  main()’s, or a recheck’s
 * @param {() => string | null} dirOf  the run’s folder, once it’s planned; null for a recheck, or a plan that threw
 * @param {{ setCode?: (code: number) => void, exit?: (code: number) => void, say?: (line: string) => void }} [io]
 */
export function exitWhenSettled(run, dirOf, io = {}) {
  const {
    setCode = (code) => {
      process.exitCode = code;
    },
    exit = (code) => process.exit(code),
    say = (line) => console.error(line),
  } = io;
  return run
    .then((findings) => setCode(runExit(dirOf(), { findings })))
    .catch((e) => {
      say(`UAT run failed: ${e?.stack ?? e?.message ?? e}`);
      exit(runExit(dirOf(), { failed: true }));
    });
}
