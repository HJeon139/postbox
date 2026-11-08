// What a UAT run knows as it goes (tools/uat-run.mjs): the state and events it read, the agents’ streams, the page’s
// console, the probes’ records and, in host mode, its hosts. The checks and triggers read it as facts.

import { newProbes } from './probes.mjs';
import { userSetup } from './run-files.mjs';

/**
 * A run’s facts before its first step.
 * @param {{ agentModels: string, agentEffort: string|null, page: { logs: any[] }, keyFrameOn: boolean, workspace: string, hr: any }} o
 */
export function runFacts({ agentModels, agentEffort, page, keyFrameOn, workspace, hr }) {
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
    apps: {},
    probes: { ...newProbes(), keyFrameOn },
    samples: [],
    ui: {},
    ...userSetup(workspace),
    ...(hr ? { hosts: hr.record } : {}),
  };
}
