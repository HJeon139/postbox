// The measurement triggers: deterministic predicates over a run’s facts, for what a run measures. tools/uat/triggers.mjs
// adds them to TRIGGERS, and reads them the same way.
// - erased-conversation-commands (#729): a room in which one of Postbox’s own checks could misread what the run did, a
//   conversation purged after its agents ran commands in it.
// - key-frame-measured (#508, designs/508/requirements.md, PF-1): whether a run measured what it was asked to. A run
//   with --measure-key-frame measures its seeded room’s key-to-frame times once it’s open (tools/uat/key-frame-run.mjs)
//   and records it in facts.probes.keyFrame. The trigger says only that the measurement ran and its report was
//   written; the report, not the trigger, judges the numbers.

import { toolCalls } from '../../server/room-checks-tools.mjs';
import { erasedStreams } from '../../server/room-checks-work.mjs';
import { deleteWindows } from './checks-assets.mjs';

/**
 * A conversation deleted past its Undo, whose agents’ turns ran Bash calls in Claude Code sessions no session in the
 * state holds any more (#729): the room in which work-commands-match-stream once reported the erased conversation’s
 * commands as missing from Work.
 */
function erasedCommands(f) {
  const erased = erasedStreams(f);
  return deleteWindows(f.probes?.conversation)
    .filter((w) => w.purged)
    .flatMap((w) => {
      const handles = new Set(w.handles ?? []);
      const ran = erased
        .filter((s) => handles.has(s.handle))
        .flatMap((s) =>
          toolCalls(s.events)
            .filter((c) => c.name === 'Bash')
            .map(() => s.handle),
        );
      if (!ran.length) return [];
      return [
        {
          at: w.until,
          evidence: `“${w.title ?? w.threadId}” was purged with ${ran.length} Bash call${ran.length === 1 ? '' : 's'} in its turns (by @${[...new Set(ran)].join(', @')}), whose sessions are gone.`,
        },
      ];
    });
}

/**
 * The run’s measurements of its own rooms that wrote a report: of a conversation the run is testing, over at least
 * one key.
 * @param {any} f
 */
function measuredRooms(f) {
  const threads = f.threads ?? [];
  return (f.probes?.keyFrame ?? []).filter((m) => threads.includes(m.threadId) && m.keys > 0 && typeof m.report === 'string' && m.report);
}

export const MEASURE_TRIGGERS = {
  'erased-conversation-commands': {
    issue: 729,
    says: 'a conversation was purged after its agents ran commands in it',
    recorded: (f) => !!f.state && Array.isArray(f.streams) && Array.isArray(f.probes?.conversation),
    run: erasedCommands,
  },
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
