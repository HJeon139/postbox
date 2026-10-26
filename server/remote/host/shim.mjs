// Postbox’s tools on a remote host (#120): a stdio MCP server, which the harness runs as `node shim.mjs <turn>`, plus
// `--bring` for a turn the person started in a side or topic thread, and `--no-prompt` for a backend that doesn’t ask
// through permission_prompt. It serves exactly the laptop’s tools (shared/mcp-tools.mjs’s TOOL_DEFS, as server/mcp.mjs
// offers them: bring_to_conversation only with --bring, and permission_prompt only without --no-prompt, whose call
// then gets NOT_YOUR_PROMPT at once), reads JSON-RPC from stdin and writes it to stdout, one message per line (MCP
// 2025-06-18, “Transports”, stdio), and logs only to stderr. Each tool call crosses to the daemon over its Unix socket in the shim-to-daemon
// messages of shared/remote-protocol.mjs; the design is architecture.md, “Remote hosts”, “Postbox’s tools on the host”
// and “Permission prompts while nobody is connected”.
//
// - The turn’s own token comes from its folder (TURN_FILES.shimToken, which the daemon writes as the turn starts),
//   read on each connect, never from arguments or the environment, which other users can read through /proc. The
//   daemon takes no other token from a shim, and refuses a call from a turn that has ended.
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
// For tests only, POSTBOX_SHIM_TIMINGS (JSON) shortens the waits (shim-state.mjs’s TIMINGS); a value can only shorten one, and
// `waitMax` only shortens the daemon’s permissionWaitMax, so it can make a prompt deny sooner, never allow.

// The shim is a state object (shim-state.mjs) and the modules that take it first: the daemon link (shim-link.mjs),
// the tool calls and permission prompts (shim-calls.mjs), and what it says to the harness (shim-harness.mjs).

import { TOOL_DEFS } from '../../../shared/mcp-tools.mjs';
import { createLineReader, REMOTE_LIMITS } from '../../../shared/remote-protocol.mjs';
import { paths } from './paths.mjs';
import { notify, toolCall } from './shim-calls.mjs';
import { fail, INITIALIZE, log, respond } from './shim-harness.mjs';
import { connect } from './shim-link.mjs';
import { settle, shimState } from './shim-state.mjs';

const CANCEL = 'notifications/cancelled'; // lint-allow spelling: the MCP protocol’s method name.

const turn = process.argv[2] ?? '';
const flags = process.argv.slice(3);
/** Whether the turn’s backend asks through permission_prompt (server/permission-prompt.mjs’s asksByPrompt). */
const asksByPrompt = !flags.includes('--no-prompt');
/**
 * tools/list’s tools: bring_to_conversation only for a turn Postbox says may post to the conversation (offersBring),
 * and permission_prompt only for a backend that asks through it.
 */
const LISTED = TOOL_DEFS.filter((t) => (t.name !== 'bring_to_conversation' || flags.includes('--bring')) && (t.name !== 'permission_prompt' || asksByPrompt));
const P = paths();
try {
  P.turn(turn);
} catch (e) {
  log(`${e.message} Run it as node shim.mjs <turn>.`);
  process.exit(2);
}
const sh = shimState(turn, P, { asksByPrompt });

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
      const id = sh.byRequest.get(key);
      if (id && settle(sh, id)?.kind === 'permission') notify(sh, 'permission-canceled', id);
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
      return toolCall(sh, msg.id, msg.params);
    default:
      return fail(msg.id, -32601, `Method “${msg.method}” isn’t supported.`);
  }
}

function shutdown() {
  if (sh.stopping) return;
  sh.stopping = true;
  if (sh.retry) clearTimeout(sh.retry);
  for (const id of [...sh.pending.keys()]) settle(sh, id);
  const s = sh.sock;
  sh.sock = null;
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

connect(sh);
