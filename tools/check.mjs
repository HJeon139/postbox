// npm run check: Biome, types, the project lints, contrast, then the unit, integration and process tests, one after
// another, stopping at the first that fails. It prints each stage’s time as it ends and every stage’s time at the end,
// so a stage that has slowed shows in every run’s output, not only when someone times it. The test stages run with
// TMPDIR set to a folder of the run’s own, which it removes at the end (tools/gate-tmp.mjs, #797). Ctrl-C or SIGTERM
// passes to the running stage, and the run removes its folder once that stage exits, then exits 130 or 143.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateRunDir } from './gate-tmp.mjs';
import { SLOT_DIR } from './heavy-lock.mjs';

export const STAGES = ['lint', 'typecheck', 'lint:project', 'check:contrast', 'test', 'test:integration', 'test:process'];
const TEST_STAGES = new Set(['test', 'test:integration', 'test:process']);

/** The exit code of a run a signal ended, as a shell reports it: 128 plus the signal’s number. */
export const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };

const secs = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * @typedef {{ kill: (signal: NodeJS.Signals) => unknown }} Child
 * @typedef {(script: string, env: Record<string, string> | undefined, spawned: (child: Child) => void) => Promise<number>} Run
 */

/**
 * `npm run <script>`, its output passed through, with env added to this process’s; hands spawned its child, and
 * resolves with its exit code.
 * @type {Run}
 */
function npmRun(script, env, spawned) {
  return new Promise((ok) => {
    const options = { stdio: /** @type {const} */ ('inherit'), env: { ...process.env, ...env } };
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', script], options);
    spawned(child);
    child.on('error', () => ok(127));
    child.on('exit', (code, signal) => ok(code ?? (signal ? 1 : 0)));
  });
}

/**
 * Runs the stages in order and returns the exit code: 0, or the first failing stage’s. With a runDir, the test
 * stages get TMPDIR set to the folder it opens, which is closed however the run ends. SIGINT or SIGTERM on signals
 * goes to the running stage’s child, and no stage starts after it; the run returns its SIGNAL_EXIT once the stage ends.
 * @param {{ stages?: string[], run?: Run, now?: () => number, log?: (m: string) => void,
 *   runDir?: { open: () => { path: string, close: () => void } }, signals?: Pick<NodeJS.EventEmitter, 'on' | 'off'> }} [o]
 */
export async function check(o = {}) {
  const { stages = STAGES, run = npmRun, now = Date.now, log = (m) => process.stdout.write(`${m}\n`), runDir, signals = process } = o;
  /** @type {keyof SIGNAL_EXIT | undefined} */
  let stopping;
  /** @type {Child | undefined} */
  let child;
  const stop = (/** @type {keyof SIGNAL_EXIT} */ sig) => {
    stopping ??= sig;
    child?.kill(sig);
  };
  const handlers = Object.keys(SIGNAL_EXIT).map((sig) => /** @type {const} */ ([sig, () => stop(/** @type {keyof SIGNAL_EXIT} */ (sig))]));
  for (const [sig, h] of handlers) signals.on(sig, h);
  const dir = runDir?.open();
  // The heavy-lock’s slots stay in the shared temp folder, where other runs look for them.
  const testEnv = dir && { TMPDIR: dir.path, POSTBOX_HEAVY_DIR: SLOT_DIR };
  const stage = async (/** @type {string} */ s) => {
    if (stopping) return SIGNAL_EXIT[stopping];
    const code = await run(s, TEST_STAGES.has(s) ? testEnv : undefined, (c) => (child = c));
    child = undefined;
    return stopping ? SIGNAL_EXIT[stopping] : code;
  };
  try {
    return await stagesInOrder(stages, stage, now, log);
  } finally {
    closeQuietly(dir, log);
    for (const [sig, h] of handlers) signals.off(sig, h);
  }
}

/**
 * Removes the run’s folder. A folder that can’t be removed is a warning, not a failed check: the next run’s sweep
 * takes it once it’s over an hour old.
 * @param {{ path: string, close: () => void } | undefined} dir @param {(m: string) => void} log
 */
function closeQuietly(dir, log) {
  try {
    dir?.close();
  } catch (e) {
    log(`⚠ npm run check couldn’t remove its temp folder ${dir?.path}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * @param {string[]} stages @param {(stage: string) => Promise<number>} run @param {() => number} now
 * @param {(m: string) => void} log
 */
async function stagesInOrder(stages, run, now, log) {
  const start = now();
  /** @type {string[]} */
  const times = [];
  for (const stage of stages) {
    const t0 = now();
    const code = await run(stage);
    const took = now() - t0;
    times.push(`${stage} ${secs(took)}`);
    if (code !== 0) {
      log(`✖ ${stage} failed (exit ${code}) in ${secs(took)}`);
      log(`npm run check failed at ${stage} after ${secs(now() - start)}: ${times.join(', ')}.`);
      return code;
    }
    log(`✔ ${stage} in ${secs(took)}`);
  }
  log(`npm run check passed in ${secs(now() - start)}: ${times.join(', ')}.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(await check({ runDir: gateRunDir() }));
