// The query() options for one Agent SDK turn (server/adapters/agent-sdk.mjs): the model, the session it resumes or
// forks, Postbox’s server, the person’s setup or the project’s only, the tools it may not use, and how it asks.

import { withAskRules } from '../permission-rules.mjs';
import { MODES } from './agent-sdk-live.mjs';
import { deniedTools, effortOf, HOST_SOURCES, ISOLATED_SOURCES, modelOf, postboxServer, settingsFor, setupOf, writeRules } from './setup.mjs';

/** The query() options for one turn. Pure apart from the callbacks, so the tests can check them. */
/**
 * @param {{ persona: any, cwd: string, addDirs?: string[], sessionId: string, resume: boolean, mcpUrl: string, guide: string,
 *           abortController: AbortController, canUseTool?: Function, fork?: any, allowOnce?: string[],
 *           rules?: { allow?: string[], ask?: string[], deny?: string[] }, memoryDir?: string|null, plugins?: string[] }} turn
 *   rules: the ones the person made for this conversation only (#66), passed every turn. memoryDir: the persona’s own (#208).
 *   plugins: plugin folders to load, Postbox’s own (agent-plugin.mjs).
 */
export function sdkOptions({
  persona,
  cwd,
  addDirs = [],
  sessionId,
  resume,
  mcpUrl,
  guide,
  abortController,
  canUseTool,
  fork = null,
  allowOnce = [],
  rules = {},
  memoryDir = null,
  plugins = [],
}) {
  const mode = persona.permissionMode in MODES ? persona.permissionMode : 'auto';
  const setup = setupOf(persona);
  const denied = [...deniedTools(persona), ...(rules.deny ?? [])];
  const allowed = [...allowOnce, ...(rules.allow ?? [])];
  return {
    cwd,
    additionalDirectories: addDirs,
    // Both always passed, as for the CLI: left out, your own settings would decide (#60).
    model: modelOf(persona),
    effort: effortOf(persona),
    // A topic thread’s first turn forks the conversation’s session at the message it branched from.
    ...(fork
      ? { resume: fork.sdkSessionId ?? fork.claudeSessionId, forkSession: true, ...(fork.uuid ? { resumeSessionAt: fork.uuid } : {}) }
      : resume
        ? { resume: sessionId }
        : { sessionId }),
    includePartialMessages: true,
    // Postbox’s server, next to your own; an Isolated persona loads Postbox’s only.
    mcpServers: postboxServer(mcpUrl),
    ...(setup.usesHostSetup ? {} : { strictMcpConfig: true }),
    // No allowedTools rule for Postbox’s tools: one would shadow canUseTool, which allows them itself. Only
    // rules the person allowed once, after a refusal, and those for this conversation (#66), go here.
    ...(allowed.length ? { allowedTools: allowed } : {}),
    // As for the CLI: the person’s setup (or the project’s only, when Isolated), the default output style, no MCP
    // servers the persona turned off, and none of the tools it may not use (server/adapters/setup.mjs).
    // A ticked tool is never an allow rule: the permission mode still decides.
    settingSources: [...(setup.usesHostSetup ? HOST_SOURCES : ISOLATED_SOURCES)],
    // The persona’s own memory folder (#208); writes outside Postbox ask first (#112), through canUseTool, so the card shows the draft.
    settings: withAskRules(settingsFor(persona, memoryDir), [...writeRules(persona), ...(rules.ask ?? [])]),
    ...(denied.length ? { disallowedTools: denied } : {}),
    // Readable thinking, and subagents’ own messages, so Postbox can show what the agent is on.
    thinking: { type: 'adaptive', display: 'summarized' },
    forwardSubagentText: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: guide },
    // Postbox’s skills, beside the person’s own.
    plugins: plugins.map((path) => ({ type: /** @type {const} */ ('local'), path })),
    permissionMode: MODES[mode],
    ...(mode === 'bypass' ? { allowDangerouslySkipPermissions: true } : { canUseTool }),
    abortController,
  };
}
