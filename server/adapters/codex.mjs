// OpenAI Codex app-server backend. Each Postbox session owns a persistent app-server thread; the local
// `codex` installation supplies sign-in, configuration, sandboxing and the model catalog.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { describeTool, isQuietTool } from './claude-stream.mjs';
import { codexApproval } from './codex-approval.mjs';
import { codexMcpApprovalConfig, postboxMcpApprovalArgs } from './codex-mcp-policy.mjs';
import { findCodex } from './codex-models.mjs';
import { attachmentPaths, CODEX_REMOTE, createCodexHost, interruptReached, pickUp, remoteEnd, spawnRemoteCodex } from './codex-remote.mjs';
import { openCodexThread } from './codex-thread.mjs';
import { codexContextPercent } from './context-usage.mjs';
import { agentFolder } from './folder.mjs';
import { formatMessage, turnGuide } from './guide.mjs';
import { listProcesses, stopTurn } from './process-group.mjs';
import { AUTO_MODEL, effortOf, POSTBOX_SERVER, recorderFor } from './setup.mjs';
import { codexWork } from './work-calls.mjs';

export { codexModels, codexVersion, findCodex } from './codex-models.mjs';
export { codexRemoteConfigArgs, createCodexRebuild, INTERRUPT_REACH_MS, interruptedError } from './codex-remote.mjs';
export { codexApproval };

// Codex always reads your own Codex configuration and MCP servers: there’s no Isolated mode (isolation: false). On a
// remote host (#120), it runs as CODEX_REMOTE says (server/adapters/codex-remote.mjs).
export const CODEX_CAPABILITIES = Object.freeze({
  resume: true,
  fork: true,
  permissions: 'none',
  tools: 'none',
  isolation: false,
  promptTool: false,
  remote: CODEX_REMOTE,
});

/** A local folder’s real path, or the folder as given if it can’t be resolved: Codex refuses a writable root with a symlink in its path. */
const realFolder = (dir) => realpath(dir).catch(() => dir);

/**
 * The sandbox and approvals for a turn. In Auto, Codex’s own reviewer (approvalsReviewer auto_review) approves or
 * denies what the sandbox stops, as Claude Code’s classifier does, instead of asking the person; Codex keeps a reviewer
 * for later turns, so every other mode names the person.
 */
export function codexPermissions(persona, cwd) {
  const mode = persona?.permissionMode ?? 'auto';
  const sandboxPolicy =
    mode === 'bypass'
      ? { type: 'dangerFullAccess' }
      : mode === 'ask'
        ? { type: 'readOnly' }
        : { type: 'workspaceWrite', ...(cwd ? { writableRoots: [cwd] } : {}), networkAccess: false };
  return { sandboxPolicy, approvalPolicy: mode === 'bypass' ? 'never' : 'on-request', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user' };
}

/**
 * The model to name in thread/start and turn/start, or null to name none, so Codex uses its own default: null for no
 * model, the mock, AUTO_MODEL and any Claude model. Codex runs none of Claude’s, and named, one fails the turn: Claude’s
 * default, say, on a persona made while Postbox had no Codex list, or one moved here from Claude Code.
 */
export const codexModelOf = (persona) => {
  const model = persona?.model ? String(persona.model) : '';
  return !model || model === 'mock' || model === AUTO_MODEL || model.startsWith('claude-') ? null : model;
};
const codexEffortOf = (persona) => (effortOf(persona) === 'max' ? 'xhigh' : effortOf(persona));

export function codexConfigArgs(mcpUrl) {
  // Codex's -c overrides are TOML expressions. JSON string quoting is valid TOML basic-string quoting.
  return [
    '-c',
    `mcp_servers.${POSTBOX_SERVER}.url=${JSON.stringify(mcpUrl)}`,
    '-c',
    `mcp_servers.${POSTBOX_SERVER}.enabled=true`,
    '-c',
    `mcp_servers.${POSTBOX_SERVER}.required=true`,
    ...postboxMcpApprovalArgs(),
  ];
}

const errorText = (x) => x?.error?.message ?? x?.message ?? 'Codex app-server failed.';

/** Translate app-server notifications into Postbox turn events. io.read: a file’s text, for the work ledger (work-calls.mjs). */
export function createCodexMapper(ctx, io = {}) {
  const labels = new Map();
  const work = codexWork(ctx, io);
  const messageText = new Map();
  let lastMessageId = null;
  const writeMessage = (id, text) => {
    if (lastMessageId !== null && id !== lastMessageId) ctx.text('\n\n');
    lastMessageId = id;
    ctx.text(text);
  };
  const pushItem = (item, state = 'running') => {
    if (!item?.id) return;
    if (item.type === 'commandExecution') {
      const label = describeTool('Bash', { command: item.command, cwd: item.cwd });
      labels.set(item.id, label);
      if (!isQuietTool('Bash')) ctx.activity({ id: item.id, label, state, kind: 'tool' });
    } else if (item.type === 'mcpToolCall') {
      const label = `${item.server === POSTBOX_SERVER ? '' : `${item.server}: `}${item.tool}`;
      labels.set(item.id, label);
      if (item.server !== POSTBOX_SERVER && !isQuietTool(item.tool)) ctx.activity({ id: item.id, label, state, kind: 'tool' });
    } else if (item.type === 'fileChange') {
      const label = `Edit ${
        item.changes
          ?.map((x) => x.path)
          .filter(Boolean)
          .join(', ') || 'files'
      }`;
      labels.set(item.id, label);
      ctx.activity({ id: item.id, label, state, kind: 'tool' });
    } else if (item.type === 'reasoning') ctx.status({ state: 'think' });
    else if (item.type === 'webSearch') {
      const label = `Search the web${item.query ? `: ${item.query}` : ''}`;
      labels.set(item.id, label);
      ctx.activity({ id: item.id, label, state, kind: 'tool' });
    }
  };
  const push = (msg) => {
    const p = msg?.params ?? {};
    switch (msg?.method) {
      case 'item/started':
        pushItem(p.item);
        work.started(p.item);
        break;
      case 'item/completed': {
        const item = p.item;
        work.completed(item);
        if (item?.type === 'agentMessage' && item.text && !messageText.has(item.id)) writeMessage(item.id, item.text);
        if (item?.type === 'webSearch' && item.query) labels.set(item.id, `Search the web: ${item.query}`);
        const label = labels.get(item?.id);
        if (label && !(item?.type === 'mcpToolCall' && item.server === POSTBOX_SERVER))
          ctx.activity({ id: item.id, label, state: item.status === 'failed' || item.status === 'declined' ? 'denied' : 'done', kind: 'tool' });
        break;
      }
      case 'item/agentMessage/delta':
        if (typeof p.delta === 'string') {
          messageText.set(p.itemId, `${messageText.get(p.itemId) ?? ''}${p.delta}`);
          ctx.status({ state: 'gen', currentStep: 'Writing a reply' });
          writeMessage(p.itemId, p.delta);
        }
        break;
      case 'item/commandExecution/outputDelta': {
        const id = p.itemId;
        if (id && labels.has(id)) ctx.activity({ id, label: labels.get(id), state: 'running', detail: String(p.delta ?? '').slice(-500), kind: 'tool' });
        break;
      }
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage ?? p.token_usage;
        const win = u?.modelContextWindow ?? u?.model_context_window ?? null;
        const last = u?.last ?? u?.total ?? {};
        const input = last.inputTokens ?? last.input_tokens ?? 0;
        const pct = codexContextPercent(input, win);
        ctx.status({ ctx: pct });
        break;
      }
      case 'turn/started':
        ctx.status({ state: 'think' });
        break;
      case 'turn/completed': {
        const status = p.turn?.status;
        if (p.turn?.model) ctx.reported?.({ model: p.turn.model, effort: p.turn.effort ?? codexEffortOf(ctx.persona) });
        if (p.turn?.id) ctx.checkpoint?.({ turnId: p.turn.id, threadId: ctx.state.codexThreadId });
        return { completed: true, status };
      }
      case 'error':
        return { error: errorText(p) };
      default:
        break;
    }
    return null;
  };
  return { push };
}

/**
 * Answers an app-server approval or elicitation request, unless the host already has (remote turns: `host` is
 * codex-remote.mjs’s createCodexHost, null here).
 * @param {any} ctx @param {any} host @param {(payload: any) => void} send @param {any} msg
 */
async function answerRequest(ctx, host, send, msg) {
  let reply;
  const asking = host ? host.asking(ctx, msg.id) : ctx;
  try {
    reply = { id: msg.id, result: await codexApproval(asking, msg) };
  } catch (error) {
    reply = { id: msg.id, error: { code: -32601, message: error.message } };
  }
  if (!host?.answered(msg.id)) send(reply);
}

/**
 * Opens the turn’s Codex thread (a fork at the saved point, a resume, or a new one), saves it, and starts the turn.
 * Returns turn/start’s answer, and the model it named.
 * @param {any} ctx @param {(method: string, params?: any) => Promise<any>} request @param {(payload: any) => void} send
 * @param {string} cwd @param {any} session @param {any} message
 */
async function startTurn(ctx, request, send, cwd, session, message) {
  await request('initialize', { clientInfo: { name: 'postbox', title: 'Postbox', version: '0.2.0' } });
  send({ method: 'initialized', params: {} });
  const permissions = codexPermissions(ctx.persona, cwd);
  const mcpConfig = await codexMcpApprovalConfig(request, ctx.persona?.permissionMode);
  // The guide belongs on thread start/resume/fork; turn/start has no top-level settings field.
  const { guide, message: turnMessage } = turnGuide(message, { ...ctx, session, brief: session?.brief, toolRules: null });
  const openConfig = { developerInstructions: guide, ...(mcpConfig ? { config: mcpConfig } : {}) };
  const model = codexModelOf(ctx.persona);
  const fork = ctx.state.fork ?? ctx.state.forkFrom;
  const sourceThreadId = fork?.threadId ?? ctx.state.codexThreadId;
  const { opened, fresh } = await openCodexThread(ctx, request, { sourceThreadId, fork, cwd, model, openConfig });
  const id = opened?.thread?.id ?? (fresh ? null : sourceThreadId);
  if (!id) throw new Error('Codex app-server did not return a thread id.');
  ctx.state.codexThreadId = id;
  ctx.saveState({ codexThreadId: id, fork: null, forkFrom: null });
  const note = '[Postbox] Your earlier conversation in this thread couldn’t be loaded, so this is a fresh start.\n\n';
  const inputText = formatMessage(fresh ? { ...turnMessage, text: note + turnMessage.text } : turnMessage, attachmentPaths(ctx, ctx.remote?.turn));
  const started = await request('turn/start', {
    threadId: id,
    input: [{ type: 'text', text: inputText }],
    ...(model ? { model } : {}),
    effort: codexEffortOf(ctx.persona),
    cwd,
    ...permissions,
  });
  return { started, model };
}

export class CodexAdapter {
  name = 'codex';
  /**
   * @param {{ bin?: string, workRoot?: string, models?: string[], spawnImpl?: typeof spawn, kill?: typeof process.kill,
   *           listProcesses?: typeof listProcesses }} opts  models: what codexModels found here; AUTO_MODEL is offered
   *   after them, and alone when there are none (Codex only on a host, #120), so the model field never falls back to
   *   Claude’s models, which Codex doesn’t run
   */
  constructor({ bin = findCodex(), workRoot = process.cwd(), models = [], spawnImpl = spawn, kill = process.kill, listProcesses: list = listProcesses } = {}) {
    this.bin = bin;
    this.kill = kill;
    this.list = list;
    this.workRoot = workRoot;
    this.spawn = spawnImpl;
    this.capabilities = { ...CODEX_CAPABILITIES, models: [...new Set([...models, AUTO_MODEL])] };
  }
  /** The folder the agent works in, by the rule every backend shares (folder.mjs). */
  folderFor(persona, project) {
    return agentFolder(persona, project, this.workRoot);
  }
  /**
   * Runs one turn, on a host with ctx.remote (#120: server/adapters/codex-remote.mjs).
   * @param {any} session @param {any} message @param {any} ctx
   */
  async deliver(session, message, ctx) {
    const remote = ctx.remote ?? null;
    const attach = remote?.attach ?? null;
    const cwd = remote ? remote.folder : await realFolder(await this.folderFor(ctx.persona, ctx.project));
    const args = ['app-server', '--listen', 'stdio://', ...codexConfigArgs(ctx.mcpUrl)];
    // Its own process group, so stopping the turn reaches everything the app-server started (#126); on a host, the daemon’s.
    /** @type {any} */
    const child = remote
      ? spawnRemoteCodex(remote, attach, cwd, this.bin)
      : this.spawn(this.bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, detached: true });
    const exitedP = new Promise((r) => {
      child.once('exit', r);
      child.once('close', r);
      child.once('error', r);
    });
    if (process.env.POSTBOX_CODEX_RECORD) mkdirSync(process.env.POSTBOX_CODEX_RECORD, { recursive: true });
    const record = recorderFor(ctx, process.env.POSTBOX_CODEX_RECORD, 'codex');
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const rl = createInterface({ input: child.stdout });
    let requestId = 1;
    let activeTurnId = null;
    const pending = new Map();
    let exited = false;
    /** What Codex last said went wrong in this turn, for the turn’s failure to give as its reason (#61). */
    let reported = null;
    /** @type {(err?: Error) => void} */
    let finish = () => {};
    // The turn’s end: resolved when it completes or you stop it, rejected with why when it fails. It can fail before
    // it’s awaited (the app-server exits while it starts), so a rejection waits for the await below.
    const ended = new Promise((resolve, reject) => {
      finish = (err) => (err ? reject(err) : resolve(undefined));
    });
    ended.catch(() => {});
    const why = (text) => `${text}${reported ? `: ${reported}` : '.'}`;
    /** @type {(Error & { code?: string }) | null} how a remote turn ended, when that’s why it can’t finish */
    let endError = null;
    const host = remote ? createCodexHost(child, remote, attach) : null;
    const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = requestId++;
        pending.set(id, { resolve, reject, method });
        send({ id, method, params });
      });
    const mapper = createCodexMapper(ctx);
    const fail = (err) => {
      for (const x of pending.values()) x.reject(err);
      pending.clear();
    };
    const answer = (msg) => answerRequest(ctx, host, send, msg);
    const onLine = async (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      record(line);
      if (host?.rebuilding) host.rebuild?.out(msg);
      if (msg.id != null && pending.has(msg.id)) {
        const item = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? item.reject(Object.assign(new Error(errorText(msg)), { code: msg.error.code })) : item.resolve(msg.result);
        return;
      }
      if (msg.id != null && msg.method) {
        // App-server initiated approval/elicitation request; one replayed after a restart waits for the rebuild (pickUp).
        if (!host?.rebuilding) await answer(msg);
        return;
      }
      if (host?.rebuilding && msg.id != null) return; // a response to the Postbox before the restart
      if (msg.method === 'turn/started') activeTurnId = msg.params?.turn?.id ?? activeTurnId;
      const result = mapper.push(msg);
      if (result?.completed) {
        const err = result.status === 'completed' ? undefined : new Error(why(`Codex turn ${result.status ?? 'did not complete'}`));
        if (err) fail(err);
        finish(err);
      } else if (result?.error) {
        reported = result.error;
        fail(new Error(result.error));
      }
    };
    rl.on('line', (line) => {
      if (host?.rebuilding) host.replay(line, onLine, fail);
      else void onLine(line).catch(fail);
    });
    child.on('error', (e) => {
      if (child.remote) endError ??= e;
      const err = new Error(
        /** @type {any} */ (e).code === 'ENOENT'
          ? 'Codex CLI is not installed or not on PATH. Install it, or set POSTBOX_CODEX_BIN.'
          : child.remote
            ? `Codex on the host stopped being reachable: ${e.message}`
            : `Codex app-server could not start: ${e.message}`,
      );
      fail(err);
      if (!child.remote) finish(err); // a remote turn ends at its close, which comes next and fails it with endError
    });
    child.on('close', (code) => {
      exited = true;
      endError ??= remoteEnd(child);
      const err =
        endError ??
        new Error(
          code !== 0
            ? why(`Codex app-server exited with code ${code}${stderr ? ` (${stderr.trim().slice(-500)})` : ''}`)
            : why('Codex app-server exited before the turn completed'),
        );
      fail(err);
      finish(err);
    });
    // Stop asks Codex to interrupt the turn; the app-server itself is stopped as the turn ends, below.
    const onAbort = () => {
      const threadId = ctx.state.codexThreadId ?? host?.rebuild?.threadId; // one still being rebuilt: what the rebuild has
      const turnId = activeTurnId ?? host?.rebuild?.turnId;
      if (host?.rebuilding && host.rebuild) requestId = Math.max(requestId, host.rebuild.nextRequestId());
      if (!threadId || !turnId) return finish();
      const id = requestId++;
      send({ id, method: 'turn/interrupt', params: { threadId, turnId } });
      if (child.remote) interruptReached(child, id).then(() => finish());
      else finish();
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (attach && host) {
        const resume = (turnId, next) => {
          activeTurnId = turnId;
          requestId = Math.max(requestId, next);
        };
        return await pickUp(host, ctx, { ended, exited: () => exited, resume, answer, fail });
      }
      const { started, model } = await startTurn(ctx, request, send, cwd, session, message);
      activeTurnId = started?.turn?.id ?? activeTurnId;
      ctx.reported?.({
        ...(started?.turn?.model || model ? { model: started?.turn?.model ?? model } : {}),
        effort: started?.turn?.effort ?? codexEffortOf(ctx.persona),
      });
      await ended;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      rl.close();
      // The turn ends once the app-server's whole group has exited: SIGINT, then SIGKILL. Until then the session reads
      // stopping, so the next turn can't resume this Codex thread beside a process that's still running it (#126).
      if (!exited) await (await stopTurn(child, { exited: exitedP, kill: this.kill, list: this.list })).gone;
    }
  }
}
