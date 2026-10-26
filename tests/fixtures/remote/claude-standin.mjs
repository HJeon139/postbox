// A stand-in for `claude` on a remote host, for tests/integration/remote-pipeline.test.mjs (#120, V1). It isn’t a
// recording, and it isn’t Claude Code: it plays a turn’s part as the host’s runner sees it, replaying recorded lines.
// The host’s claudePath names a two-line sh wrapper that execs it with the test’s node, so the daemon finds it, asks it
// `--version`, and the runner starts it with the arguments Postbox’s Claude Code adapter built.
//
// What it does, as Claude Code does in a print-mode turn:
// - `--version` prints “2.1.308 (Claude Code)”, the version of the latest recording here (permission-timeout.json).
// - Otherwise it reads its message from stdin (the turn’s message file) and Postbox’s server from `--mcp-config`, and
//   starts that server exactly as configured: its command and arguments (the host’s node and shim.mjs with the turn’s
//   ID), with its environment. It speaks MCP to it over stdio, one JSON-RPC message per line: initialize, the
//   initialized notification, tools/list, then the scenario’s calls.
// - It writes the lines of a recorded stream to stdout, one by one, so the runner appends them to out.jsonl.
// - While a call waits (a permission prompt, or a tool held at the gate below) it writes a tool_progress heartbeat
//   every HEARTBEAT_MS, in the shape a probe recorded on a Linux host (P3, Claude Code 2.x: one tool_progress line with
//   heartbeat: true, tool_use_id `<id>-heartbeat-<n>`, host name removed), far more often than the CLI’s 30 s.
// - SIGINT ends its turn, as it ends Claude Code’s (C5): it writes the result line Claude Code wrote when a recorded
//   turn was stopped with SIGINT (the last line of tests/fixtures/claude-code/background-stopped.jsonl, with this
//   stream’s session ID), and exits 1 (that recording didn’t keep the exit code). SIGTERM is left at Node’s default.
//
// The scenario is a word in the message, `standin:<name>`:
// - allow: tests/fixtures/claude-code/permission-allow.jsonl (claude 2.1.296: a Bash call the person allowed). It
//   writes the lines up to the Bash call’s message_stop, calls show_block, then permission_prompt for that call with a
//   progress token, and writes the rest once it has the answer.
// - gate: as allow, and once allowed, the Bash call “runs” until the file `go` appears in the trace folder, writing
//   heartbeats meanwhile, so a test can drop the connection, restart the daemon or Postbox, stop the turn or kill it.
// - deny: tests/fixtures/claude-code/permission-deny.jsonl (claude 2.1.296: a Bash call the person refused), asking
//   permission_prompt for its call and writing the rest once answered.
// - none of these (a turn Postbox resumed on its own, say): tests/fixtures/claude-code/model-effort.jsonl whole
//   (claude 2.1.296), with no tool calls.
//
// What happened goes in POSTBOX_STANDIN_TRACE, if set: `<pid>.jsonl`, one event per line (start, with its argv and
// CLAUDE_CODE_RESUME_INTERRUPTED_TURN; shim, with the server’s PID; mcp; block; progress; decision; gate; sigint;
// end), and `<pid>.out.jsonl`, every line it wrote to stdout, so a test can compare what Postbox applied with what was
// written.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '2.1.308';
const HEARTBEAT_MS = 250;
const FIXTURES = new URL('../claude-code/', import.meta.url);
const BLOCK = { id: 'pick', type: 'choice', version: 1, title: 'Pick', fallback: 'Pick one', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] };

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}

const TRACE = process.env.POSTBOX_STANDIN_TRACE || null;
/** @param {string} ev @param {Record<string, unknown>} [body] */
const trace = (ev, body = {}) => {
  if (TRACE) appendFileSync(join(TRACE, `${process.pid}.jsonl`), `${JSON.stringify({ ev, at: Date.now(), ...body })}\n`);
};
/** A recorded stream’s lines. @param {string} name */
const recorded = (name) =>
  readFileSync(new URL(`${name}.jsonl`, FIXTURES), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
/** One line to stdout, which the runner appends to out.jsonl, and to the trace’s copy. @param {string} line */
const out = (line) => {
  writeSync(1, `${line}\n`);
  if (TRACE) appendFileSync(join(TRACE, `${process.pid}.out.jsonl`), `${line}\n`);
};

const message = readFileSync(0, 'utf8');
const scenario = /\bstandin:(allow|gate|deny)\b/.exec(message)?.[1] ?? 'plain';
const at = argv.indexOf('--mcp-config');
const server = at === -1 ? null : JSON.parse(argv[at + 1]).mcpServers?.postbox;
trace('start', { pid: process.pid, ppid: process.ppid, argv, scenario, resumeInterrupted: process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN ?? null, server });

let sessionId = '';
// Stopped: the recorded result of a turn stopped with SIGINT, then the turn is over.
const stopped = JSON.parse(recorded('background-stopped').at(-1) ?? '{}');
process.on('SIGINT', () => {
  trace('sigint');
  out(JSON.stringify({ ...stopped, session_id: sessionId || stopped.session_id }));
  process.exit(1);
});

/** An MCP client over the server’s stdio. @param {{ command: string, args?: string[], env?: Record<string, string> }} s */
function connect(s) {
  const child = spawn(s.command, s.args ?? [], { env: { ...process.env, ...(s.env ?? {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  let ids = 0;
  /** @type {Map<number, (m: any) => void>} */
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.method === 'notifications/progress') trace('progress', { progress: m.params?.progress });
    else if (m.id !== undefined && waiting.has(m.id)) {
      const done = /** @type {(m: any) => void} */ (waiting.get(m.id));
      waiting.delete(m.id);
      done(m);
    }
  });
  const write = (/** @type {object} */ m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  return {
    child,
    /** @param {string} method @param {object} params @returns {Promise<any>} */
    request(method, params) {
      const id = ++ids;
      return new Promise((resolve, reject) => {
        waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
        write({ id, method, params });
      });
    },
    /** @param {string} method */
    notify: (method) => write({ method }),
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve(undefined);
        child.once('exit', () => resolve(undefined));
        child.stdin.end();
      }),
  };
}

/** Writes heartbeats for a tool call until `until` settles, and resolves with its value. @template T @param {{ id: string, name: string }} tool @param {Promise<T>} until */
async function beating(tool, until) {
  const t0 = Date.now();
  let n = 0;
  const beat = () =>
    out(
      JSON.stringify({
        type: 'tool_progress',
        tool_use_id: `${tool.id}-heartbeat-${n++}`,
        tool_name: tool.name,
        parent_tool_use_id: tool.id,
        elapsed_time_seconds: Math.round((Date.now() - t0) / 1000),
        heartbeat: true,
        session_id: sessionId,
        uuid: randomUUID(),
      }),
    );
  const timer = setInterval(beat, HEARTBEAT_MS);
  try {
    return await until;
  } finally {
    clearInterval(timer);
  }
}

/** Until the trace folder has `go`. */
const gate = () =>
  new Promise((resolve) => {
    const look = setInterval(() => {
      if (!TRACE || existsSync(join(TRACE, 'go'))) {
        clearInterval(look);
        resolve(undefined);
      }
    }, 20);
  });

const mcp = server ? connect(server) : null;
if (mcp) {
  trace('shim', { pid: mcp.child.pid });
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: VERSION } });
  mcp.notify('notifications/initialized');
  const list = await mcp.request('tools/list', {});
  trace('mcp', { protocolVersion: init.protocolVersion, name: init.serverInfo?.name, tools: list.tools.map((/** @type {any} */ t) => t.name) });
}

const lines = recorded(scenario === 'plain' ? 'model-effort' : scenario === 'deny' ? 'permission-deny' : 'permission-allow');
const events = lines.map((l) => JSON.parse(l));
sessionId = events.find((e) => e.session_id)?.session_id ?? '';
if (scenario === 'plain' || !mcp) {
  for (const l of lines) out(l);
} else {
  // The Bash call the recorded turn asked about, and where its message ends: the prompt comes there.
  const asked = events.findIndex((e) => e.type === 'assistant' && e.message?.content?.some((/** @type {any} */ c) => c.type === 'tool_use'));
  const call = events[asked].message.content.find((/** @type {any} */ c) => c.type === 'tool_use');
  const cut = events.findIndex((e, i) => i > asked && e.event?.type === 'message_stop') + 1;
  for (const l of lines.slice(0, cut)) out(l);
  if (scenario !== 'deny') {
    const r = await mcp.request('tools/call', { name: 'show_block', arguments: { block: BLOCK } });
    trace('block', { text: r.content?.[0]?.text ?? null, isError: r.isError === true });
  }
  const answer = mcp.request('tools/call', {
    name: 'permission_prompt',
    arguments: { tool_name: call.name, input: call.input, tool_use_id: call.id },
    _meta: { progressToken: `${call.id}-permission` },
  });
  const r = await beating(call, answer);
  const decision = JSON.parse(r.content[0].text);
  trace('decision', { decision, asked: call.input });
  if (scenario === 'gate' && decision.behavior === 'allow') {
    trace('gate');
    await beating(call, gate());
  }
  for (const l of lines.slice(cut)) out(l);
}
await mcp?.close();
trace('end');
process.exit(0);
