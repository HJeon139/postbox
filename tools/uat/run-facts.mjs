// What a UAT run knows as it goes (tools/uat-run.mjs): the state and events it read, the agents’ streams, the page’s
// console, the probes’ records, what its own Postbox printed and, in host mode, its hosts. The checks and triggers read
// it as facts.

import { newProbes } from './probes.mjs';
import { userSetup } from './run-files.mjs';

/**
 * A run’s facts before its first step.
 * @param {{ agentModels: string, agentEffort: string|null, page: { logs: any[] }, keyFrameOn: boolean, workspace: string, hr: any,
 *   postbox: { output: import('./postbox-output.mjs').PostboxOutput } }} o
 */
export function runFacts({ agentModels, agentEffort, page, keyFrameOn, workspace, hr, postbox }) {
  return {
    agentModels,
    agentEffort,
    state: null,
    threads: [],
    startPersonas: [],
    streams: [],
    kiroStreams: [],
    agyStreams: [],
    codexStreams: [],
    events: [],
    transcripts: [],
    console: page.logs,
    // The live record, so each check pass reads what it has printed by then (tools/uat/postbox-output.mjs).
    postboxOutput: postbox.output,
    apps: {},
    probes: { ...newProbes(), keyFrameOn },
    samples: [],
    ui: {},
    ...userSetup(workspace),
    ...(hr ? { hosts: hr.record } : {}),
  };
}
