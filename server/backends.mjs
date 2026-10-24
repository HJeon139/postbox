// The real backends Postbox registers (server/index.mjs): how it looks for each one’s CLI on this computer.

import { loadAgentSdk } from './adapters/agent-sdk.mjs';
import { agyModels, agyVersion, findAgy } from './adapters/antigravity-cli.mjs';
import { claudeVersion, findClaude } from './adapters/claude-code.mjs';
import { codexModels, codexVersion, findCodex } from './adapters/codex.mjs';
import { findKiro, kiroModels, kiroVersion } from './adapters/kiro-cli.mjs';

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
