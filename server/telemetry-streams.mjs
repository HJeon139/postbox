// What one recorded turn’s raw stream says, as a telemetry report’s values (designs/telemetry-persona.md, R12, Turn):
// tool calls by class, errors, refusals, repeated-call loops and the tokens spent after the first one (Li et al. 2026),
// subagents, background jobs, tokens and cost. Read from Claude Code’s stream-json; a stream from another backend gives
// what its lines share (none of it, for now), and the turn still counts as recorded.

import { BUILT_INS, POSTBOX_TOOLS, PROGRAMS } from '../shared/telemetry-vocab.mjs';

/** The same tool with the same input this many times in a row is a loop. */
export const LOOP = 3;

/** A Bash command’s program, from the fixed list; anything else is “other”. */
export function programOf(command) {
  const words = String(command ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => !/^\w+=/.test(w) && w !== 'sudo' && w !== 'env');
  const first = (words[0] ?? '').split('/').pop() ?? '';
  return PROGRAMS.includes(first) ? first : 'other';
}

/** A tool call’s class, always from the vocabulary: a Postbox tool, a built-in, a command by program, MCP, or other. */
export function callClass(name, input) {
  const n = String(name ?? '');
  if (n.startsWith('mcp__postbox__')) return POSTBOX_TOOLS.includes(n.slice(14)) ? `postbox:${n.slice(14)}` : 'other';
  if (n.startsWith('mcp__')) return 'mcp';
  if (n === 'Bash') return `command:${programOf(input?.command)}`;
  return BUILT_INS.includes(n) ? n : 'other';
}

/**
 * @param {any[]} events  one turn’s stream @param {number} [startedAt]
 * @returns {{ firstOutputMs: number|null, tokensIn: number, tokensOut: number, costUsd: number, tools: Record<string, number>,
 *   toolErrors: number, refusals: number, loops: number, tokensAfterLoop: number, subagents: number, jobs: number }}
 */
export function turnStats(events, startedAt) {
  /** @type {Record<string, number>} */
  const tools = {};
  /** @type {{ firstOutputMs: number|null, tokensIn: number, tokensOut: number, costUsd: number, toolErrors: number, refusals: number, loops: number, tokensAfterLoop: number, subagents: number, jobs: number }} */
  const s = { firstOutputMs: null, tokensIn: 0, tokensOut: 0, costUsd: 0, toolErrors: 0, refusals: 0, loops: 0, tokensAfterLoop: 0, subagents: 0, jobs: 0 };
  let run = { sig: '', n: 0 };
  let looping = false;
  for (const e of events ?? []) {
    if (e?.type === 'assistant') {
      const at = Date.parse(e.timestamp ?? '');
      if (s.firstOutputMs === null && Number.isFinite(at) && Number.isFinite(startedAt)) s.firstOutputMs = Math.max(0, at - /** @type {number} */ (startedAt));
      if (looping) s.tokensAfterLoop += e.message?.usage?.output_tokens ?? 0;
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type !== 'tool_use') continue;
        const c = callClass(b.name, b.input);
        tools[c] = (tools[c] ?? 0) + 1;
        if (b.name === 'Task' || b.name === 'Agent') s.subagents++;
        if (b.input?.run_in_background === true) s.jobs++;
        const sig = `${b.name}\n${JSON.stringify(b.input ?? {})}`;
        run = sig === run.sig ? { sig, n: run.n + 1 } : { sig, n: 1 };
        if (run.n === LOOP) {
          s.loops++;
          looping = true;
        }
      }
    } else if (e?.type === 'user') {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) if (b?.type === 'tool_result' && b.is_error === true) s.toolErrors++;
    } else if (e?.type === 'result') {
      const u = e.usage ?? {};
      s.tokensIn += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      s.tokensOut += u.output_tokens ?? 0;
      s.costUsd = Math.round((s.costUsd + (e.total_cost_usd ?? 0)) * 1e6) / 1e6;
      s.refusals += Array.isArray(e.permission_denials) ? e.permission_denials.length : 0;
    }
  }
  return { ...s, tools };
}
