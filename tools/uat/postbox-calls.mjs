// Every Postbox tool call in a run's recorded streams, with what Postbox answered: what the triggers read to see that a
// phase made an agent call Postbox (tools/uat/triggers.mjs).

import { POSTBOX_SERVER } from '../../server/adapters/setup.mjs';
import { resultText } from './trigger-facts.mjs';

const timeOf = (ts) => {
  const n = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Every Postbox tool call in the recorded streams, with what Postbox answered.
 * @param {{ handle: string, events: any[], started?: number }[]} streams
 * @returns {{ handle: string, name: string, input: any, at: number|null, error: boolean, text: string }[]}
 */
export function postboxCalls(streams) {
  const prefix = `mcp__${POSTBOX_SERVER}__`;
  const out = [];
  for (const s of streams ?? []) {
    const results = new Map();
    for (const e of s.events ?? [])
      if (e?.type === 'user')
        for (const b of Array.isArray(e.message?.content) ? e.message.content : []) if (b?.type === 'tool_result') results.set(b.tool_use_id, b);
    for (const e of s.events ?? []) {
      if (e?.type !== 'assistant') continue;
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type !== 'tool_use' || !String(b.name ?? '').startsWith(prefix)) continue;
        const r = results.get(b.id);
        out.push({
          handle: s.handle,
          name: String(b.name).slice(prefix.length),
          input: b.input ?? {},
          at: timeOf(e.timestamp) ?? (Number.isFinite(s.started) ? /** @type {number} */ (s.started) : null),
          error: r?.is_error === true,
          text: resultText(r),
        });
      }
    }
  }
  return out;
}
