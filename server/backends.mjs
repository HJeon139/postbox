// The real backends Postbox registers as it starts (server/index.mjs): how it looks for each one’s CLI on this
// computer, and registering them.

import { join } from 'node:path';
import { AgentSdkAdapter, loadAgentSdk } from './adapters/agent-sdk.mjs';
import { AntigravityCliAdapter, agyModels, agyVersion, findAgy } from './adapters/antigravity-cli.mjs';
import { ClaudeCodeAdapter, claudeVersion, findClaude } from './adapters/claude-code.mjs';
import { CodexAdapter, codexModels, codexVersion, findCodex } from './adapters/codex.mjs';
import { findKiro, KiroCliAdapter, kiroModels, kiroVersion } from './adapters/kiro-cli.mjs';

/**
 * How Postbox looks for each real backend’s CLI on this computer: its version, or null when it isn’t here, and the
 * models some of them list. Tests pass fakes for some (start’s probes, #120).
 */
export const PROBES = {
  claude: () => claudeVersion(findClaude()),
  sdk: () => loadAgentSdk(),
  kiro: () => kiroVersion(findKiro()),
  kiroModels: () => kiroModels(findKiro()),
  agy: () => agyVersion(findAgy()),
  agyModels: () => agyModels(findAgy()),
  codex: () => codexVersion(findCodex()),
  codexModels: () => codexModels(findCodex()),
};

/**
 * Registers the real backends with the adapters, moved from server/index.mjs’s start, which passes what it read.
 * Returns whether Postbox looked for them (real), and the version of each CLI it found here.
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
  const claude = real ? await look.claude() : null;
  if (real) adapters.register(new ClaudeCodeAdapter({ workRoot }), { here: !!claude });
  const sdk = real ? await look.sdk() : null;
  if (sdk) adapters.register(new AgentSdkAdapter({ sdk, workRoot }));
  // An Isolated Kiro persona runs with a Kiro home of Postbox’s own (#117), next to the workspaces.
  const kiro = real ? await look.kiro() : null;
  if (real)
    adapters.register(new KiroCliAdapter({ workRoot, isolatedHome: join(dataDir, 'kiro-home'), models: kiro ? await look.kiroModels() : [] }), {
      here: !!kiro,
    });
  // The Antigravity CLI brings Gemini models (#143). It always runs with your own agy setup: see its adapter.
  const agy = real ? await look.agy() : null;
  if (agy) adapters.register(new AntigravityCliAdapter({ workRoot, models: await look.agyModels() }));
  const codex = real ? await look.codex() : null;
  if (real) adapters.register(new CodexAdapter({ workRoot, models: codex ? await look.codexModels() : [] }), { here: !!codex });
  return { real, claude, kiro, agy, codex };
}
