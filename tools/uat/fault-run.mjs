// The runner's side of the fault launcher (#508, tools/uat/fault-launcher.mjs). A scenario whose phases say
// `- fault: fail-before-output <agent> <n>` gets its Postbox started with the launcher in front of that agent's
// backend: POSTBOX_CLAUDE_BIN, POSTBOX_CODEX_BIN, POSTBOX_KIRO_BIN or POSTBOX_AGY_BIN names the launcher, and
// POSTBOX_UAT_REAL_BIN the CLI it stands in for. Every agent on that backend runs through it; the launcher fails only
// the named agent's turns. The fault is armed through a file the launcher reads at each start
// (POSTBOX_UAT_FAULT_FILE): the phase that names it writes its line there when it starts, and a phase that doesn't
// empties it, so the fault belongs to its phase.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findAgy } from '../../server/adapters/antigravity-cli.mjs';
import { findClaude } from '../../server/adapters/claude-code.mjs';
import { findCodex } from '../../server/adapters/codex-models.mjs';
import { findKiro } from '../../server/adapters/kiro-cli-models.mjs';
import { parseFault } from './fault-launcher.mjs';

/** Each backend's binary variable, and where Postbox finds its real CLI without one. */
const BINS = {
  'claude-code': { bin: 'POSTBOX_CLAUDE_BIN', real: findClaude },
  codex: { bin: 'POSTBOX_CODEX_BIN', real: findCodex },
  'kiro-cli': { bin: 'POSTBOX_KIRO_BIN', real: findKiro },
  'antigravity-cli': { bin: 'POSTBOX_AGY_BIN', real: findAgy },
};

/**
 * The launcher's environment for a scenario with faults, and `arm(phase)`, which the runner calls as each phase
 * starts; null for a scenario without. Throws on a fault line the launcher can't read, and on faults whose agents run
 * on different backends, since the launcher stands in for one CLI.
 * @param {{ scenario: { backends: Record<string, { backend: string }>, phases: { fault?: string|null }[] }, root: string,
 *   dir: string, env: NodeJS.ProcessEnv }} o  dir: the run's folder; env: the runner's own environment
 * @returns {{ env: Record<string, string>, arm: (phase: number, log?: (line: string) => void) => void } | null}
 */
export function faultSetup({ scenario, root, dir, env }) {
  const lines = scenario.phases.map((p) => p.fault ?? null);
  const faults = lines.filter(Boolean).map((line) => {
    const f = parseFault(line);
    if (!f) throw new Error(`A phase names the fault “${line}”, and the fault launcher knows only “fail-before-output <agent> <n>”.`);
    return f;
  });
  if (!faults.length) return null;
  const backends = [...new Set(faults.map((f) => scenario.backends[f.agent]?.backend ?? 'claude-code'))];
  if (backends.length > 1)
    throw new Error(`The scenario’s faults are on agents on ${backends.join(' and ')}; the fault launcher stands in for one backend’s CLI.`);
  const on = BINS[/** @type {keyof typeof BINS} */ (backends[0])];
  if (!on) throw new Error(`The fault launcher can’t stand in for ${backends[0]}: it has no CLI to put it in front of.`);
  const folder = join(dir, 'fault');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'armed.txt');
  writeFileSync(file, '');
  let last = '';
  return {
    env: {
      [on.bin]: join(root, 'tools', 'uat', 'fault-launcher.mjs'),
      POSTBOX_UAT_REAL_BIN: on.real(env),
      POSTBOX_UAT_FAULT_FILE: file,
      POSTBOX_UAT_FAULT_STATE: join(folder, 'turns'),
      // A fault set where the runner was started would override the phases' own.
      POSTBOX_UAT_FAULT: '',
    },
    arm(phase, log = () => {}) {
      const line = lines[phase] ?? '';
      if (line === last) return;
      writeFileSync(file, line ? `${line}\n` : '');
      log(line ? `fault armed for this phase: ${line}` : `fault disarmed: “${last}” was the last phase’s`);
      last = line;
    },
  };
}
