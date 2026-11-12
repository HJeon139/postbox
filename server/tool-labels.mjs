// The words a tool call goes by in the activity list and on the ring, and which of Postbox’s own tools show as what they
// make rather than as a step. Moved from server/adapters/claude-stream.mjs.

// Postbox’s own UI tools show up in the thread as what they make, so they aren’t listed as activity;
// nor is Claude Code loading tool definitions. They still name the step on the agent’s ring.
export const QUIET =
  /^(?:mcp__postbox__(?:show_block|update_block|review_block|show_app|update_app|retire_app|define_term|propose_agent|schedule_wake|cancel_wake|wake_agent|open_topic|bring_to_conversation|permission_prompt|read_conversation|read_message|react)|ToolSearch|SubagentHandback)$/;
/** Whether a tool call shows as what it makes rather than as a step (the Kiro CLI adapter shares this). */
export const isQuietTool = (name) => QUIET.test(String(name ?? ''));
const clip = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const base = (p) => String(p ?? '').replace(/^.*\//, '');
const GENERIC = {
  Bash: 'Running a command',
  Monitor: 'Starting a watch',
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
  mcp__postbox__search_assets: 'Searching the assets',
};

/** A short label for a tool call, in the words the activity list uses. */
export function describeTool(name, input = {}) {
  const i = input ?? {};
  // A tool call’s input streams in after its name, so the first label is the generic one.
  if (!Object.keys(i).length && GENERIC[name]) return GENERIC[name];
  switch (name) {
    case 'Bash':
      return i.description ? clip(i.description, 80) : `Ran ${clip(i.command, 70)}`;
    case 'Monitor':
      return `Watching: ${clip(i.description ?? i.command, 70)}`;
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
    default:
      return mcpLabel(name, i);
  }
}

/** A label for one of Postbox’s own tools, or another MCP server’s, by its name and input. @param {string} name @param {any} i */
function mcpLabel(name, i) {
  switch (name) {
    case 'mcp__postbox__search_assets':
      return `Searched the assets for “${clip(i.query, 50)}”`;
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
    case 'mcp__postbox__cancel_wake':
      return 'Canceling a wake-up';
    case 'mcp__postbox__wake_agent':
      return `Waking @${clip(String(i.handle ?? '').replace(/^@/, ''), 24)}`;
    case 'mcp__postbox__permission_prompt':
      return 'Asking you';
    case 'mcp__postbox__read_conversation':
      return 'Reading the conversation';
    case 'mcp__postbox__read_message':
      return 'Reading a message in full';
    case 'ToolSearch':
      return 'Loading tools';
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
      return m ? `${m[2].replace(/_/g, ' ')} (${m[1]})` : name;
    }
  }
}
