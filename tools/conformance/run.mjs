// Runs the backend conformance checks (#585) and prints what each backend saved or sent of Postbox’s guide, with
// the version of the CLI it checked. Never part of npm run check or CI: it starts real CLIs.

import { spawn } from 'node:child_process';
import { findAgy } from '../../server/adapters/antigravity-cli.mjs';
import { findCodex } from '../../server/adapters/codex-models.mjs';
import { agyCheck } from './agy.mjs';
import { codexStartCheck } from './codex-start.mjs';
import { codexTurnsCheck } from './codex-turns.mjs';
import { withProbeHome } from './probe-home.mjs';
import { sandboxEnv } from './sandbox-env.mjs';

/** The backends, each with its CLI and its checks. */
export const BACKENDS = {
  codex: { bin: () => findCodex(), checks: [codexStartCheck, codexTurnsCheck] },
  agy: { bin: () => findAgy(), checks: [agyCheck] },
};

/**
 * A CLI’s whole `--version` line, run in a temp HOME, or null when it can’t run. One reader for every backend, rather
 * than the adapters’ codexVersion and agyVersion: those run in the person’s own HOME and keep only the number, and
 * agyVersion’s module is at its size ceiling, with no room for an env option, so giving codexVersion one would still
 * leave two formats. The tool prints the whole line on purpose: it names the CLI and its build, as the app’s number
 * alone doesn’t.
 * @param {string} bin
 */
export function cliVersion(bin) {
  return withProbeHome(
    ({ home }) =>
      new Promise((ok) => {
        const child = spawn(bin, ['--version'], {
          cwd: home,
          env: sandboxEnv({ home }),
          stdio: ['ignore', 'pipe', 'ignore'],
          signal: AbortSignal.timeout(10_000),
        });
        let out = '';
        child.stdout.on('data', (d) => {
          out += d;
        });
        child.on('error', () => ok(null));
        child.on('close', (code) => ok(code === 0 ? out.trim().split('\n')[0] || null : null));
      }),
  );
}

/**
 * Every check of one backend, with its version. A check that throws is a failure that says why, and a CLI that
 * won’t run is one too, so a run that checked nothing can’t pass. `backends` and `version`: the table and the
 * version reader, for the tests.
 * @param {string} backend
 * @param {Record<string, { bin: () => string, checks: ((opts: { bin: string, record?: string }) => Promise<{ name: string, ok: boolean, detail: string }[]>)[] }>} [backends]
 * @param {(bin: string) => Promise<string | null>} [versionOf]
 * @param {string} [record]  a folder each check that records writes its fixture into
 */
export async function checkBackend(backend, backends = BACKENDS, versionOf = cliVersion, record = undefined) {
  const { bin, checks } = backends[backend];
  const version = await versionOf(bin());
  if (!version) return { backend, version: null, results: [{ name: 'its CLI runs', ok: false, detail: `${bin()} --version failed` }] };
  const results = [];
  for (const check of checks) {
    try {
      const said = await check({ bin: bin(), record });
      // A check that reports nothing checked nothing, and fails rather than leaving the run to pass on the rest.
      results.push(...(said.length ? said : [{ name: check.name, ok: false, detail: 'the check reported nothing' }]));
    } catch (e) {
      results.push({ name: check.name, ok: false, detail: `the probe failed: ${e.message}` });
    }
  }
  return { backend, version, results };
}

/** The summary’s lines. @param {{ backend: string, version: string|null, results: { name: string, ok: boolean, detail: string }[] }[]} runs */
export function summary(runs) {
  return runs.flatMap(({ backend, version, results }) => [
    `${backend} (${version ?? 'version unknown'})`,
    ...results.map((r) => `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`),
  ]);
}
