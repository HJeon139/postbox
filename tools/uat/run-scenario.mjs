// The scenario a run plays, from its options (moved out of tools/uat-run.mjs, which is at its length ceiling): its file
// read and parsed, host mode applied, and the run refused before anything starts when it would need --compat or
// --release, or names a trigger that doesn’t exist.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostMode } from './hosts-options.mjs';
import { compatBackends, parseScenario, releaseGate } from './scenario.mjs';
import { unknownTriggers } from './triggers.mjs';

/**
 * @param {Record<string, any>} opt  the runner’s options  @param {string} root  the checkout
 * @returns {{ name: string, hosts: any[], placement: Record<string, string>, scenario: any, gate: { error: string|null, env: Record<string, string> } }}
 */
export function runScenario(opt, root) {
  const scenarioFile = existsSync(opt.scenario) ? opt.scenario : join(root, 'tests', 'uat', 'e2e', 'scenarios', `${opt.scenario}.md`);
  const name = opt.scenario.replace(/^.*\//, '').replace(/\.md$/, '');
  // Host mode (#120): agents on other machines over ssh (--host), Claude Code only (tools/uat/hosts-options.mjs).
  const { hosts, placement, scenario } = hostMode(opt, name, parseScenario(readFileSync(scenarioFile, 'utf8')));
  const other = compatBackends(scenario);
  if (other.length && !opt.compat && !opt.release)
    throw new Error(
      `This scenario puts agents on ${other.join(' and ')}, so it’s a compatibility run, which runs only when asked: it uses that harness’s credits, and a regular pass is Claude only. Pass --compat to run it.`,
    );
  // A release-only backend (none today: tools/uat/scenario.mjs) runs only in a release run; otherwise Postbox starts
  // without it, so the tester can’t put an agent on it from a sheet either.
  const gate = releaseGate(scenario, { release: opt.release });
  if (gate.error) throw new Error(gate.error);
  const unknown = unknownTriggers(scenario);
  if (unknown.length) throw new Error(`This scenario names triggers that don’t exist: ${unknown.join(', ')}. See tools/uat/triggers.mjs.`);
  return { name, hosts, placement, scenario, gate };
}
