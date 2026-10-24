// OpenAI Codex app-server backend. Each Postbox session owns a persistent app-server thread; the local
// `codex` installation supplies sign-in, configuration, sandboxing and the model catalog.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { hostPaths } from '../../shared/remote-protocol.mjs';
import { defaultHostSettings } from '../../shared/remote-settings.mjs';
import { codexPromptId } from '../remote/host/broker.mjs';
import { remoteSpawn } from '../remote/process.mjs';
import { draftOf } from '../write-guard.mjs';
import { checkRemoteContext, shimArgs } from './adapter.mjs';
import { describeTool, isQuietTool } from './claude-stream.mjs';
import { agentFolder } from './folder.mjs';
import { agentGuide, formatMessage } from './guide.mjs';
import { listProcesses, stopTurn } from './process-group.mjs';
import { AUTO_MODEL, effortOf, PERMISSION_WAIT_MARGIN_MS, POSTBOX_SERVER } from './setup.mjs';

// Codex always reads your own Codex configuration and MCP servers: there’s no Isolated mode (isolation: false).
// On a remote host (#120), stdin stays open for the JSON-RPC until turn/completed, it sets no variable of its own,
// Postbox’s server goes in -c mcp_servers.postbox.* overrides, and while a background command runs the model’s checks
// on it are its sign of work. Its sign-in error isn’t recorded yet.
export const CODEX_CAPABILITIES = Object.freeze({
  resume: true,
  fork: true,
  permissions: 'none',
  tools: 'none',
  isolation: false,
  remote: Object.freeze({ stdin: 'held', env: Object.freeze([]), server: 'codex-config', work: 'model-checks', signInError: null }),
});
export const findCodex = (env = process.env) => env.POSTBOX_CODEX_BIN || 'codex';

function probe(bin, args, timeout = 8000) {
  return new Promise((resolve) => {
    let out = '';
    /** @type {any} */
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
    /** @type {any} */
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
  ];
}

/**
 * For a turn on a host (#120): Postbox’s server is the stdio shim there, `command` with `args`, never the laptop’s URL.
 * The values are TOML: “The `value` portion is parsed as TOML” (codex-rs/utils/cli/src/config_override.rs, `-c`’s
 * help, whose examples include `-c 'sandbox_permissions=["disk-full-read-access"]'`), and `args` is an
 * `array<string>` (Codex’s configuration reference, `mcp_servers.<id>.args`). A JSON array of strings is a TOML inline
 * array of basic strings, as a JSON string is a TOML basic string.
 *
 * A shim call can wait on Postbox (a dropped link, say) until the host’s permissionWaitMax, when the daemon gives up on
 * it, so Codex’s own limit on the call comes an hour later, as Claude Code’s shim `timeout` does: else the agent would
 * get Codex’s timeout instead of the daemon’s answer. Codex cuts every MCP tool call at 60 seconds unless
 * `tool_timeout_sec` says otherwise: “Override the default 60s per-tool timeout for an MCP server”, a `number` of
 * seconds (Codex’s configuration reference, `mcp_servers.<id>.tool_timeout_sec`; codex-rs/config/src/mcp_types.rs reads
 * it as an f64 of seconds, which a TOML integer is too). The laptop’s HTTP server gets none: Codex has no
 * permission_prompt (CODEX_CAPABILITIES.permissions), and Postbox’s other tools answer at once.
 * @param {string} command @param {string[]} args @param {number} waitMax  the host’s permissionWaitMax, in milliseconds
 */
export function codexRemoteConfigArgs(command, args, waitMax) {
  return [
    '-c',
    `mcp_servers.${POSTBOX_SERVER}.command=${JSON.stringify(command)}`,
    '-c',
    `mcp_servers.${POSTBOX_SERVER}.args=${JSON.stringify(args)}`,
    '-c',
    `mcp_servers.${POSTBOX_SERVER}.enabled=true`,
    '-c',
    `mcp_servers.${POSTBOX_SERVER}.required=true`,
    '-c',
    `mcp_servers.${POSTBOX_SERVER}.tool_timeout_sec=${Math.ceil((waitMax + PERMISSION_WAIT_MARGIN_MS) / 1000)}`,
  ];
}

/** A remote turn that can’t go on from what the host kept: the runtime shows it as Interrupted (#120). @param {string} text */
export function interruptedError(text) {
  return Object.assign(new Error(text), { code: 'interrupted' });
}

/** A JSON-RPC ID as a key: Codex’s are integers or strings, so 1 and "1" stay apart. */
const idKey = (id) => JSON.stringify(id);

/** How long Stop on a remote Codex turn waits for its turn/interrupt to reach the host before the daemon’s stop (#120). */
export const INTERRUPT_REACH_MS = 5000;

/**
 * Settles once a remote turn’s turn/interrupt request `id` is in in.jsonl (its 'stdin-line'), the turn has exited, or
 * INTERRUPT_REACH_MS have passed. A held stdin’s lines reach the daemon one at a time (server/remote/process.mjs), so the
 * daemon’s stop, sent as the turn ends, could otherwise pass the interrupt still queued behind another line.
 * @param {any} child  server/remote/process.mjs’s @param {number} id
 */
function interruptReached(child, id) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off('stdin-line', seen);
      child.off('exit', done);
      resolve(undefined);
    };
    const seen = ({ text }) => {
      try {
        const m = JSON.parse(text);
        if (m?.id === id && m.method === 'turn/interrupt') done();
      } catch {}
    };
    const timer = setTimeout(done, INTERRUPT_REACH_MS);
    if (child.ended) return done();
    child.on('stdin-line', seen);
    child.once('exit', done);
  });
}

/**
 * How far a Codex turn on a host had got, rebuilt after a Postbox restart (#120) from its two logs: out.jsonl, the
 * app-server’s messages, and in.jsonl, what reached its stdin (Postbox’s requests and answers, and the daemon’s
 * answers to approvals that expired). It gives the thread and turn IDs, the next request ID Postbox may use, and the
 * approval requests nobody has answered yet. A request counts as settled once in.jsonl answers it, once Codex says
 * so (`serverRequest/resolved`), once the item it asks about has completed, or once the turn has.
 */
export function createCodexRebuild() {
  /** @type {string|null} */
  let threadId = null;
  /** @type {string|null} */
  let turnId = null;
  let maxId = 0;
  let completed = false;
  /** @type {Map<string, any>} */
  const requests = new Map();
  const answered = new Set();
  const items = new Set();
  const seeId = (id) => {
    if (Number.isSafeInteger(id) && id > maxId) maxId = id;
  };
  return {
    /** One out.jsonl message. @param {any} msg */
    out(msg) {
      const p = msg?.params ?? {};
      if (msg?.id != null && msg.method) requests.set(idKey(msg.id), msg);
      else if (msg?.id != null) {
        seeId(msg.id);
        threadId = msg.result?.thread?.id ?? threadId;
        turnId = msg.result?.turn?.id ?? turnId;
      } else if (msg?.method === 'thread/started') threadId = p.thread?.id ?? threadId;
      else if (msg?.method === 'turn/started') {
        turnId = p.turn?.id ?? turnId;
        threadId = threadId ?? p.threadId ?? null;
      } else if (msg?.method === 'turn/completed') completed = true;
      else if (msg?.method === 'serverRequest/resolved' && p.requestId != null) answered.add(idKey(p.requestId));
      else if (msg?.method === 'item/completed' && p.item?.id) items.add(p.item.id);
    },
    /** One in.jsonl message. @param {any} msg */
    in(msg) {
      if (msg?.id == null) return;
      if (msg.method) seeId(msg.id);
      else answered.add(idKey(msg.id));
    },
    get threadId() {
      return threadId;
    },
    get turnId() {
      return turnId;
    },
    get completed() {
      return completed;
    },
    /** One past the largest request ID either log shows, so a new request can’t take a replayed response. */
    nextRequestId: () => maxId + 1,
    /** @param {unknown} id */
    answered: (id) => answered.has(idKey(id)),
    /** The approval requests still waiting for an answer, in the order Codex sent them. */
    open: () => (completed ? [] : [...requests.values()].filter((m) => !answered.has(idKey(m.id)) && !(m.params?.itemId && items.has(m.params.itemId)))),
  };
}

const errorText = (x) => x?.error?.message ?? x?.message ?? 'Codex app-server failed.';

/** Map Codex app-server approval requests onto Postbox permissions and MCP elicitation responses. */
export async function codexApproval(ctx, msg) {
  const p = msg.params ?? {};
  if (msg.method === 'mcpServer/elicitation/request') {
    const meta = p._meta ?? {};
    // A tool call is marked by its kind, or only by its message (“Allow the github MCP server to run tool
    // “create_issue”?”): either way the card names the tool and shows its arguments, never a generic prompt (#150).
    const named = /run tool ["“]([^"”]+)["”]/i.exec(String(p.message ?? ''))?.[1];
    if (meta.codex_approval_kind === 'mcp_tool_call' || named) {
      const server = String(p.serverName ?? 'mcp').slice(0, 80);
      const name = String(meta.tool_name ?? meta.toolName ?? named ?? 'tool').slice(0, 80);
      // Postbox tools only update the current conversation. Like the Agent SDK, let those run directly;
      // the MCP endpoint still validates every call and the UI actions are intentionally user-scoped.
      if (server === POSTBOX_SERVER) return { action: 'accept', content: {} };
      const tool = `mcp__${server}__${name}`;
      const args = meta.tool_params ?? {};
      const detail = JSON.stringify(
        {
          ...(meta.tool_description ? { description: meta.tool_description } : {}),
          arguments: args,
        },
        null,
        2,
      );
      const answer = await ctx.askPermission({
        tool,
        summary: `use ${server} tool ${name}`,
        detail,
        toolUseId: msg.id,
        suppressAlways: true,
        // A write’s draft shows as Markdown on the card (#112). No input: Codex can’t run an edited call.
        ...(draftOf(tool, args) ? { draft: draftOf(tool, args) } : {}),
      });
      return answer?.allow ? { action: 'accept', content: {} } : { action: 'decline' };
    }
    const server = String(p.serverName ?? 'MCP server').slice(0, 80);
    const answer = await ctx.askPermission({
      tool: `mcp__${server}__elicitation`,
      summary: `respond to ${server}`,
      detail: String(p.message ?? 'The MCP server requests input.'),
      toolUseId: msg.id,
      suppressAlways: true,
    });
    return answer?.allow ? { action: 'accept', content: {} } : { action: 'decline' };
  }
  const isCommand = msg.method === 'item/commandExecution/requestApproval';
  const isFile = msg.method === 'item/fileChange/requestApproval';
  if (isCommand || isFile) {
    const summary = isFile ? 'change files' : 'run a command';
    const detail =
      [p.command ?? p.reason ?? p.networkApprovalContext?.host ?? p.grantRoot, p.cwd ? `Working directory: ${p.cwd}` : null].filter(Boolean).join('\n\n') ||
      summary;
    const answer = await ctx.askPermission({ tool: isFile ? 'Edit' : 'Bash', summary, detail, toolUseId: p.itemId, suppressAlways: true });
    return { decision: answer?.allow ? 'accept' : 'decline' };
  }
  throw new Error(`Unsupported Codex app-server request: ${msg.method ?? 'unknown'}`);
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
   * Runs one turn. With ctx.remote (#120), the app-server runs on that host through its daemon, in ctx.remote.folder,
   * with the shim as Postbox’s server; with ctx.remote.attach, Postbox has restarted and the turn is already running
   * there: it’s replayed from out.jsonl and rebuilt from both logs (createCodexRebuild), and `message` isn’t sent again.
   * The host turn is the runtime’s (ctx.remote.turn), or the attached one: one deliver is one host turn.
   * @param {any} session @param {any} message @param {any} ctx
   */
  async deliver(session, message, ctx) {
    /** @type {import('./adapter.mjs').RemoteContext | null} */
    const remote = ctx.remote ?? null;
    const attach = remote?.attach ?? null;
    if (remote) checkRemoteContext(remote, { attach: Boolean(attach) });
    const cwd = remote ? remote.folder : await this.folderFor(ctx.persona, ctx.project);
    /** @type {any} */
    let child;
    if (remote) {
      const turn = attach?.turn ?? /** @type {string} */ (remote.turn);
      const shim = hostPaths(remote.welcome.home, remote.version).shim;
      const wait = Number.isInteger(remote.settings?.permissionWaitMax) ? remote.settings.permissionWaitMax : defaultHostSettings().permissionWaitMax;
      const args = ['app-server', '--listen', 'stdio://', ...codexRemoteConfigArgs(remote.welcome.node.path, shimArgs(remote, shim, turn), wait)];
      // No variable of its own crosses (CODEX_CAPABILITIES.remote.env), and the laptop’s environment never does.
      const spawnRemote = remoteSpawn({
        connection: remote.link,
        harness: 'codex',
        folder: cwd,
        stdin: 'held',
        turn,
        ...(attach ? { attach: { from: 0 } } : {}),
      });
      child = spawnRemote(this.bin, args);
    } else {
      const args = ['app-server', '--listen', 'stdio://', ...codexConfigArgs(ctx.mcpUrl)];
      // Its own process group, so stopping the turn reaches everything the app-server started (#126).
      child = this.spawn(this.bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, detached: true });
    }
    const exitedP = new Promise((r) => {
      child.once('exit', r);
      child.once('close', r);
      child.once('error', r);
    });
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
    /** @type {string|null} */
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
    /** How a remote turn ended, when that’s the reason it can’t finish (the connection gave up, or it was interrupted). */
    /** @type {(Error & { code?: string }) | null} */
    let endError = null;
    // A remote turn after a Postbox restart: rebuilt until out.jsonl has been replayed as far as the welcome said it went.
    const rebuild = attach ? createCodexRebuild() : null;
    let rebuilding = Boolean(attach);
    /** Approval IDs in.jsonl has answered: the daemon declines one that waited past permissionWaitMax (H4). */
    const answeredOnHost = new Set();
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
    /**
     * Answers an app-server approval or elicitation request, unless the host already has (remote turns). On a host,
     * its card names the request as the daemon does (codex:<id>), so the daemon’s expiry of it reaches the card.
     */
    const answer = async (msg) => {
      let reply;
      const hostPrompt = remote ? codexPromptId(msg.id) : null;
      const asking = hostPrompt ? { ...ctx, askPermission: (/** @type {any} */ req) => ctx.askPermission({ ...req, hostPrompt }) } : ctx;
      try {
        reply = { id: msg.id, result: await codexApproval(asking, msg) };
      } catch (error) {
        reply = { id: msg.id, error: { code: -32601, message: error.message } };
      }
      if (answeredOnHost.has(idKey(msg.id))) return;
      send(reply);
    };
    const onLine = async (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (recordFile) appendFileSync(recordFile, `${line}\n`);
      if (rebuilding) rebuild?.out(msg);
      if (msg.id != null && pending.has(msg.id)) {
        const item = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? item.reject(new Error(errorText(msg))) : item.resolve(msg.result);
        return;
      }
      if (msg.id != null && msg.method) {
        // App-server initiated approval/elicitation request. One replayed after a restart waits for the rebuild,
        // which answers it then only if nobody has.
        if (!rebuilding) await answer(msg);
        return;
      }
      if (rebuilding && msg.id != null) return; // a response to the Postbox before the restart
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
    // The rebuild waits for the daemon’s caught-up on both logs: in.jsonl’s lines are taken as they come (stdin-line),
    // so its caught-up is enough; out.jsonl’s go through stdout and readline, so it also waits until onLine has taken
    // every byte its caught-up counted.
    let replayed = 0;
    /** @type {number | null} out.jsonl’s caught-up size, once it has come */
    let outSize = null;
    let inCaughtUp = false;
    /** @type {(v?: unknown) => void} */
    let caughtUp = () => {};
    const replayDone = new Promise((resolve) => {
      caughtUp = resolve;
    });
    const listed = attach ? (remote?.welcome?.turns ?? []).some((t) => t.turn === attach.turn) : true;
    const checkReplay = () => {
      if (rebuilding && inCaughtUp && outSize != null && replayed >= outSize) caughtUp(undefined);
    };
    rl.on('line', (line) => {
      if (rebuilding) {
        replayed += Buffer.byteLength(line, 'utf8') + 1;
        // After onLine has taken this line, so the rebuild has it.
        void onLine(line).then(checkReplay, fail);
        return;
      }
      void onLine(line).catch(fail);
    });
    if (remote) {
      child.on('cut', ({ offset, next }) => {
        replayed += next - offset;
        checkReplay();
      });
      child.on('caught-up', ({ log, size }) => {
        if (log === 'in') inCaughtUp = true;
        else outSize = size;
        checkReplay();
      });
      child.on('stdin-line', ({ text }) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg?.id != null && !msg.method) answeredOnHost.add(idKey(msg.id));
        rebuild?.in(msg);
      });
    }
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
      // A remote turn ends at its close, which comes next (server/remote/process.mjs) and fails it with endError.
      if (!child.remote) finish(err);
    });
    child.on('close', (code) => {
      exited = true;
      // The daemon found no live runner and no exit.json: the app-server ended on the host without saying how.
      if (child.remote && child.interrupted) endError ??= interruptedError('The Codex turn on the host ended without saying how, so it was interrupted.');
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
    // Stop asks Codex to interrupt the turn; the app-server itself is stopped as the turn ends, below. A remote turn
    // still being rebuilt uses what the rebuild has so far.
    const onAbort = () => {
      const threadId = ctx.state.codexThreadId ?? rebuild?.threadId;
      const turnId = activeTurnId ?? rebuild?.turnId;
      if (rebuilding && rebuild) requestId = Math.max(requestId, rebuild.nextRequestId());
      if (!threadId || !turnId) return finish();
      const id = requestId++;
      send({ id, method: 'turn/interrupt', params: { threadId, turnId } });
      if (child.remote) interruptReached(child, id).then(() => finish());
      else finish();
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (attach) {
        if (!listed) throw interruptedError('The host no longer lists this Codex turn, so it can’t be picked up after the restart.');
        // The replay goes through the mapper as it comes, so the reply is rebuilt too; a turn that completes during it
        // is done. Approvals open only once both logs have caught up, so an answer in.jsonl holds is always seen first.
        await Promise.race([replayDone, ended]);
        if (!rebuild?.completed && !ctx.signal.aborted && !exited) {
          const threadId = rebuild?.threadId ?? ctx.state.codexThreadId;
          if (!threadId || !rebuild?.turnId)
            throw interruptedError(
              `Postbox restarted before Codex on the host had ${threadId ? 'started the turn' : 'opened a thread'}, so the turn can’t be picked up.`,
            );
          ctx.state.codexThreadId = threadId;
          ctx.saveState({ codexThreadId: threadId });
          activeTurnId = rebuild.turnId;
          requestId = Math.max(requestId, rebuild.nextRequestId());
          rebuilding = false;
          for (const msg of rebuild.open()) void answer(msg).catch(fail);
        }
        rebuilding = false;
        await ended;
        return;
      }
      await request('initialize', { clientInfo: { name: 'postbox', title: 'Postbox', version: '0.2.0' } });
      send({ method: 'initialized', params: {} });
      const permissions = codexPermissions(ctx.persona, cwd);
      const model = codexModelOf(ctx.persona);
      const fork = ctx.state.fork ?? ctx.state.forkFrom;
      const sourceThreadId = fork?.threadId ?? ctx.state.codexThreadId;
      const opened =
        fork?.turnId && sourceThreadId
          ? await request('thread/fork', { threadId: sourceThreadId, lastTurnId: fork.turnId, excludeTurns: true })
          : sourceThreadId
            ? await request('thread/resume', { threadId: sourceThreadId, cwd })
            : await request('thread/start', { cwd, ...(model ? { model } : {}) });
      const threadId = sourceThreadId;
      const id = opened?.thread?.id ?? threadId;
      if (!id) throw new Error('Codex app-server did not return a thread id.');
      ctx.state.codexThreadId = id;
      ctx.saveState({ codexThreadId: id, fork: null, forkFrom: null });
      // Codex has no per-agent Tools (CODEX_CAPABILITIES.tools), so there’s nothing turned off to tell it.
      const guide = agentGuide({ persona: ctx.persona, handles: ctx.handles, room: ctx.room, project: ctx.project, brief: session?.brief, toolRules: null });
      const inputText = formatMessage(message, ctx.pathOf);
      const started = await request('turn/start', {
        threadId: id,
        input: [{ type: 'text', text: inputText }],
        settings: { developer_instructions: guide },
        ...(model ? { model } : {}),
        effort: codexEffortOf(ctx.persona),
        cwd,
        ...permissions,
      });
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
