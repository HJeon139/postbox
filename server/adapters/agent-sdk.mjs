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
// POSTBOX_SDK_RECORD=<folder> saves each turn’s messages there, one JSON line each, as the other backends record theirs (#1315).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { withQuota } from '../harness-failure.mjs';
import { liveControl } from './agent-sdk-live.mjs';
import { sdkModels } from './claude-models.mjs';
import { createStreamMapper, forkPointMissing, resultError, windowFor } from './claude-stream.mjs';
import { agentFolder, memoryRootFor } from './folder.mjs';
import { FRESH_START_TEXT, formatMessage, turnGuide } from './guide.mjs';
import { listProcesses, stopJobUnder, stopTurn } from './process-group.mjs';
import { recordOnce } from './prompt-sent.mjs';
import { backgroundWaitEnv, stoppedAfterReply } from './sdk-background.mjs';
import { listCommands } from './sdk-commands.mjs';
import { sdkOptions } from './sdk-options.mjs';
import { canUseTool as sdkCanUseTool } from './sdk-permission.mjs';
import { effortOf, fromContext, recorderFor } from './setup.mjs';

export { sdkOptions };

/** Loads the SDK, or returns null when it isn’t installed. */
export async function loadAgentSdk() {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    return typeof sdk.query === 'function' ? sdk : null;
  } catch {
    return null;
  }
}

/** Where a forked session starts: the branch point’s checkpoint, or the latest point of the session it forks. */
export function sdkForkPoint(state) {
  if (state.fork?.sdkSessionId) return state.fork;
  const from = state.forkFrom?.sdkSessionId;
  return from ? { sdkSessionId: from } : null;
}

/**
 * What a turn’s init message tells its session: the skills and commands with their descriptions and argument hints
 * (#67), once the session is up, where init’s list (names only, from the stream mapper) stands if the SDK can’t say;
 * the SDK’s session id, kept for the next turn to resume; and that its CLI started on the query’s prompt (#1528).
 * @param {any} q  the running query @param {any} m  its init message @param {any} ctx
 * @param {() => void} started  records the query’s prompt, at its first init only (server/adapters/prompt-sent.mjs)
 */
function noteInit(q, m, ctx, started) {
  started();
  listCommands(q, m, ctx);
  if (m.session_id && m.session_id !== ctx.state.sdkSessionId) {
    ctx.saveState({ sdkSessionId: m.session_id, fork: null });
    ctx.state.sdkSessionId = m.session_id;
  }
}

export class AgentSdkAdapter {
  name = 'agent-sdk';
  // It asks through canUseTool (sdk-permission.mjs), never through permission_prompt (#220).
  capabilities = { promptTool: false, images: true, skills: true };

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

  /** The models its harness offers, for the model field (server/model-lists.mjs). Empty if it can’t list. */
  listModels() {
    return sdkModels(this.sdk);
  }

  /** The folder the agent works in, by the rule every backend shares (folder.mjs). */
  folderFor(persona, project) {
    return agentFolder(persona, project, this.workRoot);
  }

  /** A turn’s folders, guide, prompt and the SDK session it resumes or starts. @param {any} session @param {any} message @param {any} ctx */
  async turnSetup(session, message, ctx) {
    const persona = ctx.persona;
    const cwd = await this.folderFor(persona, ctx.project);
    // The project’s folder, and the folders the person added for this conversation (#66).
    const addDirs = [...new Set([ctx.project?.folder, ...(ctx.addDirs ?? [])])].filter((d) => d && d !== cwd);
    const turned = turnGuide(message, { persona, session, handles: ctx.handles, room: ctx.room, project: ctx.project, brief: session?.brief });
    const [guide, prompt] = [turned.guide, formatMessage(turned.message, ctx.pathOf)];
    const resume = Boolean(ctx.state.sdkSessionId);
    const fork = resume ? null : sdkForkPoint(ctx.state);
    const sessionId = ctx.state.sdkSessionId ?? randomUUID();
    if (!resume && !fork) ctx.saveState({ sdkSessionId: sessionId });
    return { persona, cwd, addDirs, guide, prompt, resume, fork, sessionId };
  }

  async deliver(session, message, ctx) {
    const { persona, cwd, addDirs, guide, prompt, resume, fork, sessionId } = await this.turnSetup(session, message, ctx);

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
      stopping = stopTurn(child, { keep, exited, ...procs, unkilled: ctx.unkilled }).then((r) => {
        for (const k of r.kept) ctx.job?.({ id: k.id, kept: true, pgid: k.pgid, groups: k.groups });
        return r;
      });
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });

    const canUseTool = (toolName, input, opts) => sdkCanUseTool(ctx, toolName, input, opts);

    const mapper = createStreamMapper(ctx, { contextWindow: ctx.state.contextWindow ?? windowFor(persona.model), effort: effortOf(persona) });
    const record = recorderFor(ctx, process.env.POSTBOX_SDK_RECORD);
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
        ...fromContext(ctx, memoryRootFor(this.workRoot)),
      }),
      spawnClaudeCodeProcess,
      // The SDK’s wait for background work after the reply, at Postbox’s bound rather than its 10 min (#1714).
      env: backgroundWaitEnv(),
    };
    const late = stoppedAfterReply();
    /** @type {any} */
    let thrown = null;
    try {
      const q = this.sdk.query({ prompt, options });
      // A background job’s own Stop, while the CLI waits for it.
      ctx.control?.({ ...liveControl(q, persona.permissionMode ?? 'auto'), stopJob: (job) => stopJobUnder(child, job, procs) });
      const started = recordOnce(ctx, { guide, text: prompt });
      for await (const m of q) {
        record(JSON.stringify(m));
        mapper.push(m);
        late.push(m);
        if (m.type === 'system' && m.subtype === 'init') noteInit(q, m, ctx, started);
      }
    } catch (e) {
      if (ctx.signal.aborted) return;
      thrown = e;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      ctx.saveState(mapper.endState);
      // Background work the bound still stopped after the reply: the agent hears what, at its next turn (#1714).
      if (!ctx.signal.aborted && late.told()) ctx.tell?.(late.told());
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
        return this.deliver(session, { kind: 'notice', text: `${FRESH_START_TEXT}\n\n${prompt}` }, ctx);
      }
      // The result says why, when there was one; the SDK’s own error (“process exited with code 1”) doesn’t, and the SDK
      // adds no stderr to it for a process it didn’t spawn, so the last lines of the CLI’s stderr go with it (#61).
      const why = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      const said = mapper.result?.is_error ? (resultError(mapper.result) ?? '') : `The Agent SDK stopped: ${thrown.message}${why ? `: ${why}` : ''}`;
      throw withQuota(new Error(said), mapper.quota);
    }
    const current = mapper.sessionId ?? ctx.state.sdkSessionId;
    if (mapper.lastUuid && current) ctx.checkpoint?.({ sdkSessionId: current, uuid: mapper.lastUuid });
    if (ctx.signal.aborted) return;
    const failure = resultError(mapper.result);
    if (failure) throw withQuota(new Error(failure), mapper.quota);
  }
}
