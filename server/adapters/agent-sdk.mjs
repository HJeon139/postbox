// The Agent SDK backend: each turn runs query() from @anthropic-ai/claude-agent-sdk inside Postbox’s server.
// It uses the same credentials Claude Code does (your sign-in, or ANTHROPIC_API_KEY in the environment);
// Postbox never reads or stores them. The SDK is an optional dependency, loaded only when a turn needs it.
//
// The SDK streams the same messages as `claude -p --output-format stream-json`, so the Claude Code stream
// mapper turns them into Postbox’s turn context here too. Permission prompts arrive through canUseTool and
// become the same card in the thread.
//
// Postbox spawns the CLI for the SDK (its spawnClaudeCodeProcess option, sdk.d.ts) in a process group of its own, so
// Stop reaches everything it started, as for the Claude Code backend, and a turn ends only once the CLI has exited
// (#126): server/adapters/process-group.mjs.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withAskRules } from '../permission-rules.mjs';
import { commandsOf, createStreamMapper, describePermission, forkPointMissing, resultError, windowFor } from './claude-stream.mjs';
import { agentGuide, formatMessage } from './guide.mjs';
import { listProcesses, stopJobUnder, stopTurn } from './process-group.mjs';
import { deniedTools, effortOf, HOST_SOURCES, ISOLATED_SOURCES, modelOf, postboxServer, settingsFor, setupOf, writeRules } from './setup.mjs';

// Passed explicitly, as for the CLI: an agent set to ask must not inherit a looser mode from your settings.
const MODES = { auto: 'auto', ask: 'default', acceptEdits: 'acceptEdits', bypass: 'bypassPermissions' };

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
 *           abortController: AbortController, canUseTool?: Function, fork?: any, allowOnce?: string[],
 *           rules?: { allow?: string[], ask?: string[], deny?: string[] } }} turn
 *   rules: the ones the person made for this conversation only (#66), passed every turn
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
    // Writes outside Postbox ask first (#112), through canUseTool, so the card shows the draft.
    settings: withAskRules(settingsFor(persona), [...writeRules(persona), ...(rules.ask ?? [])]),
    ...(denied.length ? { disallowedTools: denied } : {}),
    // Readable thinking, and subagents’ own messages, so Postbox can show what the agent is on.
    thinking: { type: 'adaptive', display: 'summarized' },
    forwardSubagentText: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: guide },
    permissionMode: MODES[mode],
    ...(mode === 'bypass' ? { allowDangerouslySkipPermissions: true } : { canUseTool }),
    abortController,
  };
}

/**
 * What the person can change while a turn runs: the permission mode (#66), the model and the effort (#67), with the
 * running query’s setPermissionMode, setModel and applyFlagSettings({ effortLevel }). The SDK documents them for
 * streaming input only, and Postbox sends a turn’s prompt as one string, so each change is tried, and resolves to
 * whether it took effect now; if not, it applies from the next turn, since all three are passed with every turn.
 * @param {any} q  the running query
 */
export function liveControl(q) {
  return {
    /** @param {string} mode  one of Postbox’s modes */
    async setPermissionMode(mode) {
      if (typeof q?.setPermissionMode !== 'function' || !Object.hasOwn(MODES, mode)) return false;
      try {
        await q.setPermissionMode(MODES[/** @type {keyof typeof MODES} */ (mode)]);
        return true;
      } catch {
        return false;
      }
    },
    /** @param {string} model */
    async setModel(model) {
      if (typeof q?.setModel !== 'function') return false;
      try {
        await q.setModel(model);
        return true;
      } catch {
        return false;
      }
    },
    /** @param {string} effort  one of EFFORT_LEVELS */
    async setEffort(effort) {
      if (typeof q?.applyFlagSettings !== 'function') return false;
      try {
        await q.applyFlagSettings({ effortLevel: effort });
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The SDK’s supportedCommands() (name, description, argumentHint), marked as skills where init says so, and without
 * the ones bound to a terminal. It’s a control request, which the SDK documents for streaming input only: if it
 * fails, init’s list stands.
 * @param {any} q @param {any} init @param {any} ctx
 */
export function listCommands(q, init, ctx) {
  if (typeof q?.supportedCommands !== 'function' || !ctx.commands) return;
  const skills = new Set(
    commandsOf(init)
      .filter((c) => c.skill)
      .map((c) => c.name),
  );
  const terminal = new Set(Array.isArray(init?.terminal_slash_commands) ? init.terminal_slash_commands : []);
  Promise.resolve()
    .then(() => q.supportedCommands())
    .then(
      (list) => Array.isArray(list) && ctx.commands(list.filter((c) => !terminal.has(c?.name)).map((c) => (skills.has(c?.name) ? { ...c, skill: true } : c))),
      () => {},
    );
}

/** Where a forked session starts: the branch point’s checkpoint, or the latest point of the session it forks. */
export function sdkForkPoint(state) {
  if (state.fork?.sdkSessionId) return state.fork;
  const from = state.forkFrom?.sdkSessionId;
  return from ? { sdkSessionId: from } : null;
}

export class AgentSdkAdapter {
  name = 'agent-sdk';

  /**
   * @param {{ sdk: { query: Function }, workRoot: string, spawnImpl?: typeof spawn, kill?: import('./process-group.mjs').KillFn,
   *           listProcesses?: () => Promise<import('./process-group.mjs').Proc[]> }} opts
   *   spawnImpl, kill and listProcesses: how the CLI starts, and how Stop signals and finds processes; tests pass fakes
   */
  constructor({ sdk, workRoot, spawnImpl = spawn, kill = process.kill, listProcesses: list = listProcesses }) {
    this.sdk = sdk;
    this.workRoot = workRoot;
    this.spawn = spawnImpl;
    this.kill = kill;
    this.list = list;
  }

  /** Same folder rule as the Claude Code backend: the persona’s, the project’s, or a workspace of its own. */
  async folderFor(persona, project) {
    const dir = persona.folder || project?.folder || join(this.workRoot, persona.handle);
    await mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }

  async deliver(session, message, ctx) {
    const persona = ctx.persona;
    const cwd = await this.folderFor(persona, ctx.project);
    // The project’s folder, and the folders the person added for this conversation (#66).
    const addDirs = [...new Set([ctx.project?.folder, ...(ctx.addDirs ?? [])])].filter((d) => d && d !== cwd);
    const guide = agentGuide({ persona, handles: ctx.handles, room: ctx.room, project: ctx.project, brief: session?.brief });
    const prompt = formatMessage(message, ctx.pathOf);
    const resume = Boolean(ctx.state.sdkSessionId);
    const fork = resume ? null : sdkForkPoint(ctx.state);
    const sessionId = ctx.state.sdkSessionId ?? randomUUID();
    if (!resume && !fork) ctx.saveState({ sdkSessionId: sessionId });

    let stderr = '';
    /** @type {any} */
    let child = null;
    /** @type {Promise<any>|null} */
    let exited = null;
    const procs = { kill: this.kill, list: this.list };
    // The CLI, spawned as the SDK would (sdk.mjs, spawnLocalProcess), but in its own process group. The SDK doesn’t read
    // stderr from a process it didn’t spawn, so it’s read here.
    const spawnClaudeCodeProcess = (/** @type {any} */ o) => {
      child = this.spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true, detached: true });
      const c = child;
      exited = new Promise((r) => {
        c.once('exit', r);
        c.once('error', r);
      });
      c.stderr?.on('data', (d) => {
        stderr = (stderr + d).slice(-4000);
      });
      return c;
    };
    const abortController = new AbortController();
    /** @type {Promise<{ gone: Promise<void> }>|null} */
    let stopping = null;
    const onAbort = () => {
      abortController.abort();
      if (!child || !exited) return;
      // The background jobs the runtime asked to keep running, as for the Claude Code backend.
      const keep = Array.isArray(ctx.signal.reason?.keepJobs) ? ctx.signal.reason.keepJobs : [];
      stopping = stopTurn(child, { keep, exited, ...procs }).then((r) => {
        for (const k of r.kept) ctx.job?.({ id: k.id, kept: true, pgid: k.pgid, groups: k.groups });
        return r;
      });
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });

    const canUseTool = async (toolName, input, opts = {}) => {
      // Postbox’s own tools only show things in the thread.
      if (toolName.startsWith('mcp__postbox__')) return { behavior: 'allow', updatedInput: input };
      const { summary, detail } = describePermission(toolName, input);
      // The prompt’s own suggestions go to Always allow (none, when it has none or says a saved rule would grant more
      // than this call), and its agent id names the subagent that asks (#66).
      const answer = await ctx.askPermission({
        tool: toolName,
        summary,
        detail,
        input,
        suggestions: Array.isArray(opts.suggestions) ? opts.suggestions : [],
        suppressAlways: opts.suppressAlwaysAllowRule === true,
        agentId: opts.agentID ?? null,
        ...(opts.toolUseID ? { toolUseId: opts.toolUseID } : {}),
      });
      return answer.allow
        ? {
            behavior: 'allow',
            updatedInput: answer.updatedInput ?? input,
            ...(answer.updatedPermissions ? { updatedPermissions: answer.updatedPermissions } : {}),
          }
        : { behavior: 'deny', message: answer.message ?? 'The person didn’t allow this.' };
    };

    const mapper = createStreamMapper(ctx, { contextWindow: ctx.state.contextWindow ?? windowFor(persona.model), effort: effortOf(persona) });
    ctx.subagentNames?.((ids) => mapper.who(ids));
    const options = {
      ...sdkOptions({
        persona,
        cwd,
        addDirs,
        sessionId,
        resume,
        mcpUrl: ctx.mcpUrl,
        guide,
        abortController,
        canUseTool,
        fork,
        allowOnce: ctx.allowOnce ?? [],
        rules: ctx.rules ?? {},
      }),
      spawnClaudeCodeProcess,
    };
    /** @type {any} */
    let thrown = null;
    try {
      const q = this.sdk.query({ prompt, options });
      // A background job’s own Stop, while the CLI waits for it.
      ctx.control?.({ ...liveControl(q), stopJob: (job) => stopJobUnder(child, job, procs) });
      for await (const m of q) {
        mapper.push(m);
        // The skills and commands with their descriptions and argument hints (#67), once the session is up; init’s
        // list (names only, from the stream mapper) stands if the SDK can’t say.
        if (m.type === 'system' && m.subtype === 'init') listCommands(q, m, ctx);
        if (m.type === 'system' && m.subtype === 'init' && m.session_id && m.session_id !== ctx.state.sdkSessionId) {
          ctx.saveState({ sdkSessionId: m.session_id, fork: null });
          ctx.state.sdkSessionId = m.session_id;
        }
      }
    } catch (e) {
      if (ctx.signal.aborted) return;
      thrown = e;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      ctx.saveState({ contextWindow: mapper.contextWindow, model: mapper.model ?? undefined });
      // A stopped turn ends once its CLI’s whole group has exited, so the session’s next turn never runs beside it (#126).
      const stopped = /** @type {Promise<{ gone: Promise<void> }>|null} */ (stopping); // set in onAbort
      if (ctx.signal.aborted && stopped) await stopped.then((r) => r.gone);
    }
    // A branch point the SDK can no longer find (#61): fork from the conversation’s latest point instead, once.
    // The failed fork’s session is never resumed, and the fork is saved without its uuid, so a later turn never
    // goes back to the bad one.
    if (fork?.uuid && !ctx.signal.aborted && forkPointMissing(mapper.result, thrown ? `${thrown.message} ${stderr}` : '')) {
      const latest = { sdkSessionId: fork.sdkSessionId };
      ctx.saveState({ sdkSessionId: null, fork: latest });
      ctx.state.sdkSessionId = null;
      ctx.state.fork = latest;
      return this.deliver(
        session,
        {
          kind: 'notice',
          text: `This thread couldn’t start at the message it branched from, so it starts from the conversation’s latest message.\n\n${prompt}`,
        },
        ctx,
      );
    }
    if (thrown) {
      // A session the SDK no longer has starts over, once, and says so.
      if (resume && /No conversation found|session .* not found/i.test(`${thrown.message} ${stderr}`)) {
        ctx.saveState({ sdkSessionId: null });
        ctx.state.sdkSessionId = null;
        return this.deliver(
          session,
          { kind: 'notice', text: `Your earlier conversation in this thread couldn’t be loaded, so this is a fresh start.\n\n${prompt}` },
          ctx,
        );
      }
      // The result says why, when there was one; the SDK’s own error (“process exited with code 1”) doesn’t, and the SDK
      // adds no stderr to it for a process it didn’t spawn, so the last lines of the CLI’s stderr go with it (#61).
      const why = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      throw new Error(mapper.result?.is_error ? (resultError(mapper.result) ?? '') : `The Agent SDK stopped: ${thrown.message}${why ? `: ${why}` : ''}`);
    }
    const current = mapper.sessionId ?? ctx.state.sdkSessionId;
    if (mapper.lastUuid && current) ctx.checkpoint?.({ sdkSessionId: current, uuid: mapper.lastUuid });
    if (ctx.signal.aborted) return;
    const failure = resultError(mapper.result);
    if (failure) throw new Error(failure);
  }
}
