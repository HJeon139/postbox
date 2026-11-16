// A finished UAT run’s turns, read from its recorded streams: each harness records a turn in its own format, and this
// gives every turn the same three facts: its model requests, the input tokens its harness reports, and its tool calls
// in order. tools/uat/inbox-measures.mjs counts from them.

import fs from 'node:fs';
import path from 'node:path';

/** A tool’s name without what a harness puts before it, so one name counts the same on every harness. */
export const toolName = (/** @type {unknown} */ name) => String(name ?? '').replace(/^(mcp__postbox__|@postbox\/|postbox[./]|pb\.)/, '');

/** The first number in a list of values that is one. */
const numberOr = (/** @type {unknown[]} */ ...values) => /** @type {number} */ (values.find((v) => Number.isFinite(v)) ?? 0);

/** A Claude Code turn’s stream: its model requests, the input tokens it reports, and its tool calls in order. */
function claudeTurn(/** @type {any[]} */ lines) {
  const events = lines.map((l) => l.event ?? l.line ?? l);
  const assistant = events.filter((e) => e.type === 'assistant');
  const usage = events.find((e) => e.type === 'result')?.usage ?? {};
  return {
    requests: new Set(assistant.map((e) => e.message?.id)).size,
    input: numberOr(usage.input_tokens) + numberOr(usage.cache_read_input_tokens) + numberOr(usage.cache_creation_input_tokens),
    tools: assistant.flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => toolName(c.name))),
  };
}

/** A Codex turn’s stream. Its token counts run for the whole thread, so `before` is the thread’s total at the last turn. */
function codexTurn(/** @type {any[]} */ lines, /** @type {Map<string, number>} */ before) {
  const usage = lines.filter((e) => e.method === 'thread/tokenUsage/updated');
  const last = usage.at(-1)?.params;
  const total = numberOr(last?.tokenUsage?.total?.inputTokens);
  const input = total - (before.get(last?.threadId) ?? 0);
  if (last) before.set(last.threadId, total);
  const started = lines.filter((e) => e.method === 'item/started').map((e) => e.params?.item ?? {});
  return {
    requests: usage.length,
    input: last ? input : null,
    tools: started
      .filter((it) => it.type === 'mcpToolCall' || it.type === 'commandExecution')
      .map((it) => (it.type === 'mcpToolCall' ? toolName(it.tool) : 'shell')),
  };
}

/**
 * An Antigravity turn’s stream. Its input is each model call’s, added up: the result’s usage counts the whole
 * conversation so far, so a later turn’s would hold every turn before it (agyTokens in tools/uat/room-checks-agy.mjs).
 */
export function agyTurn(/** @type {any[]} */ lines) {
  const steps = lines.map((e) => e.step_update).filter(Boolean);
  const calls = steps.filter((s) => s.step_type === 'agent_response' && s.state === 'DONE');
  const used = calls.map((s) => s.usage).filter(Boolean);
  return {
    requests: calls.length,
    input: used.length ? used.reduce((n, u) => n + numberOr(u.input_tokens) + numberOr(u.cache_read_tokens), 0) : null,
    tools: steps
      .filter((s) => s.step_type === 'tool' && s.state === 'ACTIVE')
      .map((s) => (s.tool_name === 'call_mcp_tool' ? toolName(s.tool_info?.parameters?.ToolName) : String(s.tool_name))),
  };
}

/** A Kiro turn’s stream. Kiro reports no token counts and no model requests. */
function kiroTurn(/** @type {any[]} */ lines) {
  const calls = lines.map((e) => e.data?.update).filter((u) => u?.sessionUpdate === 'tool_call');
  return { requests: null, input: null, tools: calls.map((u) => toolName(String(u.title ?? u.kind).split(/[ :(]/)[0])) };
}

/** A file’s lines as JSON, without any that don’t parse: a stream cut off mid-write ends in half a line. */
export const jsonLines = (/** @type {string} */ file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });

/** The files in a folder whose names match, in order, or none when the folder isn’t there. */
export const filesIn = (/** @type {string} */ dir, /** @type {RegExp} */ like) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => like.test(f))
        .sort()
        .map((f) => path.join(dir, f))
    : [];

/**
 * A run’s turns, oldest first, from its recorded streams: `<when it started>-<handle>.jsonl`, in a folder per harness.
 * @param {string} dir  the run’s folder
 */
export function turnsIn(dir) {
  const codexBefore = new Map();
  const read = { '': claudeTurn, codex: (/** @type {any[]} */ l) => codexTurn(l, codexBefore), agy: agyTurn, kiro: kiroTurn };
  const names = { '': 'Claude Code', codex: 'Codex', agy: 'Antigravity', kiro: 'Kiro' };
  return Object.entries(read)
    .flatMap(([sub, turn]) =>
      filesIn(path.join(dir, 'streams', sub), /^\d+-.+\.jsonl$/).map((file) => {
        const [started, handle] = path.basename(file, '.jsonl').split(/-(.+)/);
        return { handle, started: Number(started), harness: names[sub], ...turn(jsonLines(file)) };
      }),
    )
    .sort((a, b) => a.started - b.started);
}
