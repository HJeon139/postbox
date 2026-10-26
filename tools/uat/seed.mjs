// The agents a UAT run seeds (tools/uat-run.mjs): a fresh install has one generic agent, so the scenario’s agents are
// written to agents.json in the run’s data folder before Postbox starts. Every persona in personas.json goes in, since
// scenarios bring more agents (@critic) into topic threads than they start with, each on the run’s model unless the
// scenario keeps the persona’s, and on the backend the scenario names. A backend’s CLI must be installed here.

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agyVersion, findAgy } from '../../server/adapters/antigravity-cli.mjs';
import { codexModels, codexVersion, findCodex } from '../../server/adapters/codex.mjs';
import { findKiro, kiroVersion } from '../../server/adapters/kiro-cli.mjs';

/** Codex’s default model, when the scenario puts an agent on Codex; it must be installed here. */
async function codexDefault(scenario, log) {
  let codexDefaultModel = null;
  if (Object.values(scenario.backends).some((b) => b.backend === 'codex')) {
    const v = await codexVersion(findCodex());
    if (!v) throw new Error('This scenario puts agents on Codex, and the Codex CLI is not installed here (or set POSTBOX_CODEX_BIN).');
    codexDefaultModel = (await codexModels(findCodex()))[0] ?? null;
    log(`Codex ${v}${codexDefaultModel ? ` · default model ${codexDefaultModel}` : ''}.`);
  }
  return codexDefaultModel;
}

// An agent the scenario puts on another backend runs there with the model it names. A Kiro agent is Isolated: it
// runs with Postbox’s own Kiro home, so the run never writes into the person’s ~/.kiro, and the Kiro checks can
// tell the person’s steering and servers from Postbox’s (#57).
const onBackend = (scenario, codexDefaultModel, p) => {
  const b = scenario.backends[p.handle];
  return b
    ? {
        ...p,
        backend: b.backend,
        ...(b.model ? { model: b.model } : b.backend === 'codex' && codexDefaultModel ? { model: codexDefaultModel } : {}),
        ...(b.backend === 'kiro-cli' ? { usesHostSetup: false } : {}),
      }
    : p;
};
// An agent the scenario gives a permission mode (`- permission_modes:`) starts in it, on whichever backend it runs:
// remotehosts’ @critic asks before it runs anything, on Claude Code (#120).
const withMode = (scenario, p) => (scenario.permissionModes[p.handle] ? { ...p, permissionMode: scenario.permissionModes[p.handle] } : p);
// Claude agents run on the run’s model, unless the scenario keeps the persona’s and --force-agent-model doesn’t override it.
const fast = (scenario, opt, p) => {
  if ((scenario.models === 'persona' && !opt['force-agent-model']) || scenario.backends[p.handle]) return p;
  return {
    ...p,
    ...(opt['agent-model'] !== 'persona' ? { model: opt['agent-model'] } : {}),
    ...(opt['agent-effort'] !== 'persona' ? { effort: opt['agent-effort'] } : {}),
  };
};

/** The CLIs the scenario’s backends need, each installed here. */
async function checkClis(scenario, opt, log) {
  if (opt.release) log('A release run: the release-only backends are on.');
  // Postbox registers the Kiro CLI only when it can run it, and seeding an agent on a backend it doesn’t have fails.
  // The same for the Antigravity CLI, which a compatibility run may use. It always runs with the
  // person’s own agy setup: it has no Isolated mode (server/adapters/antigravity-cli.mjs).
  if (Object.values(scenario.backends).some((b) => b.backend === 'antigravity-cli')) {
    const v = await agyVersion(findAgy());
    if (!v) throw new Error('This scenario puts agents on the Antigravity CLI, and agy isn’t installed here (or set POSTBOX_AGY_BIN).');
    log(`Antigravity CLI ${v}: this run uses its quota.`);
  }
  if (Object.values(scenario.backends).some((b) => b.backend === 'kiro-cli')) {
    const v = await kiroVersion(findKiro());
    if (!v) throw new Error('This scenario puts agents on the Kiro CLI, and kiro-cli isn’t installed here (or set POSTBOX_KIRO_BIN).');
    log(
      `Kiro CLI ${v}: ${Object.entries(scenario.backends)
        .map(([h, b]) => `@${h} on ${b.backend}${b.model ? ` (${b.model})` : ''}`)
        .join(', ')}.`,
    );
  }
}

/**
 * Writes the run’s agents to agents.json, and says what they run on: agentModels for the report, and the effort the
 * scenario’s Claude agents run at, for run.json.
 * @param {{ scenario: any, opt: Record<string, any>, root: string, data: string, log: (line: string) => void }} o
 * @returns {Promise<{ agentModels: string, agentEffort: string|null }>}
 */
export async function seedAgents({ scenario, opt, root, data, log }) {
  // A fresh install has one generic agent, so the scenario's agents are seeded from agents.json: every
  // persona in personas.json, since scenarios bring more agents (@critic) into topic threads than they start with.
  const personas = JSON.parse(readFileSync(join(root, 'tests', 'uat', 'e2e', 'personas.json'), 'utf8'));
  const codexDefaultModel = await codexDefault(scenario, log);
  const agents = [
    ...scenario.agents.map((h) => personas.find((p) => p.handle === h) ?? { handle: h }),
    ...personas.filter((p) => !scenario.agents.includes(p.handle)),
  ]
    .map((p) => fast(scenario, opt, p))
    .map((p) => onBackend(scenario, codexDefaultModel, p))
    .map((p) => withMode(scenario, p));
  await checkClis(scenario, opt, log);
  await writeFile(join(data, 'agents.json'), JSON.stringify(agents, null, 2));
  // What the agents ran on, for the report: a fast run’s findings about agent choices aren’t the default model’s.
  const agentModels = agents.map((p) => `@${p.handle} ${p.model ?? 'its default model'}${p.effort ? `, ${p.effort} effort` : ''}`).join('; ');
  log(`Agents: ${agentModels}.`);
  // The effort the scenario’s Claude agents run at, for run.json: a `- models: persona` run keeps each persona’s own.
  const efforts = [...new Set(agents.filter((p) => scenario.agents.includes(p.handle) && !scenario.backends[p.handle]).map((p) => p.effort ?? null))];
  const agentEffort = efforts.length > 1 ? efforts.map((e) => e ?? 'default').join('/') : (efforts[0] ?? null);
  return { agentModels, agentEffort };
}
