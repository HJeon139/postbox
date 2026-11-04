// Tool calls and results read from a room’s recorded Claude Code streams, outside room-checks.mjs at its size ceiling.

import { contentBlocks } from './adapters/claude-content.mjs';

/** Every tool call in a turn’s stream, with its result when the stream has it. @param {any[]} events */
export function toolCalls(events) {
  const results = new Map();
  for (const e of events)
    if (e.type === 'user') for (const c of contentBlocks(e.message?.content)) if (c?.type === 'tool_result') results.set(c.tool_use_id, c);
  const denied = new Set(events.filter((e) => e.type === 'result').flatMap((e) => (e.permission_denials ?? []).map((d) => d.tool_use_id)));
  // A call Claude Code answered without running it, such as { non_execution_kind: 'user-rejected' } once Postbox
  // stopped the turn. A call that ran and failed, such as a command that exited 1, has no such kind.
  const rejected = new Set(
    events
      .filter((e) => e.type === 'user')
      .flatMap((e) => (Array.isArray(e.tool_result_meta) ? e.tool_result_meta : []).filter((m) => m?.non_execution_kind).map((m) => m.id)),
  );
  return events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => contentBlocks(e.message?.content).filter((c) => c?.type === 'tool_use'))
    .map((c) => ({ id: c.id, name: c.name, input: c.input ?? {}, result: results.get(c.id) ?? null, denied: denied.has(c.id), rejected: rejected.has(c.id) }));
}

/** The Claude Code session a turn’s stream ran in, from its init. */
export const claudeSessionOf = (events) => events.find((e) => e?.type === 'system' && e.subtype === 'init')?.session_id ?? null;
