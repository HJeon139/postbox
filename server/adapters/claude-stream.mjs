// Turns Claude Code’s stream-json output (claude -p --output-format stream-json --include-partial-messages)
// into Postbox’s turn context: reply text, activity steps, ring state, context use, subagents and
// compactions. Pure apart from the ctx calls, so recorded streams can test it (tests/claude-stream.test.mjs).

// Postbox’s own UI tools show up in the thread as what they make, so they aren’t listed as activity;
// nor is Claude Code loading tool definitions. They still name the step on the agent’s ring.
const QUIET =
  /^(?:mcp__postbox__(?:show_block|update_block|show_app|update_app|define_term|propose_agent|schedule_wake|wake_agent|permission_prompt|read_conversation)|ToolSearch)$/;
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
 * @param {{ contextWindow?: number, now?: () => number }} [opts]
 */
export function createStreamMapper(ctx, { contextWindow = 200_000, now = Date.now } = {}) {
  /** @type {any} */
  const st = {
    sessionId: null,
    model: null,
    contextWindow,
    result: null,
    wroteText: false, // reply text so far this turn, so separate text blocks get a paragraph break
    streamed: new Set(), // message ids whose text arrived as deltas
    blocks: new Map(), // content block index → { type, id, name, json }
    tools: new Map(), // tool_use id → { name, label, started, quiet }
    subagents: new Map(), // Task tool_use id → { name, state, ctx, doing }
    state: null,
  };
  const status = (patch) => {
    if (patch.state && patch.state === st.state && Object.keys(patch).length === 1) return;
    if (patch.state) st.state = patch.state;
    ctx.status(patch);
  };
  const pushSubagents = () => status({ subagents: [...st.subagents.values()] });

  const startTool = (id, name, input) => {
    if (st.tools.has(id)) return;
    const quiet = QUIET.test(name);
    const label = describeTool(name, input);
    st.tools.set(id, { name, label, started: now(), quiet });
    if (!quiet) ctx.activity({ id, label, state: 'running' });
    else status({ state: 'tool', currentStep: label });
    if (SUBAGENT_TOOLS.has(name)) {
      st.subagents.set(id, {
        name: clip(input?.subagent_type ?? input?.description ?? 'subagent', 40),
        state: 'think',
        ctx: 0,
        doing: clip(input?.description, 120),
      });
      pushSubagents();
    }
    status({ state: 'tool' });
  };
  const labelTool = (id, input) => {
    const t = st.tools.get(id);
    if (!t) return;
    const label = describeTool(t.name, input);
    if (label !== t.label) {
      t.label = label;
      if (!t.quiet) ctx.activity({ id, label, state: 'running' });
      else status({ currentStep: label });
    }
    const sub = st.subagents.get(id);
    if (sub && input) {
      sub.name = clip(input.subagent_type ?? input.description ?? sub.name, 40);
      sub.doing = clip(input.description ?? sub.doing, 120);
      pushSubagents();
    }
  };
  const endTool = (id, failed) => {
    const t = st.tools.get(id);
    if (!t || t.done) return;
    t.done = true;
    if (!t.quiet) ctx.activity({ id, label: t.label, state: failed ? 'failed' : 'done', ms: now() - t.started });
    if (st.subagents.has(id)) {
      st.subagents.delete(id);
      pushSubagents();
    }
  };

  // Events from inside a subagent carry the Task call’s id; they move that subagent’s ring, not the agent’s.
  const subagentEvent = (parent, e) => {
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
      for (const b of e.message?.content ?? []) if (b.type === 'tool_use') sub.doing = describeTool(b.name, b.input);
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
        status({ state: 'think', currentStep: 'Thinking' });
      } else if (e.subtype === 'status' && e.status === 'compacting') {
        status({ currentStep: 'Summarizing the conversation' });
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
        st.blocks.set(ev.index, { type: b.type, id: b.id, name: b.name, json: '' });
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
        } else if (d.type === 'input_json_delta' && blk) blk.json += d.partial_json ?? '';
      } else if (ev.type === 'content_block_stop') {
        const blk = st.blocks.get(ev.index);
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
      for (const b of m.content ?? []) {
        if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
          startTool(b.id, b.name, b.input);
          labelTool(b.id, b.input);
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
        if (b.type === 'tool_result') endTool(b.tool_use_id, b.is_error === true);
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
      for (const [id] of st.tools) endTool(id, e.is_error === true);
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
  if (result.subtype === 'error_max_turns') return 'The agent hit its turn limit before finishing.';
  if (result.subtype === 'error_during_execution') return 'Claude Code hit an error while running the turn.';
  const text = typeof result.result === 'string' && result.result.trim() ? result.result.trim() : null;
  return text ? clip(text, 400) : `Claude Code reported a failure (${result.subtype ?? 'unknown'}).`;
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
