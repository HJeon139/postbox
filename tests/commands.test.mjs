// #67: commands in the composer. `!command` runs as the person in the conversation’s folder, streams bounded output
// into a command item, and reaches the agents on their next turn without waking them; `/name` runs an agent’s skill or
// command as its turn; /model and /effort change the conversation’s snapshot.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { listCommands } from '../server/adapters/agent-sdk.mjs';
import { commandsOf, createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { Runtime } from '../server/runtime.mjs';
import { isLoopback, runShell } from '../server/shell.mjs';
import { Store } from '../server/store.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake spawn: each call makes a child the test drives (output, exit, error), and records how it was started. */
function fakeSpawn() {
  const children = [];
  const spawn = (cmd, args, opts) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), cmd, args, opts, signals: [] });
    child.kill = (sig) => {
      child.signals.push(sig);
      if (sig === 'SIGINT') queueMicrotask(() => child.emit('close', null, 'SIGINT'));
      return true;
    };
    child.exit = (code) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, null));
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
}

class Scripted {
  name = 'claude-code';
  constructor() {
    this.calls = [];
    this.next = [];
  }
  // As the real adapters decide: the persona’s folder, the project’s, else a workspace of its own.
  async folderFor(persona, project) {
    return persona.folder || project?.folder || `/work/space/${persona.handle}`;
  }
  async deliver(session, message, ctx) {
    this.calls.push({ handle: session.handle, message, ctx });
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx);
  }
}

function setup() {
  const store = new Store(null);
  const adapter = new Scripted();
  const { spawn, children } = fakeSpawn();
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: '/nowhere' },
    spawnShell: spawn,
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/work/project' });
  const a = rt.createPersona({ handle: 'alpha', backend: 'claude-code' });
  const b = rt.createPersona({ handle: 'beta', backend: 'claude-code' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id, b.id] });
  return { store, rt, adapter, children, t, a, b };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};
const commandItem = (store, t) => store.items(t.id).find((i) => i.kind === 'command');

// ── ! ───────────────────────────────────────────────────────────────────────────────────

/** Lets a fake child’s streams and events run: output reaches the runtime, and a close is handled. */
const tick = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

test('#67: ! runs with the person’s shell in the conversation’s folder, streams its output, and ends with exit 0 and the time', async () => {
  const { rt, store, t, children } = setup();
  await rt.runShellCommand(t.id, ' npm test ');
  const c = children[0];
  assert.deepEqual([c.args, c.opts.cwd, c.opts.detached, c.opts.stdio[0]], [['-c', 'npm test'], '/work/project', true, 'ignore']);
  c.stdout.write('ok 1\n');
  c.stderr.write('warning\n');
  await tick();
  rt.flushShellOutput();
  assert.equal(commandItem(store, t).text, 'ok 1\nwarning\n');
  assert.equal(commandItem(store, t).status, 'running');
  c.stdout.write('ok 2\n');
  c.exit(0);
  await tick();
  const it = commandItem(store, t);
  assert.deepEqual([it.status, it.exitCode, it.text, it.command, it.cwd], ['done', 0, 'ok 1\nwarning\nok 2\n', 'npm test', '/work/project']);
  assert.ok(typeof it.ms === 'number' && it.ms >= 0);
});

test('#67: ! runs where the agent works, its own workspace included, as its adapter decides', async () => {
  const { rt, store, t, children } = setup();
  store.emit('project', { id: 'p1', name: 'P', folder: '' });
  await rt.runShellCommand(t.id, 'pwd');
  assert.equal(children[0].opts.cwd, '/work/space/alpha');
  assert.equal(commandItem(store, t).cwd, '/work/space/alpha');
});

test('#67: a failing command shows its exit code; one that can’t start says why', async () => {
  const { rt, store, t, children } = setup();
  await rt.runShellCommand(t.id, 'false');
  children[0].exit(1);
  await tick();
  assert.deepEqual([commandItem(store, t).status, commandItem(store, t).exitCode], ['failed', 1]);
  await rt.runShellCommand(t.id, 'nope');
  children[1].emit('error', Object.assign(new Error('spawn /bin/zsh ENOENT'), { code: 'ENOENT' }));
  const it = store.items(t.id).filter((i) => i.kind === 'command')[1];
  assert.equal(it.status, 'failed');
  assert.match(it.error, /ENOENT/);
});

test('#67: Stop sends SIGINT, then SIGKILL if the command doesn’t end', async () => {
  const { rt, store, t, children } = setup();
  const { item } = await rt.runShellCommand(t.id, 'sleep 100');
  rt.stopShellCommand(t.id, item.id);
  await tick();
  assert.deepEqual(children[0].signals, ['SIGINT']);
  assert.equal(commandItem(store, t).status, 'stopped');
  assert.throws(() => rt.stopShellCommand(t.id, item.id), /already finished/);
  // A command that ignores SIGINT gets SIGKILL.
  const kills = [];
  const stubborn = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: (s) => kills.push(s) });
  const h = runShell({ command: 'x', cwd: '/', spawnImpl: /** @type {any} */ (() => stubborn), killAfterMs: 5, onOutput: () => {}, onExit: () => {} });
  h.stop();
  await sleep(20);
  assert.deepEqual(kills, ['SIGINT', 'SIGKILL']);
});

test('#67: when Postbox shuts down, every running command gets SIGINT, then SIGKILL if it hangs on', async () => {
  const { rt, store, t, children } = setup();
  await rt.runShellCommand(t.id, 'npm run dev');
  await rt.runShellCommand(t.id, 'trap "" INT; sleep 999');
  // The second ignores SIGINT.
  children[1].kill = (sig) => {
    children[1].signals.push(sig);
    if (sig === 'SIGKILL') queueMicrotask(() => children[1].emit('close', null, 'SIGKILL'));
    return true;
  };
  await rt.stopShellCommands({ graceMs: 10 });
  await tick();
  assert.deepEqual(children[0].signals, ['SIGINT']);
  assert.deepEqual(children[1].signals, ['SIGINT', 'SIGKILL']);
  assert.equal(rt.shellRuns.size, 0);
  const items = store.items(t.id).filter((i) => i.kind === 'command');
  assert.deepEqual(
    items.map((i) => [i.status, i.error]),
    [
      ['stopped', 'Postbox stopped it as it shut down.'],
      ['stopped', 'Postbox stopped it as it shut down.'],
    ],
  );
});

test('#67: output past 64 KB keeps the end, the item says it was cut, and the store keeps a bounded amount', async () => {
  const { rt, store, t, children } = setup();
  await rt.runShellCommand(t.id, 'yes');
  const c = children[0];
  const id = commandItem(store, t).id;
  const bytes = () =>
    store.events.filter((e) => (e.type === 'item.patch' || e.type === 'item.text') && e.data.id === id).reduce((n, e) => n + JSON.stringify(e.data).length, 0);
  c.stdout.write('a'.repeat(50 * 1024));
  await tick();
  rt.flushShellOutput();
  // Far more than the bound, flushed many times: the item’s text is refreshed rarely, not on every flush.
  for (let i = 0; i < 200; i++) {
    c.stdout.write('b'.repeat(16 * 1024));
    await tick();
    rt.flushShellOutput();
  }
  assert.ok(bytes() < 3 * 64 * 1024, `the store kept ${bytes()} bytes of events for one command`);
  assert.equal(commandItem(store, t).cut, true);
  c.stdout.write('END');
  c.exit(0);
  await tick();
  const it = commandItem(store, t);
  assert.equal(it.text.length, 64 * 1024);
  assert.ok(it.text.endsWith('bEND'), 'the end arrives when it finishes');
});

test('#67: a command reaches every agent on its next turn, with its output, and wakes none', async () => {
  const { rt, store, t, adapter, children } = setup();
  await rt.runShellCommand(t.id, 'npm test');
  children[0].stdout.write('1 failing\n');
  children[0].exit(1);
  await tick();
  assert.equal(adapter.calls.length, 0, 'running a command wakes no agent');
  assert.equal(rt.s.sessions[rt.sessionsIn(t.id)[0].id].state, 'idle');
  rt.sendMessage(t.id, { text: '@beta what failed?' });
  await settle(rt);
  const said = adapter.calls[0].message.context.join('\n');
  assert.match(said, /You ran `npm test` in \/work\/project \(it exited with 1\)\. Output:\n```\n1 failing\n\n```/);
  assert.ok(store.items(t.id).some((i) => i.kind === 'command'));
});

test('#67: no command, or a long one, is refused', async () => {
  const { rt, t } = setup();
  await assert.rejects(rt.runShellCommand(t.id, '   '), /Write a command/);
  await assert.rejects(rt.runShellCommand(t.id, 'x'.repeat(10001)), /10,000/);
});

test('#67: after a restart a running command is marked stopped, saying it may still be running', () => {
  const { rt, store, t } = setup();
  rt.addItem(t.id, { kind: 'command', command: 'sleep 9', cwd: '/', status: 'running', text: '' });
  rt.expireStaleCommands();
  assert.equal(commandItem(store, t).status, 'stopped');
  assert.match(commandItem(store, t).error, /may still be running/);
});

test('#67: only loopback addresses count as this computer', () => {
  for (const a of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopback(a), a);
  for (const a of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.2', '', undefined]) assert.ok(!isLoopback(a), String(a));
});

test('#67: the ! route refuses unless Postbox listens on 127.0.0.1 and the request came from this computer', async () => {
  process.env.POSTBOX_BACKENDS = 'mock';
  const { start } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'pb-shell-'));
  const { spawn, children } = fakeSpawn();
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    const app = await start({ port: 4438, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false, host, spawnShell: spawn });
    try {
      const call = (r) => fakeRequest(app.handle, { host: '127.0.0.1:4438', ...r });
      const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
      const thread = Object.values(app.store.state.threads).find((x) => x.title === 'Corpus explorer');
      const r = await call({ method: 'POST', path: `/api/threads/${thread.id}/shell`, body: { command: 'ls' }, cookie });
      if (host === '127.0.0.1') {
        assert.equal(r.status, 201, r.text);
        assert.equal(children.length, 1);
        const away = await call({ method: 'POST', path: `/api/threads/${thread.id}/shell`, body: { command: 'ls' }, cookie, remoteAddress: '192.168.1.5' });
        assert.equal(away.status, 403);
        children[0].exit(0);
        await new Promise((r) => setImmediate(r));
      } else {
        assert.equal(r.status, 403);
        assert.match(r.json.error, /only while Postbox listens on this computer alone/);
        assert.equal(children.length, 1, 'nothing ran');
      }
      // Without the page’s token, never.
      assert.equal((await call({ method: 'POST', path: `/api/threads/${thread.id}/shell`, body: { command: 'ls' } })).status, 403);
    } finally {
      await app.close();
    }
  }
  await rm(dir, { recursive: true, force: true });
});

// ── / ───────────────────────────────────────────────────────────────────────────────────

test('#67: an agent’s skill runs as that agent’s turn, as the whole prompt, and its catch-up waits for the next turn', async () => {
  const { rt, store, t, adapter, b } = setup();
  rt.sendMessage(t.id, { text: 'hello' });
  await settle(rt);
  const beta = rt.sessionsIn(t.id).find((x) => x.personaId === b.id);
  rt.runAgentCommand(t.id, { sessionId: beta.id, text: '/review src/a.js' });
  await settle(rt);
  const call = adapter.calls.at(-1);
  assert.equal(call.handle, 'beta');
  assert.equal(call.message.text, '/review src/a.js');
  assert.equal(call.message.context, undefined);
  assert.equal(call.message.slash, true);
  assert.equal(store.items(t.id).find((i) => i.text === '/review src/a.js').kind, 'user');
  // What beta missed comes with its next ordinary turn.
  rt.sendMessage(t.id, { text: '@beta thanks' });
  await settle(rt);
  assert.match(adapter.calls.at(-1).message.context.join('\n'), /You: hello/);
  assert.throws(() => rt.runAgentCommand(t.id, { sessionId: beta.id, text: 'review' }), /starts with \//);
  assert.throws(() => rt.runAgentCommand(t.id, { sessionId: 'se_none', text: '/x' }), /isn’t in this conversation/);
});

test('#67: an agent that’s working can’t take a command until it finishes', async () => {
  const { rt, t, adapter } = setup();
  let release;
  adapter.next.push(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(10);
  const se = rt.sessionsIn(t.id)[0];
  assert.throws(() => rt.runAgentCommand(t.id, { sessionId: se.id, text: '/compact' }), /busy/);
  release();
  await settle(rt);
});

test('#67: an init’s skills and commands are kept per session, without the terminal-only ones', async () => {
  const init = readFileSync(new URL('fixtures/claude-code/permission-subagent.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((e) => e.subtype === 'init');
  const list = commandsOf(init);
  assert.equal(list.length, init.slash_commands.length - init.terminal_slash_commands.length);
  assert.ok(!list.some((c) => c.name === 'doctor'));
  assert.deepEqual(
    list.find((c) => c.name === 'code-review'),
    { name: 'code-review', skill: true },
  );
  assert.deepEqual(
    list.find((c) => c.name === 'compact'),
    { name: 'compact' },
  );
  // The mapper reports them, and the runtime keeps them on the session, bounded.
  const { rt, t, adapter, store } = setup();
  adapter.next.push(async (ctx) => {
    const m = createStreamMapper(ctx, {});
    m.push(init);
    ctx.commands([{ name: '/odd name!' }, { name: 'x'.repeat(101) }, { name: 'ok', description: 'd'.repeat(300), argumentHint: '<file>' }, { name: 'ok' }]);
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  const se = store.state.sessions[rt.sessionsIn(t.id)[0].id];
  assert.equal(se.commands.list.length, 1);
  assert.equal(se.commands.list[0].name, 'ok');
  assert.equal(se.commands.list[0].description.length, 200);
  assert.equal(se.commands.list[0].argumentHint, '<file>');
});

test('#67: the Agent SDK’s supportedCommands() adds descriptions and hints, keeps init’s skill marks, and failing is fine', async () => {
  const init = { slash_commands: ['review', 'doctor', 'deploy'], skills: ['review'], terminal_slash_commands: ['doctor'] };
  const got = [];
  const ctx = { commands: (l) => got.push(l) };
  const q = {
    supportedCommands: async () => [
      { name: 'review', description: 'Review a file', argumentHint: '<file>' },
      { name: 'doctor', description: 'Terminal only', argumentHint: '' },
      { name: 'deploy', description: 'Deploy', argumentHint: '[env]' },
    ],
  };
  listCommands(q, init, ctx);
  await sleep(5);
  assert.deepEqual(got[0], [
    { name: 'review', description: 'Review a file', argumentHint: '<file>', skill: true },
    { name: 'deploy', description: 'Deploy', argumentHint: '[env]' },
  ]);
  // The SDK documents it for streaming input only: a refusal leaves init’s list.
  listCommands({ supportedCommands: () => Promise.reject(new Error('Only available in streaming input mode')) }, init, ctx);
  listCommands({}, init, ctx);
  await sleep(5);
  assert.equal(got.length, 1);
});

test('#67: the recorded /compact turn compacted the session (Claude Code runs it in print mode)', () => {
  const events = readFileSync(new URL('fixtures/claude-code/compact.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const boundary = events.find((e) => e.subtype === 'compact_boundary');
  assert.equal(boundary.compact_metadata.trigger, 'manual');
  assert.equal(events.at(-1).subtype, 'success');
});

test('#67: /model and /effort change this conversation’s snapshot, from the next turn, and now where the backend can', async () => {
  const { rt, t, adapter } = setup();
  const se = rt.sessionsIn(t.id)[0];
  assert.deepEqual(await rt.setSessionRun(se.id, { model: 'claude-sonnet-5-5', effort: 'high' }), { ok: true, now: false });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  assert.deepEqual([adapter.calls[0].ctx.persona.model, adapter.calls[0].ctx.persona.effort], ['claude-sonnet-5-5', 'high']);
  await assert.rejects(rt.setSessionRun(se.id, { effort: 'extreme' }), /Effort is one of/);
  await assert.rejects(rt.setSessionRun(se.id, { model: 'a model; rm -rf' }), /A model is a name/);
  // A running turn whose backend can change: it says so.
  let release;
  const set = [];
  adapter.next.push(async (c) => {
    c.control({ setModel: async (m) => set.push(m) > 0 });
    await new Promise((r) => {
      release = r;
    });
  });
  rt.sendMessage(t.id, { text: 'again' });
  await sleep(10);
  assert.deepEqual(await rt.setSessionRun(se.id, { model: 'claude-opus-5-5' }), { ok: true, now: true });
  assert.deepEqual(set, ['claude-opus-5-5']);
  release();
  await settle(rt);
});
