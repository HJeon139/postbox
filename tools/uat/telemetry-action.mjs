// The tester’s telemetry action (designs/telemetry-persona.md, U1), as tools/uat/tester.mjs offers it; the runner
// does it with tools/uat/telemetry-run.mjs, telemetryAction.

export const TELEMETRY_ACTION = {
  type: 'object',
  description: 'telemetry: what to do with telemetry, from the ⋯ menu, a reaction, or the Telemetry view.',
  properties: {
    do: { enum: ['record', 'stop', 'react', 'report', 'leave_out', 'save', 'file'] },
    emoji: { enum: ['👍', '👎', '🚩', '❓', '✅'], description: 'react: the reaction, on the item given as item.' },
    history: { type: 'boolean', description: 'report: include the room’s history from before recording started.' },
    line: { type: 'integer', description: 'leave_out: the line’s number in the report.' },
    finding: { type: 'integer', description: 'file: which finding of the newest saved report, from 0.' },
  },
  required: ['do'],
};
