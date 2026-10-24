// The daemon’s broker (server/remote/host/broker.mjs, #120), for real: the in-process daemon with its own runner
// functions (tests/integration/host.mjs’s realDaemon) serving its Unix socket, the real shim (`node shim.mjs <turn>`)
// speaking JSON-RPC as a harness would, and the real runner on the stand-in harness for a held Codex turn, in a temp
// POSTBOX_REMOTE_HOME. Postbox is a pair of PassThrough streams. The broker’s rules, with fakes, are unit-tested in
// tests/remote-broker*.test.mjs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { PROGRAMS } from '../../server/remote/host/paths.mjs';
import { DIR_MODE, encode, MESSAGE_FILE, message, PROTOCOL_VERSION } from '../../shared/remote-protocol.mjs';
import { readMessages } from '../fake-daemon.mjs';
import { HARNESS, makeHost, NO_UNIX, realDaemon, TOKEN, until } from './host.mjs';

const WAIT = 60_000; // the shortest permissionWaitMax a host takes

/** The daemon serving its socket, as `host serve` does; restart() replaces it with a new one over the same home. */
async function serveDaemon(h, over = {}) {
  mkdirSync(h.p.code, { recursive: true, mode: DIR_MODE });
  /** @type {Set<import('node:net').Socket>} */
  const socks = new Set();
  let d = realDaemon(h, over);
  await d.daemon.start();
  const server = createServer((s) => {
    socks.add(s);
    s.on('close', () => socks.delete(s));
    d.daemon.accept(s);
  });
  await new Promise((resolve) => server.listen(h.p.socket, () => resolve(undefined)));
  return {
    get daemon() {
      return d.daemon;
    },
    /** A Postbox that has said hello with these settings. */
    async postbox(settings = { permissionWaitMax: WAIT }) {
      const input = new PassThrough();
      const output = new PassThrough();
      d.daemon.connect({ input, output });
      const msgs = readMessages(output);
      const send = (type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
      send('hello', { version: PROTOCOL_VERSION, token: TOKEN, takeover: true, settings });
      await msgs.next('welcome', 5000);
      return { msgs, send, end: () => input.end() };
    },
    /** The daemon crashes and a new one starts from the turn folders, as the next attach would start it. */
    async restart() {
      d.close();
      for (const s of socks) s.destroy();
      d = realDaemon(h, over);
      await d.daemon.start();
    },
    async close() {
      d.close();
      for (const s of socks) s.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/** The shim, as a harness runs it, its JSON-RPC ours. */
function startShim(h, turn) {
  const env = { ...h.env, POSTBOX_SHIM_TIMINGS: JSON.stringify({ backoff: 20, backoffMax: 100 }) };
  const w = spawn(process.execPath, [PROGRAMS.shim, turn], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  w.stdin.on('error', () => {});
  /** @type {any[]} */
  const out = [];
  let buf = '';
  let stderr = '';
  w.stdout.on('data', (b) => {
    buf += b;
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      out.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  w.stderr.on('data', (b) => (stderr += b));
  const exited = new Promise((resolve) => w.on('exit', resolve));
  let rpc = 0;
  const shim = {
    get stderr() {
      return stderr;
    },
    /** Calls a tool and returns the JSON-RPC ID. */
    tool(name, args) {
      const id = ++rpc;
      w.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
      return id;
    },
    /** The response to a request, as text and whether it’s an error. */
    async response(id, ms = 10_000) {
      const r = await until(() => out.find((m) => m.id === id), `the shim’s response to ${id}`, ms);
      return { text: r.result.content[0].text, isError: r.result.isError === true };
    },
    async kill() {
      if (w.exitCode === null && w.signalCode === null) w.kill('SIGKILL');
      await exited;
    },
  };
  return shim;
}

/**
 * The first test’s prompt, which waits across a daemon restart; the Postbox connected to the new daemon.
 * @param {Awaited<ReturnType<typeof serveDaemon>>} s @param {ReturnType<typeof startShim>} shim @param {any} pb  the first Postbox
 */
async function promptAcrossRestart(s, shim, pb) {
  // A prompt waits across a daemon restart: the shim reconnects and sends it again, the new daemon (from
  // prompts.jsonl) sends it to Postbox at its hello, and the answer reaches the harness.
  const asking = shim.tool('permission_prompt', { tool_name: 'Bash', input: { command: 'make' }, tool_use_id: 'tu_1' });
  const prompt = await pb.msgs.next('prompt', 5000);
  assert.deepEqual(prompt.request.input, { command: 'make' });
  await s.restart();
  const pb2 = await s.postbox();
  const again = await pb2.msgs.next('prompt', 5000);
  assert.equal(again.id, prompt.id, 'the same prompt, by (turn, id)');
  // The answer reaches the shim now if it has reconnected, or when it sends the prompt again.
  pb2.send('answer', { turn: 't1', prompt: prompt.id, result: { behavior: 'allow', updatedInput: { command: 'make' } } });
  const allowed = await shim.response(asking);
  assert.deepEqual(JSON.parse(allowed.text), { behavior: 'allow', updatedInput: { command: 'make' } });
  return pb2;
}

test('broker and shim: queued and asked calls, the snapshot’s reading tools, a prompt across a daemon restart, and Stop', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  const s = await serveDaemon(h);
  /** @type {ReturnType<typeof startShim> | null} */
  let shim = null;
  try {
    const pb = await s.postbox();
    pb.send('snapshot', { turn: 't1', home: 'th', threads: [{ id: 'th', items: [{ id: 'i1', line: 'You: fix the build', text: 'You: fix the build' }] }] });
    pb.send('start', {
      turn: 't1',
      harness: 'claude-code',
      folder: h.work,
      argv: [HARNESS, 'sleep:60000'],
      env: {},
      stdin: 'file',
      files: [{ name: MESSAGE_FILE, text: '{}\n' }],
    });
    await pb.msgs.next('started', 10_000);
    shim = startShim(h, 't1');

    // A queued call returns at once, and crosses as `tool`; Postbox’s reply settles it.
    const shown = await shim.response(shim.tool('show_block', { block: { id: 'pick', type: 'confirm', version: 1, fallback: 'OK?', statement: 'OK?' } }));
    assert.match(shown.text, /^Sent block pick to Postbox/);
    const tool = await pb.msgs.next('tool', 5000);
    assert.deepEqual([tool.turn, tool.name, tool.args.block.id], ['t1', 'show_block', 'pick']);
    pb.send('reply', { turn: 't1', id: tool.id, ok: true, text: 'Shown block pick.' });

    // Reading tools are answered on the host, from the snapshot sent before start.
    assert.deepEqual(await shim.response(shim.tool('read_conversation', {})), { text: 'You: fix the build', isError: false });
    const missing = await shim.response(shim.tool('read_message', { id: 'nope' }));
    assert.equal(missing.isError, true);

    // An asked call waits for Postbox’s reply.
    const asked = shim.tool('corpus_search', { query: 'build' });
    const search = await pb.msgs.next('tool', 5000);
    assert.equal(search.name, 'corpus_search');
    pb.send('reply', { turn: 't1', id: search.id, ok: true, text: '[{"id":"doc:1"}]' });
    assert.deepEqual(await shim.response(asked), { text: '[{"id":"doc:1"}]', isError: false });

    const pb2 = await promptAcrossRestart(s, shim, pb);

    // Stop: from then on the turn’s calls are refused, and nothing reaches Postbox.
    pb2.send('stop', { turn: 't1' });
    await pb2.msgs.next('ended', 15_000);
    const late = await shim.response(shim.tool('corpus_search', { query: 'late' }));
    assert.equal(late.isError, true);
    assert.match(late.text, /stopped or has ended/);
    assert.equal(pb2.msgs.messages.filter((m) => m.type === 'tool').length, 0, 'the call after Stop didn’t cross');
  } finally {
    await shim?.kill();
    await s.close();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test('broker and runner: a Codex approval nobody answers is declined on the held stdin at permissionWaitMax', { skip: NO_UNIX }, async () => {
  const h = makeHost();
  // The daemon’s clock, moved on past permissionWaitMax once the request is seen, so the test doesn’t wait a minute.
  const clock = { ahead: 0 };
  const s = await serveDaemon(h, { now: () => Date.now() + clock.ahead });
  try {
    const pb = await s.postbox();
    // Recorded shape: the app-server’s request for a command, as server/adapters/codex.mjs’s codexApproval takes it.
    const request = '{"id":7,"method":"item/commandExecution/requestApproval","params":{"itemId":"i1","command":"make"}}';
    pb.send('start', { turn: 'cx', harness: 'codex', folder: h.work, argv: [HARNESS, `out:${request}`, 'stdin'], env: {}, stdin: 'held', files: [] });
    await pb.msgs.next('started', 10_000);
    pb.send('read', { turn: 'cx', from: 0 });
    assert.equal((await pb.msgs.next('line', 10_000)).text, request);
    // Seen once the broker has read it (it reads every pollMs), then the clock moves on.
    await until(() => existsSync(h.p.turn('cx', 'prompts.jsonl')), 'the broker to see the request');
    clock.ahead = WAIT + 1000;
    const expired = await pb.msgs.next('prompt-expired', 10_000);
    assert.deepEqual([expired.turn, expired.id, expired.reason], ['cx', 'codex:7', 'expired']);
    // The harness read the decline on its stdin, as Codex would.
    assert.equal((await pb.msgs.next('line', 10_000)).text, 'got:{"id":7,"result":{"decision":"decline"}}');
    // Postbox’s late answer isn’t written: Codex gets one answer to a request.
    pb.send('write', { turn: 'cx', line: '{"id":7,"result":{"decision":"accept"}}' });
    const refused = await pb.msgs.next('error', 5000);
    assert.deepEqual([refused.code, refused.re], ['no-prompt', 'write']);
    pb.send('stop', { turn: 'cx' });
    await pb.msgs.next('ended', 15_000);
  } finally {
    await s.close();
    rmSync(h.home, { recursive: true, force: true });
  }
});
