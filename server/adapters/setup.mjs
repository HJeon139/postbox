// What a real agent loads from the person’s own Claude Code setup (#57), shared by both adapters.
//
// By default a persona loads the person’s setup, as in their terminal: user, project and local settings, so the
// same skills, slash commands, plugins, permission rules and MCP servers, claude.ai connectors included (#59).
// Postbox’s own server is added to them under the name `postbox`. Postbox overrides these:
// - The output style is forced to the default, because a style such as Concise is repeated on every turn and
//   fights the agent guide (#63).
// - Tools that publish outside Postbox are denied, unless the persona allows them. In a UAT run, an agent
//   published its result as a claude.ai artifact instead of a Postbox app, so the work left the conversation.
// - MCP servers the persona turned off (mcpOff) don’t load: see settingsFor.
// - The model and the effort are always passed (modelOf, effortOf), so neither comes from the person’s settings.
// - The persona’s Tools checklist reaches the backend as deny rules (#5), and tools that act outside Postbox’s
//   record are denied unless the persona allows them: see TOOL_RULES and deniedTools.
// A persona set to Isolated (usesHostSetup: false) loads the project’s settings only, not the person’s own, and
// only Postbox’s MCP server: both adapters pass --strict-mcp-config / strictMcpConfig for it.

/** Setting sources, as `--setting-sources` and the SDK’s `settingSources` spell them. */
export const HOST_SOURCES = ['user', 'project', 'local'];
// Isolated keeps the project’s local file too: that’s where “Always allow” on a refusal card saves its rules
// (.claude/settings.local.json in the agent’s folder, server/permission-rules.mjs), so they keep working.
export const ISOLATED_SOURCES = ['project', 'local'];

/**
 * The flag-settings overlay (`--settings`, the SDK’s `settings`): it sits above user, project and local
 * settings. `outputStyle` is the settings key (code.claude.com/docs/en/output-styles); “default” is the
 * standard style, which adds no style instructions.
 */
export const SETTINGS_OVERLAY = { outputStyle: 'default' };

/** The model a real backend uses when a persona doesn’t name one (or names the mock). */
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const modelOf = (persona) => (persona?.model && persona.model !== 'mock' ? String(persona.model) : DEFAULT_MODEL);

/** Effort levels, as `claude --effort <level>` and the SDK’s EffortLevel (sdk.d.ts) spell them. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
/**
 * The effort a persona runs with when it names none: what Claude Code itself uses for claude-opus-5-5 with no
 * --effort and no effortLevel in the person’s settings. A real turn (claude 2.1.296) ran `printenv CLAUDE_EFFORT`,
 * which Claude Code sets to the turn’s effort, and it printed “medium”; with --effort high it printed “high”. The
 * stream itself doesn’t report effort: in print mode, init has no `effort` field.
 */
export const DEFAULT_EFFORT = 'medium';
export const effortOf = (persona) => (EFFORT_LEVELS.includes(persona?.effort) ? persona.effort : DEFAULT_EFFORT);

/** Postbox’s own MCP server’s name. It always loads, and a persona can’t turn it off. */
export const POSTBOX_SERVER = 'postbox';
/** Postbox’s own server, as `--mcp-config` and the SDK’s `mcpServers` take it. */
export const postboxServer = (mcpUrl) => ({ [POSTBOX_SERVER]: { type: 'http', url: mcpUrl, alwaysLoad: true } });
// alwaysLoad: Postbox’s tools are in the first prompt, so the agent doesn’t have to search for them.

/**
 * The overlay for one persona. MCP servers it turned off go in `deniedMcpServers` ([{ serverName }]), the one
 * denylist Claude Code merges from every settings source (sdk.d.ts: “users can deny servers for themselves”).
 * How it was checked: a real turn (claude 2.1.296, the person’s setup, outside the repo) with a project server,
 * a claude.ai connector and a plugin server denied by name. Its init no longer listed any of the three in
 * `mcp_servers`, and none of their tools (tests/fixtures/claude-code/host-mcp-init.jsonl). Isolated personas
 * load no other server, so they need no denylist.
 */
export function settingsFor(persona) {
  const { usesHostSetup, mcpOff } = setupOf(persona);
  return { ...SETTINGS_OVERLAY, ...(usesHostSetup && mcpOff.length ? { deniedMcpServers: mcpOff.map((serverName) => ({ serverName })) } : {}) };
}

/**
 * Deny rules for tools that publish outside Postbox, passed as `--disallowedTools` / `disallowedTools`.
 *
 * How the list was derived: from the `init` event of a real turn with the person’s own setup (claude 2.1.296,
 * default setting sources, outside the repo). Its `tools` held the built-in Artifact, ArtifactComments,
 * ArtifactData and PushNotification, and connector tools such as mcp__claude_ai_Claude_Docs__create and
 * mcp__claude_ai_Google_Drive__share_file. Other people have other connectors, so connector tools are matched by
 * the verb in their name: Claude Code’s deny rules take globs in the tool name, and `*` spans the server part.
 * - Verbs that only ever go outward (send, post, reply, publish, share, comment) match on any server.
 * - create and upload match only on claude.ai connectors (mcp__claude_ai_<name>__…), which are remote. On a
 *   local server they make things on this computer, such as a memory server’s create_entities, a filesystem
 *   server’s create_directory or a git server’s git_create_branch, and a deny would beat any allow rule for them.
 * Read-only tools (read, search, list, get, export) stay allowed. Postbox’s own tools (mcp__postbox__*) must
 * never match a rule here, since deny beats allow; tests/claude-code.test.mjs checks that against TOOL_DEFS, and
 * checks that those local tools stay allowed.
 */
export const PUBLISHING_TOOLS = [
  // Built-in: publish a page on claude.ai, answer its comments, write its shared data; push a notification.
  'Artifact',
  'ArtifactComments',
  'ArtifactData',
  'PushNotification',
  // Any server: tools named for sending or posting, verb first (send_message, share_file, post).
  ...['send', 'post', 'reply', 'publish', 'share', 'comment'].flatMap((v) => [`mcp__*__${v}`, `mcp__*__${v}_*`]),
  // The same after a service prefix (slack_send_message), where the word doesn’t also name something to read.
  ...['send', 'publish'].map((v) => `mcp__*__*_${v}_*`),
  // claude.ai connectors only: making something there (create, create_file, slack_create_canvas, upload_file).
  ...['create', 'upload'].flatMap((v) => [`mcp__claude_ai_*__${v}`, `mcp__claude_ai_*__${v}_*`, `mcp__claude_ai_*__*_${v}_*`]),
  // Seen in the person’s connectors and not caught by a verb: edits to a claude.ai doc, and Drive copies and edits.
  'mcp__claude_ai_Claude_Docs__batch',
  'mcp__claude_ai_Claude_Docs__update',
  'mcp__claude_ai_Google_Drive__copy_file',
  'mcp__claude_ai_Google_Drive__update_file',
];

// The rules as Claude Code reads a tool-name glob: `*` stands for any text, and the rule matches the whole name.
const RULES = PUBLISHING_TOOLS.map((r) => new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
/** Whether the deny list covers a tool name, such as one in an init event’s `tools` (the UAT checks this). */
export const isPublishingTool = (name) => RULES.some((r) => r.test(String(name)));

/**
 * Tools that act outside Postbox’s record, denied for real backends unless the persona has `agents.outside`. They
 * bypass the wake cap and the record of who woke whom (intent.md, principle 6); Postbox’s own schedule_wake and
 * wake_agent are the way to do that here.
 *
 * How the list was derived: from the `tools` of real `init` events (claude 2.1.296, the person’s setup;
 * tests/fixtures/claude-code/host-mcp-init.jsonl), and wave 1’s UAT, which saw them on a critic’s turn (#5):
 * - SendMessage and ListAgents message and list the person’s other Claude sessions on this computer.
 * - RemoteTrigger starts cloud agents.
 * - CronCreate, CronDelete and ScheduleWakeup schedule work Postbox doesn’t show. CronList only lists those
 *   schedules, which then belong to the person’s other sessions, so it goes with them, as ListAgents does.
 * - Workflow runs a script of agents (agent(), parallel(), pipeline()) that Postbox doesn’t see as teammates.
 * Left out, with the reason:
 * - Monitor runs a shell command, or opens a WebSocket, and streams what comes back: `shell` and `web.fetch`
 *   decide it (TOOL_RULES).
 * - EnterWorktree and ExitWorktree move the agent into a git worktree of its own folder. That stays on this
 *   computer, in the conversation’s record, and the permission mode governs it; worktrees per conversation are #9.
 * - TaskStop only stops the agent’s own background tasks.
 */
export const OUTSIDE_TOOLS = ['SendMessage', 'ListAgents', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Workflow'];

/**
 * The persona’s Tools checklist, as deny rules for real backends (#5): each id maps to the Claude Code tools it
 * stands for, and an id that isn’t ticked denies them (`--disallowedTools`, the SDK’s `disallowedTools`).
 *
 * A ticked tool is not an allow rule. `--allowedTools Bash` would skip the permission mode’s ask for every
 * command, which “Run commands in the project folder” doesn’t promise: ticked means “not denied”, and the
 * permission mode still decides. The allow side is Postbox’s own tools and the rules allowed once, as before.
 *
 * How the map was derived: from the same real `init` events’ `tools`.
 * - shell → Bash, and Monitor, which runs a command too. With Bash denied, Claude Code offers Glob and Grep
 *   instead (recorded), which only read.
 * - web.fetch (“Fetch web pages”) → WebFetch, and WebSearch: both send the agent’s requests to the web, so a
 *   persona kept off the web is kept off both. Also Monitor, which can open a WebSocket.
 * - agents.outside → OUTSIDE_TOOLS.
 * corpus.*, arxiv.search and narrate.speak are Postbox’s own (its apps’ host tools), with nothing in Claude Code
 * to deny. No rule here may match Postbox’s own MCP tools (mcp__postbox__*): deny beats allow.
 */
export const TOOL_RULES = /** @type {Record<string, string[]>} */ ({
  shell: ['Bash', 'Monitor'],
  'web.fetch': ['WebFetch', 'WebSearch', 'Monitor'],
  'agents.outside': OUTSIDE_TOOLS,
});
/**
 * Tool ids only real backends have, appended to the checklist that /api/state serves (server/seed.mjs’s
 * KNOWN_TOOLS holds the rest). Personas from before an id existed don’t have it, so its tools are denied.
 */
export const REAL_BACKEND_TOOLS = [['agents.outside', 'Message, schedule or start agents outside Postbox']];

/** What each tool id lets an agent do, in the words the agent guide uses when it’s turned off (#104). */
export const TOOL_WORDS = /** @type {Record<string, string>} */ ({
  shell: 'running commands',
  'web.fetch': 'fetching web pages or searching the web',
  'agents.outside': 'messaging, scheduling or starting agents outside Postbox',
});

/**
 * The tool ids a backend turns off for this persona: those in its rule map (TOOL_RULES, or the Kiro CLI’s) that
 * aren’t ticked. The agent never sees their tools, so the guide tells it which are off and why (#104).
 * @param {any} persona @param {Record<string, unknown>|null} [rules]  keyed by tool id; null for a backend that can’t turn tools off
 */
export function toolsOff(persona, rules = TOOL_RULES) {
  if (!rules) return [];
  const has = new Set(Array.isArray(persona?.tools) ? persona.tools : []);
  return Object.keys(rules).filter((id) => !has.has(id));
}

/** Every deny rule for a persona’s turn: the publishing tools unless it may publish, then its unticked tools. */
export function deniedTools(persona) {
  const { canPublish } = setupOf(persona);
  const has = new Set(Array.isArray(persona?.tools) ? persona.tools : []);
  return [...new Set([...(canPublish ? [] : PUBLISHING_TOOLS), ...Object.entries(TOOL_RULES).flatMap(([id, rules]) => (has.has(id) ? [] : rules))])];
}

/** The setup choices for a persona, with the defaults for personas from before they existed. */
export function setupOf(persona) {
  return {
    usesHostSetup: persona?.usesHostSetup !== false,
    canPublish: persona?.canPublish === true,
    mcpOff: Array.isArray(persona?.mcpOff) ? persona.mcpOff.filter((n) => typeof n === 'string' && n && n !== POSTBOX_SERVER) : [],
  };
}
