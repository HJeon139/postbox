// Turns Claude Code’s stream-json output (claude -p --output-format stream-json --include-partial-messages)
// into Postbox’s turn context: reply text, activity steps, ring state, context use, subagents and
// compactions. Pure apart from the ctx calls, so recorded streams can test it (tests/claude-stream.test.mjs).

// Postbox’s own UI tools show up in the thread as what they make, so they aren’t listed as activity;
// nor is Claude Code loading tool definitions. They still name the step on the agent’s ring.
const QUIET =
  /^(?:mcp__postbox__(?:show_block|update_block|show_app|update_app|define_term|propose_agent|schedule_wake|wake_agent|permission_prompt|read_conversation)|ToolSearch|SubagentHandback)$/;
// How Postbox answers a call the person declined on a permission card (server/runtime.mjs): that’s their
// answer, not a refusal to show again.
const DECLINED = /^The person didn’t allow/;
// Default context windows until a turn’s result reports the real one.
const WINDOWS = /** @type {[RegExp, number][]} */ ([[/^claude-(?:opus|sonnet|fable)-5/, 1_000_000]]);
export const windowFor = (model, fallback = 200_000) => WINDOWS.find(([re]) => re.test(String(model ?? '')))?.[1] ?? fallback;
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

const clip = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const base = (p) => String(p ?? '').replace(/^.*\//, '');
/** The first sentence of a message, such as a refusal’s reason. */
const firstSentence = (s, n = 300) => clip(/^[\s\S]*?[.!?](?=\s|$)/.exec(String(s ?? '').trim())?.[0] ?? s, n);
/** The latest stretch of streaming text, for a one-line glimpse of what the agent is on. */
const tailOf = (s, n = 160) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= n) return t;
  const cut = t.slice(-n);
  return `…${cut.slice(cut.indexOf(' ') + 1)}`;
};
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

const GENERIC = {
  Bash: 'Running a command',
  Read: 'Reading a file',
  Write: 'Writing a file',
  Edit: 'Editing a file',
  MultiEdit: 'Editing a file',
  Glob: 'Finding files',
  Grep: 'Searching files',
  WebFetch: 'Fetching a page',
  WebSearch: 'Searching the web',
  Task: 'Starting a subagent',
  Agent: 'Starting a subagent',
  mcp__postbox__define_term: 'Defining a term',
  mcp__postbox__wake_agent: 'Waking an agent',
  mcp__postbox__corpus_search: 'Searching the corpus',
};

/** A short label for a tool call, in the words the activity list uses. */
export function describeTool(name, input = {}) {
  const i = input ?? {};
  // A tool call’s input streams in after its name, so the first label is the generic one.
  if (!Object.keys(i).length && GENERIC[name]) return GENERIC[name];
  switch (name) {
    case 'Bash':
      return i.description ? clip(i.description, 80) : `Ran ${clip(i.command, 70)}`;
    case 'Read':
      return `Read ${base(i.file_path)}`;
    case 'Write':
      return `Wrote ${base(i.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${base(i.file_path)}`;
    case 'NotebookEdit':
      return `Edited ${base(i.notebook_path)}`;
    case 'Glob':
      return `Found files matching ${clip(i.pattern, 60)}`;
    case 'Grep':
      return `Searched for “${clip(i.pattern, 50)}”`;
    case 'WebFetch':
      return `Fetched ${clip(String(i.url ?? '').replace(/^https?:\/\//, ''), 60)}`;
    case 'WebSearch':
      return `Searched the web for “${clip(i.query, 50)}”`;
    case 'Task':
    case 'Agent':
      return `Subagent: ${clip(i.description ?? i.subagent_type ?? 'task', 60)}`;
    case 'TodoWrite':
      return 'Updated the plan';
    case 'mcp__postbox__corpus_search':
      return `Searched the corpus for “${clip(i.query, 50)}”`;
    case 'mcp__postbox__show_block':
      return 'Showing a block';
    case 'mcp__postbox__update_block':
      return 'Updating a block';
    case 'mcp__postbox__show_app':
      return 'Writing an app';
    case 'mcp__postbox__update_app':
      return 'Updating an app';
    case 'mcp__postbox__define_term':
      return `Defining “${clip(i.term, 40)}”`;
    case 'mcp__postbox__propose_agent':
      return 'Proposing a teammate';
    case 'mcp__postbox__schedule_wake':
      return 'Scheduling a wake-up';
    case 'mcp__postbox__wake_agent':
      return `Waking @${clip(String(i.handle ?? '').replace(/^@/, ''), 24)}`;
    case 'mcp__postbox__permission_prompt':
      return 'Asking you';
    case 'mcp__postbox__read_conversation':
      return 'Reading the conversation';
    case 'ToolSearch':
      return 'Loading tools';
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
      return m ? `${m[2].replace(/_/g, ' ')} (${m[1]})` : name;
    }
  }
}

/** The share of the context window a request used, in percent. */
export function contextPercent(usage, window) {
  if (!usage || !window) return null;
  const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return Math.min(100, (used / window) * 100);
}

/**
 * Feeds one stream to a turn context.
 * @param {any} ctx  the turn context (see server/adapters/adapter.mjs)
 * @param {{ contextWindow?: number, now?: () => number, effort?: string|null }} [opts]  effort: what the turn was
 *   started with, reported with the model, since the stream doesn’t say
 */
export function createStreamMapper(ctx, { contextWindow = 200_000, now = Date.now, effort = null } = {}) {
  /** @type {any} */
  const st = {
    sessionId: null,
    model: null,
    answered: null, // the model the last assistant message came from
    contextWindow,
    result: null,
    wroteText: false, // reply text so far this turn, so separate text blocks get a paragraph break
    streamed: new Set(), // message ids whose text arrived as deltas
    blocks: new Map(), // content block index → { type, id, name, json }
    tools: new Map(), // tool_use id → { name, label, input, who, started, quiet }
    subagents: new Map(), // Task tool_use id → { name, state, ctx, doing }
    subNames: new Map(), // Task tool_use id → its name, kept after it finishes (refusals can arrive later)
    tasks: new Map(), // subagent task id (a refusal’s agent_id) → its Task tool_use id
    denied: new Set(), // tool_use ids Claude Code refused
    thoughts: 0,
    thoughtMessages: new Set(), // message ids whose thinking arrived as deltas
    said: '', // reply text so far this turn, for the glimpse
    glimpse: '',
    glimpseAt: 0,
    state: null,
  };
  const status = (patch) => {
    if (patch.state && patch.state === st.state && Object.keys(patch).length === 1) return;
    if (patch.state) st.state = patch.state;
    ctx.status(patch);
  };
  const pushSubagents = () => status({ subagents: [...st.subagents.values()] });
  // A short, temporary line of what the agent is thinking or writing, at most a few times a second.
  const glimpse = (text, { force = false } = {}) => {
    const t = tailOf(text);
    if (!t || t === st.glimpse) return;
    st.pending = t;
    if (!force && now() - st.glimpseAt < 400) return;
    st.glimpseAt = now();
    st.glimpse = t;
    st.pending = null;
    ctx.status({ glimpse: t });
  };
  const flushGlimpse = () => {
    if (st.pending) glimpse(st.pending, { force: true });
  };
  const thought = (text) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    st.thoughts += 1;
    ctx.activity({ id: `thought-${st.thoughts}`, label: firstSentence(t, 120), state: 'done', kind: 'thought', detail: clip(t, 1200) });
  };

  // who: the subagent that made the call, for calls made inside one.
  const startTool = (id, name, input, who = null) => {
    if (st.tools.has(id)) return;
    const quiet = QUIET.test(name);
    const label = describeTool(name, input);
    st.tools.set(id, { name, label, input, who, started: now(), quiet });
    if (!quiet) ctx.activity({ id, label, state: 'running', ...(who ? { who } : {}) });
    else if (!who) status({ state: 'tool', currentStep: label });
    if (SUBAGENT_TOOLS.has(name)) {
      const sub = clip(input?.subagent_type ?? input?.description ?? 'subagent', 40);
      st.subagents.set(id, { name: sub, state: 'think', ctx: 0, doing: clip(input?.description, 120) });
      st.subNames.set(id, sub);
      pushSubagents();
    }
    if (!who) status({ state: 'tool' });
  };
  const labelTool = (id, input) => {
    const t = st.tools.get(id);
    if (!t) return;
    if (input && Object.keys(input).length) t.input = input;
    const label = describeTool(t.name, input);
    if (label !== t.label) {
      t.label = label;
      if (!t.quiet) ctx.activity({ id, label, state: 'running', ...(t.who ? { who: t.who } : {}) });
      else if (!t.who) status({ currentStep: label });
    }
    const sub = st.subagents.get(id);
    if (sub && input) {
      sub.name = clip(input.subagent_type ?? input.description ?? sub.name, 40);
      sub.doing = clip(input.description ?? sub.doing, 120);
      st.subNames.set(id, sub.name);
      pushSubagents();
    }
  };
  const stepOf = (id, t, state, extra = {}) => ({ id, label: t.label, state, ms: now() - t.started, ...(t.who ? { who: t.who } : {}), ...extra });
  const endTool = (id, failed, detail = '') => {
    const t = st.tools.get(id);
    if (!t || t.done) return;
    t.done = true;
    if (failed && detail) t.error = detail;
    const state = st.denied.has(id) ? 'denied' : failed ? 'failed' : 'done';
    if (!t.quiet) ctx.activity(stepOf(id, t, state, failed && detail && state !== 'denied' ? { detail: firstSentence(detail, 300) } : {}));
    if (st.subagents.has(id)) {
      st.subagents.delete(id);
      pushSubagents();
    }
  };

  // Claude Code refused a call without asking: the auto-mode classifier, a deny rule, or the mode. Reported
  // as it happens, and again (authoritatively) in the result, so each is passed on once.
  // Deny rules in settings refuse without the event, so the result’s list is the only record of those, and
  // the tool’s error is their reason. The list also holds calls the person declined on a permission card:
  // those are skipped here (and the runtime matches them to their card too).
  const denial = ({ tool_use_id: id, tool_name: tool, tool_input, agent_id, message, decision_reason, decision_reason_type }, { fromResult = false } = {}) => {
    if (!id || st.denied.has(id)) return;
    const t = st.tools.get(id);
    if (fromResult && DECLINED.test(t?.error ?? '')) return;
    st.denied.add(id);
    const input = tool_input ?? t?.input ?? {};
    const who = agent_id ? (st.subNames.get(st.tasks.get(agent_id)) ?? 'a subagent') : (t?.who ?? null);
    ctx.denied?.({
      toolUseId: id,
      tool,
      input,
      label: describeTool(tool, input),
      reason: firstSentence(message ?? decision_reason ?? t?.error ?? ''),
      reasonType: decision_reason_type ?? null,
      who,
    });
    if (t?.done && !t.quiet) ctx.activity(stepOf(id, t, 'denied'));
  };

  // Events from inside a subagent carry the Task call’s id; they move that subagent’s ring, not the agent’s.
  // Its tool calls are steps in the list too, under its name.
  const subagentEvent = (parent, e) => {
    if (e.type === 'assistant') {
      const who = st.subNames.get(parent) ?? 'subagent';
      for (const b of e.message?.content ?? [])
        if (b.type === 'tool_use') {
          startTool(b.id, b.name, b.input, who);
          labelTool(b.id, b.input);
        }
    }
    const sub = st.subagents.get(parent);
    if (!sub) return;
    const ev = e.event;
    let changed = false;
    if (e.type === 'stream_event' && ev?.type === 'message_start') {
      const pct = contextPercent(ev.message?.usage, st.contextWindow);
      if (pct !== null) sub.ctx = pct;
      changed = true;
    }
    if (e.type === 'stream_event' && ev?.type === 'content_block_start') {
      const t = ev.content_block?.type;
      const next = t === 'thinking' || t === 'redacted_thinking' ? 'think' : t === 'text' ? 'gen' : 'tool';
      if (t === 'tool_use') sub.doing = describeTool(ev.content_block.name, ev.content_block.input);
      changed = sub.state !== next || changed;
      sub.state = next;
    }
    if (e.type === 'assistant') {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'tool_use') sub.doing = describeTool(b.name, b.input);
        else if (b.type === 'thinking' && b.thinking) sub.doing = firstSentence(b.thinking, 120);
      }
      changed = true;
    }
    if (changed) pushSubagents();
  };

  /** Handles one parsed line of the stream. */
  function push(e) {
    if (!e || typeof e !== 'object') return;
    const parent = e.parent_tool_use_id;
    if (parent && e.type !== 'user') return subagentEvent(parent, e);

    if (e.type === 'system') {
      if (e.subtype === 'init') {
        st.sessionId = e.session_id ?? st.sessionId;
        st.model = e.model ?? st.model;
        // The MCP servers that loaded, with their status, for the persona sheet (#59), and the model and effort
        // the turn runs with (#60).
        ctx.reported?.({
          ...(Array.isArray(e.mcp_servers) ? { mcpServers: e.mcp_servers } : {}),
          ...(e.model ? { model: e.model } : {}),
          ...(effort ? { effort } : {}),
        });
        status({ state: 'think', currentStep: 'Thinking' });
      } else if (e.subtype === 'status' && e.status === 'compacting') {
        status({ currentStep: 'Summarizing the conversation' });
      } else if (e.subtype === 'permission_denied') {
        denial(e);
      } else if (e.subtype === 'task_started' && e.task_id && e.tool_use_id) {
        st.tasks.set(e.task_id, e.tool_use_id);
      } else if (e.subtype === 'task_progress' && e.tool_use_id) {
        const sub = st.subagents.get(e.tool_use_id);
        if (sub && e.description) {
          sub.doing = clip(e.description, 120);
          pushSubagents();
          glimpse(`${sub.name}: ${e.description}`);
        }
      } else if (e.subtype === 'task_summary' && e.detail) {
        glimpse(e.detail);
      } else if (e.subtype === 'compact_boundary') {
        const total = e.compact_metadata?.pre_tokens ?? 0;
        // How much survives isn’t reported; the next request’s usage shows it, so start from a summary’s worth.
        const kept = Math.min(total, Math.round(st.contextWindow * 0.05));
        if (total) ctx.compaction({ kept, total, summary: e.compact_metadata?.summary ?? 'Claude Code summarized the earlier conversation to make room.' });
        st.wroteText = false;
      }
      return;
    }

    if (e.type === 'stream_event') {
      const ev = e.event ?? {};
      if (ev.type === 'message_start') {
        st.blocks.clear();
        st.lastUsage = ev.message?.usage ?? st.lastUsage;
        const pct = contextPercent(ev.message?.usage, st.contextWindow);
        if (pct !== null) status({ ctx: pct });
        if (ev.message?.id) st.current = ev.message.id;
      } else if (ev.type === 'content_block_start') {
        const b = ev.content_block ?? {};
        st.blocks.set(ev.index, { type: b.type, id: b.id, name: b.name, json: '', thinking: '' });
        if (b.type === 'thinking' || b.type === 'redacted_thinking') status({ state: 'think', currentStep: 'Thinking' });
        else if (b.type === 'text') {
          if (st.wroteText) ctx.text('\n\n');
          status({ state: 'gen', currentStep: 'Writing a reply' });
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') startTool(b.id, b.name, b.input);
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta ?? {};
        const blk = st.blocks.get(ev.index);
        if (d.type === 'text_delta' && d.text) {
          if (st.current) st.streamed.add(st.current);
          ctx.text(d.text);
          st.wroteText = true;
          st.said = (st.said + d.text).slice(-400);
          glimpse(st.said);
        } else if (d.type === 'thinking_delta' && d.thinking && blk) {
          if (st.current) st.thoughtMessages.add(st.current);
          blk.thinking += d.thinking;
          glimpse(blk.thinking);
        } else if (d.type === 'input_json_delta' && blk) blk.json += d.partial_json ?? '';
      } else if (ev.type === 'content_block_stop') {
        const blk = st.blocks.get(ev.index);
        if (blk?.type === 'thinking') {
          flushGlimpse();
          thought(blk.thinking);
        }
        if (blk?.id && blk.json) {
          try {
            labelTool(blk.id, JSON.parse(blk.json));
          } catch {
            // A partial input that doesn’t parse keeps the first label.
          }
        }
      }
      return;
    }

    if (e.type === 'assistant') {
      // The last top-level assistant message is where this turn ends in the transcript: a fork point.
      if (e.uuid) st.lastUuid = e.uuid;
      const m = e.message ?? {};
      // The model that actually answered (#60). Claude Code’s own messages, such as an interruption, say
      // “<synthetic>”, which isn’t a model.
      if (typeof m.model === 'string' && m.model && !m.model.startsWith('<') && m.model !== st.answered) {
        st.answered = m.model;
        ctx.reported?.({ model: m.model });
      }
      for (const b of m.content ?? []) {
        if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
          startTool(b.id, b.name, b.input);
          labelTool(b.id, b.input);
        } else if (b.type === 'thinking' && b.thinking && !st.thoughtMessages.has(m.id)) {
          // Without partial messages, thinking arrives whole.
          thought(b.thinking);
        } else if (b.type === 'text' && b.text && !st.streamed.has(m.id)) {
          // Without partial messages, text arrives whole.
          if (st.wroteText) ctx.text('\n\n');
          ctx.text(b.text);
          st.wroteText = true;
        }
      }
      return;
    }

    if (e.type === 'user') {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'tool_result') endTool(b.tool_use_id, b.is_error === true, b.is_error ? resultText(b.content) : '');
      }
      if (!parent) status({ state: 'think', currentStep: 'Thinking' });
      return;
    }

    if (e.type === 'result') {
      st.result = e;
      const usage = (st.model && e.modelUsage?.[st.model]) || Object.values(e.modelUsage ?? {})[0];
      if (usage?.contextWindow && usage.contextWindow !== st.contextWindow) {
        st.contextWindow = usage.contextWindow;
        const pct = contextPercent(st.lastUsage, st.contextWindow);
        if (pct !== null) status({ ctx: pct });
      }
      // Refusals the stream didn’t report as they happened.
      for (const d of e.permission_denials ?? []) denial(d, { fromResult: true });
      for (const [id] of st.tools) endTool(id, e.is_error === true);
      flushGlimpse();
    }
  }

  return {
    push,
    get sessionId() {
      return st.sessionId;
    },
    get model() {
      return st.model;
    },
    get contextWindow() {
      return st.contextWindow;
    },
    get result() {
      return st.result;
    },
    get lastUuid() {
      return st.lastUuid ?? null;
    },
  };
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

/** What a tool call would do, for the permission card: a short summary (“run a command”) and the detail. */
export function describePermission(name, input = {}) {
  const i = input ?? {};
  switch (name) {
    case 'Bash':
      return { summary: i.description ? `run a command: ${clip(i.description, 80)}` : 'run a command', detail: String(i.command ?? '') };
    case 'Write':
      return { summary: `write ${base(i.file_path)}`, detail: String(i.file_path ?? '') };
    case 'Edit':
    case 'MultiEdit':
      return { summary: `edit ${base(i.file_path)}`, detail: String(i.file_path ?? '') };
    case 'NotebookEdit':
      return { summary: `edit ${base(i.notebook_path)}`, detail: String(i.notebook_path ?? '') };
    case 'WebFetch':
      return { summary: `fetch ${clip(String(i.url ?? '').replace(/^https?:\/\//, ''), 60)}`, detail: String(i.url ?? '') };
    case 'WebSearch':
      return { summary: `search the web for “${clip(i.query, 60)}”`, detail: String(i.query ?? '') };
    default:
      return {
        summary: `use ${String(name)
          .replace(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/, '$2 from $1')
          .replace(/_/g, ' ')}`,
        detail: JSON.stringify(i, null, 2).slice(0, 4000),
      };
  }
}
