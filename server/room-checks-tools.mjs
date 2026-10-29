// Tool calls and results read from a room’s recorded Claude Code streams, outside room-checks.mjs at its size ceiling.

import { contentBlocks } from './adapters/claude-content.mjs';

/** Every tool call in a turn’s stream, with its result when the stream has it. @param {any[]} events */
export function toolCalls(events) {
  const results = new Map();
  for (const e of events)
    if (e.type === 'user') for (const c of contentBlocks(e.message?.content)) if (c?.type === 'tool_result') results.set(c.tool_use_id, c);
  const denied = new Set(events.filter((e) => e.type === 'result').flatMap((e) => (e.permission_denials ?? []).map((d) => d.tool_use_id)));
  return events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => contentBlocks(e.message?.content).filter((c) => c?.type === 'tool_use'))
    .map((c) => ({ id: c.id, name: c.name, input: c.input ?? {}, result: results.get(c.id) ?? null, denied: denied.has(c.id) }));
}
