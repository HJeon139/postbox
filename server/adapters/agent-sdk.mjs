// The Agent SDK backend: each turn runs query() from @anthropic-ai/claude-agent-sdk inside Postbox’s server.
// It uses the same credentials Claude Code does (your sign-in, or ANTHROPIC_API_KEY in the environment);
// Postbox never reads or stores them. The SDK is an optional dependency, loaded only when a turn needs it.
//
// The SDK streams the same messages as `claude -p --output-format stream-json`, so the Claude Code stream
// mapper turns them into Postbox’s turn context here too. Permission prompts arrive through canUseTool and
// become the same card in the thread.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createStreamMapper, describePermission, resultError, windowFor } from './claude-stream.mjs';
import { agentGuide, formatMessage } from './guide.mjs';

const DEFAULT_MODEL = 'claude-opus-5-5';
// Passed explicitly, as for the CLI: an agent set to ask must not inherit a looser mode from your settings.
const MODES = { ask: 'default', acceptEdits: 'acceptEdits', bypass: 'bypassPermissions' };

/** Loads the SDK, or returns null when it isn’t installed. */
export async function loadAgentSdk() {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    return typeof sdk.query === 'function' ? sdk : null;
  } catch {
    return null;
  }
}

/** The query() options for one turn. Pure apart from the callbacks, so the tests can check them. */
/**
 * @param {{ persona: any, cwd: string, addDirs?: string[], sessionId: string, resume: boolean, mcpUrl: string, guide: string,
 *           abortController: AbortController, canUseTool?: Function, fork?: any }} turn
 */
export function sdkOptions({ persona, cwd, addDirs = [], sessionId, resume, mcpUrl, guide, abortController, canUseTool, fork = null }) {
  const mode = persona.permissionMode in MODES ? persona.permissionMode : 'ask';
  return {
    cwd,
    additionalDirectories: addDirs,
    model: persona.model && persona.model !== 'mock' ? persona.model : DEFAULT_MODEL,
    // A topic thread’s first turn forks the conversation’s session at the message it branched from.
    ...(fork
      ? { resume: fork.sdkSessionId ?? fork.claudeSessionId, forkSession: true, ...(fork.uuid ? { resumeSessionAt: fork.uuid } : {}) }
      : resume
        ? { resume: sessionId }
        : { sessionId }),
    includePartialMessages: true,
    mcpServers: { postbox: { type: 'http', url: mcpUrl, alwaysLoad: true } },
    strictMcpConfig: true,
    // No allowedTools rule for Postbox’s tools: one would shadow canUseTool, which allows them itself.
    systemPrompt: { type: 'preset', preset: 'claude_code', append: guide },
    permissionMode: MODES[mode],
    ...(mode === 'bypass' ? { allowDangerouslySkipPermissions: true } : { canUseTool }),
    abortController,
  };
}

/** Where a forked session starts: the branch point’s checkpoint, or the latest point of the session it forks. */
export function sdkForkPoint(state) {
  if (state.fork?.sdkSessionId) return state.fork;
  const from = state.forkFrom?.sdkSessionId;
  return from ? { sdkSessionId: from } : null;
}

export class AgentSdkAdapter {
  name = 'agent-sdk';

  /** @param {{ sdk: { query: Function }, workRoot: string }} opts */
  constructor({ sdk, workRoot }) {
    this.sdk = sdk;
    this.workRoot = workRoot;
  }

  async deliver(session, message, ctx) {
    const persona = ctx.persona;
    // Same folder rule as the Claude Code backend: the persona’s, the project’s, or a workspace of its own.
    const cwd = persona.folder || ctx.project?.folder || join(this.workRoot, persona.handle);
    await mkdir(cwd, { recursive: true }).catch(() => {});
    const addDirs = [ctx.project?.folder].filter((d) => d && d !== cwd);
    const guide = agentGuide({ persona, handles: ctx.handles, project: ctx.project, brief: session?.brief });
    const prompt = formatMessage(message, ctx.pathOf);
    const resume = Boolean(ctx.state.sdkSessionId);
    const fork = resume ? null : sdkForkPoint(ctx.state);
    const sessionId = ctx.state.sdkSessionId ?? randomUUID();
    if (!resume && !fork) ctx.saveState({ sdkSessionId: sessionId });

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });

    const canUseTool = async (toolName, input) => {
      // Postbox’s own tools only show things in the thread.
      if (toolName.startsWith('mcp__postbox__')) return { behavior: 'allow', updatedInput: input };
      const { summary, detail } = describePermission(toolName, input);
      const answer = await ctx.askPermission({ tool: toolName, summary, detail });
      return answer.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: answer.message ?? 'The person didn’t allow this.' };
    };

    const mapper = createStreamMapper(ctx, { contextWindow: ctx.state.contextWindow ?? windowFor(persona.model) });
    let stderr = '';
    const options = {
      ...sdkOptions({ persona, cwd, addDirs, sessionId, resume, mcpUrl: ctx.mcpUrl, guide, abortController, canUseTool, fork }),
      stderr: (d) => {
        stderr = (stderr + d).slice(-4000);
      },
    };
    try {
      for await (const m of this.sdk.query({ prompt, options })) {
        mapper.push(m);
        if (m.type === 'system' && m.subtype === 'init' && m.session_id && m.session_id !== ctx.state.sdkSessionId) {
          ctx.saveState({ sdkSessionId: m.session_id, fork: null });
          ctx.state.sdkSessionId = m.session_id;
        }
      }
    } catch (e) {
      if (ctx.signal.aborted) return;
      // A session the SDK no longer has starts over, once, and says so.
      if (resume && /No conversation found|session .* not found/i.test(`${e.message} ${stderr}`)) {
        ctx.saveState({ sdkSessionId: null });
        ctx.state.sdkSessionId = null;
        return this.deliver(
          session,
          { kind: 'notice', text: `Your earlier conversation in this thread couldn’t be loaded, so this is a fresh start.\n\n${prompt}` },
          ctx,
        );
      }
      throw new Error(`The Agent SDK stopped: ${e.message}`);
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      ctx.saveState({ contextWindow: mapper.contextWindow, model: mapper.model ?? undefined });
    }
    const current = mapper.sessionId ?? ctx.state.sdkSessionId;
    if (mapper.lastUuid && current) ctx.checkpoint?.({ sdkSessionId: current, uuid: mapper.lastUuid });
    if (ctx.signal.aborted) return;
    const failure = resultError(mapper.result);
    if (failure) throw new Error(failure);
  }
}
