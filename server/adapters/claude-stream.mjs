// Reads Claude Code’s stream-json output (claude -p --output-format stream-json --include-partial-messages), and the
// Agent SDK’s messages, which are the same events, into the harness-event contract (server/harness-events.mjs): text,
// thinking, tool calls and results, background work, refusals, context use and the turn’s end. What Postbox builds
// from them, the reply, the steps, the ledger’s calls and the ring, is built there, for every backend. Pure apart from
// the ctx calls, so recorded streams can test it.

import { HarnessEvents } from '../harness-events.mjs';
import { clip } from '../harness-tools.mjs';
import { contentBlocks } from './claude-content.mjs';
import { commandsOf, postboxServerStatus } from './claude-init.mjs';
import { addTokens, forkOf, resultTokens, sessionTotals, turnCost } from './claude-usage.mjs';

export { describePermission } from './claude-permission.mjs';
export { commandsOf }; // moved to claude-init.mjs; its importers keep this path

// Default context windows until a turn’s result reports the real one.
const WINDOWS = /** @type {[RegExp, number][]} */ ([[/^claude-(?:opus|sonnet|fable)-5/, 1_000_000]]);
export const windowFor = (model, fallback = 200_000) => WINDOWS.find(([re]) => re.test(String(model ?? '')))?.[1] ?? fallback;
// A call that goes on in the background returns at once with the job's id, and the job runs on (#129). Recorded on
// claude 2.1.296:
// - Bash with run_in_background: “Command running in background with ID: <id>. Output is being written to: <file>. …”,
//   with tool_use_result.backgroundTaskId (tests/fixtures/claude-code/background-*.jsonl);
// - Bash past its timeout: “Command did not complete within its 120s timeout and was moved to the background (ID: <id>).
//   Output is being written to: <file>. …” (background-moved.jsonl, from the HotpotQA UAT of 22 October 2026);
// - Monitor: “Monitor started (task <id>, expires in …)”, with tool_use_result.taskId (monitor.jsonl).
// A task_notification with the same task_id says it completed, failed, or was stopped; and the CLI waits for its jobs
// before it exits. Each is how its result starts: a file the agent reads, or a search, can hold the same words.
const BACKGROUND_ID =
  /^(?:Command running in background with ID: |Command did not complete within its \d+s timeout and was moved to the background \(ID: |Monitor started \(task )([\w-]+)/;
const BACKGROUND_FILE = /Output is being written to: (\S+?)\.?(?=\s|$)/;
// A subagent started in the background, or one a subagent starts (Claude Code runs those in the background), returns
// at once too, and works on until its task_notification (subagent-tree.jsonl).
const ASYNC_AGENT = /^Async agent launched/;

/** The text of a tool result, for the reason a step failed. */
const resultText = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === 'text')
          .map((c) => c.text)
          .join(' ')
      : '';

/** The share of the context window a request used, in percent. */
export function contextPercent(usage, window) {
  if (!usage || !window) return null;
  const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return Math.min(100, (used / window) * 100);
}

/**
 * Feeds one stream to a turn context: reads Claude Code’s events into the harness-event contract
 * (server/harness-events.mjs), which builds the reply, the steps, the ledger’s calls and the ring from them.
 * @param {any} ctx  the turn context (see server/adapters/adapter.mjs)
 * @param {{ contextWindow?: number, now?: () => number, effort?: string|null }} [opts]  effort: what the turn was
 *   started with, reported with the model, since the stream doesn’t say
 */
export function createStreamMapper(ctx, { contextWindow = 200_000, now = Date.now, effort = null } = {}) {
  const events = new HarnessEvents(ctx, { now });
  /** @type {any} */
  const st = {
    sessionId: null,
    before: ctx.state?.spent ?? null, // the session’s totals when the turn started (claude-usage.mjs)
    fork: forkOf(ctx.state), // the session this turn forks, if it does: its total includes that one’s
    model: null,
    answered: null, // the model the last assistant message came from
    contextWindow,
    effort,
    result: null,
    streamed: new Set(), // message ids whose text arrived as deltas
    thoughtMessages: new Set(), // message ids whose thinking arrived as deltas
    blocks: new Map(), // content block index → { type, id, name, json }
    vcsCwd: null, // the folder of the latest commit or push Claude Code reported
    // This process’s usage key: a turn can run more than one process (a fork retried), and each reports its own
    // running totals.
    key: Math.random().toString(36).slice(2),
  };
  const emit = events.event;
  /** Handles one parsed line of the stream. @param {any} e */
  function push(e) {
    if (!e || typeof e !== 'object') return;
    const parent = e.parent_tool_use_id;
    if (parent && e.type !== 'user') return subagentEvent(emit, st, parent, e);
    if (e.type === 'system') return systemEvent(ctx, emit, st, e);
    if (e.type === 'stream_event') return streamEvent(emit, st, e.event ?? {});
    if (e.type === 'assistant') return assistantEvent(ctx, emit, st, e);
    if (e.type === 'user') return userEvent(emit, st, e, parent);
    if (e.type === 'result') return resultEvent(ctx, emit, st, e);
  }
  return {
    push,
    /**
     * The subagent behind a permission prompt (#66), by the SDK’s agent id (a task id, as a refusal’s agent_id) or by
     * the call’s tool_use id. The CLI’s prompt tool sends only the call’s id (recorded:
     * tests/fixtures/claude-code/permission-subagent.jsonl), and the subagent’s tool_use streams before the prompt,
     * so the call is known by then, with the subagent that made it. Null for the agent’s own calls.
     * @param {{ agentId?: string|null, toolUseId?: string|null }} ids
     */
    who: (ids) => events.who(ids),
    get sessionId() {
      return st.sessionId;
    },
    get model() {
      return st.model;
    },
    get contextWindow() {
      return st.contextWindow;
    },
    /** What the adapter saves when the turn ends: the window, the model, and the session’s totals (claude-usage.mjs). */
    get endState() {
      return { contextWindow: st.contextWindow, model: st.model ?? undefined, ...(st.spent ? { spent: st.spent } : {}) };
    },
    get result() {
      return st.result;
    },
    get lastUuid() {
      return st.lastUuid ?? null;
    },
  };
}

const isToolBlock = (/** @type {any} */ b) => b?.type === 'tool_use' || b?.type === 'server_tool_use' || b?.type === 'mcp_tool_use';

/** Events from inside a subagent carry the call that started it; its calls, words and thoughts are its own (#73). */
function subagentEvent(/** @type {Function} */ emit, /** @type {any} */ st, /** @type {string} */ parent, /** @type {any} */ e) {
  if (e.type === 'assistant') {
    for (const b of contentBlocks(e.message?.content))
      if (isToolBlock(b)) emit({ kind: 'tool_call', id: b.id, name: b.name, input: b.input, final: true, parent });
      else if (b.type === 'text') emit({ kind: 'text', text: b.text, parent });
      else if (b.type === 'thinking') emit({ kind: 'thinking', text: b.thinking, whole: true, parent });
    return;
  }
  const ev = e.type === 'stream_event' ? e.event : null;
  if (ev?.type === 'message_start') {
    const pct = contextPercent(ev.message?.usage, st.contextWindow);
    if (pct !== null) emit({ kind: 'context', percent: pct, parent });
  } else if (ev?.type === 'content_block_start') {
    const b = ev.content_block ?? {};
    if (b.type === 'thinking' || b.type === 'redacted_thinking') emit({ kind: 'thinking', text: '', parent });
    else if (b.type === 'text') emit({ kind: 'text', text: '', parent });
    else if (isToolBlock(b)) emit({ kind: 'tool_call', id: b.id, name: b.name, input: b.input, parent });
  }
}

/** The session’s own events: its start, its commands, refusals, background work, a commit and a compaction. */
function systemEvent(/** @type {any} */ ctx, /** @type {Function} */ emit, /** @type {any} */ st, /** @type {any} */ e) {
  switch (e.subtype) {
    case 'init':
      st.sessionId = e.session_id ?? st.sessionId;
      st.model = e.model ?? st.model;
      // MCP servers with their status, for the persona sheet (#59); the model and effort the turn runs with (#60).
      ctx.reported?.({
        ...(Array.isArray(e.mcp_servers) ? { mcpServers: e.mcp_servers } : {}),
        ...(e.model ? { model: e.model } : {}),
        ...(st.effort ? { effort: st.effort } : {}),
      });
      postboxServerStatus(ctx, e.mcp_servers); // Postbox’s own server failed: shown, and told next turn (#1161)
      if (Array.isArray(e.slash_commands)) ctx.commands?.(commandsOf(e)); // its skills and commands, for the / menu (#67)
      return emit({ kind: 'status', state: 'think', step: 'Thinking' });
    case 'commands_changed': // the list changed mid-session: it replaces the one init gave (sdk.d.ts)
      if (Array.isArray(e.commands)) ctx.commands?.(e.commands);
      return;
    case 'status':
      if (e.status === 'compacting') emit({ kind: 'status', step: 'Summarizing the conversation' });
      return;
    case 'permission_denied':
      return emit({ kind: 'refused', ...refusalOf(e) });
    case 'task_notification': // a background command or subagent ended, maybe long after its call returned (#129)
      return emit({
        kind: 'tool_end',
        job: e.task_id,
        id: e.tool_use_id,
        status: e.status,
        summary: typeof e.summary === 'string' ? e.summary : '',
        outputFile: typeof e.output_file === 'string' ? e.output_file : null,
      });
    case 'task_started':
      if (e.task_id && e.tool_use_id) emit({ kind: 'task', task: e.task_id, id: e.tool_use_id });
      return;
    case 'task_progress':
      if (e.tool_use_id && e.description) emit({ kind: 'progress', parent: e.tool_use_id, text: e.description });
      return;
    case 'vcs_state_changed': // a commit or push (recorded: ledger-push.jsonl); its tool result names the commit
      if (typeof e.cwd === 'string') st.vcsCwd = e.cwd;
      return;
    case 'task_summary':
      if (e.detail) emit({ kind: 'progress', text: e.detail });
      return;
    case 'compact_boundary': {
      const total = e.compact_metadata?.pre_tokens ?? 0;
      // How much survives isn’t reported; the next request’s usage shows it, so start from a summary’s worth.
      const kept = Math.min(total, Math.round(st.contextWindow * 0.05));
      return emit({ kind: 'compaction', kept, total, summary: e.compact_metadata?.summary ?? 'Claude Code summarized the earlier conversation to make room.' });
    }
  }
}

/** A refusal, as the stream or the result reports it. @param {any} d */
const refusalOf = (d) => ({
  id: d.tool_use_id,
  tool: d.tool_name,
  input: d.tool_input,
  agentId: d.agent_id ?? null,
  reason: d.message ?? d.decision_reason,
  reasonType: d.decision_reason_type,
});

/** Partial messages (--include-partial-messages): text and thinking as they stream, and each call as it starts. */
function streamEvent(/** @type {Function} */ emit, /** @type {any} */ st, /** @type {any} */ ev) {
  const block = `${st.current}:${ev.index}`;
  if (ev.type === 'message_start') {
    st.blocks.clear();
    st.lastUsage = ev.message?.usage ?? st.lastUsage;
    const pct = contextPercent(ev.message?.usage, st.contextWindow);
    if (pct !== null) emit({ kind: 'context', percent: pct });
    if (ev.message?.id) st.current = ev.message.id;
  } else if (ev.type === 'content_block_start') {
    const b = ev.content_block ?? {};
    st.blocks.set(ev.index, { type: b.type, id: b.id, name: b.name, json: '' });
    if (b.type === 'thinking' || b.type === 'redacted_thinking') emit({ kind: 'thinking', text: '', block });
    else if (b.type === 'text') emit({ kind: 'text', text: '', block });
    else if (isToolBlock(b)) emit({ kind: 'tool_call', id: b.id, name: b.name, input: b.input });
  } else if (ev.type === 'content_block_delta') {
    const d = ev.delta ?? {};
    const blk = st.blocks.get(ev.index);
    if (d.type === 'text_delta' && d.text) {
      if (st.current) st.streamed.add(st.current);
      emit({ kind: 'text', text: d.text, block });
    } else if (d.type === 'thinking_delta' && d.thinking && blk) {
      if (st.current) st.thoughtMessages.add(st.current);
      emit({ kind: 'thinking', text: d.thinking, block });
    } else if (d.type === 'input_json_delta' && blk) blk.json += d.partial_json ?? '';
  } else if (ev.type === 'content_block_stop') blockStop(emit, st.blocks.get(ev.index), block);
}

/** A block ended: a thought is whole, and a call’s input is known. @param {Function} emit @param {any} blk @param {string} block */
function blockStop(emit, blk, block) {
  if (blk?.type === 'thinking') emit({ kind: 'thinking_end', block });
  if (!blk?.id || !blk.json) return;
  try {
    emit({ kind: 'tool_call', id: blk.id, name: blk.name, input: JSON.parse(blk.json) });
  } catch {
    // A partial input that doesn’t parse keeps the first label.
  }
}

/** A whole assistant message: its calls with their final input, and text and thinking that didn’t stream. */
function assistantEvent(/** @type {any} */ ctx, /** @type {Function} */ emit, /** @type {any} */ st, /** @type {any} */ e) {
  // The last top-level assistant message is where this turn ends in the transcript: a fork point.
  if (e.uuid) st.lastUuid = e.uuid;
  const m = e.message ?? {};
  // The model that actually answered (#60). Claude Code’s own messages, such as an interruption, say “<synthetic>”.
  if (typeof m.model === 'string' && m.model && !m.model.startsWith('<') && m.model !== st.answered) {
    st.answered = m.model;
    ctx.reported?.({ model: m.model });
  }
  const blocks = contentBlocks(m.content);
  blocks.forEach((b, i) => {
    if (isToolBlock(b)) emit({ kind: 'tool_call', id: b.id, name: b.name, input: b.input, final: true });
    else if (b.type === 'thinking' && b.thinking && !st.thoughtMessages.has(m.id)) emit({ kind: 'thinking', text: b.thinking, whole: true });
    else if (b.type === 'text' && b.text && !st.streamed.has(m.id)) emit({ kind: 'text', text: b.text, block: `${m.id}:whole:${i}` });
  });
  emit({ kind: 'message_end', calledTools: blocks.some(isToolBlock) });
}

/** Tool results: each call ends, or goes on in the background (#129, #73), and the work ledger hears what it returned. */
function userEvent(/** @type {Function} */ emit, /** @type {any} */ st, /** @type {any} */ e, /** @type {string|undefined} */ parent) {
  const results = contentBlocks(e.message?.content).filter((b) => b.type === 'tool_result');
  for (const b of results) {
    const text = resultText(b.content);
    // tool_use_result is the tool’s own record (a file before an edit, a command’s output, a commit), one per message.
    const result = results.length === 1 ? (e.tool_use_result ?? null) : null;
    emit({
      kind: 'tool_result',
      id: b.tool_use_id,
      isError: b.is_error === true,
      text,
      result,
      vcsCwd: st.vcsCwd,
      background: backgroundOf(text, e.tool_use_result),
      parent,
    });
  }
}

/**
 * Whether a result says its call went on in the background: a job, named by its text (the fallback is the structured
 * record, one per message), or a subagent. @param {string} text @param {any} structured
 */
function backgroundOf(text, structured) {
  const named = BACKGROUND_ID.exec(String(text).trimStart())?.[1];
  const job = String(named ?? structured?.backgroundTaskId ?? structured?.taskId ?? '');
  return { ...(job ? { job, named: Boolean(named), outputFile: BACKGROUND_FILE.exec(text)?.[1] ?? null } : {}), agent: ASYNC_AGENT.test(text) };
}

/** The turn’s end: its window, what it spent, refusals the stream didn’t report, and the contract’s turn_end. */
function resultEvent(/** @type {any} */ ctx, /** @type {Function} */ emit, /** @type {any} */ st, /** @type {any} */ e) {
  st.result = e;
  const usage = (st.model && e.modelUsage?.[st.model]) || Object.values(e.modelUsage ?? {})[0];
  if (usage?.contextWindow && usage.contextWindow !== st.contextWindow) {
    st.contextWindow = usage.contextWindow;
    const pct = contextPercent(st.lastUsage, st.contextWindow);
    if (pct !== null) emit({ kind: 'context', percent: pct });
  }
  // What this turn has spent so far: the result’s totals run for the session, so less where it stood (#295).
  st.spent = sessionTotals(e);
  st.tokens = addTokens(st.tokens ?? null, resultTokens(e));
  ctx.usage?.({ key: st.key, costUsd: turnCost(st.spent, st.before, st.fork), tokens: st.tokens });
  for (const d of e.permission_denials ?? []) emit({ kind: 'refused', ...refusalOf(d), fromResult: true });
  emit({ kind: 'turn_end', isError: e.is_error === true, text: typeof e.result === 'string' ? e.result : '' });
}

/** Why a finished stream failed, in words for the person, or null if it didn’t. */
export function resultError(result) {
  if (!result) return 'Claude Code ended without finishing the turn.';
  if (!result.is_error && result.subtype === 'success') return null;
  // The reasons Claude Code gives (result.errors), bounded: a failure that only says “hit an error” can’t be fixed.
  const reasons = (Array.isArray(result.errors) ? result.errors : [])
    .filter((e) => typeof e === 'string' && e.trim())
    .slice(0, 3)
    .map((e) => clip(e, 300));
  const why = reasons.length ? `: ${reasons.join('; ')}` : '.';
  if (result.subtype === 'error_max_turns') return 'The agent hit its turn limit before finishing.';
  if (result.subtype === 'error_during_execution') return `Claude Code hit an error while running the turn${why}`;
  const text = typeof result.result === 'string' && result.result.trim() ? result.result.trim() : null;
  return text ? clip(text, 400) : `Claude Code reported a failure (${result.subtype ?? 'unknown'})${why}`;
}

/**
 * Whether a fork failed because Claude Code can’t find the message it was asked to start at
 * (--resume-session-at, or the SDK’s resumeSessionAt): that message is no longer on the session’s chain.
 * `also` is more text to look in, such as stderr or an error the SDK threw. A turn that succeeded never counts,
 * whatever stderr says: its reply stands.
 */
export function forkPointMissing(result, also = '') {
  if (result && !result.is_error) return false;
  const said = [...(Array.isArray(result?.errors) ? result.errors : []), also].map(String).join('\n');
  return /No message found with message\.uuid/.test(said);
}
