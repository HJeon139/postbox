// The claude CLI’s arguments for one turn (server/adapters/claude-code.mjs runs it; the header there lists them).

import { withAllowRules, withAskRules } from '../permission-rules.mjs';
import { deniedTools, effortOf, HOST_SOURCES, ISOLATED_SOURCES, modelOf, postboxServer, settingsFor, setupOf, writeRules } from './setup.mjs';

// Every mode is passed explicitly: left out, Claude Code would take permissions.defaultMode from your own
// settings, or auto, and an agent you set to ask could end up not asking. (manual is the CLI’s name for default.)
const MODES = {
  auto: ['--permission-mode', 'auto'],
  ask: ['--permission-mode', 'manual'],
  acceptEdits: ['--permission-mode', 'acceptEdits'],
  bypass: ['--permission-mode', 'bypassPermissions'],
};

/**
 * Which Claude Code session the turn runs in: a new one with Postbox’s id, the same one resumed, or, for a topic
 * thread’s first turn, the conversation’s session forked at the message it branched from.
 * @param {string} sessionId @param {boolean} resume @param {{ claudeSessionId: string, uuid?: string }|null} fork
 */
function sessionArgs(sessionId, resume, fork) {
  if (fork) return ['--resume', fork.claudeSessionId, '--fork-session', ...(fork.uuid ? ['--resume-session-at', fork.uuid] : [])];
  return resume ? ['--resume', sessionId] : ['--session-id', sessionId];
}

/** The CLI arguments for one turn. Pure, so the tests can check them. */
/**
 * @param {{ persona: any, sessionId: string, resume: boolean, mcpUrl?: string, guide: string, addDirs?: string[],
 *           fork?: { claudeSessionId: string, uuid?: string }|null, allowOnce?: string[], rules?: { allow?: string[], ask?: string[], deny?: string[] },
 *           server?: Record<string, object>|null, denyPrompts?: boolean, memoryDir?: string|null, plugins?: string[],
 *           hostAllow?: string[] }} turn
 *   rules: the ones the person made for this conversation only (#66), passed every turn. server: Postbox’s server in
 *   place of the HTTP one at mcpUrl (a remote turn’s shim, shimServer). denyPrompts: --permission-prompts none in place
 *   of the prompt tool, so what would be asked is denied (a host’s denyPrompts, D2). memoryDir: the persona’s own memory
 *   folder (#208, setup.mjs’s memoryFolder). plugins: plugin folders to load, Postbox’s own (agent-plugin.mjs).
 *   hostAllow: on a host, the rules the person always allowed for it there (#120, server/host-rules.mjs), sent as allow
 *   rules in --settings, as JSON data.
 */
export function claudeArgs({
  persona,
  sessionId,
  resume,
  mcpUrl = '',
  guide,
  addDirs = [],
  fork = null,
  allowOnce = [],
  rules = {},
  server = null,
  denyPrompts = false,
  memoryDir = null,
  plugins = [],
  hostAllow = [],
}) {
  const mode = persona.permissionMode in MODES ? persona.permissionMode : 'auto';
  const setup = setupOf(persona);
  const denied = [...deniedTools(persona), ...(rules.deny ?? [])];
  // With the persona’s own memory folder (#208), and ask rules for writes outside Postbox (#112), so each comes to a
  // card first, and the conversation’s own; on a host, the rules the person always allowed there (#120).
  const asks = withAskRules(settingsFor(persona, memoryDir), [...writeRules(persona), ...(rules.ask ?? [])]);
  const settings = withAllowRules(asks, hostAllow);
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Readable thinking, and subagents’ own messages, so Postbox can show what the agent is on.
    '--thinking-display',
    'summarized',
    '--forward-subagent-text',
    // Both always passed, as the permission mode is: left out, your own settings would decide (#60).
    '--model',
    modelOf(persona),
    '--effort',
    effortOf(persona),
    ...sessionArgs(sessionId, resume, fork),
    // Postbox’s server, next to your own; an Isolated persona loads Postbox’s only.
    '--mcp-config',
    JSON.stringify({ mcpServers: server ?? postboxServer(mcpUrl) }),
    ...(setup.usesHostSetup ? [] : ['--strict-mcp-config']),
    '--append-system-prompt',
    guide,
    // Postbox’s own tools never need asking: they only show things in the thread.
    '--allowedTools',
    'mcp__postbox',
    // Rules the person allowed once, after a refusal, for this turn only, and those for this conversation (#66).
    ...allowOnce,
    ...(rules.allow ?? []),
    // The person’s Claude Code setup (or the project’s only, when Isolated), with the default output style,
    // without the MCP servers the persona turned off, and without the tools it may not use: those that publish
    // or act outside Postbox, and its unticked Tools (server/adapters/setup.mjs).
    '--setting-sources',
    (setup.usesHostSetup ? HOST_SOURCES : ISOLATED_SOURCES).join(','),
    '--settings',
    JSON.stringify(settings),
    ...(denied.length ? ['--disallowedTools', ...denied] : []),
    ...MODES[mode],
    ...addDirs.flatMap((d) => ['--add-dir', d]),
    // Postbox’s skills, beside the person’s own.
    ...plugins.flatMap((p) => ['--plugin-dir', p]),
    ...(mode === 'bypass' ? [] : denyPrompts ? ['--permission-prompts', 'none'] : ['--permission-prompt-tool', 'mcp__postbox__permission_prompt']),
  ];
}
