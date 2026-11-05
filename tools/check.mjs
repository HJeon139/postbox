// npm run check: Biome, types, the project lints, contrast, then the unit, integration and process tests, one after
// another, stopping at the first that fails. It prints each stage’s time as it ends and every stage’s time at the end,
// so a stage that has slowed shows in every run’s output, not only when someone times it. The test stages run with
// TMPDIR set to a folder of the run’s own, which it removes at the end (tools/gate-tmp.mjs, #797).

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateRunDir } from './gate-tmp.mjs';
import { SLOT_DIR } from './heavy-lock.mjs';

export const STAGES = ['lint', 'typecheck', 'lint:project', 'check:contrast', 'test', 'test:integration', 'test:process'];
const TEST_STAGES = new Set(['test', 'test:integration', 'test:process']);

const secs = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * `npm run <script>`, its output passed through, with env added to this process’s; resolves with its exit code.
 * @param {string} script @param {Record<string, string>} [env]
 */
function npmRun(script, env) {
  return new Promise((ok) => {
    const options = { stdio: /** @type {const} */ ('inherit'), env: { ...process.env, ...env } };
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', script], options);
    child.on('error', () => ok(127));
    child.on('exit', (code, signal) => ok(code ?? (signal ? 1 : 0)));
  });
}

/**
 * Runs the stages in order and returns the exit code: 0, or the first failing stage’s. With a runDir, the test
 * stages get TMPDIR set to the folder it opens, which is closed however the run ends.
 * @param {{ stages?: string[], run?: (script: string, env?: Record<string, string>) => Promise<number>, now?: () => number,
 *   log?: (m: string) => void, runDir?: { open: () => { path: string, close: () => void } } }} [o]
 */
export async function check({ stages = STAGES, run = npmRun, now = Date.now, log = (m) => process.stdout.write(`${m}\n`), runDir } = {}) {
  const dir = runDir?.open();
  // The heavy-lock’s slots stay in the shared temp folder, where other runs look for them.
  const testEnv = dir && { TMPDIR: dir.path, POSTBOX_HEAVY_DIR: SLOT_DIR };
  try {
    return await stagesInOrder(stages, (stage) => run(stage, TEST_STAGES.has(stage) ? testEnv : undefined), now, log);
  } finally {
    dir?.close();
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
