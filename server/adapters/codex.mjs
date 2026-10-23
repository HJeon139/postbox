// OpenAI Codex app-server backend. Each Postbox session owns a persistent app-server thread; the local
// `codex` installation supplies sign-in, configuration, sandboxing and the model catalog.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { describeTool, isQuietTool } from './claude-stream.mjs';
import { agentGuide, formatMessage } from './guide.mjs';
import { effortOf, POSTBOX_SERVER } from './setup.mjs';

export const CODEX_CAPABILITIES = Object.freeze({ resume: true, fork: true, permissions: 'none', tools: 'none' });
export const findCodex = (env = process.env) => env.POSTBOX_CODEX_BIN || 'codex';

function probe(bin, args, timeout = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (chunk) => {
      out = (out + chunk).slice(-300_000);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
  });
}
export async function codexVersion(bin = findCodex()) {
  const out = await probe(bin, ['--version']);
  return out?.match(/(?:codex\s+)?([\w.-]+)$/i)?.[1] ?? null;
}
export async function codexModels(bin = findCodex()) {
  // The documented app-server model/list method returns the local account's picker-visible catalog.
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve([]);
      return;
    }
    const rl = createInterface({ input: child.stdout });
    let id = 1;
    let timer;
    const finish = (models) => {
      clearTimeout(timer);
      child.kill('SIGTERM');
      rl.close();
      resolve(models);
    };
    timer = setTimeout(() => finish([]), 15000);
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1 && msg.result) {
        child.stdin.write(`${JSON.stringify({ id: ++id, method: 'model/list', params: { limit: 100, includeHidden: false } })}\n`);
      } else if (msg.id === 2) {
        clearTimeout(timer);
        const models = (msg.result?.data ?? []).map((m) => m?.id ?? m?.model).filter((m) => typeof m === 'string' && /^[\w.-]{1,80}$/.test(m));
        finish([...new Set(models)].slice(0, 60));
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish([]);
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'postbox', title: 'Postbox', version: '0.2.0' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  });
}

export function codexPermissions(persona, cwd) {
  const mode = persona?.permissionMode ?? 'auto';
  const sandboxPolicy =
    mode === 'bypass'
      ? { type: 'dangerFullAccess' }
      : mode === 'ask'
        ? { type: 'readOnly' }
        : { type: 'workspaceWrite', ...(cwd ? { writableRoots: [cwd] } : {}), networkAccess: false };
  return { sandboxPolicy, approvalPolicy: mode === 'bypass' ? 'never' : 'on-request' };
}

const codexModelOf = (persona) => (persona?.model && persona.model !== 'mock' ? String(persona.model) : null);
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
  ];
}

const errorText = (x) => x?.error?.message ?? x?.message ?? 'Codex app-server failed.';

/** Map app-server command and file-change approval requests onto Postbox's permission card. */
export async function codexApproval(ctx, msg) {
  const p = msg.params ?? {};
  const isFile = msg.method === 'item/fileChange/requestApproval';
  const summary = isFile ? 'Codex wants to change files' : 'Codex wants to run a command';
  const detail = p.command ?? p.reason ?? p.networkApprovalContext?.host ?? p.grantRoot ?? summary;
  const answer = await ctx.askPermission({ tool: isFile ? 'Edit' : 'Bash', summary, detail, toolUseId: p.itemId, suppressAlways: true });
  return { decision: answer?.allow ? 'accept' : 'decline' };
}

/** Translate app-server notifications into Postbox turn events. */
export function createCodexMapper(ctx) {
  const labels = new Map();
  const messageText = new Map();
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
    else if (item.type === 'webSearch') ctx.activity({ id: item.id, label: `Search the web${item.query ? `: ${item.query}` : ''}`, state, kind: 'tool' });
  };
  const push = (msg) => {
    const p = msg?.params ?? {};
    switch (msg?.method) {
      case 'item/started':
        pushItem(p.item);
        break;
      case 'item/completed': {
        const item = p.item;
        if (item?.type === 'agentMessage' && item.text && !messageText.has(item.id)) ctx.text(item.text);
        const label = labels.get(item?.id);
        if (label && !(item?.type === 'mcpToolCall' && item.server === POSTBOX_SERVER))
          ctx.activity({ id: item.id, label, state: item.status === 'failed' || item.status === 'declined' ? 'denied' : 'done', kind: 'tool' });
        break;
      }
      case 'item/agentMessage/delta':
        if (typeof p.delta === 'string') {
          messageText.set(p.itemId, `${messageText.get(p.itemId) ?? ''}${p.delta}`);
          ctx.status({ state: 'gen', currentStep: 'Writing a reply' });
          ctx.text(p.delta);
        }
        break;
      case 'item/commandExecution/outputDelta': {
        const id = p.itemId;
        if (id && labels.has(id)) ctx.activity({ id, label: labels.get(id), state: 'running', detail: String(p.delta ?? '').slice(-500), kind: 'tool' });
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

export class CodexAdapter {
  name = 'codex';
  /** @param {{ bin?: string, workRoot?: string, models?: string[], spawnImpl?: typeof spawn }} opts */
  constructor({ bin = findCodex(), workRoot = process.cwd(), models = [], spawnImpl = spawn } = {}) {
    this.bin = bin;
    this.workRoot = workRoot;
    this.spawn = spawnImpl;
    this.capabilities = { ...CODEX_CAPABILITIES, ...(models.length ? { models } : {}) };
  }
  async folderFor(persona, project) {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = persona.folder || project?.folder || join(this.workRoot, persona.handle);
    await mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }
  async deliver(session, message, ctx) {
    const cwd = await this.folderFor(ctx.persona, ctx.project);
    const args = ['app-server', '--listen', 'stdio://', ...codexConfigArgs(ctx.mcpUrl)];
    const child = this.spawn(this.bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    /** @type {string|null} */
    let recordFile = null;
    if (process.env.POSTBOX_CODEX_RECORD) {
      mkdirSync(process.env.POSTBOX_CODEX_RECORD, { recursive: true });
      recordFile = `${process.env.POSTBOX_CODEX_RECORD}/${Date.now()}-${ctx.persona.handle}.jsonl`;
    }
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const rl = createInterface({ input: child.stdout });
    let requestId = 1;
    let activeTurnId = null;
    const pending = new Map();
    let exited = false;
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
    const onLine = async (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (recordFile) appendFileSync(recordFile, `${line}\n`);
      if (msg.id != null && pending.has(msg.id)) {
        const item = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? item.reject(new Error(errorText(msg))) : item.resolve(msg.result);
        return;
      }
      if (msg.id != null && msg.method) {
        // App-server initiated approval request. Keep Postbox's interactive permission card as the decision point.
        send({ id: msg.id, result: await codexApproval(ctx, msg) });
        return;
      }
      if (msg.method === 'turn/started') activeTurnId = msg.params?.turn?.id ?? activeTurnId;
      const result = mapper.push(msg);
      if (result?.completed) {
        mapper.onComplete?.(result.status);
        if (result.status !== 'completed') fail(new Error(`Codex turn ${result.status ?? 'did not complete'}.`));
      } else if (result?.error) fail(new Error(result.error));
    };
    rl.on('line', (line) => {
      void onLine(line).catch(fail);
    });
    child.on('error', (e) =>
      fail(
        new Error(
          /** @type {any} */ (e).code === 'ENOENT'
            ? 'Codex CLI is not installed or not on PATH. Install it, or set POSTBOX_CODEX_BIN.'
            : `Codex app-server could not start: ${e.message}`,
        ),
      ),
    );
    child.on('close', (code) => {
      exited = true;
      if (code !== 0) fail(new Error(`Codex app-server exited with code ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ''}.`));
    });
    const onAbort = () => {
      const threadId = ctx.state.codexThreadId;
      if (threadId && activeTurnId) send({ id: requestId++, method: 'turn/interrupt', params: { threadId, turnId: activeTurnId } });
      setTimeout(() => {
        if (!exited) child.kill('SIGTERM');
      }, 2500).unref?.();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await request('initialize', { clientInfo: { name: 'postbox', title: 'Postbox', version: '0.2.0' } });
      send({ method: 'initialized', params: {} });
      const permissions = codexPermissions(ctx.persona, cwd);
      const fork = ctx.state.fork ?? ctx.state.forkFrom;
      const sourceThreadId = fork?.threadId ?? ctx.state.codexThreadId;
      const opened =
        fork?.turnId && sourceThreadId
          ? await request('thread/fork', { threadId: sourceThreadId, lastTurnId: fork.turnId, excludeTurns: true })
          : sourceThreadId
            ? await request('thread/resume', { threadId: sourceThreadId, cwd })
            : await request('thread/start', { cwd, ...(codexModelOf(ctx.persona) ? { model: codexModelOf(ctx.persona) } : {}) });
      const threadId = sourceThreadId;
      const id = opened?.thread?.id ?? threadId;
      if (!id) throw new Error('Codex app-server did not return a thread id.');
      ctx.state.codexThreadId = id;
      ctx.saveState({ codexThreadId: id, fork: null, forkFrom: null });
      const guide = agentGuide({ persona: ctx.persona, handles: ctx.handles, project: ctx.project, brief: session?.brief });
      const inputText = formatMessage(message, ctx.pathOf);
      const started = await request('turn/start', {
        threadId: id,
        input: [{ type: 'text', text: inputText }],
        settings: { developer_instructions: guide },
        ...(codexModelOf(ctx.persona) ? { model: codexModelOf(ctx.persona) } : {}),
        effort: codexEffortOf(ctx.persona),
        cwd,
        ...permissions,
      });
      activeTurnId = started?.turn?.id ?? activeTurnId;
      ctx.reported?.({
        ...(started?.turn?.model || codexModelOf(ctx.persona) ? { model: started?.turn?.model ?? codexModelOf(ctx.persona) } : {}),
        effort: started?.turn?.effort ?? codexEffortOf(ctx.persona),
      });
      await new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (ctx.signal.aborted) {
            clearInterval(check);
            resolve(undefined);
          } else if (exited) {
            clearInterval(check);
            reject(new Error('Codex app-server exited before the turn completed.'));
          }
        }, 25);
        mapper.onComplete = (status) => {
          clearInterval(check);
          if (status === 'completed' || ctx.signal.aborted) resolve(undefined);
          else reject(new Error(`Codex turn ${status ?? 'did not complete'}.`));
        };
      });
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      if (!exited) child.kill('SIGTERM');
      rl.close();
    }
  }
}
