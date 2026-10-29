// What a real agent loads from the person’s own Claude Code setup (#57), shared by both adapters; and where each
// adapter’s raw stream goes (recorderFor).
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

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
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
/**
 * A persona’s model that leaves the choice to its harness: Kiro’s own name for its router (`kiro-cli chat
 * --list-models` lists it), and for Codex no model at all, so Codex’s configuration decides. Codex offers it beside
 * the models its CLI lists, and alone when Postbox has no list, as when Codex is only on a host (#120).
 */
export const AUTO_MODEL = 'auto';

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
/**
 * How long Claude Code waits on one call to Postbox’s server, in ms: 25 hours, a day’s wait plus a margin (#217).
 * permission_prompt answers only when the person answers the card, often minutes later. With no `timeout`, Claude
 * Code gives an HTTP server’s request 60 s to its first byte, so a card left for a minute failed the call with “The
 * operation timed out” (claude 2.1.308, cut at 60.0 s twice); with `timeout: 900000` it was still waiting at 8 min
 * 44 s. The per-server timeout raises that timer to itself, and sets a floor under the 5-minute idle window for calls
 * that send nothing (code.claude.com/docs/en/mcp, “Time limits on MCP tool calls”). Every other Postbox tool returns
 * at once, and the Agent SDK asks through canUseTool instead, so for them it changes nothing in practice.
 */
export const POSTBOX_TIMEOUT_MS = 25 * 60 * 60 * 1000;
/**
 * The margin over the longest permission wait, in milliseconds: an hour. On a remote host (#120) the shim denies a prompt
 * at the host’s permissionWaitMax, so Claude Code’s own limit on the call must come later, or the agent would get “The
 * operation timed out” instead of the denial the card shows (C1).
 */
export const PERMISSION_WAIT_MARGIN_MS = 60 * 60 * 1000;
/** Postbox’s own server, as `--mcp-config` and the SDK’s `mcpServers` take it. */
export const postboxServer = (mcpUrl) => ({ [POSTBOX_SERVER]: { type: 'http', url: mcpUrl, alwaysLoad: true, timeout: POSTBOX_TIMEOUT_MS } });
// alwaysLoad: Postbox’s tools are in the first prompt, so the agent doesn’t have to search for them.

/**
 * Postbox’s server for a turn on a remote host (#120): the host’s stdio shim, which the daemon ships, started by the
 * host’s node with the turn’s ID. A stdio server has no per-request timer (the docs’ env-vars page, MCP_TOOL_TIMEOUT), and
 * its `timeout` is the hard wall-clock limit on one call and, of at least 1000 ms, a floor under the 30-minute idle
 * window (C1). The docs’ MCP page spells a stdio entry { type: 'stdio', command, args, env }; alwaysLoad is on every
 * server type.
 * @param {{ command: string, args: string[], timeout: number }} o
 */
export const shimServer = ({ command, args, timeout }) => ({
  [POSTBOX_SERVER]: { type: 'stdio', command, args: [...args], alwaysLoad: true, timeout },
});

/**
 * The overlay for one persona. MCP servers it turned off go in `deniedMcpServers` ([{ serverName }]), the one
 * denylist Claude Code merges from every settings source (sdk.d.ts: “users can deny servers for themselves”).
 * How it was checked: a real turn (claude 2.1.296, the person’s setup, outside the repo) with a project server,
 * a claude.ai connector and a plugin server denied by name. Its init no longer listed any of the three in
 * `mcp_servers`, and none of their tools (tests/fixtures/claude-code/host-mcp-init.jsonl). Isolated personas
 * load no other server, so they need no denylist. memoryDir: the persona’s memory folder (memoryFolder), on every turn.
 * @param {any} persona @param {string|null} [memoryDir]
 */
export function settingsFor(persona, memoryDir = null) {
  const { usesHostSetup, mcpOff } = setupOf(persona);
  return {
    ...SETTINGS_OVERLAY,
    ...(memoryDir ? { autoMemoryDirectory: memoryDir } : {}),
    ...(usesHostSetup && mcpOff.length ? { deniedMcpServers: mcpOff.map((serverName) => ({ serverName })) } : {}),
  };
}

/**
 * The folder a persona keeps its auto memory in for a project (#208): `<root>/<persona id>/<project id>`, passed as
 * `autoMemoryDirectory` in the overlay. Claude Code keys auto memory by working folder (~/.claude/projects/<project>/
 * memory/, code.claude.com/docs/en/memory), and every persona in a project runs in the project’s folder, so without it
 * two personas, and the person’s own sessions there, shared one memory (reproduced with two real agents, 26 October
 * 2026). “Uses your setup” doesn’t include the person’s memory: that setting is for tooling (decided 27 October), so
 * every persona gets one. Keyed by id, so a new persona with an old one’s name starts clean. The project’s shared
 * folder stays as it was, for the person’s own sessions: nothing is copied or deleted.
 * @param {string} root  where memory folders go: Postbox’s data folder’s, or its folder on a host
 * @param {{ id?: string, handle: string }} persona @param {{ id?: string } | null | undefined} project
 */
export const memoryFolder = (root, persona, project) => `${personaMemory(root, persona)}/${part(project?.id || 'no-project')}`;

/** A persona’s memory folders for every project, which deleting it removes (server/persona-delete.mjs). */
export const personaMemory = (root, persona) => `${root}/${part(persona.id || persona.handle)}`;
// Ids are Postbox’s own (newId); anything else in one is replaced, so it stays one folder under root.
const part = (v) => String(v).replace(/[^\w-]/g, '_');

/**
 * What both Claude adapters pass from a turn’s context: the rules the person allowed once or for this conversation
 * (#66), and the persona’s own memory folder under `memoryRoot` (#208).
 * @param {any} ctx @param {string} memoryRoot
 */
export const fromContext = (ctx, memoryRoot) => ({
  allowOnce: ctx.allowOnce ?? [],
  rules: ctx.rules ?? {},
  memoryDir: memoryFolder(memoryRoot, ctx.persona, ctx.project),
});

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
// lint-allow regex: PUBLISHING_TOOLS is Postbox's own list, escaped here, with * as its one wildcard.
const RULES = PUBLISHING_TOOLS.map((r) => new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
/** Whether the deny list covers a tool name, such as one in an init event’s `tools` (the UAT checks this). */
export const isPublishingTool = (name) => RULES.some((r) => r.test(String(name)));

/**
 * Ask rules for calls that write outside Postbox (#112), passed in the settings overlay’s `permissions.ask` with the
 * conversation’s own. Claude Code then asks before each one in every mode but bypass, through Postbox’s permission
 * prompt, and the card shows the draft before anything exists outside. An agent created a document in a shared folder
 * of an external doc tool with a number already taken, and with broken links, and everyone with access saw it first.
 *
 * Unlike PUBLISHING_TOOLS these ask rather than deny, on every server, local ones too: a local server can write to a
 * remote service (a doc tool’s server runs on this computer), and Postbox can’t tell which. Calls the person has
 * settled pass without a card (server/write-guard.mjs): an Always allow for the tool itself, and the publishing tools
 * when the persona may publish. Matched by the verb in the tool’s name, as PUBLISHING_TOOLS is:
 * - write, create, edit, upload, append, insert, delete, remove, patch, move, rename, copy, add, put and set, verb
 *   first or after a service prefix, at _ or - (create_document, notion_create_page, notion-create-pages), and in
 *   camelCase (createIssue, createConfluencePage, jiraCreateIssue). Not add or set in camelCase: addressOf, settings
 *   and getAddress would ask;
 * - update only on its own, after a prefix (issue_update, notion-update-page, notionUpdatePage), at - (update-page),
 *   or with a named target (update_file, updateIssue), since Postbox’s own update_block and update_app must never
 *   match: ask beats the allow rule for mcp__postbox.
 * - gh commands that file or change issues, pull requests and releases.
 * tests/claude-code.test.mjs checks that none matches a Postbox tool, and which real tool names they catch.
 */
const WRITE_VERBS = ['write', 'create', 'edit', 'upload', 'append', 'insert', 'delete', 'remove', 'patch', 'move', 'rename', 'copy', 'add', 'put', 'set'];
const UPDATE_TARGETS = [
  'file',
  'document',
  'doc',
  'page',
  'issue',
  'pull_request',
  'comment',
  'post',
  'message',
  'record',
  'row',
  'item',
  'entry',
  'task',
  'ticket',
  'event',
  'card',
  'database',
  'sheet',
  'note',
  'block_children',
];
const CAMEL = WRITE_VERBS.filter((v) => v !== 'add' && v !== 'set');
const word = (v) => `${v[0].toUpperCase()}${v.slice(1)}`;
/** The verb after a prefix, at _ or -: notion_create_page, issue_update, notion-create-pages, notion-update. */
const later = (v) => [`mcp__*__*_${v}`, `mcp__*__*_${v}_*`, `mcp__*__*-${v}`, `mcp__*__*-${v}-*`];
export const WRITE_TOOLS = [
  // A verb first: create_document and create-document, or in camelCase createIssue, which create* covers.
  ...WRITE_VERBS.flatMap((v) => (CAMEL.includes(v) ? [`mcp__*__${v}*`] : [`mcp__*__${v}`, `mcp__*__${v}_*`, `mcp__*__${v}-*`])),
  ...WRITE_VERBS.flatMap(later),
  // A verb later in camelCase: jiraCreateIssue, notionUpdatePage.
  ...CAMEL.map((v) => `mcp__*__*${word(v)}*`),
  'mcp__*__update',
  'mcp__*__update-*',
  ...later('update'),
  'mcp__*__*Update*',
  ...UPDATE_TARGETS.flatMap((t) => [`mcp__*__update_${t}`, `mcp__*__update${t.split('_').map(word).join('')}`]),
  ...['issue create', 'issue comment', 'issue edit', 'pr create', 'pr comment', 'pr edit', 'pr review', 'release create'].map((c) => `Bash(gh ${c}:*)`),
];

/** The ask rules for writes outside Postbox, for a persona’s turn: none in bypass, which runs everything. */
export const writeRules = (persona) => (persona?.permissionMode === 'bypass' ? [] : [...WRITE_TOOLS]);

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

// ── Raw streams ─────────────────────────────────────────────────────────────────────────────
// Each adapter hands every line its backend streams to recorderFor: it goes to POSTBOX_*_RECORD’s folder when that’s set
// (test fixtures, the UAT), and to the stream taps, which a recorded room’s telemetry registers (server/telemetry.mjs).

/** @type {Map<any, (ctx: any, line: string, backend: string) => void>} by runtime */
const taps = new Map();
/** Registers a runtime’s tap; returns what unregisters it. */
export function setStreamTap(rt, tap) {
  taps.set(rt, tap);
  return () => taps.delete(rt);
}

/** How much of a turn’s raw stream its context keeps, for a reply that ends empty (#485): its last lines, each bounded. */
const RAW_TAIL = 12;
const RAW_LINE = 1000;
/** The fields whose words a line’s shape keeps: what kind of event it is, and how it ended. */
const SHAPE_WORDS = new Set(['type', 'subtype', 'name', 'stop_reason', 'status', 'kind', 'operationType', 'sessionUpdate', 'terminal_reason']);

/** A value’s shape: other strings become their length, so no reply, file or secret a tool printed is kept. */
const shapeOf = (/** @type {unknown} */ v, depth = 0, key = '') => {
  if (typeof v === 'string') return SHAPE_WORDS.has(key) ? v.slice(0, 60) : v.length;
  if (Array.isArray(v)) return depth > 3 ? `[${v.length}]` : v.slice(0, 8).map((x) => shapeOf(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  if (depth > 3) return '{…}';
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1, k)]));
};

/**
 * Keeps an event’s shape in the turn’s ctx.rawTail, when it has one, for an empty reply’s diagnosis (#485). The item
 * that keeps it is saved and sent to every page, so it holds kinds and sizes, never text.
 * @param {any} ctx @param {unknown} event  a parsed event, or a raw line
 */
export function keepShape(ctx, event) {
  const tail = Array.isArray(ctx.rawTail) ? ctx.rawTail : null;
  if (!tail) return;
  let e = event;
  if (typeof e === 'string')
    try {
      e = JSON.parse(e);
    } catch {
      e = { unparsed: e.length };
    }
  // Too long whole (a result’s usage, say), only its top-level fields, so the line still parses.
  let line = JSON.stringify(shapeOf(e));
  if (line.length > RAW_LINE) line = JSON.stringify(shapeOf(e, 3));
  if (tail.push(line.slice(0, RAW_LINE)) > RAW_TAIL) tail.shift();
}

/**
 * What one turn writes each raw line to. The last few go in the turn’s ctx.rawTail too, as shapes (keepShape).
 * @param {any} ctx  the turn’s context @param {string|undefined} dir  POSTBOX_*_RECORD @param {string} backend
 * @returns {(line: string) => void}
 */
export function recorderFor(ctx, dir, backend) {
  const file = dir ? join(dir, `${Date.now()}-${ctx.persona.handle}.jsonl`) : null;
  return (line) => {
    if (file) appendFileSync(file, `${line}\n`);
    keepShape(ctx, line);
    for (const tap of taps.values()) tap(ctx, line, backend);
  };
}

/** The setup choices for a persona, with the defaults for personas from before they existed. */
export function setupOf(persona) {
  return {
    usesHostSetup: persona?.usesHostSetup !== false,
    canPublish: persona?.canPublish === true,
    mcpOff: Array.isArray(persona?.mcpOff) ? persona.mcpOff.filter((n) => typeof n === 'string' && n && n !== POSTBOX_SERVER) : [],
  };
}
