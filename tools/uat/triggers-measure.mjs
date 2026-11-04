// The triggers for what a run measures of Postbox’s own checks: a room in which a check could misread what the run
// did. tools/uat/triggers.mjs adds them to TRIGGERS, and reads them the same way: deterministic predicates over the
// run’s facts.

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

export const MEASURE_TRIGGERS = {
  'erased-conversation-commands': {
    issue: 729,
    says: 'a conversation was purged after its agents ran commands in it',
    recorded: (f) => !!f.state && Array.isArray(f.streams) && Array.isArray(f.probes?.conversation),
    run: erasedCommands,
  },
};
