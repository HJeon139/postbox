// npm run check: Biome, types, the project lints, contrast, then the unit, integration and process tests, one after
// another, stopping at the first that fails. It prints each stage’s time as it ends and every stage’s time at the end,
// so a stage that has slowed shows in every run’s output, not only when someone times it.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGES = ['lint', 'typecheck', 'lint:project', 'check:contrast', 'test', 'test:integration', 'test:process'];

const secs = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)} s`;

/** `npm run <script>`, its output passed through; resolves with its exit code. @param {string} script */
function npmRun(script) {
  return new Promise((ok) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', script], { stdio: 'inherit' });
    child.on('error', () => ok(127));
    child.on('exit', (code, signal) => ok(code ?? (signal ? 1 : 0)));
  });
}

/**
 * Runs the stages in order and returns the exit code: 0, or the first failing stage’s.
 * @param {{ stages?: string[], run?: (script: string) => Promise<number>, now?: () => number, log?: (m: string) => void }} [o]
 */
export async function check({ stages = STAGES, run = npmRun, now = Date.now, log = (m) => process.stdout.write(`${m}\n`) } = {}) {
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(await check());
