// What a real agent loads from the person’s own Claude Code setup (#57), shared by both adapters.
//
// By default a persona loads the person’s setup, as in their terminal: user, project and local settings, so the
// same skills, slash commands, plugins and permission rules. Not their MCP servers or claude.ai connectors yet:
// both adapters pass --strict-mcp-config / strictMcpConfig, which loads only Postbox’s own server (#59).
// Postbox overrides two things:
// - The output style is forced to the default, because a style such as Concise is repeated on every turn and
//   fights the agent guide (#63).
// - Tools that publish outside Postbox are denied, unless the persona allows them. In a UAT run, an agent
//   published its result as a claude.ai artifact instead of a Postbox app, so the work left the conversation.
// A persona set to Isolated (usesHostSetup: false) loads the project’s settings only, not the person’s own.

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

/** The setup choices for a persona, with the defaults for personas from before they existed. */
export function setupOf(persona) {
  return { usesHostSetup: persona?.usesHostSetup !== false, canPublish: persona?.canPublish === true };
}
