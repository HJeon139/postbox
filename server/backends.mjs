// The real backends Postbox registers as it starts (server/index.mjs): how it looks for each one’s CLI on this
// computer, registering them, and asking agy for its quota once Postbox has started.

import { join } from 'node:path';
import { quotaKeyOf } from '../shared/quota-key.mjs';
import { sweepAgyPlugins } from './adapters/agy-plugin-record.mjs';
import { agyUsage, usageProbe } from './adapters/agy-usage.mjs';
import { AntigravityCliAdapter, agyVersion, findAgy } from './adapters/antigravity-cli.mjs';
import { ClaudeCodeAdapter, claudeVersion, findClaude } from './adapters/claude-code.mjs';
import { CodexAdapter, codexVersion, findCodex } from './adapters/codex.mjs';
import { sweepKiroAgents } from './adapters/kiro-agent-files.mjs';
import { findKiro, KiroCliAdapter, kiroVersion } from './adapters/kiro-cli.mjs';
import { recordQuotaOf, reportedAt } from './quota-usage.mjs';

/**
 * How Postbox looks for each real backend’s CLI on this computer: its version, or null when it isn’t here. Tests pass
 * fakes for some (start’s probes, #120). Their models are asked when a model field opens (server/model-lists.mjs).
 */
export const PROBES = {
  claude: () => claudeVersion(findClaude()),
  kiro: () => kiroVersion(findKiro()),
  agy: () => agyVersion(findAgy()),
  codex: () => codexVersion(findCodex()),
};

/**
 * Registers the real backends with the adapters, moved from server/index.mjs’s start, which passes what it read.
 * Returns whether Postbox looked for them (real), the version of each CLI it found here, and agy’s usage probe.
 * @param {import('./adapters/adapter.mjs').AdapterRegistry} adapters
 * @param {{ dataDir: string, demo: boolean, probes?: Partial<typeof PROBES> }} opts
 */
export async function registerBackends(adapters, { dataDir, demo, probes }) {
  // The real backends. Those that can run on a host (capabilities.remote: Claude Code, Kiro CLI and Codex) register
  // without their CLI here too, as host-only (here: false), so an agent can run them there (#120); the rest only when
  // they can run here. POSTBOX_BACKENDS=mock turns them all off (tests, demo).
  const real = (probes !== undefined || process.env.POSTBOX_BACKENDS !== 'mock') && !demo;
  const look = { ...PROBES, ...probes };
  const workRoot = join(dataDir, 'workspaces');
  // A Kiro turn’s agent file that a killed Postbox left in a Kiro home goes first, before any turn (#1864).
  if (real) await sweepKiroAgents(workRoot);
  // An Antigravity turn’s plugin that a killed Postbox left in an agent’s folder goes first, before any turn (#314).
  if (real) await sweepAgyPlugins(workRoot);
  const claude = real ? await look.claude() : null;
  if (real) adapters.register(new ClaudeCodeAdapter({ workRoot }), { here: !!claude });
  // An Isolated Kiro persona runs with a Kiro home of Postbox’s own (#117), next to the workspaces.
  const kiro = real ? await look.kiro() : null;
  if (real) adapters.register(new KiroCliAdapter({ workRoot, isolatedHome: join(dataDir, 'kiro-home') }), { here: !!kiro });
  // The Antigravity CLI brings Gemini models (#143). It always runs with your own agy setup: see its adapter.
  const agy = real ? await look.agy() : null;
  // Its quota comes from asking agy’s /usage alongside a turn (#1466).
  const usage = usageProbe((signal) => agyUsage(findAgy(), { signal }));
  if (agy) adapters.register(new AntigravityCliAdapter({ workRoot, version: agy, usage }));
  const codex = real ? await look.codex() : null;
  if (real) adapters.register(new CodexAdapter({ workRoot }), { here: !!codex });
  return { real, claude, kiro, agy, codex, usage };
}

/**
 * Antigravity’s quota as Postbox starts (#1494): the turn probe asks agy’s /usage only as a turn starts, so after a
 * restart its bar waited for the agent’s next turn. /usage runs no model, so this asks once too, for a room with an
 * Antigravity agent on this computer, through the same probe and its once-a-minute limit.
 *
 * Asks agy for its usage and records the answer, as a turn’s report is, without holding up the start. done resolves
 * once it’s recorded, and never rejects; stop, which Postbox’s close calls before the store closes, stops agy and
 * records nothing after.
 * @param {any} rt @param {ReturnType<typeof import('./adapters/agy-usage.mjs').usageProbe>} usage
 * @param {string | null | undefined} version  agy’s version here, null when it isn’t here
 * @returns {{ done: Promise<void>, stop: () => void }}
 */
export function askAgyQuota(rt, usage, version) {
  const stopped = new AbortController();
  const here = Object.values(rt.s.personas ?? {}).some((p) => p?.backend === 'antigravity-cli' && !p.remote?.hostId);
  const owner = { id: quotaKeyOf({ backend: 'antigravity-cli' }), backend: 'antigravity-cli', host: null };
  const ctx = { signal: stopped.signal, quota: (/** @type {any} */ r) => recordQuotaOf(rt, owner, r, reportedAt(r)) };
  const done = version && here ? usage.report(ctx, usage.start(version, stopped.signal)) : Promise.resolve();
  return {
    done: done.catch((e) => console.error('Postbox couldn’t record Antigravity’s quota as it started; its next turn will:', e)),
    stop: () => stopped.abort(),
  };
}

/**
 * What Postbox prints as it starts: where it runs, its data, the backends here with the version of each CLI it found,
 * those only on hosts, and demo controls. Moved from server/index.mjs’s start.
 * @param {{ origin: string, dataDir: string, adapters: import('./adapters/adapter.mjs').AdapterRegistry, local: string[],
 *   found: { claude: any, kiro: any, agy: any, codex: any }, demo: boolean }} o
 */
export function startedBanner({ origin, dataDir, adapters, local, found: { claude, kiro, agy, codex }, demo }) {
  const remoteOnly = adapters.names().filter((n) => !adapters.runsHere(n));
  return `Postbox is running at ${origin}/\nData: ${dataDir}\nBackends: ${local.join(', ')}${claude ? ` (Claude Code ${claude})` : ''}${kiro ? ` (Kiro CLI ${kiro})` : ''}${agy ? ` (Antigravity CLI ${agy})` : ''}${codex ? ` (Codex ${codex})` : ''}${remoteOnly.length ? `\nOn hosts only: ${remoteOnly.join(', ')}` : ''}${demo ? '\nDemo controls are on.' : ''}`;
}
