// Postbox’s tools on a remote host (#120): a stdio MCP server, which the harness runs as `node shim.mjs <turn>`, plus
// `--bring` for a turn the person started in a side or topic thread. It serves exactly the laptop’s tools
// (shared/mcp-tools.mjs’s TOOL_DEFS; bring_to_conversation only with --bring, as server/mcp.mjs lists it only for such
// a turn), reads JSON-RPC from stdin and writes it to stdout, one message per line (MCP 2025-06-18, “Transports”,
// stdio), and logs only to stderr. Each tool call crosses to the daemon over its Unix socket in the shim-to-daemon
// messages of shared/remote-protocol.mjs; the design is architecture.md, “Remote hosts”, “Postbox’s tools on the host”
// and “Permission prompts while nobody is connected”.
//
// - The turn’s token comes from ~/.postbox-remote/token, read on each connect, never from arguments or the
//   environment, which other users can read through /proc. The daemon refuses a call from a turn that has ended.
// - A `queue` tool (TOOL_ROUTES) returns at once, connected or not: the call waits here until the daemon answers it
//   with `result`, and is sent again, with the same ID, after each reconnect. Its text says it was sent, not what
//   the laptop would say: the laptop’s text depends on its state (an id already taken, a block it refuses), which the
//   shim can’t know, so it never claims a block was shown.
// - An `ask` or `host` tool waits for the daemon’s `result`, sent again after a reconnect. It fails with an error
//   that says why if the daemon stays unreachable for TIMINGS.unreachable, or doesn’t answer in TIMINGS.askMax.
// - permission_prompt sends `permission` and waits for `permission-answer`, however many times the daemon restarts.
//   It never allows on its own: at the daemon’s permissionWaitMax it denies, and tells the daemon with
//   `permission-expired` (kept until it’s sent, so the card can say so on reconnect). If the harness cancels the call
//   (MCP’s cancel notification), it tells the daemon with `permission-canceled`, kept the same way. While it waits,
//   it sends a progress notification every TIMINGS.progress if the call carried a progress token, with a value that
//   goes up by one each time, as MCP requires (“Progress”). Claude Code’s per-server `timeout` is what lets the call
//   last; the progress only backs up its idle window (the plan’s C1).
// - IDs are a counter with a prefix for this process, so a shim the harness restarts within a turn can’t reuse an
//   ID the daemon still holds for that turn: a prompt’s or call’s identity is (turn, ID).
// - `server/discover` (Kiro CLI tries it first), like any method it doesn’t serve, gets “method not found”, so the
//   client goes on to `initialize` at once. Batches aren’t accepted: MCP 2025-06-18 removed them.
// - Shutdown is the client’s: when stdin ends, it closes the daemon link and exits 0 (MCP “Lifecycle”, stdio).
//
// For tests only, POSTBOX_SHIM_TIMINGS (JSON) shortens the waits below; a value can only shorten one, and
// `waitMax` only shortens the daemon’s permissionWaitMax, so it can make a prompt deny sooner, never allow.

import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { TOOL_DEFS } from '../../../shared/mcp-tools.mjs';
import { createLineReader, createMessageReader, encode, HOST_DEFAULTS, message, REMOTE_LIMITS, TOOL_ROUTES } from '../../../shared/remote-protocol.mjs';
import { paths } from './paths.mjs';

/** The same answer to initialize as the laptop’s server/mcp.mjs; tests/remote-shim.test.mjs compares them. */
const PROTOCOL = '2025-06-18';
const INITIALIZE = {
  protocolVersion: PROTOCOL,
  capabilities: { tools: { listChanged: false } },
  serverInfo: { name: 'postbox', version: '0.2.0' },
  instructions:
    'Postbox renders your UI. Reply in Markdown; use show_block for questions and show_app for interactive software. Tools never block: answers arrive as new messages.',
};
const CANCEL = 'notifications/cancelled'; // lint-allow spelling: the MCP protocol’s method name.
const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** How long the shim waits, in milliseconds. */
const TIMINGS = timings({
  /** Between progress notifications while a prompt waits. */
  progress: MINUTE,
  /** An asked tool fails once the daemon has been unreachable this long. */
  unreachable: 30 * SECOND,
  /** An asked tool fails if the daemon hasn’t answered it in this long. */
  askMax: 10 * MINUTE,
  /** The first and the longest pause before connecting again. */
  backoff: 100,
  backoffMax: 5 * SECOND,
  /** A cap under the daemon’s permissionWaitMax; Infinity is no cap. */
  waitMax: Number.POSITIVE_INFINITY,
});

const log = (text) => process.stderr.write(`postbox shim: ${text}\n`);

const turn = process.argv[2] ?? '';
/** tools/list’s tools: bring_to_conversation only for a turn Postbox says may post to the conversation (offersBring). */
const LISTED = process.argv[3] === '--bring' ? TOOL_DEFS : TOOL_DEFS.filter((t) => t.name !== 'bring_to_conversation');
const P = paths();
try {
  P.turn(turn);
} catch (e) {
  log(`${e.message} Run it as node shim.mjs <turn>.`);
  process.exit(2);
}

// ── Talking to the harness (stdout) ─────────────────────────────────────────────────

/** @param {object} msg */
const send = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, text) => send({ jsonrpc: '2.0', id, error: { code, message: text } });
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

// ── What’s waiting ──────────────────────────────────────────────────────────────────

/**
 * A message for the daemon, kept until it’s settled and sent again, in order, after each reconnect.
 * @typedef {{ msg: Record<string, any>, kind: 'queue' | 'ask' | 'permission' | 'notice', rpcId?: any,
 *   started: number, timers: Set<ReturnType<typeof setTimeout>>, progress?: { token: string | number, value: number },
 *   tool?: string, down?: ReturnType<typeof setTimeout> | null }} Pending
 */
/** @type {Map<string, Pending>} by the shim’s ID (an expiry or cancel notice by `notice:<id>`) */
const pending = new Map();
/** The JSON-RPC request each pending ID answers, for a cancellation notification. @type {Map<string, string>} */
const byRequest = new Map();

const prefix = `${process.pid.toString(36)}${Date.now().toString(36)}`;
let counter = 0;
const nextId = () => `${prefix}-${++counter}`;

/** Ends a pending entry: its timers stop and it’s no longer sent. @param {string} id */
function settle(id) {
  const p = pending.get(id);
  if (!p) return null;
  pending.delete(id);
  for (const t of p.timers) clearTimeout(t);
  if (p.down) clearTimeout(p.down);
  if (p.rpcId !== undefined) byRequest.delete(JSON.stringify(p.rpcId));
  return p;
}

/** @param {Pending} p @param {() => void} fn @param {number} ms */
function after(p, fn, ms) {
  const t = setTimeout(() => {
    p.timers.delete(t);
    fn();
  }, ms);
  t.unref();
  p.timers.add(t);
  return t;
}

// ── The daemon link ─────────────────────────────────────────────────────────────────

/** @type {import('node:net').Socket | null} */
let sock = null;
/** Whether the daemon has welcomed this connection, so messages may go. */
let ready = false;
/** The daemon’s permissionWaitMax, in milliseconds; the host’s default until a welcome says. */
let waitMax = Number(HOST_DEFAULTS.permissionWaitMax);
let backoff = TIMINGS.backoff;
let stopping = false;
/** Whether the daemon being unreachable was already logged since the last welcome. */
let quiet = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let retry = null;

function connect() {
  retry = null;
  if (stopping) return;
  let token;
  try {
    token = readFileSync(P.token, 'utf8').trim();
  } catch (e) {
    if (!quiet) log(`Couldn’t read the host’s token at ${P.token} (${e.code ?? e.message}); trying again until it can.`);
    quiet = true;
    return reconnectLater();
  }
  let hello;
  try {
    hello = encode(message('shim-to-daemon', 'hello', { token, turn }));
  } catch (e) {
    log(`The token at ${P.token} isn’t one the daemon takes: ${e.message}`);
    return reconnectLater();
  }
  const s = createConnection(P.socket);
  sock = s;
  const reader = createMessageReader('daemon-to-shim', {
    onMessage: (m) => sock === s && fromDaemon(m),
    onError: (e) => log(`The daemon sent a line the shim refused: ${e.message}`),
  });
  s.on('connect', () => s.write(hello));
  s.on('data', (chunk) => reader.push(chunk));
  s.on('error', (e) => {
    // A daemon that isn’t up yet, or restarting, is the usual case: say so once, not on every attempt.
    if (sock !== s || quiet) return;
    quiet = true;
    log(`The daemon’s socket isn’t answering (${/** @type {any} */ (e).code ?? e.message}); trying again until it does.`);
  });
  s.on('close', () => {
    if (sock !== s) return;
    sock = null;
    ready = false;
    for (const p of pending.values()) if (p.kind === 'ask') watchDown(p);
    reconnectLater();
  });
}

function reconnectLater() {
  if (stopping || retry) return;
  retry = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, TIMINGS.backoffMax);
}

/** Writes one pending entry’s message if the daemon has welcomed this connection. @param {Pending} p @param {string} id */
function deliver(p, id) {
  if (!ready || !sock) return;
  sock.write(encode(p.msg));
  // A notice needs no answer: once it’s written to a welcomed link, it’s the daemon’s.
  if (p.kind === 'notice') settle(id);
}

/** @param {{ type: string, [field: string]: any }} m */
function fromDaemon(m) {
  switch (m.type) {
    case 'welcome': {
      if (m.turn !== turn) log(`The daemon welcomed turn ${m.turn}, not ${turn}.`);
      ready = true;
      quiet = false;
      backoff = TIMINGS.backoff;
      waitMax = m.permissionWaitMax;
      for (const [id, p] of pending) {
        if (p.down) clearTimeout(p.down);
        p.down = null;
        if (p.kind === 'permission') armExpiry(p, id);
      }
      for (const [id, p] of [...pending]) deliver(p, id);
      return;
    }
    case 'result': {
      const p = pending.get(m.id);
      if (!p || (p.kind !== 'queue' && p.kind !== 'ask')) return;
      settle(m.id);
      // A queued call’s agent already has its answer; a refusal here is the daemon’s to report to Postbox.
      if (p.kind === 'queue') {
        if (!m.ok) log(`Postbox’s daemon refused ${p.tool} (${m.id}): ${m.text}`);
        return;
      }
      respond(p.rpcId, textResult(m.text, !m.ok));
      return;
    }
    case 'permission-answer': {
      const p = pending.get(m.id);
      if (p?.kind !== 'permission') return;
      settle(m.id);
      const r = m.result;
      // The laptop’s permission() shape, key for key.
      const decision =
        r.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: r.updatedInput, ...(r.updatedPermissions ? { updatedPermissions: r.updatedPermissions } : {}) }
          : { behavior: 'deny', message: r.message };
      respond(p.rpcId, textResult(JSON.stringify(decision)));
      return;
    }
    case 'error': {
      log(`The daemon said ${m.code}: ${m.message}`);
      // A token it refuses or a turn that has ended won’t answer what waits, so those calls end now, with its reason.
      // A prompt is denied, never allowed.
      if (m.code === 'bad-token' || m.code === 'turn-ended') {
        for (const [id, p] of [...pending]) {
          if (p.kind === 'ask') {
            settle(id);
            respond(p.rpcId, textResult(`Postbox’s daemon on this host refused ${p.tool}: ${m.message}`, true));
          } else if (p.kind === 'permission') {
            settle(id);
            respond(p.rpcId, textResult(JSON.stringify({ behavior: 'deny', message: `Postbox’s daemon on this host refused the prompt: ${m.message}` })));
          }
        }
      }
      return;
    }
  }
}

// ── Tool calls ──────────────────────────────────────────────────────────────────────

/** What a queued tool returns at once. It says the call was sent, never how the laptop took it. */
function queuedText(name, args) {
  const said = (v) => (typeof v === 'string' && v ? v : null);
  const block = said(args.block?.id);
  const since = 'Postbox applies it as soon as it’s connected to this host';
  switch (name) {
    case 'show_block':
      return `Sent block ${block ?? '(no id)'} to Postbox, which checks it and shows it as soon as it’s connected to this host.`;
    case 'update_block':
      return `Sent the update to block ${block ?? '(no id)'} to Postbox, which checks it and applies it as soon as it’s connected to this host.`;
    case 'show_app':
      return `Sent app ${args.id} to Postbox, which checks it and shows it as soon as it’s connected to this host. Use that id to update it.`;
    case 'update_app':
      return `Sent the new version of app ${said(args.id) ?? '(no id)'} to Postbox. ${since}.`;
    case 'define_term':
      return `Sent “${said(args.term) ?? ''}” to the glossary. ${since}.`;
    case 'propose_agent':
      return 'Proposed. The person decides whether to create it.';
    case 'schedule_wake':
      return `Asked Postbox to wake you in ${Number(args.in_minutes) || 1} minutes. ${since}.`;
    case 'wake_agent':
      return `Sent your message for ${said(args.handle) ?? 'that agent'} to Postbox. ${since}.`;
    case 'ask_for_tool':
      return `Asked for ${said(args.tool) ?? 'that tool'}. The person sees a card once Postbox is connected to this host. End your turn: their answer arrives as a message.`;
    default:
      return `Sent ${name} to Postbox. ${since}.`;
  }
}

/** @param {any} rpcId @param {any} params */
function toolCall(rpcId, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (typeof name !== 'string' || !TOOL_NAMES.has(name) || !Object.hasOwn(TOOL_ROUTES, name)) return fail(rpcId, -32602, `There’s no tool called “${name}”.`);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail(rpcId, -32602, `${name}’s arguments must be an object.`);
  if (name === 'permission_prompt') return permission(rpcId, args, params?._meta?.progressToken);
  const route = TOOL_ROUTES[name];
  // show_app without an id gets one here, so the text can name it and the agent can update it; the laptop would
  // pick one the same way (newId('app')).
  const sent = name === 'show_app' && typeof args.id !== 'string' ? { ...args, id: `app_${nextId()}` } : args;
  const id = nextId();
  let msg;
  try {
    msg = message('shim-to-daemon', 'call', { id, name, args: sent });
    encode(msg);
  } catch (e) {
    return respond(rpcId, textResult(`Postbox couldn’t send ${name}: ${e.message}`, true));
  }
  /** @type {Pending} */
  const p = { msg, kind: route === 'queue' ? 'queue' : 'ask', started: Date.now(), timers: new Set(), tool: name, down: null };
  pending.set(id, p);
  if (route === 'queue') {
    deliver(p, id);
    return respond(rpcId, textResult(queuedText(name, sent)));
  }
  p.rpcId = rpcId;
  byRequest.set(JSON.stringify(rpcId), id);
  after(
    p,
    () => {
      if (!settle(id)) return;
      respond(rpcId, textResult(`Postbox didn’t answer ${name} within ${minutes(TIMINGS.askMax)}, so it ended without a result. Try again.`, true));
    },
    TIMINGS.askMax,
  );
  if (!ready) watchDown(p);
  deliver(p, id);
}

/** An asked call fails once the daemon has been unreachable for TIMINGS.unreachable. @param {Pending} p */
function watchDown(p) {
  if (p.down) return;
  const id = p.msg.id;
  p.down = setTimeout(() => {
    p.down = null;
    if (ready || !settle(id)) return;
    respond(
      p.rpcId,
      textResult(`Postbox’s daemon on this host isn’t reachable, so ${p.tool} couldn’t run. The daemon may be restarting; try again in a minute.`, true),
    );
  }, TIMINGS.unreachable);
  p.down.unref();
}

/**
 * permission_prompt: waits for the person’s answer, or denies at permissionWaitMax.
 * @param {any} rpcId @param {Record<string, any>} args @param {unknown} progressToken
 */
function permission(rpcId, args, progressToken) {
  const id = nextId();
  let msg;
  try {
    msg = message('shim-to-daemon', 'permission', { id, request: args });
    encode(msg);
  } catch (e) {
    // A request Postbox can’t carry is denied with the reason, never allowed.
    return respond(rpcId, textResult(JSON.stringify({ behavior: 'deny', message: `Postbox couldn’t show this permission request: ${e.message}` })));
  }
  /** @type {Pending} */
  const p = { msg, kind: 'permission', rpcId, started: Date.now(), timers: new Set(), tool: 'permission_prompt' };
  if (typeof progressToken === 'string' || (typeof progressToken === 'number' && Number.isFinite(progressToken))) {
    p.progress = { token: progressToken, value: 0 };
    const tick = () => {
      if (!pending.has(id) || !p.progress) return;
      p.progress.value += 1;
      send({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: p.progress.token, progress: p.progress.value, message: 'Waiting for the person to answer in Postbox.' },
      });
      after(p, tick, TIMINGS.progress);
    };
    after(p, tick, TIMINGS.progress);
  }
  pending.set(id, p);
  byRequest.set(JSON.stringify(rpcId), id);
  armExpiry(p, id);
  deliver(p, id);
}

/** @type {WeakMap<Pending, ReturnType<typeof setTimeout>>} */
const expiries = new WeakMap();

/** (Re)sets a prompt’s deadline from when it was asked, by the latest permissionWaitMax. @param {Pending} p @param {string} id */
function armExpiry(p, id) {
  const old = expiries.get(p);
  if (old) {
    clearTimeout(old);
    p.timers.delete(old);
  }
  const limit = Math.min(waitMax, TIMINGS.waitMax);
  const t = after(p, () => expire(id, limit), Math.max(0, p.started + limit - Date.now()));
  expiries.set(p, t);
}

/** @param {string} id @param {number} limit */
function expire(id, limit) {
  const p = settle(id);
  if (!p) return;
  const message = `Nobody answered this permission request in Postbox within ${minutes(limit)}, so it was denied. Ask again if you still need it.`;
  respond(p.rpcId, textResult(JSON.stringify({ behavior: 'deny', message })));
  notify('permission-expired', id);
}

/**
 * Tells the daemon a prompt ended without the person’s answer (`permission-expired` or `permission-canceled`), kept
 * until it’s sent to a welcomed link, so the card can say so after a reconnect.
 * @param {'permission-expired' | 'permission-canceled'} type @param {string} id
 */
function notify(type, id) {
  const key = `notice:${id}`;
  /** @type {Pending} */
  const notice = { msg: messageFor(type, { id, at: Date.now() }), kind: 'notice', started: Date.now(), timers: new Set() };
  pending.set(key, notice);
  deliver(notice, key);
}

/** @param {string} type @param {Record<string, unknown>} body */
const messageFor = (type, body) => message('shim-to-daemon', type, body);

/** @param {number} ms */
function minutes(ms) {
  if (ms >= 2 * 60 * MINUTE && ms % (60 * MINUTE) === 0) return `${ms / (60 * MINUTE)} hours`;
  if (ms >= MINUTE) return `${Math.round(ms / MINUTE)} minute${Math.round(ms / MINUTE) === 1 ? '' : 's'}`;
  return `${Math.round(ms / SECOND)} seconds`;
}

// ── JSON-RPC from the harness (stdin) ───────────────────────────────────────────────

/** @param {string} text */
function fromHarness(text) {
  if (!text.trim()) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    return fail(null, -32700, `A line wasn’t JSON (${e.message}).`);
  }
  if (Array.isArray(msg)) return fail(null, -32600, 'Batches aren’t supported: MCP 2025-06-18 sends one message per line.');
  // A response to a request: the shim sends none, so there’s nothing to match it to.
  if (msg?.jsonrpc === '2.0' && msg.method === undefined && msg.id !== undefined) return;
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id ?? null, -32600, 'Not a JSON-RPC 2.0 request.');
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'notifications/initialized':
      return;
    case CANCEL: {
      // The client gave up on the call, so it gets no answer. A prompt it gave up on is the daemon’s to clear, so it
      // hears permission-canceled, and Postbox withdraws the card.
      const key = JSON.stringify(msg.params?.requestId);
      const id = byRequest.get(key);
      if (id && settle(id)?.kind === 'permission') notify('permission-canceled', id);
      return;
    }
  }
  if (isNotification) return;
  switch (msg.method) {
    case 'initialize':
      return respond(msg.id, INITIALIZE);
    case 'ping':
      return respond(msg.id, {});
    case 'tools/list':
      return respond(msg.id, { tools: LISTED });
    case 'tools/call':
      return toolCall(msg.id, msg.params);
    default:
      return fail(msg.id, -32601, `Method “${msg.method}” isn’t supported.`);
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (retry) clearTimeout(retry);
  for (const id of [...pending.keys()]) settle(id);
  const s = sock;
  sock = null;
  s?.destroy();
  process.stdout.write('', () => process.exit(0));
}

const stdin = createLineReader({
  onLine: (text) => fromHarness(text),
  onError: (e) => {
    log(e.message);
    fail(null, -32700, e.message);
  },
  maxBytes: REMOTE_LIMITS.lineBytes,
});
process.stdin.on('data', (chunk) => stdin.push(chunk));
process.stdin.on('end', () => {
  stdin.end();
  shutdown();
});
process.stdin.on('error', shutdown);
// The client went away mid-write: nothing is left to answer.
process.stdout.on('error', shutdown);

connect();

/**
 * The default waits, each shortened by POSTBOX_SHIM_TIMINGS if it says so. For tests only (see the header).
 * @template {Record<string, number>} T @param {T} defaults @returns {T}
 */
function timings(defaults) {
  const raw = process.env.POSTBOX_SHIM_TIMINGS;
  if (!raw) return defaults;
  /** @type {Record<string, number>} */
  const out = { ...defaults };
  try {
    const given = JSON.parse(raw);
    for (const k of Object.keys(defaults)) {
      const v = given?.[k];
      if (Number.isFinite(v) && v >= 1 && v < out[k]) out[k] = v;
    }
  } catch {
    process.stderr.write('postbox shim: POSTBOX_SHIM_TIMINGS isn’t JSON, so it was ignored.\n');
  }
  return /** @type {T} */ (out);
}
