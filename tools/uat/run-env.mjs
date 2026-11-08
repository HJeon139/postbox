// The environment of the Postbox a UAT run starts and restarts (tools/uat-run.mjs): the gate’s, where each backend’s
// streams are recorded, and what the scenario sets.

import { gitRemoteEnv } from './git-remote.mjs';
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
  ...chainLimitEnv(scenario), // the scenario’s `- chain-limit:` (#508), for the Postbox this run starts and restarts
  ...gitRemoteEnv(scenario, dir), // `- seed: git-remote`’s guards (#305), so no git or gh in the run reaches anything real
  ...faults?.env,
});
