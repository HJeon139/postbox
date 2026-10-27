// The Codex backend on a remote host (#120, ctx.remote; architecture.md “Remote hosts”). The app-server runs on that
// host through its daemon (server/remote/process.mjs), in ctx.remote.folder, with the shim as Postbox’s server. With
// ctx.remote.attach, Postbox has restarted and the turn is already running there: it’s replayed from out.jsonl and
// rebuilt from both logs (createCodexRebuild), and the message isn’t sent again. The host turn is the runtime’s
// (ctx.remote.turn), or the attached one: one deliver is one host turn. Its start carries the message’s attachments,
// and turn/start’s input names their copies in the turn’s folder there (remote-turn.mjs’s attachmentPaths).
// server/adapters/codex.mjs runs the turn; this module holds what only a host needs.

import { codexPromptId } from '../remote/host/broker.mjs';
import { remoteSpawn } from '../remote/process.mjs';
import { checkRemoteContext } from './adapter.mjs';
import { postboxMcpApprovalArgs } from './codex-mcp-policy.mjs';
import { hostShim, hostWaitMax, startAttachments } from './remote-turn.mjs';
import { PERMISSION_WAIT_MARGIN_MS, POSTBOX_SERVER } from './setup.mjs';

export { attachmentPaths } from './remote-turn.mjs';

/**
 * How Codex runs on a remote host (CODEX_CAPABILITIES.remote): stdin stays open for the JSON-RPC until turn/completed,
 * it sets no variable of its own, Postbox’s server goes in -c mcp_servers.postbox.* overrides, and while a background
 * command runs the model’s checks on it are its sign of work. Its sign-in error isn’t recorded yet.
 */
export const CODEX_REMOTE = Object.freeze({ stdin: 'held', env: Object.freeze([]), server: 'codex-config', work: 'model-checks', signInError: null });

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
    ...postboxMcpApprovalArgs(),
  ];
}

/** A remote turn that can’t go on from what the host kept: the runtime shows it as Interrupted (#120). @param {string} text */
export function interruptedError(text) {
  return Object.assign(new Error(text), { code: 'interrupted' });
}

/** A JSON-RPC ID as a key: Codex’s are integers or strings, so 1 and "1" stay apart. */
export const idKey = (id) => JSON.stringify(id);

/** How long Stop on a remote Codex turn waits for its turn/interrupt to reach the host before the daemon’s stop (#120). */
export const INTERRUPT_REACH_MS = 5000;

/**
 * Settles once a remote turn’s turn/interrupt request `id` is in in.jsonl (its 'stdin-line'), the turn has exited, or
 * INTERRUPT_REACH_MS have passed. A held stdin’s lines reach the daemon one at a time (server/remote/process.mjs), so the
 * daemon’s stop, sent as the turn ends, could otherwise pass the interrupt still queued behind another line.
 * @param {any} child  server/remote/process.mjs’s @param {number} id
 */
export function interruptReached(child, id) {
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
 * The app-server on the host, through its daemon, in `cwd` there, with the shim as Postbox’s server: started as the
 * runtime’s host turn, or read from the start when `attach` names one already there. No variable of its own crosses
 * (CODEX_REMOTE.env), and the laptop’s environment never does. A context the runtime didn’t fill in is refused first,
 * before anything starts on the host (checkRemoteContext).
 * @param {import('./adapter.mjs').RemoteContext} remote @param {{ turn: string } | null} attach @param {string} cwd
 * @param {string} bin
 */
export function spawnRemoteCodex(remote, attach, cwd, bin) {
  checkRemoteContext(remote, { attach: Boolean(attach) });
  const turn = attach?.turn ?? /** @type {string} */ (remote.turn);
  const shim = hostShim(remote, remote.welcome, turn);
  const args = ['app-server', '--listen', 'stdio://', ...codexRemoteConfigArgs(shim.command, shim.args, hostWaitMax(remote))];
  const spawnRemote = remoteSpawn({
    connection: remote.link,
    harness: 'codex',
    folder: cwd,
    stdin: 'held',
    attachments: startAttachments(remote),
    turn,
    ...(attach ? { attach: { from: 0 } } : {}),
  });
  return spawnRemote(bin, args);
}

/**
 * One out.jsonl message, into the rebuild’s state: a request Codex sent, a response (to a Postbox request), or a
 * notification. @param {any} s @param {any} msg
 */
function rebuildOut(s, msg) {
  const p = msg?.params ?? {};
  if (msg?.id != null && msg.method) s.requests.set(idKey(msg.id), msg);
  else if (msg?.id != null) {
    s.seeId(msg.id);
    s.threadId = msg.result?.thread?.id ?? s.threadId;
    s.turnId = msg.result?.turn?.id ?? s.turnId;
  } else if (msg?.method === 'thread/started') s.threadId = p.thread?.id ?? s.threadId;
  else if (msg?.method === 'turn/started') {
    s.turnId = p.turn?.id ?? s.turnId;
    s.threadId = s.threadId ?? p.threadId ?? null;
  } else if (msg?.method === 'turn/completed') s.completed = true;
  else if (msg?.method === 'serverRequest/resolved' && p.requestId != null) s.answered.add(idKey(p.requestId));
  else if (msg?.method === 'item/completed' && p.item?.id) s.items.add(p.item.id);
}

/**
 * How far a Codex turn on a host had got, rebuilt after a Postbox restart (#120) from its two logs: out.jsonl, the
 * app-server’s messages, and in.jsonl, what reached its stdin (Postbox’s requests and answers, and the daemon’s
 * answers to approvals that expired). It gives the thread and turn IDs, the next request ID Postbox may use, and the
 * approval requests nobody has answered yet. A request counts as settled once in.jsonl answers it, once Codex says
 * so (`serverRequest/resolved`), once the item it asks about has completed, or once the turn has.
 */
export function createCodexRebuild() {
  const s = {
    /** @type {string|null} */
    threadId: null,
    /** @type {string|null} */
    turnId: null,
    maxId: 0,
    completed: false,
    /** @type {Map<string, any>} */
    requests: new Map(),
    answered: new Set(),
    items: new Set(),
    seeId(id) {
      if (Number.isSafeInteger(id) && id > s.maxId) s.maxId = id;
    },
  };
  return {
    /** One out.jsonl message. @param {any} msg */
    out: (msg) => rebuildOut(s, msg),
    /** One in.jsonl message. @param {any} msg */
    in(msg) {
      if (msg?.id == null) return;
      if (msg.method) s.seeId(msg.id);
      else s.answered.add(idKey(msg.id));
    },
    get threadId() {
      return s.threadId;
    },
    get turnId() {
      return s.turnId;
    },
    get completed() {
      return s.completed;
    },
    /** One past the largest request ID either log shows, so a new request can’t take a replayed response. */
    nextRequestId: () => s.maxId + 1,
    /** @param {unknown} id */
    answered: (id) => s.answered.has(idKey(id)),
    /** The approval requests still waiting for an answer, in the order Codex sent them. */
    open: () =>
      s.completed ? [] : [...s.requests.values()].filter((m) => !s.answered.has(idKey(m.id)) && !(m.params?.itemId && s.items.has(m.params.itemId))),
  };
}

/**
 * The remote side of one Codex deliver (#120): the approvals in.jsonl has answered (the daemon declines one that waited
 * past permissionWaitMax, H4) and, after a Postbox restart, the rebuild, which runs until out.jsonl has been replayed as
 * far as the daemon said it went. The rebuild waits for the daemon’s caught-up on both logs: in.jsonl’s lines are taken
 * as they come (stdin-line), so its caught-up is enough; out.jsonl’s go through stdout and readline, so it also waits
 * until the turn has taken every byte its caught-up counted.
 * @param {any} child  server/remote/process.mjs’s @param {any} remote  ctx.remote @param {{ turn: string } | null} attach
 */
export function createCodexHost(child, remote, attach) {
  /** @type {(v?: unknown) => void} */
  let caughtUp = () => {};
  const host = {
    rebuild: attach ? createCodexRebuild() : null,
    rebuilding: Boolean(attach),
    answeredOnHost: new Set(),
    replayed: 0,
    /** @type {number | null} out.jsonl’s caught-up size, once it has come */
    outSize: null,
    inCaughtUp: false,
    replayDone: new Promise((resolve) => {
      caughtUp = resolve;
    }),
    listed: attach ? (remote?.welcome?.turns ?? []).some((t) => t.turn === attach.turn) : true,
    checkReplay() {
      if (host.rebuilding && host.inCaughtUp && host.outSize != null && host.replayed >= host.outSize) caughtUp(undefined);
    },
    /** A line of out.jsonl read while rebuilding: counted, then checked once `onLine` has taken it, so the rebuild has it. */
    replay(line, onLine, fail) {
      host.replayed += Buffer.byteLength(line, 'utf8') + 1;
      void onLine(line).then(host.checkReplay, fail);
    },
    /** Whether in.jsonl has answered request `id`. */
    answered: (id) => host.answeredOnHost.has(idKey(id)),
    /** The context to ask with: its card names the request as the daemon does (codex:<id>), so the daemon’s expiry reaches it. */
    asking(ctx, id) {
      const hostPrompt = codexPromptId(id);
      return hostPrompt ? { ...ctx, askPermission: (/** @type {any} */ req) => ctx.askPermission({ ...req, hostPrompt }) } : ctx;
    },
  };
  listenToHost(host, child);
  return host;
}

/** The remote child’s own events: the cut and caught-up of a replay, and each line that reached in.jsonl. */
function listenToHost(host, child) {
  child.on('cut', ({ offset, next }) => {
    host.replayed += next - offset;
    host.checkReplay();
  });
  child.on('caught-up', ({ log, size }) => {
    if (log === 'in') host.inCaughtUp = true;
    else host.outSize = size;
    host.checkReplay();
  });
  child.on('stdin-line', ({ text }) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg?.id != null && !msg.method) host.answeredOnHost.add(idKey(msg.id));
    host.rebuild?.in(msg);
  });
}

/** Why a remote turn ended when the daemon found no live runner and no exit.json: the app-server ended there without saying how. */
export const remoteEnd = (child) =>
  child.remote && child.interrupted ? interruptedError('The Codex turn on the host ended without saying how, so it was interrupted.') : null;

/**
 * Picks up a turn already on the host, after a Postbox restart. The replay goes through the mapper as it comes, so the
 * reply is rebuilt too; a turn that completes during it is done. Approvals open only once both logs have caught up, so
 * an answer in.jsonl holds is always seen first. `resume` takes the turn’s ID and the next request ID Postbox may use.
 * @param {any} host  createCodexHost’s @param {any} ctx
 * @param {{ ended: Promise<unknown>, exited: () => boolean, resume: (turnId: string, nextRequestId: number) => void,
 *           answer: (msg: any) => Promise<void>, fail: (err: Error) => void }} o
 */
export async function pickUp(host, ctx, { ended, exited, resume, answer, fail }) {
  const { rebuild } = host;
  if (!host.listed) throw interruptedError('The host no longer lists this Codex turn, so it can’t be picked up after the restart.');
  await Promise.race([host.replayDone, ended]);
  if (!rebuild?.completed && !ctx.signal.aborted && !exited()) {
    const threadId = rebuild?.threadId ?? ctx.state.codexThreadId;
    if (!threadId || !rebuild?.turnId)
      throw interruptedError(
        `Postbox restarted before Codex on the host had ${threadId ? 'started the turn' : 'opened a thread'}, so the turn can’t be picked up.`,
      );
    ctx.state.codexThreadId = threadId;
    ctx.saveState({ codexThreadId: threadId });
    resume(rebuild.turnId, rebuild.nextRequestId());
    host.rebuilding = false;
    for (const msg of rebuild.open()) void answer(msg).catch(fail);
  }
  host.rebuilding = false;
  await ended;
}
