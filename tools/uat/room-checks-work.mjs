// The Work ledger’s checks (#132): what the turns’ streams changed and ran, against what Work shows. Part of
// tools/uat/room-checks.mjs’s CHECKS, outside it at its size ceiling.

import { claudeSessionOf, toolCalls } from './room-checks-tools.mjs';

const ledgerEntries = (f) => Object.values(f.state?.work ?? {}).flat();
/**
 * The turns’ streams of sessions the state still has (#729). Deleting a conversation removes its sessions, its cards
 * and its steps, and its Work ledger goes with it, since Work is kept by conversation, but its turns’ stream files
 * stay, and only the Claude Code session id in their init ties them to a session. So a check that compares the
 * streams with the state reads them through this. A stream with no session id is kept: it can’t be shown erased. A
 * session keeps only its current id, so a live session whose id Postbox reset (Claude Code had lost it) loses its
 * turns from before the reset here.
 */
export const keptStreams = (f) => splitStreams(f).kept;
/** The turns’ streams of erased sessions: the ones keptStreams leaves out. */
export const erasedStreams = (f) => splitStreams(f).erased;

/** A session that has run a turn: one ends with finishedAt set, and a turn’s result sets lastModel. */
const hasRun = (se) => typeof se?.finishedAt === 'number' || (typeof se?.lastModel === 'string' && !!se.lastModel);

function splitStreams(f) {
  const sessions = Object.values(f.state?.sessions ?? {});
  // A state with a session that ran a turn but has no id, such as one saved before sessions kept them, can’t tell an
  // erased stream from a live one, so every stream is kept. A session that never ran a turn has no id to hold, so
  // sessions like that alone, or none at all once every conversation is deleted, still split the streams.
  if (sessions.some((se) => hasRun(se) && !se?.backendState?.claudeSessionId)) return { kept: [...(f.streams ?? [])], erased: [] };
  const held = new Set(sessions.map((se) => se?.backendState?.claudeSessionId).filter(Boolean));
  const kept = [];
  const erased = [];
  for (const s of f.streams ?? []) {
    const id = claudeSessionOf(s.events ?? []);
    (!id || held.has(id) ? kept : erased).push(s);
  }
  return { kept, erased };
}
/** The tools that change a file: its path is in the call’s input. */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export const WORK_CHECKS = [
  {
    id: 'work-files-match-stream',
    inputs: ['state', 'streams'],
    issue: 132,
    run: (f) => {
      // A file changed on a host is in Work as an edit step there, with no diff (server/ledger-remote.mjs, #120).
      const ledger = new Set(ledgerEntries(f).flatMap((e) => (e.kind === 'file' || e.kind === 'edit' ? [e.path] : [])));
      const edited = new Set(
        keptStreams(f).flatMap((s) =>
          toolCalls(s.events)
            .filter((c) => EDIT_TOOLS.has(c.name) && !c.denied && c.result && !c.result.is_error)
            .map((c) => c.input.file_path ?? c.input.notebook_path),
        ),
      );
      const missing = [...edited].filter((p) => p && !ledger.has(p));
      return missing.length
        ? [
            {
              title: 'A file an agent changed isn’t in the Work view',
              evidence: `Changed by an Edit or Write call, but not in the ledger: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'work-commands-match-stream',
    inputs: ['state', 'streams'],
    issue: 132,
    run: (f) => {
      const ledger = new Set(
        ledgerEntries(f)
          .filter((e) => e.kind === 'command')
          .map((e) => e.toolUseId),
      );
      const ran = keptStreams(f).flatMap((s) =>
        toolCalls(s.events)
          // A call Claude Code answered without running it, such as one left when Postbox stopped the turn, ran nothing.
          .filter((c) => c.name === 'Bash' && !c.denied && !c.rejected)
          .map((c) => ({ ...c, handle: s.handle })),
      );
      const missing = ran.filter((c) => !ledger.has(c.id));
      return missing.length
        ? [
            {
              title: 'A command an agent ran isn’t in the Work view',
              evidence: `${missing.length} of ${ran.length} Bash calls aren’t in the ledger, such as @${missing[0].handle}’s \`${String(missing[0].input.command ?? '').slice(0, 80)}\`.`,
            },
          ]
        : [];
    },
  },
];
