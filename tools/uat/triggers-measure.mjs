// The measurement triggers: deterministic predicates over a run’s facts, for what a run measures. tools/uat/triggers.mjs
// adds them to TRIGGERS, and reads them the same way.
// - key-frame-measured (#508, designs/508/requirements.md, PF-1): whether a run measured what it was asked to. A run
//   with --measure-key-frame measures its seeded room’s key-to-frame times once it’s open (tools/uat/key-frame-run.mjs)
//   and records it in facts.probes.keyFrame. The trigger says only that the measurement ran and its report was
//   written; the report, not the trigger, judges the numbers.

/**
 * The run’s measurements of its own rooms that wrote a report: of a conversation the run is testing, over at least
 * one key. It doesn’t judge the numbers, the report does: on a fast machine most keys have no Event Timing entry.
 * @param {any} f
 */
function measuredRooms(f) {
  const threads = f.threads ?? [];
  const wrote = (m) => typeof m.report === 'string' && m.report !== '';
  return (f.probes?.keyFrame ?? []).filter((m) => threads.includes(m.threadId) && Number.isInteger(m.keys) && m.keys > 0 && wrote(m));
}

export const MEASURE_TRIGGERS = {
  'key-frame-measured': {
    issue: 508,
    requirements: ['PF-1'],
    says: 'the key-to-frame tool measured the run’s seeded room and wrote its report',
    // Only a run with --measure-key-frame on could show it: every other one, older ones too, has keyFrame empty.
    recorded: (f) => f.probes?.keyFrameOn === true,
    run: (f) =>
      measuredRooms(f).map((m) => ({
        at: Number.isFinite(m.at) ? m.at : null,
        evidence: `Measured ${m.keys} keys in ${m.threadId}’s ${m.items.toLocaleString('en-US')} items, and wrote ${m.report}.`,
      })),
  },
};
