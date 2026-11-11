// Codex’s app-server items, read into the harness-event contract (server/harness-events.mjs): a command, an MCP call,
// each file a change touches, a web search and a thought, each when it starts and with what it returned when it
// completes (recorded: tests/fixtures/codex-app-server/ledger-edits.jsonl). A fileChange can change several files: each
// is a call of its own, `<item id>:<index>`. An item that completes without having started is told then too. Moved
// from work-calls.mjs’s codexWork, which told the work ledger alone while codex.mjs built the steps.

import { readFileSync } from 'node:fs';
import { beforePatch, unwrapShell } from './work-calls.mjs';

/** A file’s text, or null when it can’t be read. */
const readText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Gone or unreadable: the ledger keeps the copy it read when the change started.
    return null;
  }
};

/** What an MCP tool returned, as text. */
const mcpText = (item) =>
  item.error?.message ??
  (Array.isArray(item.result?.content)
    ? item.result.content
        .map((c) => (typeof c?.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n')
    : '');

/** The tool’s own record of a file before a change, as Claude Code gives it (originalFile), when Codex’s says enough. */
function originalOf(change, read) {
  if (change.kind?.type === 'add') return { type: 'create', originalFile: null };
  if (change.kind?.type !== 'update' || change.kind.move_path || typeof change.diff !== 'string') return null;
  const after = read(change.path);
  const before = after === null ? null : beforePatch(after, change.diff);
  return before === null ? null : { originalFile: before };
}

/**
 * The calls an item makes, when it starts. @param {(e: any) => void} emit @param {any} item
 */
export function itemStarted(emit, item) {
  if (!item?.id) return;
  if (item.type === 'commandExecution') emit({ kind: 'tool_call', id: item.id, name: 'Bash', input: { command: unwrapShell(item.command) }, final: true });
  else if (item.type === 'mcpToolCall')
    emit({ kind: 'tool_call', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {}, final: true });
  else if (item.type === 'webSearch')
    emit({ kind: 'tool_call', id: item.id, name: 'WebSearch', input: item.query ? { query: item.query } : {}, final: Boolean(item.query) });
  else if (item.type === 'reasoning') emit({ kind: 'thinking', text: '', block: item.id });
  else if (item.type === 'fileChange')
    (item.changes ?? []).forEach((/** @type {any} */ c, /** @type {number} */ i) => {
      if (typeof c?.path === 'string' && c.path)
        emit({ kind: 'tool_call', id: `${item.id}:${i}`, name: c.kind?.type === 'add' ? 'Write' : 'Edit', input: { file_path: c.path }, final: true });
    });
}

/**
 * What an item returned, when it completes. @param {(e: any) => void} emit @param {any} item
 * @param {(path: string) => string|null} [read]  a file’s text, for what a change replaced
 */
export function itemCompleted(emit, item, read = readText) {
  if (!item?.id) return;
  itemStarted(emit, item);
  const isError = item.status !== 'completed';
  if (item.type === 'commandExecution') {
    const failed = isError || (Number.isInteger(item.exitCode) && item.exitCode !== 0);
    const text = failed && Number.isInteger(item.exitCode) ? `Exit code ${item.exitCode}` : '';
    emit({ kind: 'tool_result', id: item.id, isError: failed, text, result: { stdout: String(item.aggregatedOutput ?? '') } });
  } else if (item.type === 'mcpToolCall') emit({ kind: 'tool_result', id: item.id, isError, text: mcpText(item) });
  else if (item.type === 'webSearch') emit({ kind: 'tool_result', id: item.id, isError });
  else if (item.type === 'reasoning') {
    emit({
      kind: 'thinking',
      text: []
        .concat(item.summary ?? [])
        .filter((x) => typeof x === 'string')
        .join('\n'),
      block: item.id,
    });
    emit({ kind: 'thinking_end', block: item.id });
  } else if (item.type === 'fileChange')
    (item.changes ?? []).forEach((/** @type {any} */ c, /** @type {number} */ i) => {
      if (typeof c?.path === 'string' && c.path) emit({ kind: 'tool_result', id: `${item.id}:${i}`, isError, result: originalOf(c, read) });
    });
}
