// The environment of the Postbox a UAT run starts and restarts (tools/uat-run.mjs): the gate’s, where each backend’s
// streams are recorded, and what the scenario sets.

import { gitRemoteEnv } from './git-remote.mjs';
import { noGithubEnv } from './github-guard.mjs';
import { chainLimitEnv } from './scenario.mjs';
import * as tm from './telemetry-run.mjs';

/**
 * @param {{ gate: { env: Record<string, string> }, paths: Record<string, string>, scenario: any, dir: string, opt: any,
 *   faults: { env: Record<string, string> } | null }} o
 * @returns {Record<string, string>}
 */
export const runEnv = ({ gate, paths, scenario, dir, opt, faults }) => ({
  ...gate.env,
  POSTBOX_CLAUDE_RECORD: paths.streams,
  POSTBOX_KIRO_RECORD: paths.kiroStreams,
  POSTBOX_AGY_RECORD: paths.agyStreams,
  POSTBOX_CODEX_RECORD: paths.codexStreams,
  ...tm.telemetryEnv(scenario, dir, opt),
  ...skillsEnv(scenario),
  ...chainLimitEnv(scenario), // the scenario’s `- chain-limit:` (#508), for the Postbox this run starts and restarts
  ...noGithubEnv(scenario, dir), // every run’s agents have no gh login and no network git, unless `- github: real` says so
  ...gitRemoteEnv(scenario, dir), // `- seed: git-remote`’s guards (#305): the agents’ git reaches no network remote, and their gh is a fake
  ...faults?.env,
});

/** `- skills: off` (#206): Postbox starts with no skills of its own for its agents, for a baseline. */
export const skillsEnv = (scenario) => (scenario.skills === 'off' ? { POSTBOX_AGENT_SKILLS: 'off' } : {});
